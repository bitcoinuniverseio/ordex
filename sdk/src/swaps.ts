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

import {
  checkTransitionShapes,
  deriveAssetFlow,
  matchTransitions,
  readInventory,
  type AssetInventory,
  type FlowInput,
  type StatedTransition,
} from './asset-flow.js';
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

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const ASSET_TYPES = ['BTC', 'ORDINAL', 'RARE_SAT', 'RUNE', 'COUNTERPARTY'];

export const SWAP_INTENT_SCHEMA = 'ordex.swap-intent/v1';
export const SWAP_ACCEPTANCE_SCHEMA = 'ordex.swap-acceptance-plan/v2';
export const SWAP_SIGNED_TRANSACTION_SCHEMA = 'ordex.swap-signed-transaction/v1';

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
  scriptPubKeyHex?: unknown;
  sequence?: unknown;
  /** What the authorities report the outpoint carries; see readInventory. */
  inventory?: AssetInventory;
}

export interface SwapAcceptanceOutput {
  scriptHex?: unknown;
  valueSats?: unknown;
}

export interface SwapTaker {
  receiveScriptHex?: unknown;
  changeScriptHex?: unknown;
  identityProof?: { kind?: unknown; address?: unknown; signature?: unknown };
}

export interface SwapAcceptance {
  schema?: unknown;
  intentDigest?: unknown;
  network?: unknown;
  checkpoint?: { height?: unknown; blockHash?: unknown };
  taker?: SwapTaker;
  transaction?: { version?: unknown; lockTime?: unknown };
  tx?: { inputs?: SwapAcceptanceInput[]; outputs?: SwapAcceptanceOutput[] };
  assetTransitions?: unknown;
  fee?: { feeSats?: unknown; makerFeeSats?: unknown; takerFeeSats?: unknown };
  signing?: { sighashPolicy?: unknown };
  digest?: unknown;
  [key: string]: unknown;
}

