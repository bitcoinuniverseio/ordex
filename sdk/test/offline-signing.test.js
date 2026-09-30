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
} from '../dist/index.js';

const vectorsPath = fileURLToPath(new URL('../../conformance/offline-signing-vectors.json', import.meta.url));
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
  assert.equal(EXPECTED_TRANSACTION_MANIFEST_SCHEMA, 'ordex.expected-transaction-manifest/v2');
});

test('a malformed manifest or signed result is refused, never thrown on', () => {
  assert.equal(verifyExpectedTransactionManifest(null).ok, false);
  assert.equal(verifyExpectedTransactionManifest({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(compareSignedResultToManifest(null, null).ok, false);
  assert.equal(compareSignedResultToManifest({}, {}).code, 'SCHEMA_UNSUPPORTED');
});

test('the digest covers the transaction and the policy, never the display text', () => {
  const manifest = {
    schema: EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
    network: 'regtest',
    purpose: 'one',
    watchOnly: false,
    unsignedTx: {
      version: 2,
      lockTime: 0,
      inputs: [
        {
          txid: 'a'.repeat(64),
          vout: 0,
          sequence: 0xfffffffd,
          valueSats: '1000',
          scriptPubKeyHex: '0014' + 'aa'.repeat(20),
          controlledByUser: true,
          sighashType: 'ALL',
          explanation: 'why',
        },
      ],
      outputs: [{ scriptHex: '5120' + 'bb'.repeat(32), valueSats: '900', role: 'recipient', explanation: 'who' }],
    },
    fee: { feeSats: '100', maxFeeSats: '200' },
    digest: 'x',
  };
  const digest = expectedTransactionDigest(manifest);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const cosmetic = structuredClone(manifest);
  Object.assign(cosmetic, { purpose: 'two', watchOnly: true, account: { descriptor: 'wpkh(...)' } });
  cosmetic.unsignedTx.inputs[0].explanation = 'other words';
  cosmetic.unsignedTx.outputs[0].role = 'gift';
  assert.equal(expectedTransactionDigest(cosmetic), digest, 'display fields must not move the digest');
  const real = structuredClone(manifest);
  real.unsignedTx.outputs[0].scriptHex = '5120' + 'cc'.repeat(32);
  assert.notEqual(expectedTransactionDigest(real), digest, 'a changed script must move the digest');
});

test('parseSats accepts only exact non-negative decimal strings', () => {
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats('546'), 546n);
  for (const bad of ['', '-1', '1.5', '01', null, 546]) {
    assert.equal(parseSats(bad), null, `expected ${String(bad)} to be refused`);
  }
});
