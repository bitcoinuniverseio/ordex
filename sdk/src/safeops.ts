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
import { counterpartyMoveOutcome } from './counterparty.js';
import { verifyRuneAllocation } from './runes.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const RUNE_ID = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
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
const listOf = (value: unknown[] | undefined): unknown[] => (value === undefined ? [] : value);

type Asset =
  | { assetType: 'ORDINAL' | 'RARE_SAT'; assetId: string; offset: bigint; count: bigint }
  | { assetType: 'RUNE'; assetId: string; amount: string }
  | { assetType: 'COUNTERPARTY'; assetId: string; name: string; quantitySats: string };

type Refusal = { ok: false; code: SafeOpsPlanRefusalCode; reason: string };

function readInventory(
  inventory: SafeOpsInventory | undefined,
  index: number,
  value: bigint,
  outpoint: { txid: string; vout: number }
): { assets: Asset[] } | Refusal {
  if (!inventory || typeof inventory !== 'object' || inventory.examined !== true) {
    return refuse('INVENTORY_UNEXAMINED', `Input ${index} was never examined against the protocol authorities.`);
  }
  const bad = (what: string): Refusal => refuse('INVENTORY_INVALID', `Input ${index} ${what}.`);
  const record = inventory as Record<string, unknown>;
  for (const field of ['inscriptions', 'rareSatRanges', 'runeAllocations', 'counterpartyAssets', 'unknownClaims']) {
    if (record[field] !== undefined && !Array.isArray(record[field])) return bad(`lists ${field} as something other than an array`);
  }
  const unknownClaims = listOf(inventory.unknownClaims);
  if (unknownClaims.length > 0) {
    return refuse(
      'UNKNOWN_CLAIM_FAILS_CLOSED',
      `Input ${index} carries an unrecognized claim (${String(unknownClaims[0])}); resolve it before planning.`
    );
  }
  const assets: Asset[] = [];
  for (const raw of listOf(inventory.inscriptions)) {
    const entry = raw as { inscriptionId?: unknown; offset?: unknown; satpoint?: unknown } | null;
    const offset = parseSats(entry?.offset);
    if (!entry || typeof entry.inscriptionId !== 'string' || !/^[0-9a-f]{64}i(0|[1-9][0-9]*)$/.test(entry.inscriptionId)) {
      return bad('names an inscription without a valid inscription id');
    }
    if (offset === null || offset >= value) return bad(`places ${entry.inscriptionId} at an offset the input does not have`);
    if (entry.satpoint !== undefined && entry.satpoint !== `${outpoint.txid}:${outpoint.vout}:${String(entry.offset)}`) {
      return bad(`gives ${entry.inscriptionId} a satpoint that is not this input at this offset`);
    }
    assets.push({ assetType: 'ORDINAL', assetId: entry.inscriptionId, offset, count: 1n });
  }
  for (const raw of listOf(inventory.rareSatRanges)) {
    const entry = raw as { rangeId?: unknown; offset?: unknown; count?: unknown } | null;
    const offset = parseSats(entry?.offset);
    const count = parseSats(entry?.count);
    if (!entry || typeof entry.rangeId !== 'string' || entry.rangeId.length === 0) return bad('names a rare sat range without an id');
    if (offset === null || count === null || count === 0n || offset + count > value) {
      return bad(`places rare sat range ${entry.rangeId} outside the input`);
    }
    assets.push({ assetType: 'RARE_SAT', assetId: entry.rangeId, offset, count });
  }
  const runes = new Set<string>();
  for (const raw of listOf(inventory.runeAllocations)) {
    const entry = raw as { runeId?: unknown; amount?: unknown } | null;
    if (!entry || typeof entry.runeId !== 'string' || !RUNE_ID.test(entry.runeId) || parseSats(entry.amount) === null) {
      return bad('lists a rune balance without an exact rune id and amount');
    }
    if (runes.has(entry.runeId)) return bad(`lists rune ${entry.runeId} twice`);
    runes.add(entry.runeId);
    assets.push({ assetType: 'RUNE', assetId: entry.runeId, amount: entry.amount as string });
  }
  for (const raw of listOf(inventory.counterpartyAssets)) {
    const entry = raw as { name?: unknown; assetId?: unknown; quantitySats?: unknown } | null;
    const quantity = parseSats(entry?.quantitySats);
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      typeof entry.assetId !== 'string' ||
      !DECIMAL.test(entry.assetId) ||
      quantity === null ||
      quantity === 0n
    ) {
      return bad('lists a Counterparty attachment without a name, a numeric asset id and an exact quantity');
    }
    assets.push({ assetType: 'COUNTERPARTY', assetId: entry.assetId, name: entry.name, quantitySats: entry.quantitySats as string });
  }
  return { assets };
}

function outputAt(outputValues: bigint[], position: bigint): number {
  let end = 0n;
  for (let j = 0; j < outputValues.length; j += 1) {
    end += outputValues[j] ?? 0n;
    if (position < end) return j;
  }
  return -1;
}

interface Movement {
  assetType: string;
  assetId: string;
  fromInput?: unknown;
  toOutput: unknown;
  quantity: unknown;
}

