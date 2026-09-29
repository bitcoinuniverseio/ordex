// Reference verifier for Ordex SafeOps v2.
//
// This file restates spec/safeops.md as executable checks. It answers two
// questions about an already prepared operation: is the plan internally
// sound and asset safe, and does a signed transaction still match the plan
// the user agreed to. Reading live input values, protocol inventories, and
// mempool state from Bitcoin Core, ord, and the other chain authorities is
// the caller's responsibility; the gateway runs those reads first and then
// these same checks.
//
// Every amount is an atomic integer carried as a decimal string and handled
// as BigInt. Floating point never appears here.

import { createHash } from 'node:crypto';

import {
  MAX_OP_RETURN_RELAY_BYTES,
  bytesToHex,
  dustThresholdSats,
  parseTransaction,
  serializeTransaction,
  unsignedCopy,
  verifyInputSignature,
} from './bitcoin-tx.js';
import { checkTransitionShapes, deriveAssetFlow, matchTransitions, readInventory } from './asset-flow.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const NETWORKS = ['mainnet', 'testnet', 'testnet4', 'signet', 'regtest'];
const OPERATION_KINDS = [
  'BTC_BATCH_SEND',
  'ORDINAL_BATCH_TRANSFER',
  'RUNE_BATCH_TRANSFER',
  'CARDINAL_CONSOLIDATION',
  'SPLIT_AND_POSTAGE',
  'RECOVERY',
  'RBF_REPLACE',
  'CPFP_CHILD',
];
const OUTPUT_ROLES = ['recipient', 'change', 'preserve', 'data'];
const CARDINAL_ONLY_KINDS = ['BTC_BATCH_SEND', 'CARDINAL_CONSOLIDATION'];
const SIGHASH_POLICIES = ['DEFAULT', 'ALL'];
const U32_MAX = 0xffffffff;
export const SAFEOPS_PLAN_SCHEMA = 'ordex.safeops-plan/v2';
export const SAFEOPS_SIGNED_RESULT_SCHEMA = 'ordex.safeops-signed-result/v2';
export const SAFEOPS_PROTOCOL_MIN = '1.2';
/**
 * Ordex product postage: the least an output carrying a sat-bound asset (an
 * inscription or a rare sat range) may hold. A product rule, separate from the
 * script-specific Bitcoin Core dust threshold every spendable output meets.
 */
export const SAFEOPS_POSTAGE_FLOOR_SATS = '546';

export function parseSats(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

/** Serialize any JSON value with object keys sorted recursively. */
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 over the binding content of a plan: everything except the digest
 * itself and the human oriented findings. Lowercase hex.
 */
export function safeopsPlanDigest(plan) {
  const binding = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key === 'digest' || key === 'findings') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}

const refuse = (code, reason) => ({ ok: false, code, reason });

function validOutpoint(outpoint) {
  return (
    !!outpoint &&
    typeof outpoint.txid === 'string' &&
    HEX64.test(outpoint.txid) &&
    Number.isInteger(outpoint.vout) &&
    outpoint.vout >= 0
  );
}

const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= U32_MAX;
const isOpReturn = (scriptHex) => scriptHex.startsWith('6a');

/**
 * Verify a SafeOps plan.
 *
 * plan:
 *   schema, protocolVersion, network, operationKind, createdAtHeight,
 *   expiryHeight, checkpoint { height, blockHash },
 *   transaction { version, lockTime },
 *   inputs  [{ outpoint {txid, vout}, valueSats, scriptPubKeyHex, sequence,
 *             inventory { examined, inscriptions [{ inscriptionId, offset }],
 *             rareSatRanges [{ rangeId, offset, count }],
 *             runeAllocations [{ runeId, amount }],
 *             counterpartyAssets [{ name, assetId, quantitySats }],
 *             unknownClaims [] } }],
 *   outputs [{ scriptHex, valueSats, role }],
 *   assetTransitions [{ assetType, assetId, fromInput?, toOutput, quantity }],
 *   fee { feeSats, maxFeeSats, feeRateSatsPerVb },
 *   signing { requiredIndexes [], sighashType },
 *   findings [], digest
 *
 * Answers { ok: true, digest } or { ok: false, code, reason }.
 */
