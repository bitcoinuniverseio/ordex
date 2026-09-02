import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COLLECTION_MANIFEST_SCHEMA,
  buildMembershipProof,
  collectionManifestDigest,
  collectionRevocationDigest,
  memberLeafHash,
  membershipRoot,
  verifyCollectionManifest,
  verifyManifestRevocation,
  verifyMembershipProof,
} from './collection-manifest.js';

const vectorsPath = fileURLToPath(new URL('../conformance/collection-manifest-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    let verdict;
    if (vector.membership) {
      verdict = verifyMembershipProof({
        manifest: vector.manifest,
        memberIdentity: vector.membership.memberIdentity,
        proof: vector.membership.proof,
      });
    } else if (vector.revocation) {
      verdict = verifyManifestRevocation(vector.revocation, vector.manifest);
    } else {
      verdict = verifyCollectionManifest(vector.manifest);
    }
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (!vector.expected.ok) assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
  });
}

test('the schema name is stable', () => {
  assert.equal(COLLECTION_MANIFEST_SCHEMA, 'ordex.collection-manifest/v1');
});

test('a malformed manifest is refused, never thrown on', () => {
  assert.equal(verifyCollectionManifest(null).ok, false);
  assert.equal(verifyCollectionManifest([]).ok, false);
  assert.equal(verifyCollectionManifest({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(verifyManifestRevocation(null, null).ok, false);
  assert.equal(verifyMembershipProof({ manifest: null, memberIdentity: 'x', proof: [] }).ok, false);
});

test('member leaves are domain separated from interior nodes', () => {
  const leaf = memberLeafHash('collection', 'member-a');
  assert.equal(leaf, memberLeafHash('collection', 'member-a'));
  assert.notEqual(leaf, memberLeafHash('collection', 'member-b'));
  assert.notEqual(leaf, memberLeafHash('other-collection', 'member-a'));
  assert.match(leaf, /^[0-9a-f]{64}$/);
});

for (const size of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`a ${size} member collection roots and proves every member`, () => {
    const members = Array.from({ length: size }, (_, i) => `identity-${String(i).padStart(3, '0')}`);
    const collectionId = 'round-trip';
    const root = membershipRoot(collectionId, members);
    for (const member of members) {
      const proof = buildMembershipProof(collectionId, members, member);
      const verdict = verifyMembershipProof({
        manifest: {
          schema: COLLECTION_MANIFEST_SCHEMA,
          protocolVersion: '1.2',
          network: 'regtest',
          protocol: 'ordinals',
          collectionId,
          displayName: 'Round Trip',
          creatorAddress: 'bc1q',
          memberIdentityType: 'inscriptionId',
          members,
          membershipRoot: root,
          supplyStatement: { kind: 'FIXED', declared: String(size) },
          createdAtHeight: 1,
          version: 1,
          status: 'CREATOR_SIGNED',
          creatorSignature: { kind: 'bip322', address: 'bc1q', signature: 'sig' },
          digest: collectionManifestDigest({
            schema: COLLECTION_MANIFEST_SCHEMA,
            protocolVersion: '1.2',
            network: 'regtest',
            protocol: 'ordinals',
            collectionId,
            displayName: 'Round Trip',
            creatorAddress: 'bc1q',
            memberIdentityType: 'inscriptionId',
            members,
            membershipRoot: root,
            supplyStatement: { kind: 'FIXED', declared: String(size) },
            createdAtHeight: 1,
            version: 1,
            status: 'CREATOR_SIGNED',
            creatorSignature: { kind: 'bip322', address: 'bc1q', signature: 'sig' },
          }),
        },
        memberIdentity: member,
        proof,
      });
      assert.equal(verdict.ok, true, `member ${member} failed: ${verdict.reason || ''}`);
    }
  });
}

test('a member removed from the list cannot prove membership', () => {
  const members = ['a', 'b', 'c'];
  const staleProof = buildMembershipProof('collection', members, 'b');
  const smaller = ['a', 'c'];
  const manifest = {
    schema: COLLECTION_MANIFEST_SCHEMA,
    protocolVersion: '1.2',
    network: 'regtest',
    protocol: 'ordinals',
    collectionId: 'collection',
    displayName: 'Smaller',
    creatorAddress: 'bc1q',
    memberIdentityType: 'inscriptionId',
    members: smaller,
    membershipRoot: membershipRoot('collection', smaller),
    supplyStatement: { kind: 'FIXED', declared: '2' },
    createdAtHeight: 1,
    version: 2,
    previousManifestDigest: 'b'.repeat(64),
    status: 'CREATOR_SIGNED',
    creatorSignature: { kind: 'bip322', address: 'bc1q', signature: 'sig' },
  };
  manifest.digest = collectionManifestDigest(manifest);
  const verdict = verifyMembershipProof({
    manifest,
    memberIdentity: 'b',
    proof: staleProof,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'MEMBER_NOT_PROVEN');
});

test('the revocation digest excludes the signature and the digest', () => {
  const revocation = { schema: 'ordex.collection-manifest-revocation/v1', reason: 'r', digest: 'x' };
  const withSignature = { ...revocation, creatorSignature: { kind: 'bip322', address: 'a', signature: 's' } };
  assert.equal(collectionRevocationDigest(revocation), collectionRevocationDigest(withSignature));
});
