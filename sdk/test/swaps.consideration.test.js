import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SWAP_SIGNED_TRANSACTION_SCHEMA,
  swapAcceptanceDigest,
  swapUnsignedTransaction,
  verifySwapAcceptance,
  verifySwapSignedTransaction,
} from '../dist/index.js';
import { bytesToHex, serializeTransaction } from '../dist/index.js';
import { p2trKeyPath, p2wpkhScript, signP2wpkh, signTaprootKeyPath, testKey } from '../../scripts/vector-signer.mjs';

// OX-P02 (SDK port): consideration is judged by asset identity and quantity at the owning
// party's script, and a settlement is proved from its signed bytes.

const vectors = JSON.parse(
  await readFile(fileURLToPath(new URL('../../conformance/swap-vectors.json', import.meta.url)), 'utf8')
).cases;
const find = (name) => structuredClone(vectors.find((v) => v.name === name));
const redigest = (acceptance) => {
  acceptance.digest = swapAcceptanceDigest(acceptance);
  return acceptance;
};
const SETTLED = [
  'BTC for an inscription settles with the inscription at the maker',
  'an inscription for BTC settles with the inscription at the taker',
  'BTC for a rune settles with the exact rune amount at the maker',
];

test('each settlement cohort derives the fee shares from value flow', () => {
  const shares = SETTLED.map((name) => {
    const v = find(name);
    const verdict = verifySwapAcceptance(v.acceptance, v.intent);
    assert.equal(verdict.ok, true, `${name}: ${verdict.reason}`);
    return [verdict.makerFeeSats, verdict.takerFeeSats];
  });
  assert.deepEqual(shares, [
    ['600', '0'],
    ['0', '600'],
    ['54', '546'],
  ]);
});

test('P-R09: a required rune absent, of another id, or short is refused', () => {
  assert.equal(
    verifySwapAcceptance(...(({ acceptance, intent }) => [acceptance, intent])(find('P-R09: a required rune the taker never supplies is refused'))).code,
    'CONSIDERATION_SHORTFALL'
  );
  // Absent: the taker input carries no runes at all.
  const v = find('BTC for a rune settles with the exact rune amount at the maker');
  v.acceptance.tx.inputs[1].inventory = { examined: true };
  v.acceptance.tx.outputs.shift();
  v.acceptance.assetTransitions = [];
  const verdict = verifySwapAcceptance(redigest(v.acceptance), v.intent);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CONSIDERATION_SHORTFALL');
  assert.equal(
    verifySwapAcceptance(...(({ acceptance, intent }) => [acceptance, intent])(find('a required rune delivered short is refused'))).code,
    'CONSIDERATION_SHORTFALL'
  );
});

test('P-R10: labels decide nothing; a maker give paid to the maker refuses', () => {
  const v = find('P-R10: an inscription the maker gives, paid back to the maker, is refused');
  for (const output of v.acceptance.tx.outputs) output.role = 'takerAsset';
  assert.equal(verifySwapAcceptance(redigest(v.acceptance), v.intent).code, 'MAKER_ASSET_NOT_DELIVERED');
});

test('replays against another network or intent are refused', () => {
  const v = find('BTC for an inscription settles with the inscription at the maker');
  const other = find('an inscription for BTC settles with the inscription at the taker');
  assert.equal(verifySwapAcceptance(v.acceptance, other.intent).code, 'INTENT_DIGEST_MISMATCH');
  const moved = structuredClone(v.acceptance);
  moved.network = 'signet';
  assert.equal(verifySwapAcceptance(redigest(moved), v.intent).code, 'NETWORK_MISMATCH');
});

test('hidden outputs and fee theft are refused', () => {
  const v = find('BTC for an inscription settles with the inscription at the maker');
  v.acceptance.tx.outputs[2] = { scriptHex: '0014' + '9'.repeat(40), valueSats: '400' };
  assert.equal(verifySwapAcceptance(redigest(v.acceptance), v.intent).code, 'OUTPUT_UNOWNED');
  const w = find('BTC for an inscription settles with the inscription at the maker');
  w.acceptance.tx.outputs.push({ scriptHex: '6a0401020304', valueSats: '0' });
  assert.equal(verifySwapAcceptance(redigest(w.acceptance), w.intent).code, 'DATA_OUTPUT_NOT_PERMITTED');
});

const MAKER_KEY = testKey('swap-maker');
const TAKER_KEY = testKey('swap-taker');
const KEYS = { [p2trKeyPath(MAKER_KEY).scriptHex]: MAKER_KEY, [p2wpkhScript(TAKER_KEY)]: TAKER_KEY };

function settle(v, { skip = [], hashTypes = {}, tamper } = {}) {
  const tx = swapUnsignedTransaction(v.acceptance);
  const prevouts = v.acceptance.tx.inputs.map((input) => ({ valueSats: input.valueSats, scriptHex: input.scriptPubKeyHex }));
  tx.inputs.forEach((input, i) => {
    if (skip.includes(i)) return;
    const script = prevouts[i].scriptHex;
    input.witness = script.startsWith('5120')
      ? [signTaprootKeyPath(tx, i, prevouts, KEYS[script], hashTypes[i] ?? 0x00)]
      : signP2wpkh(tx, i, prevouts, KEYS[script], hashTypes[i] ?? 0x01);
  });
  if (tamper) tamper(tx);
  return { schema: SWAP_SIGNED_TRANSACTION_SCHEMA, acceptanceDigest: v.acceptance.digest, signedTxHex: bytesToHex(serializeTransaction(tx)) };
}

test('every settlement cohort settles as one transaction signed by both parties', () => {
  for (const name of SETTLED) {
    const v = find(name);
    const verdict = verifySwapSignedTransaction(settle(v), v.acceptance, v.intent);
    assert.equal(verdict.ok, true, `${name}: ${verdict.reason}`);
    assert.match(verdict.txid, /^[0-9a-f]{64}$/);
  }
});

test('a settlement missing a party signature, re-signed, or altered is refused', () => {
  const v = find('an inscription for BTC settles with the inscription at the taker');
  assert.equal(verifySwapSignedTransaction(settle(v, { skip: [1] }), v.acceptance, v.intent).code, 'SIGNATURE_MISSING');
  assert.equal(verifySwapSignedTransaction(settle(v, { hashTypes: { 0: 0x81 } }), v.acceptance, v.intent).code, 'UNCLOSED_SIGHASH');
  assert.equal(
    verifySwapSignedTransaction(
      settle(v, { tamper: (tx) => (tx.outputs[2].valueSats = '9399') }),
      v.acceptance,
      v.intent
    ).code,
    'TRANSACTION_CHANGED'
  );
  const wrong = settle(v);
  wrong.acceptanceDigest = '0'.repeat(64);
  assert.equal(verifySwapSignedTransaction(wrong, v.acceptance, v.intent).code, 'ACCEPTANCE_DIGEST_MISMATCH');
  const forged = settle(v, { tamper: (tx) => (tx.inputs[0].witness = [`${'11'.repeat(64)}`]) });
  assert.equal(verifySwapSignedTransaction(forged, v.acceptance, v.intent).code, 'SIGNATURE_INVALID');
});
