// Reference verifier for the Ordex Collection Provenance Registry.
//
// This file restates spec/collection-manifest.md as executable checks. It
// validates a creator-signed collection manifest, recomputes its membership
// root, and proves or refuses membership offline: a member proof is checked
// with nothing but the manifest, the member identity, the proof, and this
// file. Creator signature validity is the caller's to prove
// cryptographically; everything else, including every hash, is proven here.
//
// Every hash is SHA-256, lowercase hex, over sorted-key JSON or over
// concatenated 32-byte digests with domain separation, so a member proof can
// never be replayed as another object type.

import { createHash } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const IDENTITY_TYPES = ['inscriptionId', 'output', 'assetId', 'satpoint'];
const PROTOCOLS = ['ordinals', 'runes', 'stamps', 'counterparty', 'multi'];
const STATUSES = [
  'DRAFT',
  'CREATOR_SIGNED',
  'ANCHOR_PENDING',
  'ANCHORED',
  'SUPERSEDED',
  'REVOKED',
  'SIGNATURE_INVALID',
  'MEMBERSHIP_INVALID',
  'ANCHOR_CONFLICTED',
  'REORGED',
];
export const COLLECTION_MANIFEST_SCHEMA = 'ordex.collection-manifest/v1';
export const COLLECTION_MANIFEST_REVOCATION_SCHEMA = 'ordex.collection-manifest-revocation/v1';
const MEMBER_DOMAIN = 'ordex.collection-member/v1';
const NODE_DOMAIN = 'ordex.collection-node/v1';

const refuse = (code, reason) => ({ ok: false, code, reason });

/** Serialize any JSON value with object keys sorted recursively. */
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The domain separated leaf for one member identity. The domain string makes
 * a member leaf impossible to replay as a Merkle interior node or as any
 * other artifact's leaf.
 */
export function memberLeafHash(collectionId, memberIdentity) {
  return sha256Hex(sortedJson({ domain: MEMBER_DOMAIN, collectionId, memberIdentity }));
}

/** One interior node: the two children in ascending byte order, domain separated. */
function nodeHash(left, right) {
  const [a, b] = left <= right ? [left, right] : [right, left];
  return sha256Hex(sortedJson({ domain: NODE_DOMAIN, left: a, right: b }));
}

/**
 * Recompute the membership root from member identities. Leaves are sorted
 * ascending before pairing so the root depends only on the member set.
 * A lone final leaf is promoted unchanged at every level.
 */
export function membershipRoot(collectionId, memberIdentityList) {
  let level = memberIdentityList
    .map((identity) => memberLeafHash(collectionId, identity))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) next.push(level[i]);
      else next.push(nodeHash(level[i], level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

/**
 * Build the inclusion proof for one member identity. Returns
 * [{ sibling, position }] from the leaf upward, where position names the
 * side the current digest occupies before its sibling. A lone leaf promoted
 * between levels adds no step, exactly as the root recomputation promotes it.
 */
export function buildMembershipProof(collectionId, memberIdentityList, memberIdentity) {
  let level = memberIdentityList
    .map((identity) => memberLeafHash(collectionId, identity))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let index = level.indexOf(memberLeafHash(collectionId, memberIdentity));
  if (index === -1) return null;
  const path = [];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        if (i === index) index = next.length - 1;
      } else {
        next.push(nodeHash(level[i], level[i + 1]));
        if (i === index) {
          path.push({ sibling: level[i + 1], position: 'right' });
          index = next.length - 1;
        } else if (i + 1 === index) {
          path.push({ sibling: level[i], position: 'left' });
          index = next.length - 1;
        }
      }
    }
    level = next;
  }
  return path;
}

/**
 * Recompute the manifest digest: SHA-256 over the sorted-key JSON of the
 * whole manifest except the digest and the creator signature, which cannot
 * cover themselves.
 */
export function collectionManifestDigest(manifest) {
  const binding = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'digest' || key === 'creatorSignature') continue;
    binding[key] = value;
  }
  return sha256Hex(sortedJson(binding));
}

/**
 * Verify a collection manifest.
 *
 * manifest:
 *   schema, protocolVersion, network, protocol, collectionId, displayName,
 *   description?, creatorAddress, memberIdentityType, members [],
 *   membershipRoot, metadataSchemaHash?, traitSchemaHash?, mediaDigests?,
 *   supplyStatement { kind: 'FIXED'|'OPEN', declared }, parentCollectionId?,
 *   rightsDeclaration?, createdAtHeight, version, previousManifestDigest?,
 *   anchor? { txid, inscriptionId? }, status, creatorSignature { kind,
 *   address, signature }, digest
 *
 * Answers { ok: true, digest, membershipRoot } or
 * { ok: false, code, reason }.
 */
