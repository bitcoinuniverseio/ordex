/**
 * The Collection Provenance Registry rules from
 * spec/collection-manifest.md, typed.
 *
 * This is the same verifier as verifier/collection-manifest.js at the
 * repository root, ported to TypeScript for SDK consumers. Both
 * implementations are run against conformance/collection-manifest-vectors.json,
 * so they cannot drift apart without a test failing.
 *
 * Every hash is SHA-256, lowercase hex, over sorted-key JSON or over
 * concatenated 32-byte digests with domain separation, so a member proof can
 * never be replayed as another object type.
 */

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

/** Serialize any JSON value with object keys sorted recursively. */
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface CollectionManifest {
  schema?: unknown;
  protocolVersion?: unknown;
  network?: unknown;
  protocol?: unknown;
  collectionId?: unknown;
  displayName?: unknown;
  description?: unknown;
  creatorAddress?: unknown;
  memberIdentityType?: unknown;
  members?: unknown[];
  membershipRoot?: unknown;
  metadataSchemaHash?: unknown;
  traitSchemaHash?: unknown;
  mediaDigests?: unknown;
  supplyStatement?: { kind?: unknown; declared?: unknown };
  parentCollectionId?: unknown;
  rightsDeclaration?: unknown;
  createdAtHeight?: unknown;
  version?: unknown;
  previousManifestDigest?: unknown;
  anchor?: { txid?: unknown; inscriptionId?: unknown };
  status?: unknown;
  creatorSignature?: { kind?: unknown; address?: unknown; signature?: unknown };
  digest?: unknown;
  [key: string]: unknown;
}

export interface CollectionManifestRevocation {
  schema?: unknown;
  protocolVersion?: unknown;
  network?: unknown;
  collectionId?: unknown;
  manifestDigest?: unknown;
  reason?: unknown;
  creatorSignature?: { kind?: unknown; address?: unknown; signature?: unknown };
  digest?: unknown;
  [key: string]: unknown;
}

export interface MembershipProofStep {
  sibling?: unknown;
  position?: unknown;
}

/**
 * The domain separated leaf for one member identity. The domain string makes
 * a member leaf impossible to replay as a Merkle interior node or as any
 * other artifact's leaf.
 */
export function memberLeafHash(collectionId: string, memberIdentity: string): string {
  return sha256Hex(sortedJson({ domain: MEMBER_DOMAIN, collectionId, memberIdentity }));
}

/** One interior node: the two children in ascending byte order, domain separated. */
function nodeHash(left: string, right: string): string {
  const [a, b] = left <= right ? [left, right] : [right, left];
  return sha256Hex(sortedJson({ domain: NODE_DOMAIN, left: a, right: b }));
}

const byHex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Recompute the membership root from member identities. Leaves are sorted
 * ascending before pairing so the root depends only on the member set.
 * A lone final leaf is promoted unchanged at every level.
 */
export function membershipRoot(collectionId: string, memberIdentityList: string[]): string {
  let level = memberIdentityList
    .map((identity) => memberLeafHash(collectionId, identity))
    .sort(byHex);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) next.push(level[i] as string);
      else next.push(nodeHash(level[i] as string, level[i + 1] as string));
    }
    level = next;
  }
  return level[0] as string;
}

/**
 * Build the inclusion proof for one member identity. Returns
 * [{ sibling, position }] from the leaf upward, where position names the
 * side the current digest occupies before its sibling. A lone leaf promoted
 * between levels adds no step, exactly as the root recomputation promotes it.
 */
export function buildMembershipProof(
  collectionId: string,
  memberIdentityList: string[],
  memberIdentity: string,
): Array<{ sibling: string; position: 'left' | 'right' }> | null {
  let level = memberIdentityList
    .map((identity) => memberLeafHash(collectionId, identity))
    .sort(byHex);
  let index = level.indexOf(memberLeafHash(collectionId, memberIdentity));
  if (index === -1) return null;
  const path: Array<{ sibling: string; position: 'left' | 'right' }> = [];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i] as string);
        if (i === index) index = next.length - 1;
      } else {
        next.push(nodeHash(level[i] as string, level[i + 1] as string));
        if (i === index) {
          path.push({ sibling: level[i + 1] as string, position: 'right' });
          index = next.length - 1;
        } else if (i + 1 === index) {
          path.push({ sibling: level[i] as string, position: 'left' });
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
export function collectionManifestDigest(manifest: CollectionManifest): string {
  const binding: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'digest' || key === 'creatorSignature') continue;
    binding[key] = value;
  }
  return sha256Hex(sortedJson(binding));
}

