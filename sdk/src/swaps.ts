/**
 * The swap link rules from spec/swaps.md, typed.
 *
 * This is the same verifier as verifier/swaps.js at the repository root,
 * ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/swap-vectors.json, so they cannot drift apart
 * without a test failing.
 *
 * Every amount is an atomic integer carried as a decimal string and handled
 * as BigInt. Floating point never appears here.
 */

import { createHash } from 'node:crypto';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const ASSET_TYPES = ['BTC', 'ORDINAL', 'RARE_SAT', 'RUNE', 'COUNTERPARTY'];

export const SWAP_INTENT_SCHEMA = 'ordex.swap-intent/v1';
export const SWAP_ACCEPTANCE_SCHEMA = 'ordex.swap-acceptance-plan/v1';

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

export interface SwapOutpoint {
  txid?: unknown;
  vout?: unknown;
}

export interface SwapGive {
  assetType?: unknown;
  assetId?: unknown;
  outpoint?: SwapOutpoint;
  quantitySats?: unknown;
}

export interface SwapRequirement {
  assetType?: unknown;
  assetId?: unknown;
  inscriptionId?: unknown;
  minQuantitySats?: unknown;
}

export interface SwapIntent {
  schema?: unknown;
  protocolVersion?: unknown;
  network?: unknown;
  visibility?: unknown;
  makerReceiveScriptHex?: unknown;
  gives?: SwapGive[];
  requires?: SwapRequirement[];
  maxMakerFeeSats?: unknown;
  expiryHeight?: unknown;
  nonce?: unknown;
  createdAtHeight?: unknown;
  checkpoint?: { height?: unknown; blockHash?: unknown };
  takerBinding?: { address?: unknown };
  adapterVersions?: unknown[];
  makerIdentityProof?: { kind?: unknown; address?: unknown; signature?: unknown };
  digest?: unknown;
  [key: string]: unknown;
}

export interface SwapAcceptanceInput {
  outpoint?: SwapOutpoint;
  party?: unknown;
  valueSats?: unknown;
  assets?: Array<{ assetType?: unknown; assetId?: unknown }>;
}

export interface SwapAcceptanceOutput {
  scriptHex?: unknown;
  valueSats?: unknown;
  role?: unknown;
}

export interface SwapAcceptance {
  schema?: unknown;
  intentDigest?: unknown;
  network?: unknown;
  tx?: { inputs?: SwapAcceptanceInput[]; outputs?: SwapAcceptanceOutput[] };
  assetTransitions?: Array<{
    assetType?: unknown;
    assetId?: unknown;
    fromInput?: unknown;
    toOutput?: unknown;
  }>;
  fee?: { feeSats?: unknown; makerFeeSats?: unknown; takerFeeSats?: unknown };
  signing?: { sighashPolicy?: unknown };
  [key: string]: unknown;
}

/**
 * SHA-256 over the signed content of an intent: everything except the
 * digest itself and the identity signature. Lowercase hex.
 */
export function swapIntentDigest(intent: SwapIntent): string {
  const binding: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(intent)) {
    if (key === 'digest' || key === 'makerIdentityProof') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}

export type SwapIntentRefusalCode =
  | 'MALFORMED_INTENT'
  | 'SCHEMA_UNSUPPORTED'
  | 'PROTOCOL_UNSUPPORTED'
  | 'NETWORK_UNKNOWN'
  | 'VISIBILITY_INVALID'
  | 'RECEIVE_SCRIPT_INVALID'
  | 'GIVES_INVALID'
  | 'REQUIRES_INVALID'
  | 'FEE_BUDGET_INVALID'
  | 'CHECKPOINT_INVALID'
  | 'EXPIRY_INVALID'
  | 'NONCE_INVALID'
  | 'ADAPTER_VERSIONS_MISSING'
  | 'MAKER_PROOF_INVALID'
  | 'TAKER_BINDING_INVALID'
  | 'DIGEST_MISMATCH';

export type SwapIntentVerdict =
  | { ok: true; digest: string }
  | { ok: false; code: SwapIntentRefusalCode; reason: string };

const refuse = (code: SwapIntentRefusalCode, reason: string): SwapIntentVerdict => ({
  ok: false,
  code,
  reason,
});

function validOutpoint(outpoint: SwapOutpoint | undefined): boolean {
  return (
    !!outpoint &&
    typeof outpoint.txid === 'string' &&
    HEX64.test(outpoint.txid) &&
    Number.isInteger(outpoint.vout) &&
    (outpoint.vout as number) >= 0
  );
}

