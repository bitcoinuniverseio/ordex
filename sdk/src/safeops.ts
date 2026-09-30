/**
 * The SafeOps rules from spec/safeops.md, typed.
 *
 * This is the same verifier as verifier/safeops.js at the repository root,
 * ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/safeops-vectors.json, so they cannot drift apart
 * without a test failing.
 *
 * Every amount is an atomic integer carried as a decimal string and handled
 * as BigInt. Floating point never appears here.
 */

import { createHash } from 'node:crypto';

import {
  MAX_OP_RETURN_RELAY_BYTES,
  bytesToHex,
  dustThresholdSats,
  parseTransaction,
  serializeTransaction,
  unsignedCopy,
  verifyInputSignature,
  type Transaction,
} from './bitcoin-tx.js';
import {
  checkTransitionShapes,
  deriveAssetFlow,
  matchTransitions,
  readInventory,
  type InventoryAsset,
  type StatedTransition,
} from './asset-flow.js';

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

/** Parse an exact non-negative decimal string into a bigint, or null. */
export function parseSats(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

/** Serialize any JSON value with object keys sorted recursively. */
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface SafeOpsOutpoint {
  txid?: unknown;
  vout?: unknown;
}

export interface SafeOpsInventory {
  examined?: unknown;
  /** [{ inscriptionId, offset, satpoint? }] */
  inscriptions?: unknown[];
  /** [{ runeId, amount }] exact balances */
  runeAllocations?: unknown[];
  /** [{ name, assetId, quantitySats }] */
  counterpartyAssets?: unknown[];
  /** [{ rangeId, offset, count }] */
  rareSatRanges?: unknown[];
  unknownClaims?: unknown[];
}

export interface SafeOpsInput {
  outpoint?: SafeOpsOutpoint;
  valueSats?: unknown;
  scriptPubKeyHex?: unknown;
  sequence?: unknown;
  inventory?: SafeOpsInventory;
}

export interface SafeOpsOutput {
  scriptHex?: unknown;
  valueSats?: unknown;
  role?: unknown;
}

export interface SafeOpsAssetTransition {
  assetType?: unknown;
  assetId?: unknown;
  fromInput?: unknown;
  toOutput?: unknown;
  quantity?: unknown;
}

export interface SafeOpsFee {
  feeSats?: unknown;
  maxFeeSats?: unknown;
  feeRateSatsPerVb?: unknown;
}

export interface SafeOpsCheckpoint {
  height?: unknown;
  blockHash?: unknown;
}

export interface SafeOpsSigning {
  requiredIndexes?: unknown[];
  sighashType?: unknown;
}

export interface SafeOpsTransaction {
  version?: unknown;
  lockTime?: unknown;
}

export interface SafeOpsPlan {
  schema?: unknown;
  protocolVersion?: unknown;
  network?: unknown;
  operationKind?: unknown;
  createdAtHeight?: unknown;
  expiryHeight?: unknown;
  checkpoint?: SafeOpsCheckpoint;
  transaction?: SafeOpsTransaction;
  inputs?: SafeOpsInput[];
  outputs?: SafeOpsOutput[];
  assetTransitions?: SafeOpsAssetTransition[];
  fee?: SafeOpsFee;
  signing?: SafeOpsSigning | null;
  findings?: unknown[];
  digest?: unknown;
  [key: string]: unknown;
}

export interface SafeOpsSignedResult {
  schema?: unknown;
  planDigest?: unknown;
  /** The complete signed transaction, lowercase hex. */
  signedTxHex?: unknown;
  [key: string]: unknown;
}

/**
 * SHA-256 over the binding content of a plan: everything except the digest
 * itself and the human oriented findings. Lowercase hex.
 */
export function safeopsPlanDigest(plan: SafeOpsPlan): string {
  const binding: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key === 'digest' || key === 'findings') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}