const transitionKey = (t: Movement): string =>
  `${t.assetType}|${t.assetId}|${t.fromInput === undefined ? '' : String(t.fromInput)}|${String(t.toOutput)}|${String(t.quantity)}`;

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
  const inputAssets: Asset[][] = [];
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
    if (!('assets' in read)) return read;
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
    if (plan.operationKind === 'RUNE_BATCH_TRANSFER' && !read.assets.some((a) => a.assetType === 'RUNE')) {
      return refuse('RUNE_INPUT_MISSING_ALLOCATION', `Input ${i} carries no rune allocation.`);
    }
    inputValues.push(value);
    inputAssets.push(read.assets);
    totalIn += value;
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

  const derived: Movement[] = [];
  let inputStart = 0n;
  for (let i = 0; i < inputs.length; i += 1) {
    for (const asset of inputAssets[i] ?? []) {
      if (asset.assetType !== 'ORDINAL' && asset.assetType !== 'RARE_SAT') continue;
      const start = inputStart + asset.offset;
      const first = outputAt(outputValues, start);
      const last = outputAt(outputValues, start + asset.count - 1n);
      if (first === -1 || last === -1) {
        return refuse('ASSET_TO_FEE', `${asset.assetType} ${asset.assetId} would land in the fee and be lost to the miner.`);
      }
      if (first !== last) {
        return refuse('RARE_SAT_RANGE_SPLIT', `Rare sat range ${asset.assetId} would be split across outputs ${first} and ${last}.`);
      }
      if ((outputValues[first] ?? 0n) < BigInt(SAFEOPS_POSTAGE_FLOOR_SATS)) {
        return refuse('POSTAGE_BELOW_FLOOR', `Output ${first} carries ${asset.assetId} with less than the ${SAFEOPS_POSTAGE_FLOOR_SATS} sat postage floor.`);
      }
      derived.push({ assetType: asset.assetType, assetId: asset.assetId, fromInput: i, toOutput: first, quantity: asset.count.toString() });
    }
    inputStart += inputValues[i] ?? 0n;
  }

  const transitions = plan.assetTransitions;
  if (!Array.isArray(transitions)) return refuse('MALFORMED_PLAN', 'Expected an assetTransitions array.');
  for (const t of transitions) {
    if (!t || typeof t !== 'object' || typeof t.assetType !== 'string' || typeof t.assetId !== 'string') {
      return refuse('TRANSITION_INVALID', 'Every asset transition names an asset type and id.');
    }
    if (typeof t.toOutput !== 'number' || !Number.isInteger(t.toOutput) || !outputs[t.toOutput]) {
      return refuse('TRANSITION_OUTPUT_MISSING', `Asset ${t.assetType}:${t.assetId} names output ${String(t.toOutput)}, which does not exist.`);
    }
    if (parseSats(t.quantity) === null) return refuse('TRANSITION_INVALID', `Asset ${t.assetType}:${t.assetId} carries no exact quantity.`);
  }
  const typed = transitions as Array<Movement & { toOutput: number; quantity: string }>;

  if (carriesRunes) {
    const runePlan = typed
      .filter((t) => t.assetType === 'RUNE')
      .map((t) => ({ output: t.toOutput, runeId: t.assetId, amount: t.quantity }));
    const verdict = verifyRuneAllocation(
      scripts,
      inputs.map((input) => ({
        indexed: true,
        balances: listOf(input.inventory?.runeAllocations) as Array<{ runeId: string; amount: string }>,
      })),
      runePlan
    );
    if (!verdict.ok) return refuse(verdict.code as SafeOpsPlanRefusalCode, verdict.reason);
  } else if (typed.some((t) => t.assetType === 'RUNE')) {
    return refuse('TRANSITION_UNEXPECTED', 'The plan moves runes no input carries.');
  }

  if (inputAssets.some((assets) => assets.some((a) => a.assetType === 'COUNTERPARTY'))) {
    const outcome = counterpartyMoveOutcome(
      {
        inputs: inputs.map((input) => ({
          txid: input.outpoint?.txid,
          vout: input.outpoint?.vout,
          attachments: listOf(input.inventory?.counterpartyAssets),
        })),
        outputs: scripts.map((scriptHex) => ({ scriptHex })),
      },
      { network: plan.network, height: checkpointHeight + 1 }
    );
    if (!outcome.ok) return refuse(outcome.code as SafeOpsPlanRefusalCode, outcome.reason);
    if (outcome.operation !== 'MOVE') {
      return refuse(
        'COUNTERPARTY_NOT_MOVED',
        `Counterparty would ${outcome.operation === 'STRANDED' ? 'strand' : 'detach'} the attached assets instead of moving them.`
      );
    }
    for (const moved of outcome.moved) {
      const toOutput = moved.toOutput as number;
      if ((outputs[toOutput] as SafeOpsOutput).role === 'data') {
        return refuse('ASSET_TO_FEE', `Counterparty asset ${moved.assetId} would be credited to an unspendable output.`);
      }
      derived.push({ assetType: 'COUNTERPARTY', assetId: moved.assetId, fromInput: moved.fromInput, toOutput, quantity: moved.quantitySats });
    }
  }

  const planned = new Map<string, number>();
  for (const t of typed) {
    if (t.assetType === 'RUNE') continue;
    const key = transitionKey(t);
    planned.set(key, (planned.get(key) ?? 0) + 1);
  }
  for (const d of derived) {
    const key = transitionKey(d);
    const count = planned.get(key) ?? 0;
    if (count === 0) {
      const named = typed.some((t) => t.assetType === d.assetType && t.assetId === d.assetId);
      return refuse(
        named ? 'TRANSITION_MISMATCH' : 'TRACKED_ASSET_UNASSIGNED',
        named
          ? `${d.assetType} ${d.assetId} moves to output ${String(d.toOutput)} with quantity ${String(d.quantity)}, which the plan does not state.`
          : `${d.assetType} ${d.assetId} has no destination in the asset transitions.`
      );
    }
    planned.set(key, count - 1);
  }
  for (const [key, count] of planned) {
    if (count > 0) return refuse('TRANSITION_UNEXPECTED', `The plan states a movement no input asset makes: ${key.split('|').slice(0, 2).join(' ')}.`);
  }

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