export function verifyCollectionManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return refuse('MALFORMED_MANIFEST', 'Expected a manifest object.');
  }
  if (manifest.schema !== COLLECTION_MANIFEST_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The manifest schema is not ordex.collection-manifest/v1.');
  }
  if (typeof manifest.protocolVersion !== 'string' || !/^1\.[2-9][0-9]*$/.test(manifest.protocolVersion)) {
    return refuse('PROTOCOL_UNSUPPORTED', 'The manifest protocol version must be 1.2 or a later 1.x.');
  }
  if (typeof manifest.network !== 'string' || !NETWORKS.includes(manifest.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof manifest.protocol !== 'string' || !PROTOCOLS.includes(manifest.protocol)) {
    return refuse('PROTOCOL_FAMILY_UNKNOWN', 'The protocol family is not one this registry names.');
  }
  if (typeof manifest.collectionId !== 'string' || manifest.collectionId.length === 0 || manifest.collectionId.length > 200) {
    return refuse('COLLECTION_ID_INVALID', 'The manifest must name a collection id of at most 200 characters.');
  }
  if (typeof manifest.displayName !== 'string' || manifest.displayName.length === 0 || manifest.displayName.length > 200) {
    return refuse('DISPLAY_NAME_INVALID', 'The manifest must name a display name of at most 200 characters.');
  }
  if (typeof manifest.creatorAddress !== 'string' || manifest.creatorAddress.length === 0) {
    return refuse('CREATOR_ADDRESS_INVALID', 'The manifest must name the creator signing address.');
  }
  if (typeof manifest.memberIdentityType !== 'string' || !IDENTITY_TYPES.includes(manifest.memberIdentityType)) {
    return refuse('IDENTITY_TYPE_UNKNOWN', 'The member identity type is not one this registry names.');
  }
  if (!Array.isArray(manifest.members) || manifest.members.length === 0) {
    return refuse('MEMBERS_EMPTY', 'A manifest must list at least one member identity.');
  }
  if (!manifest.members.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 256)) {
    return refuse('MEMBERS_INVALID', 'Every member identity must be a string of at most 256 characters.');
  }
  const sortedMembers = [...manifest.members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < sortedMembers.length; i += 1) {
    if (sortedMembers[i] === sortedMembers[i - 1]) {
      return refuse('MEMBERS_DUPLICATED', `The member ${sortedMembers[i]} appears more than once.`);
    }
  }
  if (manifest.members.length !== sortedMembers.length || manifest.members.some((m, i) => m !== sortedMembers[i])) {
    return refuse('MEMBERS_UNSORTED', 'The member list must be stored in ascending sorted order.');
  }
  const root = membershipRoot(manifest.collectionId, manifest.members);
  if (manifest.membershipRoot !== root) {
    return refuse('MEMBERSHIP_ROOT_MISMATCH', 'The membership root does not match the member list.');
  }
  if (
    !manifest.supplyStatement ||
    typeof manifest.supplyStatement !== 'object' ||
    (manifest.supplyStatement.kind !== 'FIXED' && manifest.supplyStatement.kind !== 'OPEN') ||
    !/^(0|[1-9][0-9]*)$/.test(manifest.supplyStatement.declared || '')
  ) {
    return refuse('SUPPLY_STATEMENT_INVALID', 'The supply statement must be FIXED or OPEN with an exact declared count.');
  }
  if (manifest.supplyStatement.kind === 'FIXED' && manifest.supplyStatement.declared !== String(manifest.members.length)) {
    return refuse('SUPPLY_MISMATCH', 'A FIXED supply must declare exactly the member count.');
  }
  if (!Number.isInteger(manifest.createdAtHeight) || manifest.createdAtHeight < 0) {
    return refuse('CREATED_AT_INVALID', 'createdAtHeight must be a non-negative block height.');
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    return refuse('VERSION_INVALID', 'The manifest version must be a positive integer.');
  }
  if (manifest.version > 1) {
    if (typeof manifest.previousManifestDigest !== 'string' || !HEX64.test(manifest.previousManifestDigest)) {
      return refuse('PREVIOUS_DIGEST_REQUIRED', 'A manifest after version 1 must name the manifest it supersedes.');
    }
  } else if (manifest.previousManifestDigest !== undefined) {
    return refuse('PREVIOUS_DIGEST_FORBIDDEN', 'Version 1 cannot name a previous manifest.');
  }
  if (manifest.anchor !== undefined) {
    if (
      typeof manifest.anchor !== 'object' ||
      typeof manifest.anchor.txid !== 'string' ||
      !HEX64.test(manifest.anchor.txid)
    ) {
      return refuse('ANCHOR_INVALID', 'An anchor must name a lowercase 64 hex transaction id.');
    }
  }
  if (typeof manifest.status !== 'string' || !STATUSES.includes(manifest.status)) {
    return refuse('STATUS_INVALID', 'The manifest status is not one this registry names.');
  }
  const signature = manifest.creatorSignature;
  if (!signature || signature.kind !== 'bip322' || typeof signature.address !== 'string' || typeof signature.signature !== 'string' || signature.signature.length === 0) {
    return refuse('CREATOR_SIGNATURE_INVALID', 'The manifest must carry a bip322 creator signature.');
  }
  if (signature.address !== manifest.creatorAddress) {
    return refuse('SIGNER_IDENTITY_MISMATCH', 'The signature address is not the creator address.');
  }
  const digest = collectionManifestDigest(manifest);
  if (manifest.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The manifest digest does not match its content.');
  }
  return { ok: true, digest, membershipRoot: root };
}