export type SafeOpsPlanRefusalCode =
  | 'MALFORMED_PLAN'
  | 'SCHEMA_UNSUPPORTED'
  | 'PROTOCOL_UNSUPPORTED'
  | 'NETWORK_UNKNOWN'
  | 'OPERATION_KIND_UNKNOWN'
  | 'INPUTS_EMPTY'
  | 'CHECKPOINT_INVALID'
  | 'EXPIRY_INVALID'
  | 'TRANSACTION_INVALID'
  | 'FEE_INVALID'
  | 'INPUT_OUTPOINT_INVALID'
  | 'INPUT_DUPLICATED'
  | 'INPUT_VALUE_INVALID'
  | 'INPUT_SCRIPT_INVALID'
  | 'INPUT_SEQUENCE_INVALID'
  | 'INVENTORY_UNEXAMINED'
  | 'INVENTORY_INVALID'
  | 'ASSET_IN_CARDINAL_OPERATION'
  | 'RUNE_INPUT_MISSING_ALLOCATION'
  | 'OUTPUT_SCRIPT_INVALID'
  | 'OUTPUT_VALUE_INVALID'
  | 'OUTPUT_ROLE_UNKNOWN'
  | 'DATA_OUTPUT_ROLE_MISMATCH'
  | 'DATA_OUTPUT_BURNS_VALUE'
  | 'DATA_OUTPUT_NOT_PERMITTED'
  | 'DATA_OUTPUT_NONSTANDARD'
  | 'DUST_OUTPUT'
  | 'VALUE_NOT_CONSERVED'
  | 'UNKNOWN_CLAIM_FAILS_CLOSED'
  | 'ASSET_TO_FEE'
  | 'RARE_SAT_RANGE_SPLIT'
  | 'POSTAGE_BELOW_FLOOR'
  | 'TRANSITION_INVALID'
  | 'TRANSITION_OUTPUT_MISSING'
  | 'TRANSITION_MISMATCH'
  | 'TRANSITION_UNEXPECTED'
  | 'TRACKED_ASSET_UNASSIGNED'
  | 'COUNTERPARTY_NOT_MOVED'
  | 'SIGNING_INVALID'
  | 'SIGHASH_NOT_PERMITTED'
  | 'DIGEST_MISMATCH'
  // Rune allocation and Counterparty move refusals pass through unchanged.
  | 'ALLOCATION_BURNS_BALANCE'
  | 'CENOTAPH_BURNS_BALANCE'
  | 'RUNE_ALLOCATION_MISMATCH'
  | 'RUNE_MINT_UNRESOLVED'
  | 'MALFORMED_RUNE_BALANCE'
  | 'MALFORMED_RUNE_EXPECTATION'
  | 'RUNE_INPUT_UNPROVEN'
  | 'MALFORMED_OUTPUT_SCRIPT'
  | 'RUNE_BALANCES_REQUIRED'
  | 'RUNE_OUTPUTS_INCOMPLETE'
  | 'BURN_PATH_WITH_UNPROVEN_INPUT'
  | 'CENOTAPH_WITH_UNPROVEN_INPUT'
  | 'INPUT_ATTACHMENTS_UNKNOWN'
  | 'CONTEXT_INVALID'
  | 'UTXO_SUPPORT_INACTIVE'
  | 'OUTPOINT_DUPLICATED'
  | 'MALFORMED_TRANSACTION';

export type SafeOpsPlanVerdict =
  | { ok: true; digest: string }
  | { ok: false; code: SafeOpsPlanRefusalCode; reason: string };

const refuse = (code: SafeOpsPlanRefusalCode, reason: string): { ok: false; code: SafeOpsPlanRefusalCode; reason: string } => ({
  ok: false,
  code,
  reason,
});

function validOutpoint(outpoint: SafeOpsOutpoint | undefined): outpoint is { txid: string; vout: number } {
  return (
    !!outpoint &&
    typeof outpoint.txid === 'string' &&
    HEX64.test(outpoint.txid) &&
    typeof outpoint.vout === 'number' &&
    Number.isInteger(outpoint.vout) &&
    outpoint.vout >= 0
  );
}

const isU32 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= U32_MAX;
const isOpReturn = (scriptHex: string): boolean => scriptHex.startsWith('6a');

