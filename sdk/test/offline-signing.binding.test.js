import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compareSignedResultToManifest,
  expectedTransactionDigest,
  verifyExpectedTransactionManifest,
} from '../dist/index.js';
import { parsePsbt, parseTransaction } from '../dist/index.js';

// OX-P03: the manifest digest commits to the full unsigned transaction and the
// protection policy, and a signed result is judged from its bytes.

const vectors = JSON.parse(
  await readFile(fileURLToPath(new URL('../../conformance/offline-signing-vectors.json', import.meta.url)), 'utf8')
).cases;
const find = (name) => structuredClone(vectors.find((v) => v.name === name));
const base = () => find('a complete manifest is accepted').manifest;

test('P-R12: version, locktime and each sequence change the commitment', () => {
  const digest = expectedTransactionDigest(base());
  const mutations = [
    (m) => (m.unsignedTx.version = 1),
    (m) => (m.unsignedTx.lockTime = 500000000),
    (m) => (m.unsignedTx.inputs[0].sequence = 0xffffffff),
    (m) => (m.unsignedTx.inputs[1].sequence = 0),
    (m) => (m.unsignedTx.inputs = [m.unsignedTx.inputs[1], m.unsignedTx.inputs[0]]),
    (m) => (m.unsignedTx.inputs[0].scriptPubKeyHex = '5120' + '00'.repeat(32)),
    (m) => (m.unsignedTx.inputs[0].valueSats = '50001'),
    (m) => (m.network = 'signet'),
  ];
  for (const mutate of mutations) {
    const m = base();
    mutate(m);
    assert.notEqual(expectedTransactionDigest(m), digest, mutate.toString());
  }
});

test('P-R13: the protection policy is part of the commitment', () => {
  const digest = expectedTransactionDigest(base());
  const mutations = [
    (m) => m.unsignedTx.outputs.forEach((o) => delete o.expectedAssets),
    (m) => (m.unsignedTx.outputs[0].expectedAssets[0].quantity = '2'),
    (m) => (m.unsignedTx.outputs[1].expectedAssets = m.unsignedTx.outputs[0].expectedAssets),
    (m) => (m.unsignedTx.inputs[0].sighashType = 'ALL'),
    (m) => (m.unsignedTx.inputs[1].controlledByUser = false),
    (m) => (m.fee.maxFeeSats = '2001'),
  ];
  for (const mutate of mutations) {
    const m = base();
    mutate(m);
    assert.notEqual(expectedTransactionDigest(m), digest, mutate.toString());
  }
  // A manifest edited after its digest was taken is refused.
  const edited = base();
  edited.unsignedTx.outputs[0].expectedAssets = [];
  assert.equal(verifyExpectedTransactionManifest(edited).code, 'DIGEST_MISMATCH');
});

test('P-R11: a result that drops, adds or moves protected asset observations is refused', () => {
  const accepted = find('a signed transaction matching the manifest is accepted');
  assert.equal(compareSignedResultToManifest(accepted.signed, accepted.manifest).ok, true);

  const dropped = structuredClone(accepted.signed);
  delete dropped.observedAssets;
  assert.equal(compareSignedResultToManifest(dropped, accepted.manifest).code, 'PROTECTED_ASSET_OBSERVATION_MISSING');

  const empty = structuredClone(accepted.signed);
  empty.observedAssets = [];
  assert.equal(compareSignedResultToManifest(empty, accepted.manifest).code, 'PROTECTED_ASSET_MISPLACED');

  const extra = structuredClone(accepted.signed);
  extra.observedAssets.push({ assetType: 'RUNE', assetId: '840000:1', quantity: '5', outputIndex: 1 });
  assert.equal(compareSignedResultToManifest(extra, accepted.manifest).code, 'PROTECTED_ASSET_MISPLACED');
});

test('a raw transaction and its PSBT v0 and v2 forms describe the same presented transaction', () => {
  const raw = find('a signed transaction matching the manifest is accepted');
  const v0 = find('a signed PSBT v0 matching the manifest is accepted');
  const v2 = find('a signed PSBT v2 matching the manifest is accepted');
  const tx = parseTransaction(raw.signed.signedTxHex).tx;
  for (const form of [v0, v2]) {
    const { psbt } = parsePsbt(form.signed.psbt);
    assert.equal(psbt.tx.version, tx.version);
    assert.equal(psbt.tx.lockTime, tx.lockTime);
    assert.deepEqual(
      psbt.tx.inputs.map((i) => [i.txid, i.vout, i.sequence]),
      tx.inputs.map((i) => [i.txid, i.vout, i.sequence])
    );
    assert.deepEqual(psbt.tx.outputs, tx.outputs);
    const verdict = compareSignedResultToManifest(form.signed, form.manifest);
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.complete, false, 'a PSBT with partial signatures is not yet complete');
  }
  assert.equal(compareSignedResultToManifest(raw.signed, raw.manifest).complete, true);
});

test('an already signed seller input is preserved; changing or dropping it refuses', () => {
  const purchase = find('a purchase that preserves the seller signature is accepted');
  const verdict = compareSignedResultToManifest(purchase.signed, purchase.manifest);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.complete, true);

  const tx = parseTransaction(purchase.signed.signedTxHex).tx;
  const dropped = structuredClone(purchase.signed);
  const hex = purchase.signed.signedTxHex;
  const signature = tx.inputs[1].witness[0];
  dropped.signedTxHex = hex.replace(`41${signature}`, '00');
  assert.notEqual(dropped.signedTxHex, hex);
  assert.equal(compareSignedResultToManifest(dropped, purchase.manifest).code, 'FOREIGN_SIGNATURE_CHANGED');
});

test('hostile shapes answer with stable refusals', () => {
  const accepted = find('a signed transaction matching the manifest is accepted');
  const cases = [
    [{ ...accepted.signed, signedTxHex: undefined }, 'MALFORMED_SIGNED_RESULT'],
    [{ ...accepted.signed, psbt: 'cHNidP8=' }, 'MALFORMED_SIGNED_RESULT'],
    [{ ...accepted.signed, signedTxHex: 'zz' }, 'MALFORMED_SIGNED_RESULT'],
    [{ ...accepted.signed, observedAssets: [null] }, 'MALFORMED_SIGNED_RESULT'],
    [{ ...accepted.signed, extraField: 1 }, 'UNKNOWN_CRITICAL_FIELDS'],
    [{ ...accepted.signed, schema: 'ordex.offline-signing-session/v1' }, 'SCHEMA_UNSUPPORTED'],
  ];
  for (const [signed, code] of cases) assert.equal(compareSignedResultToManifest(signed, accepted.manifest).code, code, code);
  for (const hostile of [null, 7, 'x', [], { schema: 'ordex.expected-transaction-manifest/v2', unsignedTx: null }]) {
    assert.equal(verifyExpectedTransactionManifest(hostile).ok, false);
  }
  const noTx = base();
  noTx.unsignedTx.inputs[0] = null;
  assert.equal(verifyExpectedTransactionManifest(noTx).code, 'INPUT_DESCRIPTION_INVALID');
});