export interface SwapSignedTransaction {
  schema?: unknown;
  acceptanceDigest?: unknown;
  signedTxHex?: unknown;
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
  | 'CHECKPOINT_INVALID'
  | 'INTENT_EXPIRED'
  | 'TRANSACTION_INVALID'
  | 'TAKER_INVALID'
  | 'TAKER_BINDING_MISMATCH'
  | 'PARTY_SCRIPTS_OVERLAP'
  | 'ADAPTER_UNSUPPORTED'
  | 'QUANTITY_UNSUPPORTED'
  | 'ATOMICITY_IMPOSSIBLE'
  | 'UNCLOSED_SIGHASH'
  | 'INPUT_OUTPOINT_INVALID'
  | 'INPUT_PARTY_INVALID'
  | 'INPUT_VALUE_INVALID'
  | 'INPUT_SCRIPT_INVALID'
  | 'INPUT_SEQUENCE_INVALID'
  | 'INPUT_DUPLICATED'
  | 'MAKER_OUTPOINT_MISSING'
  | 'MAKER_OUTPOINT_REASSIGNED'
  | 'UNEXPECTED_MAKER_INPUT'
  | 'GIVE_NOT_HELD'
  | 'OUTPUT_SCRIPT_INVALID'
  | 'OUTPUT_VALUE_INVALID'
  | 'OUTPUT_UNOWNED'
  | 'DATA_OUTPUT_BURNS_VALUE'
  | 'DATA_OUTPUT_NOT_PERMITTED'
  | 'DATA_OUTPUT_NONSTANDARD'
  | 'DUST_OUTPUT'
  | 'VALUE_NOT_CONSERVED'
  | 'MAKER_ASSET_NOT_DELIVERED'
  | 'GIVE_QUANTITY_MISMATCH'
  | 'ASSET_MISDIRECTED'
  | 'ASSET_OUTPUT_MIXED'
  | 'CONSIDERATION_SHORTFALL'
  | 'FEE_INVALID'
  | 'FEE_SPLIT_INVALID'
  | 'FEE_CHANGED'
  | 'FEE_BUDGET_EXCEEDED'
  | 'DIGEST_MISMATCH'
  // Inventory, asset flow and transition refusals pass through unchanged.
  | 'INVENTORY_UNEXAMINED'
  | 'INVENTORY_INVALID'
  | 'UNKNOWN_CLAIM_FAILS_CLOSED'
  | 'ASSET_TO_FEE'
  | 'RARE_SAT_RANGE_SPLIT'
  | 'ALLOCATION_BURNS_BALANCE'
  | 'CENOTAPH_BURNS_BALANCE'
  | 'RUNE_MINT_UNRESOLVED'
  | 'COUNTERPARTY_NOT_MOVED'
  | 'TRANSITION_INVALID'
  | 'TRANSITION_OUTPUT_MISSING'
  | 'TRANSITION_MISMATCH'
  | 'TRANSITION_UNEXPECTED'
  | 'TRACKED_ASSET_UNASSIGNED'
  | 'RUNE_ALLOCATION_MISMATCH';

type AcceptanceRefusal = { ok: false; code: SwapAcceptanceRefusalCode | SwapIntentRefusalCode; reason: string };

export type SwapAcceptanceVerdict = { ok: true; digest: string; makerFeeSats: string; takerFeeSats: string } | AcceptanceRefusal;

const acceptanceRefuse = (code: SwapAcceptanceRefusalCode, reason: string): AcceptanceRefusal => ({ ok: false, code, reason });
const passThrough = (refusal: { code: string; reason: string }): AcceptanceRefusal => ({
  ok: false,
  code: refusal.code as SwapAcceptanceRefusalCode,
  reason: refusal.reason,
});

/**
 * SHA-256 over the sorted-key JSON of an acceptance plan without its digest:
 * the one immutable identity both parties sign against.
 */
export function swapAcceptanceDigest(acceptance: SwapAcceptance): string {
  const binding: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(acceptance)) {
    if (key === 'digest') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}

const U32_MAX = 0xffffffff;
const isU32 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= U32_MAX;
const ADAPTER_OF: Record<string, string> = { ORDINAL: 'ordinals', RARE_SAT: 'ordinals', RUNE: 'runes', COUNTERPARTY: 'counterparty' };
const SUPPORTED_ADAPTERS: Record<string, string[]> = { ordinals: ['1.2'], runes: ['1.2'], counterparty: ['1.2'] };

const requiredId = (r: SwapRequirement): unknown =>
  r.assetType === 'ORDINAL' && (r.assetId === undefined || r.assetId === '') ? r.inscriptionId : r.assetId;

/** The unsigned transaction an acceptance plan describes. */
export function swapUnsignedTransaction(acceptance: SwapAcceptance): Transaction {
  const transaction = acceptance.transaction as { version: number; lockTime: number };
  return {
    version: transaction.version,
    lockTime: transaction.lockTime,
    inputs: (acceptance.tx?.inputs ?? []).map((input) => ({
      txid: input.outpoint?.txid as string,
      vout: input.outpoint?.vout as number,
      scriptSigHex: '',
      sequence: input.sequence as number,
      witness: [],
    })),
    outputs: (acceptance.tx?.outputs ?? []).map((output) => ({
      valueSats: String(parseSats(output.valueSats)),
      scriptHex: output.scriptHex as string,
    })),
  };
}

interface PartyInput extends FlowInput {
  party: 'maker' | 'taker';
}

/**
 * Verify that an acceptance plan settles an intent in one transaction. Every
 * movement is derived from the inputs' inventories by the owning protocol's
 * rule; consideration is judged by asset identity and quantity at the owning
 * party's script; fee shares come from each party's value flow.
 */
// OX-P02: P-R09 accepted a required Rune that never arrived and P-R10 a maker asset
// paid back to the maker. Consideration is now judged by asset identity and quantity
// at the owning party's script, never by a BTC value, and fee shares come from each
// party's actual value flow with postage kept with the asset it carries.
export function verifySwapAcceptance(acceptance: unknown, intent: unknown): SwapAcceptanceVerdict {
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    return acceptanceRefuse('MALFORMED_ACCEPTANCE', 'Expected an acceptance plan object.');
  }
  const a = acceptance as SwapAcceptance;
  if (a.schema !== SWAP_ACCEPTANCE_SCHEMA) {
    return acceptanceRefuse('SCHEMA_UNSUPPORTED', 'The acceptance schema is not ordex.swap-acceptance-plan/v2. Build the plan again.');
  }
  const intentVerdict = verifySwapIntent(intent);
  if (!intentVerdict.ok) return intentVerdict;
  const i = intent as SwapIntent & {
    gives: SwapGive[];
    requires: SwapRequirement[];
    makerReceiveScriptHex: string;
    checkpoint: { height: number };
    expiryHeight: number;
    maxMakerFeeSats: string;
    network: string;
  };
  if (a.intentDigest !== i.digest) {
    return acceptanceRefuse('INTENT_DIGEST_MISMATCH', 'The acceptance plan was not built from this intent.');
  }
  if (a.network !== i.network) {
    return acceptanceRefuse('NETWORK_MISMATCH', 'The acceptance plan was built for a different network.');
  }
  const checkpoint = a.checkpoint;
  if (
    !checkpoint ||
    typeof checkpoint.height !== 'number' ||
    !Number.isInteger(checkpoint.height) ||
    checkpoint.height < i.checkpoint.height ||
    typeof checkpoint.blockHash !== 'string' ||
    !HEX64.test(checkpoint.blockHash)
  ) {
    return acceptanceRefuse('CHECKPOINT_INVALID', 'The plan must carry the checkpoint its outpoints were revalidated at, no earlier than the intent.');
  }
  const height = checkpoint.height;
  if (height + 1 >= i.expiryHeight) {
    return acceptanceRefuse('INTENT_EXPIRED', 'The intent expires before this plan could confirm.');
  }
  if (!a.transaction || !isU32(a.transaction.version) || a.transaction.version < 1 || !isU32(a.transaction.lockTime)) {
    return acceptanceRefuse('TRANSACTION_INVALID', 'The plan must fix the transaction version and locktime.');
  }
  const taker = a.taker;
  if (
    !taker ||
    typeof taker.receiveScriptHex !== 'string' ||
    !EVEN_HEX.test(taker.receiveScriptHex) ||
    (taker.changeScriptHex !== undefined && (typeof taker.changeScriptHex !== 'string' || !EVEN_HEX.test(taker.changeScriptHex)))
  ) {
    return acceptanceRefuse('TAKER_INVALID', 'The plan must name the taker receive script, and a change script only as hex.');
  }
  const takerReceive = taker.receiveScriptHex;
  if (i.takerBinding !== undefined) {
    const proof = taker.identityProof;
    if (!proof || proof.kind !== 'bip322' || proof.address !== i.takerBinding.address) {
      return acceptanceRefuse('TAKER_BINDING_MISMATCH', 'This intent is bound to one taker, and the plan does not carry that taker identity proof.');
    }
  }
  const makerScripts = new Set([i.makerReceiveScriptHex]);
  const takerScripts = new Set<string>([takerReceive, ...(typeof taker.changeScriptHex === 'string' ? [taker.changeScriptHex] : [])]);
  if ([...takerScripts].some((script) => makerScripts.has(script))) {
    return acceptanceRefuse('PARTY_SCRIPTS_OVERLAP', 'The taker would receive at a maker script, so nothing could prove which party an output belongs to.');
  }
  if (!a.signing || a.signing.sighashPolicy !== 'ALL') {
    return acceptanceRefuse(
      'UNCLOSED_SIGHASH',
      'Every input must commit to every output (SIGHASH_ALL), or one party could move its asset without the other receiving theirs.'
    );
  }
  for (const entry of [...i.gives, ...i.requires] as Array<SwapGive & SwapRequirement>) {
    const adapter = ADAPTER_OF[entry.assetType as string];
    if (!adapter) continue;
    const versions = i.adapterVersions as Array<{ protocol?: unknown; version?: unknown } | null>;
    const pinned = versions.find((v) => v && v.protocol === adapter);
    if (!pinned || !(SUPPORTED_ADAPTERS[adapter] ?? []).includes(pinned.version as string)) {
      return acceptanceRefuse('ADAPTER_UNSUPPORTED', `The intent relies on ${adapter} adapter ${pinned ? String(pinned.version) : 'none'}, which this verifier does not run.`);
    }
    const quantity = entry.assetType === 'ORDINAL' ? entry.quantitySats ?? entry.minQuantitySats : null;
    if (quantity !== null && quantity !== '1') {
      return acceptanceRefuse('QUANTITY_UNSUPPORTED', 'An inscription is exchanged whole: its quantity is 1.');
    }
  }