/**
 * Verify a SafeOps plan. Answers { ok: true, digest } or a refusal.
 */
// OX-P01: every asset family moves by its own protocol rule. Inscriptions and rare
// sats follow the absolute sat position (prior input values plus offset), runes the
// ord 0.29.0 allocation, and Counterparty attachments the Core v11.4.0 move rule, and
// the plan's transitions must equal that derived multiset exactly. A zero-value
// OP_RETURN is allowed only as the one runestone whose allocation is proved, and
// dust follows Bitcoin Core v29 per script while postage is a separate product rule.
export function verifySafeOpsPlan(plan: SafeOpsPlan): SafeOpsPlanVerdict {
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
  const inputs = plan.inputs;
  const outputs = plan.outputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return refuse('INPUTS_EMPTY', 'A plan must select at least one input.');
  }
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return refuse('MALFORMED_PLAN', 'Expected a non-empty outputs array.');
  }
  const checkpoint = plan.checkpoint;
  if (
    !checkpoint ||
    typeof checkpoint.height !== 'number' ||
    !Number.isInteger(checkpoint.height) ||
    checkpoint.height < 0 ||
    typeof checkpoint.blockHash !== 'string' ||
    !HEX64.test(checkpoint.blockHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The plan must carry the chain checkpoint it was built against.');
  }
  const checkpointHeight = checkpoint.height;
  if (typeof plan.expiryHeight !== 'number' || !Number.isInteger(plan.expiryHeight) || plan.expiryHeight <= checkpointHeight) {
    return refuse('EXPIRY_INVALID', 'The expiry height must be a block after the checkpoint height.');
  }
  const transaction = plan.transaction;
  if (!transaction || typeof transaction !== 'object' || !isU32(transaction.version) || transaction.version < 1 || !isU32(transaction.lockTime)) {
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

  let totalIn = 0n;
  const inputValues: bigint[] = [];
  const inputAssets: InventoryAsset[][] = [];
  const outpoints = new Set<string>();
  const assetIds = new Set<string>();
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i] as SafeOpsInput;
    const outpoint = input?.outpoint;
    if (!validOutpoint(outpoint)) {
      return refuse('INPUT_OUTPOINT_INVALID', `Input ${i} does not carry a lowercase txid and vout.`);
    }
    const key = `${outpoint.txid}:${outpoint.vout}`;
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
    const read = readInventory(input.inventory, i, value, outpoint);
    if (!('assets' in read)) return refuse(read.code as SafeOpsPlanRefusalCode, read.reason);
    for (const asset of read.assets) {
      if (asset.assetType === 'RUNE' || asset.assetType === 'COUNTERPARTY') continue;
      const id = `${asset.assetType}:${asset.assetId}`;
      if (assetIds.has(id)) return refuse('INVENTORY_INVALID', `${id} is listed on more than one input.`);
      assetIds.add(id);
    }
    const first = read.assets[0];
    if (CARDINAL_ONLY_KINDS.includes(plan.operationKind) && first) {
      return refuse(
        'ASSET_IN_CARDINAL_OPERATION',
        `Input ${i} carries ${first.assetType} ${first.assetId}; this operation moves cardinal value only.`
      );
    }
    // D7: a rune transfer may be funded by cardinal inputs that carry no tracked
    // asset, so a rune on a dust output can move; an input with other assets and
    // no rune allocation is refused, and some input must carry a rune allocation.
    if (plan.operationKind === 'RUNE_BATCH_TRANSFER' && first && !read.assets.some((a) => a.assetType === 'RUNE')) {
      return refuse(
        'RUNE_INPUT_MISSING_ALLOCATION',
        `Input ${i} carries ${first.assetType} ${first.assetId} but no rune allocation; a rune transfer is funded only by rune inputs or asset-free inputs.`,
      );
    }
    inputValues.push(value);
    inputAssets.push(read.assets);
    totalIn += value;
  }
  if (
    plan.operationKind === 'RUNE_BATCH_TRANSFER' &&
    !inputAssets.some((assets) => assets.some((a) => a.assetType === 'RUNE'))
  ) {
    return refuse('RUNE_INPUT_MISSING_ALLOCATION', 'No input carries a rune allocation, so there is no rune to transfer.');
  }

  let totalOut = 0n;
  const outputValues: bigint[] = [];
  const dataOutputs: number[] = [];
  const scripts: string[] = [];
  for (let i = 0; i < outputs.length; i += 1) {
    const output = outputs[i] as SafeOpsOutput;
    if (typeof output?.scriptHex !== 'string' || !EVEN_HEX.test(output.scriptHex)) {
      return refuse('OUTPUT_SCRIPT_INVALID', `Output ${i} does not carry lowercase hex script bytes.`);
    }
    const scriptHex = output.scriptHex;
    const value = parseSats(output.valueSats);
    if (value === null) {
      return refuse('OUTPUT_VALUE_INVALID', `Output ${i} does not carry an exact decimal value.`);
    }
    if (typeof output.role !== 'string' || !OUTPUT_ROLES.includes(output.role)) {
      return refuse('OUTPUT_ROLE_UNKNOWN', `Output ${i} does not name a recipient, change, preserve, or data role.`);
    }
    if ((output.role === 'data') !== isOpReturn(scriptHex)) {
      return refuse('DATA_OUTPUT_ROLE_MISMATCH', `Output ${i}: an OP_RETURN output is a data output and a data output is an OP_RETURN.`);
    }
    const dust = dustThresholdSats(scriptHex) ?? 0n;
    if (output.role === 'data') {
      if (value !== 0n) return refuse('DATA_OUTPUT_BURNS_VALUE', `Output ${i} would burn ${String(output.valueSats)} sats in an OP_RETURN.`);
      dataOutputs.push(i);
    } else if (value < dust) {
      return refuse('DUST_OUTPUT', `Output ${i} holds ${String(output.valueSats)} sats, below the ${dust} sat dust threshold for its script.`);
    }
    outputValues.push(value);
    scripts.push(scriptHex);
    totalOut += value;
  }

  if (totalIn !== totalOut + declaredFee) {
    return refuse(
      'VALUE_NOT_CONSERVED',
      'The inputs do not equal the outputs plus the declared fee, so the plan cannot be built as written.'
    );
  }

  const carriesRunes = inputAssets.some((assets) => assets.some((a) => a.assetType === 'RUNE'));
  const firstData = dataOutputs[0];
  if (firstData !== undefined) {
    const script = scripts[firstData] as string;
    // A cenotaph passes this gate so the allocation below names its burn.
    if (dataOutputs.length > 1 || !carriesRunes || !script.startsWith('6a5d')) {
      return refuse('DATA_OUTPUT_NOT_PERMITTED', 'The only data output a plan may carry is one readable runestone for the runes it moves.');
    }
    if (script.length / 2 > MAX_OP_RETURN_RELAY_BYTES) {
      return refuse('DATA_OUTPUT_NONSTANDARD', `The runestone exceeds the ${MAX_OP_RETURN_RELAY_BYTES} byte relay limit.`);
    }
  }

  const transitions = plan.assetTransitions;
  if (!Array.isArray(transitions)) return refuse('MALFORMED_PLAN', 'Expected an assetTransitions array.');
  const shapes = checkTransitionShapes(transitions, outputs.length);
  if (!shapes.ok) return refuse(shapes.code as SafeOpsPlanRefusalCode, shapes.reason);

  // Derive every asset movement from the protocol rules, then require the
  // plan's transitions to be exactly that multiset.
  const flow = deriveAssetFlow({
    network: plan.network,
    height: checkpointHeight + 1,
    inputs: inputs.map((input, i) => ({
      outpoint: input.outpoint as { txid: string; vout: number },
      value: inputValues[i] as bigint,
      assets: inputAssets[i] as InventoryAsset[],
    })),
    outputs: scripts.map((scriptHex, i) => ({ scriptHex, valueSats: (outputValues[i] as bigint).toString() })),
  });
  if (!flow.ok) return refuse(flow.code as SafeOpsPlanRefusalCode, flow.reason);
  for (const m of flow.movements) {
    if ((m.assetType === 'ORDINAL' || m.assetType === 'RARE_SAT') && (outputValues[m.toOutput] ?? 0n) < BigInt(SAFEOPS_POSTAGE_FLOOR_SATS)) {
      return refuse('POSTAGE_BELOW_FLOOR', `Output ${m.toOutput} carries ${m.assetId} with less than the ${SAFEOPS_POSTAGE_FLOOR_SATS} sat postage floor.`);
    }
  }
  const matched = matchTransitions(transitions as StatedTransition[], flow.movements);
  if (!matched.ok) return refuse(matched.code as SafeOpsPlanRefusalCode, matched.reason);

  const signing = plan.signing;
  if (!signing || typeof signing !== 'object' || Array.isArray(signing)) {
    return refuse('SIGNING_INVALID', 'The plan must carry a signing object.');
  }
  const indexes = signing.requiredIndexes;
  if (!Array.isArray(indexes)) {
    return refuse('SIGNING_INVALID', 'The plan must list its required signing indexes.');
  }
  const required = new Set(indexes);
  if (
    required.size !== indexes.length ||
    indexes.some((index) => typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= inputs.length) ||
    required.size !== inputs.length
  ) {
    return refuse('SIGNING_INVALID', 'The user signs every selected input exactly once; list each input index once.');
  }
  if (typeof signing.sighashType !== 'string' || !SIGHASH_POLICIES.includes(signing.sighashType)) {
    return refuse('SIGHASH_NOT_PERMITTED', 'SafeOps signs with SIGHASH_ALL or the Taproot default only, so no input or output can change after signing.');
  }

  const digest = safeopsPlanDigest(plan);
  if (plan.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The plan digest does not match its binding content.');
  }
  return { ok: true, digest };
}

