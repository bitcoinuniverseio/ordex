import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
  compareSignedResultToManifest,
  expectedTransactionDigest,
  parseSats,
  verifyExpectedTransactionManifest,
} from './offline-signing.js';

const vectorsPath = fileURLToPath(new URL('../conformance/offline-signing-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    if (!vector.signed) {
      const verdict = verifyExpectedTransactionManifest(vector.manifest);
      assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
      if (vector.expected.ok) assert.equal(verdict.digest, vector.manifest.digest);
      else assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
      return;
    }
    const verdict = compareSignedResultToManifest(vector.signed, vector.manifest);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (!vector.expected.ok) assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
  });
}

test('the schema names are stable', () => {
  assert.equal(EXPECTED_TRANSACTION_MANIFEST_SCHEMA, 'ordex.expected-transaction-manifest/v1');
});

test('a malformed manifest or signed result is refused, never thrown on', () => {
  assert.equal(verifyExpectedTransactionManifest(null).ok, false);
  assert.equal(verifyExpectedTransactionManifest({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(compareSignedResultToManifest(null, null).ok, false);
  assert.equal(compareSignedResultToManifest({}, {}).code, 'SCHEMA_UNSUPPORTED');
});

test('the digest covers the unsigned transaction, network, and sighash policy only', () => {
  const manifest = {
    schema: EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
    network: 'regtest',
    purpose: 'one',
    watchOnly: false,
    unsignedTx: {
      inputs: [
        {
          txid: 'a'.repeat(64),
          vout: 0,
          valueSats: '1000',
          scriptPubKeyHex: '0014aa',
          controlledByUser: true,
          sighashType: 'ALL',
          explanation: 'why',
        },
      ],
      outputs: [{ scriptHex: '5120bb', valueSats: '900', role: 'recipient', explanation: 'who' }],
    },
    fee: { feeSats: '100', maxFeeSats: '200' },
    digest: 'x',
  };
  const digest = expectedTransactionDigest(manifest);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const cosmeticChange = { ...manifest, purpose: 'two', watchOnly: true, account: { descriptor: 'wpkh(...)' } };
  assert.equal(expectedTransactionDigest(cosmeticChange), digest, 'presentation fields must not move the digest');
  const realChange = {
    ...manifest,
    unsignedTx: {
      ...manifest.unsignedTx,
      outputs: [{ scriptHex: '5120cc', valueSats: '900', role: 'recipient', explanation: 'who' }],
    },
  };
  assert.notEqual(expectedTransactionDigest(realChange), digest, 'a changed script must move the digest');
});

test('parseSats accepts only exact non-negative decimal strings', () => {
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats('546'), 546n);
  for (const bad of ['', '-1', '1.5', '01', null, 546]) {
    assert.equal(parseSats(bad), null, `expected ${String(bad)} to be refused`);
  }
});
