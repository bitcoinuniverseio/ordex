import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { verifyAttachmentFollows, verifyCounterpartyUtxoAsset } from '../verifier/counterparty-asset.js';
import { mapAttachments } from './positions.mjs';

const vectors = JSON.parse(await readFile(new URL('../conformance/counterparty-asset-vectors.json', import.meta.url)));

for (const vector of vectors.cases) {
  test(`conformance and mapping: ${vector.name}`, () => {
    const record = vector.record;
    const recordVerdict = verifyCounterpartyUtxoAsset(record);
    const verdict = vector.spendTx
      ? verifyAttachmentFollows(record, vector.spendTx, vector.expectedOutputIndex)
      : recordVerdict;
    assert.equal(verdict.ok, vector.expected.ok);
    if (vector.expected.carriedToIndex !== undefined) {
      assert.equal(verdict.carriedToIndex, vector.expected.carriedToIndex);
    }
    if (!verdict.ok) assert.equal(verdict.code, vector.expected.code);

    const context = {
      ...record.outpoint,
      network: record.network,
      snapshot: record.checkpoint,
      output: { address: record.address, valueSats: record.sourceValueSats },
    };
    if (recordVerdict.ok) {
      assert.deepEqual(mapAttachments([record], context).positions, [{
        protocolId: 'ordex',
        assetId: record.asset.assetId,
        quantityAtomic: record.asset.quantitySats,
        offsetAtomic: '0',
        spanAtomic: '1',
      }]);
    } else {
      assert.throws(() => mapAttachments([record], context), /counterparty_attachment_unproven/);
    }
  });
}