/** The exact unsigned transaction a verified plan describes. */
export function safeopsUnsignedTransaction(plan: SafeOpsPlan): Transaction {
  const transaction = plan.transaction as { version: number; lockTime: number };
  return {
    version: transaction.version,
    lockTime: transaction.lockTime,
    inputs: (plan.inputs ?? []).map((input) => ({
      txid: input.outpoint?.txid as string,
      vout: input.outpoint?.vout as number,
      scriptSigHex: '',
      sequence: input.sequence as number,
      witness: [],
    })),
    outputs: (plan.outputs ?? []).map((output) => ({ valueSats: output.valueSats as string, scriptHex: output.scriptHex as string })),
  };
}

export type SafeOpsSignedResultRefusalCode =
  | SafeOpsPlanRefusalCode
  | 'MALFORMED_SIGNED_RESULT'
  | 'PLAN_DIGEST_MISMATCH'
  | 'TRANSACTION_CHANGED'
  | 'INPUT_SET_CHANGED'
  | 'INPUT_ORDER_CHANGED'
  | 'SEQUENCE_CHANGED'
  | 'OUTPUT_SET_CHANGED'
  | 'SCRIPT_CHANGED'
  | 'VALUE_CHANGED'
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_UNVERIFIABLE'
  | 'SIGNATURE_INVALID'
  | 'SIGHASH_CHANGED';