export type CollectionManifestRefusalCode =
  | 'MALFORMED_MANIFEST'
  | 'SCHEMA_UNSUPPORTED'
  | 'PROTOCOL_UNSUPPORTED'
  | 'NETWORK_UNKNOWN'
  | 'PROTOCOL_FAMILY_UNKNOWN'
  | 'COLLECTION_ID_INVALID'
  | 'DISPLAY_NAME_INVALID'
  | 'CREATOR_ADDRESS_INVALID'
  | 'IDENTITY_TYPE_UNKNOWN'
  | 'MEMBERS_EMPTY'
  | 'MEMBERS_INVALID'
  | 'MEMBERS_DUPLICATED'
  | 'MEMBERS_UNSORTED'
  | 'MEMBERSHIP_ROOT_MISMATCH'
  | 'SUPPLY_STATEMENT_INVALID'
  | 'SUPPLY_MISMATCH'
  | 'CREATED_AT_INVALID'
  | 'VERSION_INVALID'
  | 'PREVIOUS_DIGEST_REQUIRED'
  | 'PREVIOUS_DIGEST_FORBIDDEN'
  | 'ANCHOR_INVALID'
  | 'STATUS_INVALID'
  | 'CREATOR_SIGNATURE_INVALID'
  | 'SIGNER_IDENTITY_MISMATCH'
  | 'DIGEST_MISMATCH';

export type CollectionManifestVerdict =
  | { ok: true; digest: string; membershipRoot: string }
  | { ok: false; code: CollectionManifestRefusalCode; reason: string };

const refuse = (code: CollectionManifestRefusalCode, reason: string): CollectionManifestVerdict => ({
  ok: false,
  code,
  reason,
});

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
export function verifyCollectionManifest(manifest: unknown): CollectionManifestVerdict {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return refuse('MALFORMED_MANIFEST', 'Expected a manifest object.');
  }
  const m = manifest as CollectionManifest;
  if (m.schema !== COLLECTION_MANIFEST_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The manifest schema is not ordex.collection-manifest/v1.');
  }
  if (typeof m.protocolVersion !== 'string' || !/^1\.[2-9][0-9]*$/.test(m.protocolVersion)) {
    return refuse('PROTOCOL_UNSUPPORTED', 'The manifest protocol version must be 1.2 or a later 1.x.');
  }
  if (typeof m.network !== 'string' || !NETWORKS.includes(m.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof m.protocol !== 'string' || !PROTOCOLS.includes(m.protocol)) {
    return refuse('PROTOCOL_FAMILY_UNKNOWN', 'The protocol family is not one this registry names.');
  }
  if (typeof m.collectionId !== 'string' || m.collectionId.length === 0 || m.collectionId.length > 200) {
    return refuse('COLLECTION_ID_INVALID', 'The manifest must name a collection id of at most 200 characters.');
  }
  if (typeof m.displayName !== 'string' || m.displayName.length === 0 || m.displayName.length > 200) {
    return refuse('DISPLAY_NAME_INVALID', 'The manifest must name a display name of at most 200 characters.');
  }
  if (typeof m.creatorAddress !== 'string' || m.creatorAddress.length === 0) {
    return refuse('CREATOR_ADDRESS_INVALID', 'The manifest must name the creator signing address.');
  }
  if (typeof m.memberIdentityType !== 'string' || !IDENTITY_TYPES.includes(m.memberIdentityType)) {
    return refuse('IDENTITY_TYPE_UNKNOWN', 'The member identity type is not one this registry names.');
  }
  if (!Array.isArray(m.members) || m.members.length === 0) {
    return refuse('MEMBERS_EMPTY', 'A manifest must list at least one member identity.');
  }
  if (!m.members.every((member) => typeof member === 'string' && member.length > 0 && member.length <= 256)) {
    return refuse('MEMBERS_INVALID', 'Every member identity must be a string of at most 256 characters.');
  }
  const members = m.members as string[];
  const sortedMembers = [...members].sort(byHex);
  for (let i = 1; i < sortedMembers.length; i += 1) {
    if (sortedMembers[i] === sortedMembers[i - 1]) {
      return refuse('MEMBERS_DUPLICATED', `The member ${sortedMembers[i]} appears more than once.`);
    }
  }
  if (members.length !== sortedMembers.length || members.some((member, i) => member !== sortedMembers[i])) {
    return refuse('MEMBERS_UNSORTED', 'The member list must be stored in ascending sorted order.');
  }
  const root = membershipRoot(m.collectionId, members);
  if (m.membershipRoot !== root) {
    return refuse('MEMBERSHIP_ROOT_MISMATCH', 'The membership root does not match the member list.');
  }
  if (
    !m.supplyStatement ||
    typeof m.supplyStatement !== 'object' ||
    (m.supplyStatement.kind !== 'FIXED' && m.supplyStatement.kind !== 'OPEN') ||
    !/^(0|[1-9][0-9]*)$/.test((m.supplyStatement.declared || '') as string)
  ) {
    return refuse('SUPPLY_STATEMENT_INVALID', 'The supply statement must be FIXED or OPEN with an exact declared count.');
  }
  if (m.supplyStatement.kind === 'FIXED' && m.supplyStatement.declared !== String(members.length)) {
    return refuse('SUPPLY_MISMATCH', 'A FIXED supply must declare exactly the member count.');
  }
  if (!Number.isInteger(m.createdAtHeight) || (m.createdAtHeight as number) < 0) {
    return refuse('CREATED_AT_INVALID', 'createdAtHeight must be a non-negative block height.');
  }
  if (!Number.isInteger(m.version) || (m.version as number) < 1) {
    return refuse('VERSION_INVALID', 'The manifest version must be a positive integer.');
  }
  if ((m.version as number) > 1) {
    if (typeof m.previousManifestDigest !== 'string' || !HEX64.test(m.previousManifestDigest)) {
      return refuse('PREVIOUS_DIGEST_REQUIRED', 'A manifest after version 1 must name the manifest it supersedes.');
    }
  } else if (m.previousManifestDigest !== undefined) {
    return refuse('PREVIOUS_DIGEST_FORBIDDEN', 'Version 1 cannot name a previous manifest.');
  }
  if (m.anchor !== undefined) {
    if (typeof m.anchor !== 'object' || typeof m.anchor.txid !== 'string' || !HEX64.test(m.anchor.txid)) {
      return refuse('ANCHOR_INVALID', 'An anchor must name a lowercase 64 hex transaction id.');
    }
  }
  if (typeof m.status !== 'string' || !STATUSES.includes(m.status)) {
    return refuse('STATUS_INVALID', 'The manifest status is not one this registry names.');
  }
  const signature = m.creatorSignature;
  if (
    !signature ||
    signature.kind !== 'bip322' ||
    typeof signature.address !== 'string' ||
    typeof signature.signature !== 'string' ||
    signature.signature.length === 0
  ) {
    return refuse('CREATOR_SIGNATURE_INVALID', 'The manifest must carry a bip322 creator signature.');
  }
  if (signature.address !== m.creatorAddress) {
    return refuse('SIGNER_IDENTITY_MISMATCH', 'The signature address is not the creator address.');
  }
  const digest = collectionManifestDigest(m);
  if (m.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The manifest digest does not match its content.');
  }
  return { ok: true, digest, membershipRoot: root };
}

