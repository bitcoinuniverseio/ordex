import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { safeopsPlanDigest, verifySafeOpsPlan, verifySafeOpsSignedResult } from '../dist/index.js';

// OX-P01 protocol safety (SDK port): each asset family moves by its own rule, and the
// P-R01 to P-R04 counterexamples from the handoff are refused.

const vectors = JSON.parse(
  await readFile(fileURLToPath(new URL('../../conformance/safeops-vectors.json', import.meta.url)), 'utf8')
).cases;
const vector = (name) => structuredClone(vectors.find((v) => v.name === name));
const redigest = (plan) => {
  plan.digest = safeopsPlanDigest(plan);
  return plan;
};
const INSCRIPTION = 'e'.repeat(64) + 'i0';
const P2TR = '5120' + 'a'.repeat(64);

function inscriptionPlan(inputValues, carrier, offset, outputValues, toOutput) {
  const plan = vector('an inscription at offset 0 moves with the first sat of its input').plan;
  plan.inputs = inputValues.map((value, i) => ({
    outpoint: { txid: String(i + 1).repeat(64).slice(0, 64), vout: i },
    valueSats: String(value),
    scriptPubKeyHex: P2TR,
    sequence: 0xfffffffd,
    inventory: i === carrier ? { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION, offset: String(offset) }] } : { examined: true },
  }));
  plan.outputs = outputValues.map((value) => ({ scriptHex: P2TR, valueSats: String(value), role: 'recipient' }));
  const fee = inputValues.reduce((a, b) => a + b, 0) - outputValues.reduce((a, b) => a + b, 0);
  plan.fee = { feeSats: String(fee), maxFeeSats: String(fee), feeRateSatsPerVb: '1' };
  plan.signing = { requiredIndexes: inputValues.map((_, i) => i), sighashType: 'DEFAULT' };
  plan.assetTransitions = [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: carrier, toOutput, quantity: '1' }];
  return redigest(plan);
}

test('P-R01: an inscription lands in the output holding its absolute sat, across seeded layouts', () => {
  let seed = 7;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let checked = 0;
  for (let round = 0; round < 300; round += 1) {
    const inputValues = Array.from({ length: 1 + next(3) }, () => 1000 + next(4000));
    const carrier = next(inputValues.length);
    const offset = next(inputValues[carrier]);
    const total = inputValues.reduce((a, b) => a + b, 0);
    const outputValues = [];
    let left = total - 200;
    while (left > 0) {
      const value = Math.min(left, 600 + next(3000));
      if (left - value > 0 && left - value < 600) {
        outputValues.push(left);
        break;
      }
      outputValues.push(value);
      left -= value;
    }
    // Where the sat really goes, computed independently of the verifier.
    const absolute = inputValues.slice(0, carrier).reduce((a, b) => a + b, 0) + offset;
    let destination = -1;
    for (let j = 0, end = 0; j < outputValues.length; j += 1) {
      end += outputValues[j];
      if (absolute < end) {
        destination = j;
        break;
      }
    }
    for (let toOutput = 0; toOutput < outputValues.length; toOutput += 1) {
      const verdict = verifySafeOpsPlan(inscriptionPlan(inputValues, carrier, offset, outputValues, toOutput));
      if (destination === -1) {
        assert.equal(verdict.code, 'ASSET_TO_FEE');
      } else if (toOutput === destination) {
        assert.equal(verdict.ok, true, verdict.reason);
      } else {
        assert.equal(verdict.code, 'TRANSITION_MISMATCH');
      }
      checked += 1;
    }
  }
  assert.ok(checked > 300);
});

test('P-R02: a zero-sat runestone is a data output, never dust, and only with a proved allocation', () => {
  assert.equal(verifySafeOpsPlan(vector('P-R02: a zero-sat runestone with a proved allocation is accepted').plan).ok, true);
  // The same runestone without any rune input has nothing to prove.
  const plan = vector('a cardinal batch send plan with examined inputs is accepted').plan;
  plan.outputs = [{ scriptHex: '6a5d0800c0a23301f40301', valueSats: '0', role: 'data' }, ...plan.outputs];
  assert.equal(verifySafeOpsPlan(redigest(plan)).code, 'DATA_OUTPUT_NOT_PERMITTED');
});