function validGives(gives: SwapGive[] | undefined): boolean {
  if (!Array.isArray(gives) || gives.length === 0) return false;
  return gives.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.assetType !== 'string' || !ASSET_TYPES.includes(entry.assetType)) return false;
    if (!validOutpoint(entry.outpoint)) return false;
    if (parseSats(entry.quantitySats) === null) return false;
    if (entry.assetType === 'BTC') {
      return entry.assetId === undefined || typeof entry.assetId === 'string';
    }
    return typeof entry.assetId === 'string' && entry.assetId.length > 0;
  });
}

function validRequires(requires: SwapRequirement[] | undefined): boolean {
  if (!Array.isArray(requires) || requires.length === 0) return false;
  return requires.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.assetType !== 'string' || !ASSET_TYPES.includes(entry.assetType)) return false;
    if (parseSats(entry.minQuantitySats) === null) return false;
    if (entry.assetType === 'BTC') {
      return entry.assetId === undefined || typeof entry.assetId === 'string';
    }
    if (typeof entry.assetId !== 'string' || entry.assetId.length === 0) {
      // An ORDINAL may instead name one inscription id as the asset id.
      return entry.assetType === 'ORDINAL' && typeof entry.inscriptionId === 'string' && entry.inscriptionId.length > 0;
    }
    return true;
  });
}

/**
 * Verify a swap intent.
 *
 * intent:
 *   schema, protocolVersion, network, visibility ('PUBLIC'|'PRIVATE'),
 *   makerReceiveScriptHex, gives [], requires [], maxMakerFeeSats,
 *   expiryHeight, nonce, createdAtHeight, checkpoint { height, blockHash },
 *   takerBinding? { address }, adapterVersions [],
 *   makerIdentityProof { kind, address, signature }, digest
 *
 * Answers { ok: true, digest } or { ok: false, code, reason }.
 */