export type MembershipRefusalCode =
  | 'PROOF_MALFORMED'
  | 'MEMBER_NOT_PROVEN';

export type MembershipVerdict =
  | { ok: true }
  | { ok: false; code: CollectionManifestRefusalCode | MembershipRefusalCode; reason: string };

const refuseMembership = (
  code: CollectionManifestRefusalCode | MembershipRefusalCode,
  reason: string,
): MembershipVerdict => ({ ok: false, code, reason });

/**
 * Verify that a member identity belongs to a manifest, offline.
 *
 * proof: [{ sibling, position }] as produced by buildMembershipProof.
 *
 * Returns { ok: true } or { ok: false, code, reason }. A manifest that did
 * not pass verifyCollectionManifest is refused before any hash walk.
 */
export function verifyMembershipProof({
  manifest,
  memberIdentity,
  proof,
}: {
  manifest: unknown;
  memberIdentity: string;
  proof: MembershipProofStep[];
}): MembershipVerdict {
  const manifestVerdict = verifyCollectionManifest(manifest);
  if (!manifestVerdict.ok) return manifestVerdict;
  const m = manifest as CollectionManifest;
  if (
    !Array.isArray(proof) ||
    !proof.every(
      (step) =>
        step && HEX64.test(step.sibling as string) && (step.position === 'left' || step.position === 'right'),
    )
  ) {
    return refuseMembership('PROOF_MALFORMED', 'Every proof step needs a sibling digest and a position.');
  }
  let digest = memberLeafHash(m.collectionId as string, memberIdentity);
  for (const step of proof) {
    digest =
      step.position === 'left'
        ? nodeHash(step.sibling as string, digest)
        : nodeHash(digest, step.sibling as string);
  }
  if (digest !== m.membershipRoot) {
    return refuseMembership('MEMBER_NOT_PROVEN', 'The proof does not resolve to the membership root, so this identity is not a member.');
  }
  return { ok: true };
}