// OX-P01: every asset family moves by its own protocol rule. Inscriptions and rare
// sats follow the absolute sat position (prior input values plus offset), runes the
// ord 0.29.0 allocation, and Counterparty attachments the Core v11.4.0 move rule, and
// the plan's transitions must equal that derived multiset exactly. A zero-value
// OP_RETURN is allowed only as the one runestone whose allocation is proved, and
// dust follows Bitcoin Core v29 per script while postage is a separate product rule.
export function verifySafeOpsPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return refuse('MALFORMED_PLAN', 'Expected a plan object.');
  }
  if (plan.schema !== SAFEOPS_PLAN_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The plan schema is not ordex.safeops-plan/v2. Replan an older plan; it is never reinterpreted.');
  }
  if (typeof plan.protocolVersion !== 'string' || !/^1\.[2-9][0-9]*$/.test(plan.protocolVersion)) {
    return refuse('PROTOCOL_UNSUPPORTED', 'The plan protocol version must be 1.2 or a later 1.x.');
  }
  if (typeof plan.network !== 'string' || !NETWORKS.includes(plan.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof plan.operationKind !== 'string' || !OPERATION_KINDS.includes(plan.operationKind)) {
    return refuse('OPERATION_KIND_UNKNOWN', 'The operation kind is not one this protocol names.');
  }
  if (!Array.isArray(plan.inputs) || plan.inputs.length === 0) {
    return refuse('INPUTS_EMPTY', 'A plan must select at least one input.');
  }
  if (!Array.isArray(plan.outputs) || plan.outputs.length === 0) {
    return refuse('MALFORMED_PLAN', 'Expected a non-empty outputs array.');
  }
  if (
    !plan.checkpoint ||
    !Number.isInteger(plan.checkpoint.height) ||
    plan.checkpoint.height < 0 ||
    typeof plan.checkpoint.blockHash !== 'string' ||
    !HEX64.test(plan.checkpoint.blockHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The plan must carry the chain checkpoint it was built against.');
  }
  if (!Number.isInteger(plan.expiryHeight) || plan.expiryHeight <= plan.checkpoint.height) {
    return refuse('EXPIRY_INVALID', 'The expiry height must be a block after the checkpoint height.');
  }
  if (
    !plan.transaction ||
    typeof plan.transaction !== 'object' ||
    !isU32(plan.transaction.version) ||
    plan.transaction.version < 1 ||
    !isU32(plan.transaction.lockTime)
  ) {
    return refuse('TRANSACTION_INVALID', 'The plan must fix the transaction version and locktime it will sign.');
  }
  if (!plan.fee || typeof plan.fee !== 'object') {
    return refuse('FEE_INVALID', 'The plan must carry a fee object.');
  }
  const declaredFee = parseSats(plan.fee.feeSats);
  const maxFee = parseSats(plan.fee.maxFeeSats);
  if (declaredFee === null || maxFee === null || declaredFee > maxFee) {
    return refuse('FEE_INVALID', 'feeSats and maxFeeSats must be exact decimal strings and fee <= maxFee.');
  }

  // Every selected input is a distinct outpoint with its value, script,
  // sequence and an examined inventory. An input whose inventory was never
  // examined is refused, never assumed cardinal.
  let totalIn = 0n;
  const inputValues = [];
  const inputAssets = [];
  const outpoints = new Set();
  const assetIds = new Set();
  for (let i = 0; i < plan.inputs.length; i += 1) {
    const input = plan.inputs[i];
    if (!validOutpoint(input && input.outpoint)) {
      return refuse('INPUT_OUTPOINT_INVALID', `Input ${i} does not carry a lowercase txid and vout.`);
    }
    const key = `${input.outpoint.txid}:${input.outpoint.vout}`;
    if (outpoints.has(key)) return refuse('INPUT_DUPLICATED', `Input ${i} spends ${key} a second time.`);
    outpoints.add(key);
    const value = parseSats(input.valueSats);
    if (value === null) {
      return refuse('INPUT_VALUE_INVALID', `Input ${i} does not carry an exact decimal value.`);
    }
    if (typeof input.scriptPubKeyHex !== 'string' || !EVEN_HEX.test(input.scriptPubKeyHex)) {
      return refuse('INPUT_SCRIPT_INVALID', `Input ${i} does not carry the script of the output it spends.`);
    }
    if (!isU32(input.sequence)) {
      return refuse('INPUT_SEQUENCE_INVALID', `Input ${i} does not fix its sequence number.`);
    }
    const read = readInventory(input.inventory, i, value, input.outpoint);
    if (!read.assets) return read;
    for (const asset of read.assets) {
      if (asset.assetType === 'RUNE' || asset.assetType === 'COUNTERPARTY') continue;
      const id = `${asset.assetType}:${asset.assetId}`;
      if (assetIds.has(id)) return refuse('INVENTORY_INVALID', `${id} is listed on more than one input.`);
      assetIds.add(id);
    }
    if (CARDINAL_ONLY_KINDS.includes(plan.operationKind) && read.assets.length > 0) {
      return refuse(
        'ASSET_IN_CARDINAL_OPERATION',
        `Input ${i} carries ${read.assets[0].assetType} ${read.assets[0].assetId}; this operation moves cardinal value only.`,
      );
    }
    if (plan.operationKind === 'RUNE_BATCH_TRANSFER' && !read.assets.some((a) => a.assetType === 'RUNE')) {
      return refuse('RUNE_INPUT_MISSING_ALLOCATION', `Input ${i} carries no rune allocation.`);
    }
    inputValues.push(value);
    inputAssets.push(read.assets);
    totalIn += value;
  }

  // Outputs: an OP_RETURN is only ever a declared data output of zero value;
  // every other output meets the Bitcoin Core dust threshold for its script.
  let totalOut = 0n;
  const outputValues = [];
  const dataOutputs = [];
  for (let i = 0; i < plan.outputs.length; i += 1) {
    const output = plan.outputs[i];
    if (typeof (output && output.scriptHex) !== 'string' || !EVEN_HEX.test(output.scriptHex)) {
      return refuse('OUTPUT_SCRIPT_INVALID', `Output ${i} does not carry lowercase hex script bytes.`);
    }
    const value = parseSats(output.valueSats);
    if (value === null) {
      return refuse('OUTPUT_VALUE_INVALID', `Output ${i} does not carry an exact decimal value.`);
    }
    if (typeof output.role !== 'string' || !OUTPUT_ROLES.includes(output.role)) {
      return refuse('OUTPUT_ROLE_UNKNOWN', `Output ${i} does not name a recipient, change, preserve, or data role.`);
    }
    if ((output.role === 'data') !== isOpReturn(output.scriptHex)) {
      return refuse('DATA_OUTPUT_ROLE_MISMATCH', `Output ${i}: an OP_RETURN output is a data output and a data output is an OP_RETURN.`);
    }
    if (output.role === 'data') {
      if (value !== 0n) return refuse('DATA_OUTPUT_BURNS_VALUE', `Output ${i} would burn ${output.valueSats} sats in an OP_RETURN.`);
      dataOutputs.push(i);
    } else if (value < dustThresholdSats(output.scriptHex)) {
      return refuse(
        'DUST_OUTPUT',
        `Output ${i} holds ${output.valueSats} sats, below the ${dustThresholdSats(output.scriptHex)} sat dust threshold for its script.`,
      );
    }
    outputValues.push(value);
    totalOut += value;
  }

  if (totalIn !== totalOut + declaredFee) {
    return refuse(
      'VALUE_NOT_CONSERVED',
      'The inputs do not equal the outputs plus the declared fee, so the plan cannot be built as written.',
    );
  }

  // The only data output a plan may carry is one runestone, and only for rune
  // balances whose allocation is proved below. Relay policy allows one
  // OP_RETURN of at most 83 bytes.
  const carriesRunes = inputAssets.some((assets) => assets.some((a) => a.assetType === 'RUNE'));
  const scripts = plan.outputs.map((o) => o.scriptHex);
  if (dataOutputs.length > 0) {
    const index = dataOutputs[0];
    // A cenotaph passes this gate so the allocation below names its burn.
    if (dataOutputs.length > 1 || !carriesRunes || !scripts[index].startsWith('6a5d')) {
      return refuse('DATA_OUTPUT_NOT_PERMITTED', 'The only data output a plan may carry is one readable runestone for the runes it moves.');
    }
    if (scripts[index].length / 2 > MAX_OP_RETURN_RELAY_BYTES) {
      return refuse('DATA_OUTPUT_NONSTANDARD', `The runestone exceeds the ${MAX_OP_RETURN_RELAY_BYTES} byte relay limit.`);
    }
  }

  const transitions = plan.assetTransitions;
  if (!Array.isArray(transitions)) return refuse('MALFORMED_PLAN', 'Expected an assetTransitions array.');
  const shapes = checkTransitionShapes(transitions, plan.outputs.length);
  if (!shapes.ok) return shapes;

  // Derive every asset movement from the protocol rules, then require the
  // plan's transitions to be exactly that multiset.
  const flow = deriveAssetFlow({
    network: plan.network,
    height: plan.checkpoint.height + 1,
    inputs: plan.inputs.map((input, i) => ({ outpoint: input.outpoint, value: inputValues[i], assets: inputAssets[i] })),
    outputs: plan.outputs,
  });
  if (!flow.ok) return flow;
  for (const m of flow.movements) {
    if ((m.assetType === 'ORDINAL' || m.assetType === 'RARE_SAT') && outputValues[m.toOutput] < BigInt(SAFEOPS_POSTAGE_FLOOR_SATS)) {
      return refuse('POSTAGE_BELOW_FLOOR', `Output ${m.toOutput} carries ${m.assetId} with less than the ${SAFEOPS_POSTAGE_FLOOR_SATS} sat postage floor.`);
    }
  }
  const matched = matchTransitions(transitions, flow.movements);
  if (!matched.ok) return matched;

  // The user signs every input, with SIGHASH_ALL or its Taproot default only.
  const signing = plan.signing;
  if (!signing || typeof signing !== 'object' || Array.isArray(signing)) {
    return refuse('SIGNING_INVALID', 'The plan must carry a signing object.');
  }
  if (!Array.isArray(signing.requiredIndexes)) {
    return refuse('SIGNING_INVALID', 'The plan must list its required signing indexes.');
  }
  const required = new Set(signing.requiredIndexes);
  if (
    required.size !== signing.requiredIndexes.length ||
    signing.requiredIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= plan.inputs.length) ||
    required.size !== plan.inputs.length
  ) {
    return refuse('SIGNING_INVALID', 'The user signs every selected input exactly once; list each input index once.');
  }
  if (!SIGHASH_POLICIES.includes(signing.sighashType)) {
    return refuse('SIGHASH_NOT_PERMITTED', 'SafeOps signs with SIGHASH_ALL or the Taproot default only, so no input or output can change after signing.');
  }

  const digest = safeopsPlanDigest(plan);
  if (plan.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The plan digest does not match its binding content.');
  }
  return { ok: true, digest };
}