/**
 * Verify that a member identity belongs to a manifest, offline.
 *
 * proof: [{ sibling, position }] as produced by buildMembershipProof.
 *
 * Returns { ok: true } or { ok: false, code, reason }. A manifest that did
 * not pass verifyCollectionManifest is refused before any hash walk.
 */
export function verifyMembershipProof({ manifest, memberIdentity, proof }) {
  const manifestVerdict = verifyCollectionManifest(manifest);
  if (!manifestVerdict.ok) return manifestVerdict;
  if (!Array.isArray(proof) || !proof.every((step) => step && HEX64.test(step.sibling) && (step.position === 'left' || step.position === 'right'))) {
    return refuse('PROOF_MALFORMED', 'Every proof step needs a sibling digest and a position.');
  }
  let digest = memberLeafHash(manifest.collectionId, memberIdentity);
  for (const step of proof) {
    digest = step.position === 'left' ? nodeHash(step.sibling, digest) : nodeHash(digest, step.sibling);
  }
  if (digest !== manifest.membershipRoot) {
    return refuse('MEMBER_NOT_PROVEN', 'The proof does not resolve to the membership root, so this identity is not a member.');
  }
  return { ok: true };
}

/**
 * SHA-256 over the signed content of a revocation: everything except the
 * digest itself and the creator signature.
 */
export function collectionRevocationDigest(revocation) {
  const binding = {};
  for (const [key, value] of Object.entries(revocation)) {
    if (key === 'digest' || key === 'creatorSignature') continue;
    binding[key] = value;
  }
  return sha256Hex(sortedJson(binding));
}

/**
 * Verify a signed revocation of a manifest.
 *
 * revocation: { schema, protocolVersion, network, collectionId,
 *   manifestDigest, reason, creatorSignature { kind, address, signature },
 *   digest }
 */
export function verifyManifestRevocation(revocation, manifest) {
  if (!revocation || typeof revocation !== 'object' || Array.isArray(revocation)) {
    return refuse('MALFORMED_REVOCATION', 'Expected a revocation object.');
  }
  if (revocation.schema !== COLLECTION_MANIFEST_REVOCATION_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The revocation schema is not ordex.collection-manifest-revocation/v1.');
  }
  if (typeof revocation.protocolVersion !== 'string' || !/^1\.[2-9][0-9]*$/.test(revocation.protocolVersion)) {
    return refuse('PROTOCOL_UNSUPPORTED', 'The revocation protocol version must be 1.2 or a later 1.x.');
  }
  if (typeof revocation.network !== 'string' || !NETWORKS.includes(revocation.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof revocation.collectionId !== 'string' || revocation.collectionId.length === 0) {
    return refuse('COLLECTION_ID_INVALID', 'The revocation must name the collection id.');
  }
  if (typeof revocation.manifestDigest !== 'string' || !HEX64.test(revocation.manifestDigest)) {
    return refuse('MANIFEST_DIGEST_INVALID', 'The revocation must name the manifest digest it revokes.');
  }
  if (typeof revocation.reason !== 'string' || revocation.reason.length === 0 || revocation.reason.length > 500) {
    return refuse('REASON_REQUIRED', 'The revocation must state a reason of at most 500 characters.');
  }
  const signature = revocation.creatorSignature;
  if (!signature || signature.kind !== 'bip322' || typeof signature.address !== 'string' || signature.address.length === 0) {
    return refuse('CREATOR_SIGNATURE_INVALID', 'The revocation must carry a bip322 creator signature.');
  }
  if (manifest) {
    const manifestVerdict = verifyCollectionManifest(manifest);
    if (!manifestVerdict.ok) return manifestVerdict;
    if (manifestVerdict.digest !== revocation.manifestDigest) {
      return refuse('MANIFEST_DIGEST_MISMATCH', 'The revocation names a different manifest than the one supplied.');
    }
    if (signature.address !== manifest.creatorAddress) {
      return refuse('SIGNER_IDENTITY_MISMATCH', 'The revocation was signed by an address that never created the manifest.');
    }
  }
  const digest = collectionRevocationDigest(revocation);
  if (revocation.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The revocation digest does not match its content.');
  }
  return { ok: true, digest };
}
