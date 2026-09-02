import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COUNTERPARTY_UTXO_ASSET_SCHEMA,
  counterpartyRecordDigest,
  verifyAttachmentFollows,
  verifyCounterpartyUtxoAsset,
} from '../dist/index.js';

const vectorsPath = fileURLToPath(new URL('../../conformance/counterparty-asset-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    if (vector.spendTx) {
      const verdict = verifyAttachmentFollows(vector.record, vector.spendTx, vector.expectedOutputIndex);
      assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
      if (vector.expected.ok) {
        assert.equal(verdict.carriedToIndex, vector.expected.carriedToIndex);
      } else {
        assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
      }
      return;
    }
    const verdict = verifyCounterpartyUtxoAsset(vector.record);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (!vector.expected.ok) assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
  });
}

test('the schema name is stable', () => {
  assert.equal(COUNTERPARTY_UTXO_ASSET_SCHEMA, 'ordex.counterparty-utxo-asset/v1');
});

test('a malformed record is refused, never thrown on', () => {
  assert.equal(verifyCounterpartyUtxoAsset(null).ok, false);
  assert.equal(verifyCounterpartyUtxoAsset([]).ok, false);
  assert.equal(verifyCounterpartyUtxoAsset({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(verifyAttachmentFollows(null, null, 0).code, 'MALFORMED_RECORD');
});

test('the record digest excludes the digest field alone', () => {
  const accepted = vectors.cases.find((c) => c.expected.ok && c.record);
  const record = accepted.record;
  const redigested = { ...record, digest: 'x' };
  assert.equal(
    counterpartyRecordDigest(redigested),
    counterpartyRecordDigest(record),
    'the digest field is not part of the digest',
  );
  const moved = { ...record, address: 'bc1qsomeoneelse' };
  assert.notEqual(counterpartyRecordDigest(moved), counterpartyRecordDigest(record));
});

test('a spend carrying the attachment replays against the planned output', () => {
  const accepted = vectors.cases.find((c) => c.spendTx && c.expected.ok);
  const verdict = verifyAttachmentFollows(accepted.record, accepted.spendTx, accepted.expectedOutputIndex);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.carriedToIndex, accepted.expectedOutputIndex);
  assert.equal(verdict.carriedToIndex, accepted.expected.carriedToIndex);
});
