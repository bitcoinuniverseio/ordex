import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildMembershipProof,
  collectionManifestDigest,
  collectionRevocationDigest,
  verifyCollectionManifest,
  verifyManifestRevocation,
  verifyMembershipProof,
} from '../dist/index.js';

// OX-P09: the SDK mirror of verifier/collection-revocation-context.test.js,
// run against sdk/dist with the same vectors.

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../../conformance/collection-manifest-vectors.json', import.meta.url)), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const accepted = vectors.cases.find((c) => c.name === 'a revocation signed by the creator is accepted');
const manifest = accepted.manifest;
const revise = (revocation, changes) => {
  const next = { ...clone(revocation), ...changes };
  next.digest = collectionRevocationDigest(next);
  return next;
};
const resign = (m, changes) => {
  const next = { ...clone(m), ...changes };
  next.digest = collectionManifestDigest(next);
  return next;
};

test('every revocation vector answers with its exact code and scope', () => {
  const cases = vectors.cases.filter((c) => c.revocation);
  assert.ok(cases.length >= 8);
  for (const c of cases) {
    const verdict = verifyManifestRevocation(c.revocation, c.manifest);
    for (const [key, value] of Object.entries(c.expected)) assert.equal(verdict[key], value, `${c.name}: ${key} ${verdict.reason || ''}`);
  }
});

test('P-R17: another network and collection with a recomputed digest is refused', () => {
  const replay = revise(accepted.revocation, { network: manifest.network === 'signet' ? 'mainnet' : 'signet', collectionId: 'unrelated' });
  assert.equal(verifyManifestRevocation(replay, manifest).code, 'REVOCATION_CONTEXT_MISMATCH');
  const onlyCollection = revise(accepted.revocation, { collectionId: 'unrelated' });
  assert.equal(verifyManifestRevocation(onlyCollection, manifest).code, 'REVOCATION_CONTEXT_MISMATCH');
});

test('the context is refused before the digest and the signer are considered', () => {
  const everythingWrong = revise(accepted.revocation, {
    network: 'signet',
    manifestDigest: 'a'.repeat(64),
    creatorSignature: { kind: 'bip322', address: 'bc1qsomeoneelse', signature: 'MEUCIQ==' },
  });
  assert.equal(verifyManifestRevocation(everythingWrong, manifest).code, 'REVOCATION_CONTEXT_MISMATCH');
});

test('a creator-bound revocation is TARGET_BOUND; without the target it is STRUCTURE_ONLY', () => {
  const bound = verifyManifestRevocation(accepted.revocation, manifest);
  assert.deepEqual(bound, { ok: true, digest: accepted.revocation.digest, scope: 'TARGET_BOUND' });
  for (const absent of [undefined, null]) {
    const loose = verifyManifestRevocation(accepted.revocation, absent);
    assert.equal(loose.ok, true);
    assert.equal(loose.scope, 'STRUCTURE_ONLY');
  }
  const replay = revise(accepted.revocation, { network: 'signet' });
  assert.equal(verifyManifestRevocation(replay).scope, 'STRUCTURE_ONLY', 'without the target, context cannot be judged, and the verdict says so');
});

test('a target with null fields or a wrong creator is refused', () => {
  for (const field of ['network', 'collectionId', 'creatorAddress']) {
    const broken = resign(manifest, { [field]: null });
    const verdict = verifyManifestRevocation(accepted.revocation, broken);
    assert.equal(verdict.ok, false, field);
  }
  const wrongCreator = revise(accepted.revocation, { creatorSignature: { kind: 'bip322', address: 'bc1qsomeoneelse', signature: 'MEUCIQ==' } });
  assert.equal(verifyManifestRevocation(wrongCreator, manifest).code, 'SIGNER_IDENTITY_MISMATCH');
});

test('signature material must be a bip322 address and a base64 signature', () => {
  for (const creatorSignature of [
    null,
    { kind: 'ecdsa', address: manifest.creatorAddress, signature: 'MEUCIQ==' },
    { kind: 'bip322', address: '', signature: 'MEUCIQ==' },
    { kind: 'bip322', address: manifest.creatorAddress },
    { kind: 'bip322', address: manifest.creatorAddress, signature: '' },
    { kind: 'bip322', address: manifest.creatorAddress, signature: 'MEUCIQ=' },
    { kind: 'bip322', address: manifest.creatorAddress, signature: 'ME UCIQ==' },
    { kind: 'bip322', address: manifest.creatorAddress, signature: 'A'.repeat(10004) },
  ]) {
    const verdict = verifyManifestRevocation(revise(accepted.revocation, { creatorSignature }), manifest);
    assert.equal(verdict.code, 'CREATOR_SIGNATURE_INVALID', JSON.stringify(creatorSignature)?.slice(0, 80));
  }
});

test('a revocation of one version never validates against its successor', () => {
  const successor = resign(manifest, { version: 2, previousManifestDigest: manifest.digest, displayName: `${manifest.displayName} II` });
  assert.equal(verifyCollectionManifest(successor).ok, true);
  assert.equal(verifyManifestRevocation(accepted.revocation, successor).code, 'MANIFEST_DIGEST_MISMATCH');
  const forSuccessor = revise(accepted.revocation, { manifestDigest: successor.digest });
  assert.equal(verifyManifestRevocation(forSuccessor, successor).scope, 'TARGET_BOUND');
});

test('verification is deterministic, so a registry can apply a revocation exactly once', () => {
  const first = verifyManifestRevocation(accepted.revocation, manifest);
  const again = verifyManifestRevocation(clone(accepted.revocation), clone(manifest));
  assert.deepEqual(again, first);
  const second = revise(accepted.revocation, { reason: 'A second, different revocation.' });
  const secondVerdict = verifyManifestRevocation(second, manifest);
  assert.equal(secondVerdict.ok, true);
  assert.notEqual(secondVerdict.digest, first.digest, 'a different revocation of the same manifest is a different document');
});

test('a revocation never rewrites the creator document or its membership proofs', () => {
  const before = collectionManifestDigest(manifest);
  verifyManifestRevocation(accepted.revocation, manifest);
  assert.equal(collectionManifestDigest(manifest), before);
  assert.equal(manifest.digest, before);
  const proof = buildMembershipProof(manifest.collectionId, manifest.members, manifest.members[0]);
  assert.equal(verifyMembershipProof({ manifest, memberIdentity: manifest.members[0], proof }).ok, true);
});
