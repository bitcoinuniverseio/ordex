import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
  OFFLINE_SIGNING_SESSION_SCHEMA,
  compareSignedResultToManifest,
  expectedTransactionDigest,
  verifyExpectedTransactionManifest,
} from '../dist/index.js';

const vectorsPath = fileURLToPath(new URL('../../conformance/offline-signing-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    const verdict = vector.signed
      ? compareSignedResultToManifest(vector.signed, vector.manifest)
      : verifyExpectedTransactionManifest(vector.manifest);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (vector.expected.ok) {
      if ('digest' in vector.expected) assert.equal(verdict.digest, vector.expected.digest);
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    }
  });
}

test('the schema names are stable', () => {
  assert.equal(EXPECTED_TRANSACTION_MANIFEST_SCHEMA, 'ordex.expected-transaction-manifest/v1');
  assert.equal(OFFLINE_SIGNING_SESSION_SCHEMA, 'ordex.offline-signing-session/v1');
});

test('a malformed manifest is refused, never thrown on', () => {
  assert.equal(verifyExpectedTransactionManifest(null).ok, false);
  assert.equal(verifyExpectedTransactionManifest([]).ok, false);
  assert.equal(verifyExpectedTransactionManifest({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(compareSignedResultToManifest(null, null).code, 'MALFORMED_SIGNED_RESULT');
});

test('the digest covers the transaction, not the presentation around it', () => {
  const complete = vectors.cases.find((c) => c.expected.ok && !c.signed && c.manifest);
  const manifest = complete.manifest;
  const relabelled = {
    ...manifest,
    purpose: 'a different one line purpose',
    watchOnly: !manifest.watchOnly,
    account: { descriptor: "wpkh([d34db33f/84h/0h/0h]xpub)" },
    unsignedTx: {
      ...manifest.unsignedTx,
      inputs: manifest.unsignedTx.inputs.map((input, i) => ({
        ...input,
        explanation: `input ${i} explained differently`,
      })),
      outputs: manifest.unsignedTx.outputs.map((output, i) => ({
        ...output,
        explanation: `output ${i} explained differently`,
      })),
    },
  };
  assert.equal(expectedTransactionDigest(relabelled), manifest.digest, 'explanations and profile fields are not signed content');
  const changed = JSON.parse(JSON.stringify(manifest));
  changed.unsignedTx.outputs[0].valueSats = String(BigInt(changed.unsignedTx.outputs[0].valueSats) + 1n);
  assert.notEqual(expectedTransactionDigest(changed), manifest.digest, 'a moved sat must move the digest');
});

test('the accepted signed result replays against its manifest digest', () => {
  const accepted = vectors.cases.find((c) => c.signed && c.expected.ok);
  const manifestVerdict = verifyExpectedTransactionManifest(accepted.manifest);
  assert.equal(manifestVerdict.ok, true);
  assert.equal(accepted.signed.manifestDigest, manifestVerdict.digest);
  assert.equal(compareSignedResultToManifest(accepted.signed, accepted.manifest).ok, true);
});