export function verifySwapIntent(intent: unknown): SwapIntentVerdict {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    return refuse('MALFORMED_INTENT', 'Expected an intent object.');
  }
  const i = intent as SwapIntent;
  if (i.schema !== SWAP_INTENT_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The intent schema is not ordex.swap-intent/v1.');
  }
  if (typeof i.protocolVersion !== 'string' || !/^1\.[2-9][0-9]*$/.test(i.protocolVersion)) {
    return refuse('PROTOCOL_UNSUPPORTED', 'The intent protocol version must be 1.2 or a later 1.x.');
  }
  if (typeof i.network !== 'string' || !NETWORKS.includes(i.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (i.visibility !== 'PUBLIC' && i.visibility !== 'PRIVATE') {
    return refuse('VISIBILITY_INVALID', 'Visibility must be PUBLIC or PRIVATE.');
  }
  if (typeof i.makerReceiveScriptHex !== 'string' || !EVEN_HEX.test(i.makerReceiveScriptHex)) {
    return refuse('RECEIVE_SCRIPT_INVALID', 'The maker receive script must be lowercase hex bytes.');
  }
  if (!validGives(i.gives)) {
    return refuse('GIVES_INVALID', 'The intent must give at least one exact outpoint with an exact quantity.');
  }
  if (!validRequires(i.requires)) {
    return refuse('REQUIRES_INVALID', 'The intent must require at least one exact asset with a minimum quantity.');
  }
  const maxMakerFee = parseSats(i.maxMakerFeeSats);
  if (maxMakerFee === null || maxMakerFee < 0n) {
    return refuse('FEE_BUDGET_INVALID', 'maxMakerFeeSats must be an exact non-negative decimal string.');
  }
  if (
    !i.checkpoint ||
    !Number.isInteger(i.checkpoint.height) ||
    (i.checkpoint.height as number) < 0 ||
    typeof i.checkpoint.blockHash !== 'string' ||
    !HEX64.test(i.checkpoint.blockHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The intent must carry the chain checkpoint it was signed against.');
  }
  if (!Number.isInteger(i.expiryHeight) || (i.expiryHeight as number) <= (i.checkpoint.height as number)) {
    return refuse('EXPIRY_INVALID', 'The expiry height must be a block after the checkpoint height.');
  }
  if (typeof i.nonce !== 'string' || i.nonce.length < 8 || i.nonce.length > 128) {
    return refuse('NONCE_INVALID', 'The intent must carry a nonce of 8 to 128 characters.');
  }
  if (!Array.isArray(i.adapterVersions) || i.adapterVersions.length === 0) {
    return refuse('ADAPTER_VERSIONS_MISSING', 'The intent must name the protocol adapter versions it relies on.');
  }
  const proof = i.makerIdentityProof;
  if (!proof || proof.kind !== 'bip322' || typeof proof.address !== 'string' || proof.address.length === 0) {
    return refuse('MAKER_PROOF_INVALID', 'The intent must carry a bip322 maker identity proof with an address.');
  }
  if (
    i.takerBinding !== undefined &&
    (typeof i.takerBinding !== 'object' ||
      typeof i.takerBinding.address !== 'string' ||
      i.takerBinding.address.length === 0)
  ) {
    return refuse('TAKER_BINDING_INVALID', 'A taker binding must name an address.');
  }

  const digest = swapIntentDigest(i);
  if (i.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The intent digest does not match its signed content.');
  }
  return { ok: true, digest };
}

export type SwapAcceptanceRefusalCode =
  | 'MALFORMED_ACCEPTANCE'
  | 'SCHEMA_UNSUPPORTED'
  | 'INTENT_DIGEST_MISMATCH'
  | 'NETWORK_MISMATCH'
  | 'ATOMICITY_IMPOSSIBLE'
  | 'UNCLOSED_SIGHASH'
  | 'INPUT_OUTPOINT_INVALID'
  | 'INPUT_PARTY_INVALID'
  | 'INPUT_VALUE_INVALID'
  | 'INPUT_DUPLICATED'
  | 'MAKER_OUTPOINT_MISSING'
  | 'MAKER_OUTPOINT_REASSIGNED'
  | 'UNEXPECTED_MAKER_INPUT'
  | 'OUTPUT_SCRIPT_INVALID'
  | 'OUTPUT_VALUE_INVALID'
  | 'DUST_OUTPUT'
  | 'VALUE_NOT_CONSERVED'
  | 'FEE_INVALID'
  | 'FEE_SPLIT_INVALID'
  | 'FEE_CHANGED'
  | 'FEE_BUDGET_EXCEEDED'
  | 'CONSIDERATION_SHORTFALL'
  | 'ASSET_TRANSITION_DUPLICATED'
  | 'MAKER_ASSET_UNASSIGNED'
  | 'TAKER_ASSET_UNASSIGNED'
  | 'TRANSITION_SOURCE_MISMATCH'
  | 'TRANSITION_OUTPUT_MISSING'
  | 'TRANSITION_SAT_FLOW_MISMATCH';

export type SwapAcceptanceVerdict =
  | { ok: true }
  | { ok: false; code: SwapAcceptanceRefusalCode | SwapIntentRefusalCode; reason: string };

const acceptanceRefuse = (
  code: SwapAcceptanceRefusalCode,
  reason: string,
): SwapAcceptanceVerdict => ({ ok: false, code, reason });

/**
 * Verify a swap acceptance plan against its intent.
 *
 * acceptance:
 *   schema, intentDigest, network,
 *   tx { inputs  [{ txid, vout, party, valueSats }],
 *        outputs [{ scriptHex, valueSats, role }] },
 *   assetTransitions [{ assetType, assetId, fromInput, toOutput }],
 *   fee { feeSats, makerFeeSats, takerFeeSats },
 *   signing { sighashPolicy }
 *
 * The invariant this check proves: with SIGHASH_ALL on every input, no
 * transaction carrying only one party's signatures can confirm, so neither
 * side can lose its asset while the other withholds the final signature.
 */
export function verifySwapAcceptance(acceptance: unknown, intent: unknown): SwapAcceptanceVerdict {
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    return acceptanceRefuse('MALFORMED_ACCEPTANCE', 'Expected an acceptance plan object.');
  }
  const a = acceptance as SwapAcceptance;
  if (a.schema !== SWAP_ACCEPTANCE_SCHEMA) {
    return acceptanceRefuse('SCHEMA_UNSUPPORTED', 'The acceptance schema is not ordex.swap-acceptance-plan/v1.');
  }
  const intentVerdict = verifySwapIntent(intent);
  if (!intentVerdict.ok) return intentVerdict;
  const i = intent as SwapIntent;
  if (a.intentDigest !== i.digest) {
    return acceptanceRefuse('INTENT_DIGEST_MISMATCH', 'The acceptance plan was not built from this intent.');
  }
  if (a.network !== i.network) {
    return acceptanceRefuse('NETWORK_MISMATCH', 'The acceptance plan was built for a different network.');
  }
  const tx = a.tx;
  if (
    !tx ||
    !Array.isArray(tx.inputs) ||
    tx.inputs.length < 2 ||
    !Array.isArray(tx.outputs) ||
    tx.outputs.length < 2
  ) {
    return acceptanceRefuse(
      'ATOMICITY_IMPOSSIBLE',
      'A swap settles both sides in one transaction with inputs and outputs from both parties.',
    );
  }
  if (!a.signing || a.signing.sighashPolicy !== 'ALL') {
    return acceptanceRefuse(
      'UNCLOSED_SIGHASH',
      'Every input must commit to every output (SIGHASH_ALL), or one party could move its asset without the other receiving theirs.',
    );
  }

  const inputs = tx.inputs;
  const outputs = tx.outputs;
  let totalIn = 0n;
  const inputByOutpoint = new Map<string, { index: number; party: string; value: bigint }>();
  for (let n = 0; n < inputs.length; n += 1) {
    const input = inputs[n];
    if (!validOutpoint(input && input.outpoint)) {
      return acceptanceRefuse('INPUT_OUTPOINT_INVALID', `Input ${n} does not carry a lowercase txid and vout.`);
    }
    if (input?.party !== 'maker' && input?.party !== 'taker') {
      return acceptanceRefuse('INPUT_PARTY_INVALID', `Input ${n} must name the maker or the taker.`);
    }
    const value = parseSats(input && input.valueSats);
    if (value === null) {
      return acceptanceRefuse('INPUT_VALUE_INVALID', `Input ${n} does not carry an exact decimal value.`);
    }
    const key = `${String(input?.outpoint?.txid)}:${String(input?.outpoint?.vout)}`;
    if (inputByOutpoint.has(key)) {
      return acceptanceRefuse('INPUT_DUPLICATED', `Input ${key} appears more than once.`);
    }
    inputByOutpoint.set(key, { index: n, party: input?.party as string, value });
    totalIn += value;
  }

  // Every maker commitment must be spent by exactly one maker input, and no
  // maker input may spend anything the intent did not commit.
  for (const give of i.gives as SwapGive[]) {
    const key = `${String(give.outpoint?.txid)}:${String(give.outpoint?.vout)}`;
    const input = inputByOutpoint.get(key);
    if (!input) {
      return acceptanceRefuse('MAKER_OUTPOINT_MISSING', `The committed outpoint ${key} is not spent by the acceptance plan.`);
    }
    if (input.party !== 'maker') {
      return acceptanceRefuse('MAKER_OUTPOINT_REASSIGNED', `The committed outpoint ${key} is claimed by the taker.`);
    }
  }
  for (const [key, input] of inputByOutpoint) {
    if (input.party !== 'maker') continue;
    const committed = (i.gives as SwapGive[]).some(
      (give) => `${String(give.outpoint?.txid)}:${String(give.outpoint?.vout)}` === key,
    );
    if (!committed) {
      return acceptanceRefuse('UNEXPECTED_MAKER_INPUT', `Input ${key} spends an outpoint the intent never committed.`);
    }
  }

  let totalOut = 0n;
  for (let n = 0; n < outputs.length; n += 1) {
    const output = outputs[n];
    if (typeof (output && output.scriptHex) !== 'string' || !EVEN_HEX.test((output?.scriptHex ?? null) as string)) {
      return acceptanceRefuse('OUTPUT_SCRIPT_INVALID', `Output ${n} does not carry lowercase hex script bytes.`);
    }
    const value = parseSats(output && output.valueSats);
    if (value === null) {
      return acceptanceRefuse('OUTPUT_VALUE_INVALID', `Output ${n} does not carry an exact decimal value.`);
    }
    if (value < 546n) {
      return acceptanceRefuse('DUST_OUTPUT', `Output ${n} is below the 546 sat dust floor.`);
    }
    totalOut += value;
  }
  const fee = totalIn - totalOut;
  if (fee < 0n) {
    return acceptanceRefuse('VALUE_NOT_CONSERVED', 'The outputs exceed the inputs.');
  }
  const feeSpec = a.fee;
  if (!feeSpec || typeof feeSpec !== 'object') {
    return acceptanceRefuse('FEE_INVALID', 'The acceptance plan must carry a fee object.');
  }
  const declaredFee = parseSats(feeSpec.feeSats);
  const makerFee = parseSats(feeSpec.makerFeeSats);
  const takerFee = parseSats(feeSpec.takerFeeSats);
  if (declaredFee === null || makerFee === null || takerFee === null || declaredFee < 0n) {
    return acceptanceRefuse('FEE_INVALID', 'Fee contributions must be exact decimal strings.');
  }
  if (makerFee + takerFee !== declaredFee) {
    return acceptanceRefuse('FEE_SPLIT_INVALID', 'The maker and taker contributions must equal the declared fee.');
  }
  if (fee !== declaredFee) {
    return acceptanceRefuse('FEE_CHANGED', 'The declared fee does not match the transaction.');
  }
  if (makerFee > parseSats(i.maxMakerFeeSats)) {
    return acceptanceRefuse('FEE_BUDGET_EXCEEDED', 'The maker contribution exceeds the budget the intent approved.');
  }

  // Each required criterion must be satisfied by an output paying the maker
  // receive script with at least the minimum quantity.
  for (const criterion of i.requires as SwapRequirement[]) {
    const minimum = parseSats(criterion.minQuantitySats);
    const satisfied = outputs.some(
      (output) =>
        output.scriptHex === i.makerReceiveScriptHex && parseSats(output?.valueSats) >= minimum,
    );
    if (!satisfied) {
      return acceptanceRefuse(
        'CONSIDERATION_SHORTFALL',
        `No output pays the maker receive script at least ${String(criterion.minQuantitySats)} for ${String(criterion.assetType)}.`,
      );
    }
  }

  // Every asset the maker gives must be delivered to a taker asset output
  // through an explicit transition, and every taker asset must be preserved
  // or delivered the same way. An unassigned asset could land in the fee
  // region or in unrelated change. For every non-BTC asset the declared
  // destination must also be the output that receives the input's first
  // sat: the first output whose accumulated value passes the range start.
  const transitions = Array.isArray(a.assetTransitions) ? a.assetTransitions : [];
  const inputValues = inputs.map((input) => parseSats(input?.valueSats) as bigint);
  const firstSatOutput = (fromInput: number): number => {
    let rangeStart = 0n;
    for (let n = 0; n < fromInput; n += 1) rangeStart += inputValues[n] as bigint;
    let accumulated = 0n;
    for (let j = 0; j < outputs.length; j += 1) {
      accumulated += parseSats(outputs[j]?.valueSats) as bigint;
      if (accumulated > rangeStart) return j;
    }
    return -1;
  };
  const seen = new Set<string>();
  const checkAsset = (
    assetType: string,
    assetId: string,
    fromIndex: number,
    label: 'MAKER_ASSET' | 'TAKER_ASSET',
  ): SwapAcceptanceVerdict | null => {
    const key = `${assetType}:${assetId}`;
    if (seen.has(key)) {
      return acceptanceRefuse('ASSET_TRANSITION_DUPLICATED', `Asset ${key} is assigned to more than one transition.`);
    }
    seen.add(key);
    const transition = transitions.find((t) => t && t.assetType === assetType && t.assetId === assetId);
    if (!transition) {
      return acceptanceRefuse(`${label}_UNASSIGNED` as SwapAcceptanceRefusalCode, `Asset ${key} has no destination in the asset transitions.`);
    }
    if (!Number.isInteger(transition.fromInput) || transition.fromInput !== fromIndex) {
      return acceptanceRefuse(
        'TRANSITION_SOURCE_MISMATCH',
        `Asset ${key} declares input ${String(transition.fromInput)} but rides on input ${fromIndex}.`,
      );
    }
    const output = outputs[transition.toOutput as number];
    if (!Number.isInteger(transition.toOutput) || !output) {
      return acceptanceRefuse('TRANSITION_OUTPUT_MISSING', `Asset ${key} names output ${String(transition.toOutput)}, which does not exist.`);
    }
    if (assetType !== 'BTC' && (transition.toOutput as number) !== firstSatOutput(fromIndex)) {
      return acceptanceRefuse(
        'TRANSITION_SAT_FLOW_MISMATCH',
        `Asset ${key} declares output ${String(transition.toOutput)}, but the sat range of input ${fromIndex} begins in a different output.`,
      );
    }
    return null;
  };
  for (const give of i.gives as SwapGive[]) {
    const key = `${String(give.outpoint?.txid)}:${String(give.outpoint?.vout)}`;
    const error = checkAsset(
      give.assetType as string,
      (give.assetId || 'BTC') as string,
      inputByOutpoint.get(key)?.index as number,
      'MAKER_ASSET',
    );
    if (error) return error;
  }
  for (let n = 0; n < inputs.length; n += 1) {
    const input = inputs[n];
    if (input?.party !== 'taker') continue;
    for (const carried of Array.isArray(input.assets) ? input.assets : []) {
      const error = checkAsset(
        carried.assetType as string,
        (carried.assetId || 'BTC') as string,
        n,
        'TAKER_ASSET',
      );
      if (error) return error;
    }
  }

  return { ok: true };
}