  const tx = a.tx;
  if (!tx || !Array.isArray(tx.inputs) || tx.inputs.length < 2 || !Array.isArray(tx.outputs) || tx.outputs.length < 2) {
    return acceptanceRefuse('ATOMICITY_IMPOSSIBLE', 'A swap settles both sides in one transaction with inputs and outputs from both parties.');
  }

  let totalIn = 0n;
  const inputs: PartyInput[] = [];
  const inputByOutpoint = new Map<string, number>();
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const input = tx.inputs[index] as SwapAcceptanceInput;
    if (!validOutpoint(input?.outpoint)) {
      return acceptanceRefuse('INPUT_OUTPOINT_INVALID', `Input ${index} does not carry a lowercase txid and vout.`);
    }
    const outpoint = input.outpoint as { txid: string; vout: number };
    if (input.party !== 'maker' && input.party !== 'taker') {
      return acceptanceRefuse('INPUT_PARTY_INVALID', `Input ${index} must name the maker or the taker.`);
    }
    const value = parseSats(input.valueSats);
    if (value === null) {
      return acceptanceRefuse('INPUT_VALUE_INVALID', `Input ${index} does not carry an exact decimal value.`);
    }
    if (typeof input.scriptPubKeyHex !== 'string' || !EVEN_HEX.test(input.scriptPubKeyHex)) {
      return acceptanceRefuse('INPUT_SCRIPT_INVALID', `Input ${index} does not carry the script of the output it spends.`);
    }
    if (!isU32(input.sequence)) {
      return acceptanceRefuse('INPUT_SEQUENCE_INVALID', `Input ${index} does not fix its sequence number.`);
    }
    const key = `${outpoint.txid}:${outpoint.vout}`;
    if (inputByOutpoint.has(key)) {
      return acceptanceRefuse('INPUT_DUPLICATED', `Input ${key} appears more than once.`);
    }
    const read = readInventory(input.inventory, index, value, outpoint);
    if (!('assets' in read)) return passThrough(read);
    inputByOutpoint.set(key, index);
    inputs.push({ outpoint, party: input.party, value, assets: read.assets });
    totalIn += value;
  }
  if (!inputs.some((input) => input.party === 'taker')) {
    return acceptanceRefuse('ATOMICITY_IMPOSSIBLE', 'The taker contributes no input, so this is not a swap.');
  }

  for (const give of i.gives) {
    const outpoint = give.outpoint as { txid: string; vout: number };
    const key = `${outpoint.txid}:${outpoint.vout}`;
    const index = inputByOutpoint.get(key);
    if (index === undefined) {
      return acceptanceRefuse('MAKER_OUTPOINT_MISSING', `The committed outpoint ${key} is not spent by the acceptance plan.`);
    }
    const input = inputs[index] as PartyInput;
    if (input.party !== 'maker') {
      return acceptanceRefuse('MAKER_OUTPOINT_REASSIGNED', `The committed outpoint ${key} is claimed by the taker.`);
    }
    const quantity = BigInt(give.quantitySats as string);
    const held =
      give.assetType === 'BTC'
        ? input.value >= quantity
        : input.assets.some(
            (asset) =>
              asset.assetType === give.assetType &&
              asset.assetId === give.assetId &&
              (asset.assetType === 'RUNE'
                ? BigInt(asset.amount) >= quantity
                : asset.assetType === 'COUNTERPARTY'
                  ? BigInt(asset.quantitySats) >= quantity
                  : true)
          );
    if (!held) {
      return acceptanceRefuse('GIVE_NOT_HELD', `The committed outpoint ${key} does not carry the ${String(give.assetType)} the intent gives.`);
    }
  }
  for (const [key, index] of inputByOutpoint) {
    if (inputs[index]?.party !== 'maker') continue;
    if (!i.gives.some((give) => `${String(give.outpoint?.txid)}:${String(give.outpoint?.vout)}` === key)) {
      return acceptanceRefuse('UNEXPECTED_MAKER_INPUT', `Input ${key} spends an outpoint the intent never committed.`);
    }
  }

  const carriesRunes = inputs.some((input) => input.assets.some((asset) => asset.assetType === 'RUNE'));
  let totalOut = 0n;
  const owners: Array<'maker' | 'taker' | 'data'> = [];
  const outputs: Array<{ scriptHex: string; valueSats: string }> = [];
  let dataOutputs = 0;
  for (let index = 0; index < tx.outputs.length; index += 1) {
    const output = tx.outputs[index] as SwapAcceptanceOutput;
    if (typeof output?.scriptHex !== 'string' || !EVEN_HEX.test(output.scriptHex)) {
      return acceptanceRefuse('OUTPUT_SCRIPT_INVALID', `Output ${index} does not carry lowercase hex script bytes.`);
    }
    const scriptHex = output.scriptHex;
    const value = parseSats(output.valueSats);
    if (value === null) {
      return acceptanceRefuse('OUTPUT_VALUE_INVALID', `Output ${index} does not carry an exact decimal value.`);
    }
    if (scriptHex.startsWith('6a')) {
      dataOutputs += 1;
      if (value !== 0n) return acceptanceRefuse('DATA_OUTPUT_BURNS_VALUE', `Output ${index} would burn ${String(output.valueSats)} sats in an OP_RETURN.`);
      if (dataOutputs > 1 || !carriesRunes || !scriptHex.startsWith('6a5d')) {
        return acceptanceRefuse('DATA_OUTPUT_NOT_PERMITTED', 'The only data output a swap may carry is one runestone for the runes it moves.');
      }
      if (scriptHex.length / 2 > MAX_OP_RETURN_RELAY_BYTES) {
        return acceptanceRefuse('DATA_OUTPUT_NONSTANDARD', `The runestone exceeds the ${MAX_OP_RETURN_RELAY_BYTES} byte relay limit.`);
      }
      owners.push('data');
    } else {
      const dust = dustThresholdSats(scriptHex) ?? 0n;
      if (value < dust) {
        return acceptanceRefuse('DUST_OUTPUT', `Output ${index} is below the ${dust} sat dust threshold for its script.`);
      }
      const owner = makerScripts.has(scriptHex) ? 'maker' : takerScripts.has(scriptHex) ? 'taker' : null;
      if (!owner) {
        return acceptanceRefuse('OUTPUT_UNOWNED', `Output ${index} pays a script that belongs to neither party.`);
      }
      owners.push(owner);
    }
    outputs.push({ scriptHex, valueSats: value.toString() });
    totalOut += value;
  }
  if (!owners.includes('maker') || !owners.includes('taker')) {
    return acceptanceRefuse('ATOMICITY_IMPOSSIBLE', 'Both parties must receive an output.');
  }
  const fee = totalIn - totalOut;
  if (fee < 0n) {
    return acceptanceRefuse('VALUE_NOT_CONSERVED', 'The outputs exceed the inputs.');
  }

  const shapes = checkTransitionShapes(a.assetTransitions, outputs.length);
  if (!shapes.ok) return passThrough(shapes);
  const flow = deriveAssetFlow({ network: i.network, height: height + 1, inputs, outputs });
  if (!flow.ok) return passThrough(flow);
  const matched = matchTransitions(a.assetTransitions as StatedTransition[], flow.movements);
  if (!matched.ok) return passThrough(matched);

  const gives = new Map<string, SwapGive>(
    i.gives.filter((g) => g.assetType !== 'BTC').map((g) => [`${String(g.assetType)}|${String(g.assetId)}`, g])
  );
  const requires = new Map<string, SwapRequirement>(
    i.requires.filter((r) => r.assetType !== 'BTC').map((r) => [`${String(r.assetType)}|${String(requiredId(r))}`, r])
  );
  const runeTotals = new Map<string, bigint>();
  const runeKey = (party: string, runeId: string): string => `${party}|${runeId}`;
  for (const input of inputs) {
    for (const asset of input.assets) {
      if (asset.assetType !== 'RUNE') continue;
      const k = runeKey(`${input.party}In`, asset.assetId);
      runeTotals.set(k, (runeTotals.get(k) ?? 0n) + BigInt(asset.amount));
    }
  }
  const crossed = new Map<number, 'maker' | 'taker'>();
  const kept = new Set<number>();
  const received = new Map<string, bigint>();
  for (const m of flow.movements) {
    const owner = owners[m.toOutput] as 'maker' | 'taker' | 'data';
    if (m.assetType === 'RUNE') {
      const k = runeKey(`${owner}Out`, m.assetId);
      runeTotals.set(k, (runeTotals.get(k) ?? 0n) + BigInt(m.quantity));
      continue;
    }
    const from = (inputs[m.fromInput as number] as PartyInput).party;
    const key = `${m.assetType}|${m.assetId}`;
    const give = gives.get(key);
    if (from === 'maker' && give) {
      if (outputs[m.toOutput]?.scriptHex !== takerReceive) {
        return acceptanceRefuse('MAKER_ASSET_NOT_DELIVERED', `${m.assetType} ${m.assetId} would not reach the taker receive script.`);
      }
      if (m.assetType === 'COUNTERPARTY' && m.quantity !== give.quantitySats) {
        return acceptanceRefuse(
          'GIVE_QUANTITY_MISMATCH',
          `Counterparty moves all ${m.quantity} of ${m.assetId}, not the ${String(give.quantitySats)} the intent gives.`
        );
      }
    } else if (from === 'taker' && requires.has(key)) {
      if (owner !== 'maker') {
        return acceptanceRefuse('CONSIDERATION_SHORTFALL', `${m.assetType} ${m.assetId} the maker requires would not reach the maker.`);
      }
      received.set(key, (received.get(key) ?? 0n) + BigInt(m.quantity));
    } else if (owner !== from) {
      return acceptanceRefuse('ASSET_MISDIRECTED', `${m.assetType} ${m.assetId} belongs to the ${from} and would land with the ${owner}.`);
    }
    if (m.assetType === 'ORDINAL' || m.assetType === 'RARE_SAT') {
      if (from === owner) kept.add(m.toOutput);
      else crossed.set(m.toOutput, owner as 'maker' | 'taker');
    }
  }
  // Postage travels with a sat-bound asset across parties, not as payment. An
  // output holding both a traded and an owner's own sat-bound asset has no
  // single meaning, so it is refused.
  let makerPostageIn = 0n;
  let takerPostageIn = 0n;
  for (const [output, owner] of crossed) {
    if (kept.has(output)) {
      return acceptanceRefuse('ASSET_OUTPUT_MIXED', `Output ${output} carries a traded sat-bound asset together with its owner's own.`);
    }
    const value = BigInt(outputs[output]?.valueSats ?? '0');
    if (owner === 'maker') makerPostageIn += value;
    else takerPostageIn += value;
  }
  for (const [key, give] of gives) {
    const [assetType, assetId] = key.split('|') as [string, string];
    if (assetType === 'RUNE') {
      const gain = (runeTotals.get(runeKey('takerOut', assetId)) ?? 0n) - (runeTotals.get(runeKey('takerIn', assetId)) ?? 0n);
      if (gain !== BigInt(give.quantitySats as string)) {
        return acceptanceRefuse('MAKER_ASSET_NOT_DELIVERED', `The taker would gain ${gain} of rune ${assetId}, not the ${String(give.quantitySats)} the intent gives.`);
      }
    } else if (!flow.movements.some((m) => m.assetType === assetType && m.assetId === assetId)) {
      return acceptanceRefuse('MAKER_ASSET_NOT_DELIVERED', `${assetType} ${assetId} is not moved by this transaction.`);
    }
  }
  for (const [key, requirement] of requires) {
    const [assetType, assetId] = key.split('|') as [string, string];
    const minimum = assetType === 'ORDINAL' ? 1n : BigInt(requirement.minQuantitySats as string);
    const got =
      assetType === 'RUNE'
        ? (runeTotals.get(runeKey('makerOut', assetId)) ?? 0n) - (runeTotals.get(runeKey('makerIn', assetId)) ?? 0n)
        : (received.get(key) ?? 0n);
    if (got < minimum) {
      return acceptanceRefuse('CONSIDERATION_SHORTFALL', `The maker would receive ${got} of ${assetType} ${assetId}, less than the ${minimum} it requires.`);
    }
  }
  const runeIds = new Set([...runeTotals.keys()].map((k) => k.split('|')[1] as string));
  for (const runeId of runeIds) {
    if (gives.has(`RUNE|${runeId}`) || requires.has(`RUNE|${runeId}`)) continue;
    for (const party of ['maker', 'taker']) {
      const gain = (runeTotals.get(runeKey(`${party}Out`, runeId)) ?? 0n) - (runeTotals.get(runeKey(`${party}In`, runeId)) ?? 0n);
      if (gain !== 0n) return acceptanceRefuse('ASSET_MISDIRECTED', `Rune ${runeId} would move between the parties though neither side trades it.`);
    }
  }

  const feeSpec = a.fee;
  if (!feeSpec || typeof feeSpec !== 'object') {
    return acceptanceRefuse('FEE_INVALID', 'The acceptance plan must carry a fee object.');
  }
  const declaredFee = parseSats(feeSpec.feeSats);
  const makerFee = parseSats(feeSpec.makerFeeSats);
  const takerFee = parseSats(feeSpec.takerFeeSats);
  if (declaredFee === null || makerFee === null || takerFee === null) {
    return acceptanceRefuse('FEE_INVALID', 'Fee contributions must be exact decimal strings.');
  }
  if (declaredFee !== fee) {
    return acceptanceRefuse('FEE_CHANGED', 'The declared fee does not match the transaction.');
  }
  let makerIn = 0n;
  let makerOut = 0n;
  for (const input of inputs) if (input.party === 'maker') makerIn += input.value;
  outputs.forEach((output, index) => {
    if (owners[index] === 'maker') makerOut += BigInt(output.valueSats);
  });
  const btcGiven = i.gives.filter((g) => g.assetType === 'BTC').reduce((n, g) => n + BigInt(g.quantitySats as string), 0n);
  const btcRequired = i.requires.filter((r) => r.assetType === 'BTC').reduce((n, r) => n + BigInt(r.minQuantitySats as string), 0n);
  const makerBtcChange = makerOut - makerPostageIn - makerIn + takerPostageIn;
  const makerFeeActual = btcRequired - btcGiven - makerBtcChange;
  if (makerFeeActual > BigInt(i.maxMakerFeeSats)) {
    return btcRequired > 0n
      ? acceptanceRefuse('CONSIDERATION_SHORTFALL', `The maker would receive less BTC than the ${btcRequired} sats it requires within its fee budget.`)
      : acceptanceRefuse('FEE_BUDGET_EXCEEDED', `The maker would contribute ${makerFeeActual} sats, above the budget the intent approved.`);
  }
  const takerFeeActual = fee - makerFeeActual;
  if (makerFee !== makerFeeActual || takerFee !== takerFeeActual) {
    return acceptanceRefuse(
      'FEE_SPLIT_INVALID',
      `From the value flow the maker contributes ${makerFeeActual} and the taker ${takerFeeActual}, not the ${String(feeSpec.makerFeeSats)} and ${String(feeSpec.takerFeeSats)} declared.`
    );
  }

  const digest = swapAcceptanceDigest(a);
  if (a.digest !== digest) {
    return acceptanceRefuse('DIGEST_MISMATCH', 'The acceptance digest does not match the plan.');
  }
  return { ok: true, digest, makerFeeSats: makerFeeActual.toString(), takerFeeSats: takerFeeActual.toString() };
}