export type SafeOpsSignedResultVerdict =
  | { ok: true; txid: string }
  | { ok: false; code: SafeOpsSignedResultRefusalCode; reason: string };

const refuseSigned = (code: SafeOpsSignedResultRefusalCode, reason: string): SafeOpsSignedResultVerdict => ({
  ok: false,
  code,
  reason,
});

/**
 * Verify a signed SafeOps result against its plan. The transaction is read
 * from its bytes: exactly the plan's unsigned transaction plus witnesses, with
 * every input's signature verified against the plan's prevouts.
 */
// OX-P01: a signature is proved from the transaction bytes, never from a label. A
// signaturePresent flag in caller JSON proved nothing, so v2 results carry the raw
// signed transaction and every input's signature is checked cryptographically.
export function verifySafeOpsSignedResult(signed: SafeOpsSignedResult, plan: SafeOpsPlan): SafeOpsSignedResultVerdict {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    return refuseSigned('MALFORMED_SIGNED_RESULT', 'Expected a signed result object.');
  }
  if (signed.schema !== SAFEOPS_SIGNED_RESULT_SCHEMA) {
    return refuseSigned('SCHEMA_UNSUPPORTED', 'The signed result schema is not ordex.safeops-signed-result/v2.');
  }
  const planVerdict = verifySafeOpsPlan(plan);
  if (!planVerdict.ok) return planVerdict;

  if (signed.planDigest !== plan.digest) {
    return refuseSigned('PLAN_DIGEST_MISMATCH', 'The signed result was not produced from this plan. Refresh the plan and sign again.');
  }
  const parsed = parseTransaction(signed.signedTxHex);
  if (!parsed.ok) return refuseSigned('MALFORMED_SIGNED_RESULT', parsed.reason);
  const tx = parsed.tx;
  const expected = safeopsUnsignedTransaction(plan);

  if (tx.version !== expected.version || tx.lockTime !== expected.lockTime) {
    return refuseSigned('TRANSACTION_CHANGED', 'The signed transaction changed its version or locktime.');
  }
  if (tx.inputs.length !== expected.inputs.length) {
    return refuseSigned('INPUT_SET_CHANGED', 'The signed transaction does not spend exactly the planned inputs.');
  }
  for (let i = 0; i < expected.inputs.length; i += 1) {
    const actual = tx.inputs[i];
    const wanted = expected.inputs[i];
    if (!actual || !wanted || actual.txid !== wanted.txid || actual.vout !== wanted.vout) {
      return refuseSigned('INPUT_ORDER_CHANGED', `Input ${i} was reordered or substituted after the plan was agreed.`);
    }
    if (actual.sequence !== wanted.sequence) {
      return refuseSigned('SEQUENCE_CHANGED', `Input ${i} changed its sequence number.`);
    }
  }
  if (tx.outputs.length !== expected.outputs.length) {
    return refuseSigned('OUTPUT_SET_CHANGED', 'The signed transaction does not carry exactly the planned outputs.');
  }
  for (let i = 0; i < expected.outputs.length; i += 1) {
    const actual = tx.outputs[i];
    const wanted = expected.outputs[i];
    if (!actual || !wanted || actual.scriptHex !== wanted.scriptHex) {
      return refuseSigned('SCRIPT_CHANGED', `Output ${i} no longer pays the planned script.`);
    }
    if (actual.valueSats !== String(parseSats(wanted.valueSats))) {
      return refuseSigned('VALUE_CHANGED', `Output ${i} no longer carries its planned value.`);
    }
  }
  if (bytesToHex(serializeTransaction(unsignedCopy(tx))) !== bytesToHex(serializeTransaction(expected))) {
    return refuseSigned('TRANSACTION_CHANGED', 'The signed transaction is not the planned transaction.');
  }

  const prevouts = (plan.inputs ?? []).map((input) => ({
    valueSats: input.valueSats as string,
    scriptHex: input.scriptPubKeyHex as string,
  }));
  const sighashPolicy = (plan.signing as SafeOpsSigning).sighashType;
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const verdict = verifyInputSignature(tx, i, prevouts);
    if (verdict.status === 'UNSIGNED') {
      return refuseSigned('SIGNATURE_MISSING', `Input ${i} is required to sign and is still unsigned.`);
    }
    if (verdict.status === 'UNSUPPORTED') {
      return refuseSigned('SIGNATURE_UNVERIFIABLE', `Input ${i} spends a script this verifier cannot check, so its signature is unproven.`);
    }
    if (verdict.status !== 'VALID') {
      return refuseSigned('SIGNATURE_INVALID', `Input ${i} carries a signature that does not verify against the planned transaction.`);
    }
    const allowed = verdict.type === 'p2tr' && sighashPolicy === 'DEFAULT' ? 0x00 : 0x01;
    if (verdict.sighashType !== allowed) {
      return refuseSigned('SIGHASH_CHANGED', `Input ${i} was signed with a different sighash than the plan approved.`);
    }
  }

  return { ok: true, txid: parsed.txid };
}