test('P-R03 and P-R04: null or hostile shapes answer with stable refusals', () => {
  const base = () => vector('a cardinal batch send plan with examined inputs is accepted').plan;
  const cases = [
    [(p) => (p.signing = null), 'SIGNING_INVALID'],
    [(p) => (p.signing = []), 'SIGNING_INVALID'],
    [(p) => (p.signing = { requiredIndexes: [0, 0, 1], sighashType: 'DEFAULT' }), 'SIGNING_INVALID'],
    [(p) => (p.inputs[1].outpoint = structuredClone(p.inputs[0].outpoint)), 'INPUT_DUPLICATED'],
    [(p) => (p.inputs[0].inventory = null), 'INVENTORY_UNEXAMINED'],
    [(p) => (p.inputs[0].inventory = { examined: true, inscriptions: 'none' }), 'INVENTORY_INVALID'],
    [(p) => (p.inputs[0].inventory = { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION, offset: '50000' }] }), 'INVENTORY_INVALID'],
    [(p) => (p.inputs[0].sequence = -1), 'INPUT_SEQUENCE_INVALID'],
    [(p) => (p.inputs[0].scriptPubKeyHex = undefined), 'INPUT_SCRIPT_INVALID'],
    [(p) => (p.assetTransitions = null), 'MALFORMED_PLAN'],
    [(p) => (p.assetTransitions = [null]), 'TRANSITION_INVALID'],
  ];
  for (const [mutate, code] of cases) {
    const plan = base();
    mutate(plan);
    assert.equal(verifySafeOpsPlan(redigest(plan)).code, code, code);
  }
});

test('a transition for an asset no input carries is refused', () => {
  const plan = vector('a cardinal batch send plan with examined inputs is accepted').plan;
  plan.operationKind = 'RECOVERY';
  plan.assetTransitions = [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 0, quantity: '1' }];
  assert.equal(verifySafeOpsPlan(redigest(plan)).code, 'TRANSITION_UNEXPECTED');
  plan.assetTransitions = [{ assetType: 'RUNE', assetId: '840000:1', toOutput: 0, quantity: '1' }];
  assert.equal(verifySafeOpsPlan(redigest(plan)).code, 'TRANSITION_UNEXPECTED');
});

test('runes: a cenotaph, an extra OP_RETURN and an oversized runestone are refused', () => {
  const rune = () => vector('P-R02: a zero-sat runestone with a proved allocation is accepted').plan;
  const cenotaph = rune();
  cenotaph.outputs[0].scriptHex = '6a5d027e01';
  assert.equal(verifySafeOpsPlan(redigest(cenotaph)).code, 'CENOTAPH_BURNS_BALANCE');

  const twoData = rune();
  twoData.outputs.push({ scriptHex: '6a0401020304', valueSats: '0', role: 'data' });
  assert.equal(verifySafeOpsPlan(redigest(twoData)).code, 'DATA_OUTPUT_NOT_PERMITTED');

  const oversized = rune();
  oversized.outputs[0].scriptHex = `6a5d4c52${'7f00'.repeat(41)}`;
  assert.equal(verifySafeOpsPlan(redigest(oversized)).code, 'DATA_OUTPUT_NONSTANDARD');
});

test('Counterparty: a spend Counterparty finds no destination in detaches, and is refused', () => {
  const plan = vector('a Counterparty attachment moves to the first spendable output').plan;
  // A one-byte push of 0x6a is spendable, but Counterparty passes over it as
  // OP_RETURN, so the attachment would detach to its owner instead of moving.
  plan.outputs = [{ scriptHex: '016a', valueSats: '69400', role: 'recipient' }];
  plan.assetTransitions = [];
  assert.equal(verifySafeOpsPlan(redigest(plan)).code, 'COUNTERPARTY_NOT_MOVED');
});

test('a signed result is proved from its bytes: any flipped signature bit is refused', () => {
  const accepted = vectors.filter((v) => v.signed && v.expected.ok);
  assert.ok(accepted.length >= 2);
  for (const v of accepted) {
    assert.equal(verifySafeOpsSignedResult(v.signed, v.plan).ok, true, v.name);
    const hex = v.signed.signedTxHex;
    // Flip one bit inside the last witness item of input 0's signature.
    const signatureStart = hex.length - 8 - 2 * 60;
    const flipped = hex.slice(0, signatureStart) + ((Number.parseInt(hex[signatureStart], 16) ^ 1).toString(16)) + hex.slice(signatureStart + 1);
    const verdict = verifySafeOpsSignedResult({ ...v.signed, signedTxHex: flipped }, v.plan);
    assert.equal(verdict.ok, false, v.name);
  }
  const v1 = { schema: 'ordex.safeops-signed-result/v1', planDigest: accepted[0].plan.digest, tx: { inputs: [], outputs: [] } };
  assert.equal(verifySafeOpsSignedResult(v1, accepted[0].plan).code, 'SCHEMA_UNSUPPORTED');
});