export type SwapSettlementRefusalCode =
  | 'MALFORMED_SIGNED_RESULT'
  | 'ACCEPTANCE_DIGEST_MISMATCH'
  | 'TRANSACTION_CHANGED'
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_UNVERIFIABLE'
  | 'SIGNATURE_INVALID';

export type SwapSettlementVerdict =
  | { ok: true; txid: string }
  | { ok: false; code: SwapSettlementRefusalCode | SwapAcceptanceRefusalCode | SwapIntentRefusalCode; reason: string };

const settlementRefuse = (code: SwapSettlementRefusalCode | SwapAcceptanceRefusalCode, reason: string): SwapSettlementVerdict => ({
  ok: false,
  code,
  reason,
});

/**
 * Verify the fully signed settlement transaction of an accepted swap: the
 * exact planned transaction, every input signed and verified, every signature
 * closing the transaction with SIGHASH_ALL (or the Taproot default).
 */
// OX-P02: a settlement is proved from its bytes. Both parties' signatures must
// verify over the planned transaction, and only a closing sighash is accepted.
export function verifySwapSignedTransaction(signed: unknown, acceptance: unknown, intent: unknown): SwapSettlementVerdict {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    return settlementRefuse('MALFORMED_SIGNED_RESULT', 'Expected a signed settlement object.');
  }
  const s = signed as SwapSignedTransaction;
  if (s.schema !== SWAP_SIGNED_TRANSACTION_SCHEMA) {
    return settlementRefuse('SCHEMA_UNSUPPORTED', 'The signed settlement schema is not ordex.swap-signed-transaction/v1.');
  }
  const plan = verifySwapAcceptance(acceptance, intent);
  if (!plan.ok) return plan;
  const a = acceptance as SwapAcceptance;
  if (s.acceptanceDigest !== plan.digest) {
    return settlementRefuse('ACCEPTANCE_DIGEST_MISMATCH', 'The signed settlement was not produced from this acceptance plan.');
  }
  const parsed = parseTransaction(s.signedTxHex);
  if (!parsed.ok) return settlementRefuse('MALFORMED_SIGNED_RESULT', parsed.reason);
  const tx = parsed.tx;
  if (bytesToHex(serializeTransaction(unsignedCopy(tx))) !== bytesToHex(serializeTransaction(swapUnsignedTransaction(a)))) {
    return settlementRefuse('TRANSACTION_CHANGED', 'The signed settlement is not the planned transaction.');
  }
  const planInputs = a.tx?.inputs ?? [];
  const prevouts = planInputs.map((input) => ({
    valueSats: String(parseSats(input.valueSats)),
    scriptHex: input.scriptPubKeyHex as string,
  }));
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const verdict = verifyInputSignature(tx, index, prevouts);
    const party = String(planInputs[index]?.party);
    if (verdict.status === 'UNSIGNED') return settlementRefuse('SIGNATURE_MISSING', `Input ${index} of the ${party} is unsigned.`);
    if (verdict.status === 'UNSUPPORTED') return settlementRefuse('SIGNATURE_UNVERIFIABLE', `Input ${index} spends a script this verifier cannot check.`);
    if (verdict.status !== 'VALID') return settlementRefuse('SIGNATURE_INVALID', `Input ${index} carries a signature that does not verify against the planned transaction.`);
    const closing = verdict.type === 'p2tr' ? [0x00, 0x01] : [0x01];
    if (!closing.includes(verdict.sighashType as number)) {
      return settlementRefuse('UNCLOSED_SIGHASH', `Input ${index} was signed without committing to every input and output.`);
    }
  }
  return { ok: true, txid: parsed.txid };
}
