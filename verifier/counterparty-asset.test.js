import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COUNTERPARTY_UTXO_ASSET_SCHEMA,
  counterpartyRecordDigest,
  parseSats,
  verifyAttachmentFollows,
  verifyCounterpartyUtxoAsset,
} from './counterparty-asset.js';

const vectorsPath = fileURLToPath(new URL('../conformance/counterparty-asset-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    const verdict = vector.spendTx
      ? verifyAttachmentFollows(vector.record, vector.spendTx, vector.expectedOutputIndex)
      : verifyCounterpartyUtxoAsset(vector.record);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (vector.expected.ok) {
      if (vector.expected.carriedToIndex !== undefined) {
        assert.equal(verdict.carriedToIndex, vector.expected.carriedToIndex);
      }
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    }
  });
}

test('the schema name is stable', () => {
  assert.equal(COUNTERPARTY_UTXO_ASSET_SCHEMA, 'ordex.counterparty-utxo-asset/v1');
});

test('a malformed record is refused, never thrown on', () => {
  assert.equal(verifyCounterpartyUtxoAsset(null).ok, false);
  assert.equal(verifyCounterpartyUtxoAsset('record').ok, false);
  assert.equal(verifyCounterpartyUtxoAsset({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(verifyAttachmentFollows(null, null, 0).ok, false);
});

test('co-traveling assets must be declared with exact quantities', () => {
  const verdict = verifyCounterpartyUtxoAsset({
    schema: COUNTERPARTY_UTXO_ASSET_SCHEMA,
    network: 'mainnet',
    asset: { name: 'A', assetId: '1', divisible: false, quantitySats: '1' },
    outpoint: { txid: 'a'.repeat(64), vout: 0 },
    address: '1X',
    sourceValueSats: '1000',
    checkpoint: { height: 1, blockHash: 'b'.repeat(64), ledgerHash: 'c'.repeat(64) },
    authority: { kind: 'counterparty-core', ready: true },
    attached: true,
    coTravelingAssets: [{ name: 'B' }],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'COTRAVELING_INVALID');
});

test('the record digest ignores a stale digest field', () => {
  const record = { schema: COUNTERPARTY_UTXO_ASSET_SCHEMA, assetId: '1' };
  assert.equal(counterpartyRecordDigest(record), counterpartyRecordDigest({ ...record, digest: 'old' }));
});

test('parseSats accepts only exact non-negative decimal strings', () => {
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats('2100000000000000'), 2100000000000000n);
  for (const bad of ['', '-1', '1.5', '01', null, 1]) {
    assert.equal(parseSats(bad), null, `expected ${String(bad)} to be refused`);
  }
});