/** The exact unsigned transaction a verified plan describes. */
export function safeopsUnsignedTransaction(plan) {
  return {
    version: plan.transaction.version,
    lockTime: plan.transaction.lockTime,
    inputs: plan.inputs.map((input) => ({
      txid: input.outpoint.txid,
      vout: input.outpoint.vout,
      scriptSigHex: '',
      sequence: input.sequence,
      witness: [],
    })),
    outputs: plan.outputs.map((output) => ({ valueSats: output.valueSats, scriptHex: output.scriptHex })),
  };
}

/**
 * Verify a signed SafeOps result against its plan.
 *
 * signed: { schema, planDigest, signedTxHex }
 *
 * The transaction is read from its bytes: it must be exactly the plan's
 * unsigned transaction plus witnesses, and every input must carry a signature
 * that verifies against the plan's prevouts under the approved sighash.
 */
// OX-P01: a signature is proved from the transaction bytes, never from a label. A
// signaturePresent flag in caller JSON proved nothing, so v2 results carry the raw
// signed transaction and every input's signature is checked cryptographically.
export function verifySafeOpsSignedResult(signed, plan) {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    return refuse('MALFORMED_SIGNED_RESULT', 'Expected a signed result object.');
  }
  if (signed.schema !== SAFEOPS_SIGNED_RESULT_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The signed result schema is not ordex.safeops-signed-result/v2.');
  }
  const planVerdict = verifySafeOpsPlan(plan);
  if (!planVerdict.ok) return planVerdict;

  if (signed.planDigest !== plan.digest) {
    return refuse(
      'PLAN_DIGEST_MISMATCH',
      'The signed result was not produced from this plan. Refresh the plan and sign again.',
    );
  }
  const parsed = parseTransaction(signed.signedTxHex);
  if (!parsed.ok) return refuse('MALFORMED_SIGNED_RESULT', parsed.reason);
  const tx = parsed.tx;
  const expected = safeopsUnsignedTransaction(plan);

  if (tx.version !== expected.version || tx.lockTime !== expected.lockTime) {
    return refuse('TRANSACTION_CHANGED', 'The signed transaction changed its version or locktime.');
  }
  if (tx.inputs.length !== expected.inputs.length) {
    return refuse('INPUT_SET_CHANGED', 'The signed transaction does not spend exactly the planned inputs.');
  }
  for (let i = 0; i < expected.inputs.length; i += 1) {
    const actual = tx.inputs[i];
    if (actual.txid !== expected.inputs[i].txid || actual.vout !== expected.inputs[i].vout) {
      return refuse('INPUT_ORDER_CHANGED', `Input ${i} was reordered or substituted after the plan was agreed.`);
    }
    if (actual.sequence !== expected.inputs[i].sequence) {
      return refuse('SEQUENCE_CHANGED', `Input ${i} changed its sequence number.`);
    }
  }
  if (tx.outputs.length !== expected.outputs.length) {
    return refuse('OUTPUT_SET_CHANGED', 'The signed transaction does not carry exactly the planned outputs.');
  }
  for (let i = 0; i < expected.outputs.length; i += 1) {
    if (tx.outputs[i].scriptHex !== expected.outputs[i].scriptHex) {
      return refuse('SCRIPT_CHANGED', `Output ${i} no longer pays the planned script.`);
    }
    if (tx.outputs[i].valueSats !== String(parseSats(expected.outputs[i].valueSats))) {
      return refuse('VALUE_CHANGED', `Output ${i} no longer carries its planned value.`);
    }
  }
  // With every field above equal, the unsigned bytes are the plan's bytes.
  if (bytesToHex(serializeTransaction(unsignedCopy(tx))) !== bytesToHex(serializeTransaction(expected))) {
    return refuse('TRANSACTION_CHANGED', 'The signed transaction is not the planned transaction.');
  }

  const prevouts = plan.inputs.map((input) => ({ valueSats: input.valueSats, scriptHex: input.scriptPubKeyHex }));
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const verdict = verifyInputSignature(tx, i, prevouts);
    if (verdict.status === 'UNSIGNED') {
      return refuse('SIGNATURE_MISSING', `Input ${i} is required to sign and is still unsigned.`);
    }
    if (verdict.status === 'UNSUPPORTED') {
      return refuse('SIGNATURE_UNVERIFIABLE', `Input ${i} spends a script this verifier cannot check, so its signature is unproven.`);
    }
    if (verdict.status !== 'VALID') {
      return refuse('SIGNATURE_INVALID', `Input ${i} carries a signature that does not verify against the planned transaction.`);
    }
    const allowed = verdict.type === 'p2tr' && plan.signing.sighashType === 'DEFAULT' ? 0x00 : 0x01;
    if (verdict.sighashType !== allowed) {
      return refuse('SIGHASH_CHANGED', `Input ${i} was signed with a different sighash than the plan approved.`);
    }
  }

  return { ok: true, txid: parsed.txid };
}