/**
 * SHA-256 over the signed content of a revocation: everything except the
 * digest itself and the creator signature.
 */
export function collectionRevocationDigest(revocation: CollectionManifestRevocation): string {
  const binding: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(revocation)) {
    if (key === 'digest' || key === 'creatorSignature') continue;
    binding[key] = value;
  }
  return sha256Hex(sortedJson(binding));
}

export type CollectionRevocationRefusalCode =
  | 'MALFORMED_REVOCATION'
  | 'SCHEMA_UNSUPPORTED'
  | 'PROTOCOL_UNSUPPORTED'
  | 'NETWORK_UNKNOWN'
  | 'COLLECTION_ID_INVALID'
  | 'MANIFEST_DIGEST_INVALID'
  | 'REASON_REQUIRED'
  | 'CREATOR_SIGNATURE_INVALID'
  | 'SIGNER_IDENTITY_MISMATCH'
  | 'MANIFEST_DIGEST_MISMATCH'
  | 'DIGEST_MISMATCH';

export type CollectionRevocationVerdict =
  | { ok: true; digest: string }
  | { ok: false; code: CollectionRevocationRefusalCode | CollectionManifestRefusalCode; reason: string };

const refuseRevocation = (
  code: CollectionRevocationRefusalCode,
  reason: string,
): CollectionRevocationVerdict => ({ ok: false, code, reason });

/**
 * Verify a signed revocation of a manifest.
 *
 * revocation: { schema, protocolVersion, network, collectionId,
 *   manifestDigest, reason, creatorSignature { kind, address, signature },
 *   digest }
 */
export function verifyManifestRevocation(
  revocation: unknown,
  manifest?: unknown,
): CollectionRevocationVerdict {
  if (!revocation || typeof revocation !== 'object' || Array.isArray(revocation)) {
    return refuseRevocation('MALFORMED_REVOCATION', 'Expected a revocation object.');
  }
  const r = revocation as CollectionManifestRevocation;
  if (r.schema !== COLLECTION_MANIFEST_REVOCATION_SCHEMA) {
    return refuseRevocation('SCHEMA_UNSUPPORTED', 'The revocation schema is not ordex.collection-manifest-revocation/v1.');
  }
  if (typeof r.protocolVersion !== 'string' || !/^1\.[2-9][0-9]*$/.test(r.protocolVersion)) {
    return refuseRevocation('PROTOCOL_UNSUPPORTED', 'The revocation protocol version must be 1.2 or a later 1.x.');
  }
  if (typeof r.network !== 'string' || !NETWORKS.includes(r.network)) {
    return refuseRevocation('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof r.collectionId !== 'string' || r.collectionId.length === 0) {
    return refuseRevocation('COLLECTION_ID_INVALID', 'The revocation must name the collection id.');
  }
  if (typeof r.manifestDigest !== 'string' || !HEX64.test(r.manifestDigest)) {
    return refuseRevocation('MANIFEST_DIGEST_INVALID', 'The revocation must name the manifest digest it revokes.');
  }
  if (typeof r.reason !== 'string' || r.reason.length === 0 || r.reason.length > 500) {
    return refuseRevocation('REASON_REQUIRED', 'The revocation must state a reason of at most 500 characters.');
  }
  const signature = r.creatorSignature;
  if (
    !signature ||
    signature.kind !== 'bip322' ||
    typeof signature.address !== 'string' ||
    signature.address.length === 0
  ) {
    return refuseRevocation('CREATOR_SIGNATURE_INVALID', 'The revocation must carry a bip322 creator signature.');
  }
  if (manifest) {
    const manifestVerdict = verifyCollectionManifest(manifest);
    if (!manifestVerdict.ok) return manifestVerdict;
    if (manifestVerdict.digest !== r.manifestDigest) {
      return refuseRevocation('MANIFEST_DIGEST_MISMATCH', 'The revocation names a different manifest than the one supplied.');
    }
    if (signature.address !== (manifest as CollectionManifest).creatorAddress) {
      return refuseRevocation('SIGNER_IDENTITY_MISMATCH', 'The revocation was signed by an address that never created the manifest.');
    }
  }
  const digest = collectionRevocationDigest(r);
  if (r.digest !== digest) {
    return refuseRevocation('DIGEST_MISMATCH', 'The revocation digest does not match its content.');
  }
  return { ok: true, digest };
}
