/**
 * The offer rules from spec/offers.md, typed.
 *
 * This is the same verifier as verifier/offers.js at the repository root,
 * ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/offer-vectors.json, so they cannot drift apart
 * without a test failing.
 *
 * Two sentences describe the trust model the way a buyer or a seller needs
 * them stated: a valid acceptance requires two independent policy signers,
 * and after the expiry height the buyer can recover alone. Before expiry the
 * two policy signers together could spend the funded output outside these
 * rules, so an offer is not trustless, and nothing here may describe it as
 * trustless.
 */

import { createHash } from 'node:crypto';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const INSCRIPTION = /^[0-9a-f]{64}i[0-9]+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const KINDS = ['ITEM', 'COLLECTION', 'TRAIT'];

/** Parse an exact non-negative decimal string into a bigint, or null. */
export function parseSats(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

export const OFFER_TERMS_SCHEMA = 'ordex.offer-terms/v1';

export type OfferKind = 'ITEM' | 'COLLECTION' | 'TRAIT';

export interface OfferTerms {
  schema: string;
  protocolVersion: string;
  network: string;
  offerKind: OfferKind;
  collectionId: string;
  collectionRoot: string;
  itemInscriptionId?: string;
  traitName?: string;
  traitValue?: string;
  criteriaHash: string;
  buyerReceiveScriptHex: string;
  priceSats: string;
  maxNetworkFeeSats: string;
  expiryHeight: number;
  buyerRecoveryKeyHex: string;
}

export type OfferTermsRefusalCode =
  | 'MALFORMED_TERMS'
  | 'TERMS_SCHEMA_UNSUPPORTED'
  | 'TERMS_PROTOCOL_UNSUPPORTED'
  | 'TERMS_NETWORK_UNKNOWN'
  | 'TERMS_KIND_UNKNOWN'
  | 'TERMS_SCOPE_FIELDS'
  | 'TERMS_ROOT_INVALID'
  | 'TERMS_CRITERIA_INVALID'
  | 'TERMS_SCRIPT_INVALID'
  | 'TERMS_AMOUNT_INVALID'
  | 'TERMS_EXPIRY_INVALID'
  | 'TERMS_RECOVERY_KEY_INVALID';

export type OfferTermsVerdict =
  | { ok: true; offerTermsHash: string }
  | { ok: false; code: OfferTermsRefusalCode; reason: string };

const refuse = (code: OfferTermsRefusalCode, reason: string): OfferTermsVerdict => ({
  ok: false,
  code,
  reason,
});

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

/** SHA-256 over the exact serialized form of the terms, as lowercase hex. */
export function offerTermsHash(terms: OfferTerms): string {
  return createHash('sha256').update(sortedJson(terms), 'utf8').digest('hex');
}

/**
 * Verify offer terms field by field and answer their hash. A hash that
 * matches nothing is refused everywhere; verifiers recompute it.
 */
export function verifyOfferTerms(terms: unknown): OfferTermsVerdict {
  if (!terms || typeof terms !== 'object' || Array.isArray(terms)) {
    return refuse('MALFORMED_TERMS', 'Expected a terms object.');
  }
  const t = terms as Record<string, unknown>;
  const known = new Set([
    'schema',
    'protocolVersion',
    'network',
    'offerKind',
    'collectionId',
    'collectionRoot',
    'itemInscriptionId',
    'traitName',
    'traitValue',
    'criteriaHash',
    'buyerReceiveScriptHex',
    'priceSats',
    'maxNetworkFeeSats',
    'expiryHeight',
    'buyerRecoveryKeyHex',
  ]);
  for (const key of Object.keys(t)) {
    if (!known.has(key)) return refuse('MALFORMED_TERMS', `Unknown field ${key}.`);
  }
  if (t.schema !== OFFER_TERMS_SCHEMA) {
    return refuse('TERMS_SCHEMA_UNSUPPORTED', 'The terms schema is not ordex.offer-terms/v1.');
  }
  if (typeof t.protocolVersion !== 'string' || !/^1\.[1-9][0-9]*$/.test(t.protocolVersion)) {
    return refuse('TERMS_PROTOCOL_UNSUPPORTED', 'The terms protocol version must be 1.1 or a later 1.x.');
  }
  if (typeof t.network !== 'string' || !NETWORKS.includes(t.network)) {
    return refuse('TERMS_NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof t.offerKind !== 'string' || !KINDS.includes(t.offerKind)) {
    return refuse('TERMS_KIND_UNKNOWN', 'The offer kind is not one this protocol names.');
  }
  const kind = t.offerKind as OfferKind;
  if (kind === 'ITEM') {
    if (typeof t.itemInscriptionId !== 'string' || !INSCRIPTION.test(t.itemInscriptionId)) {
      return refuse('TERMS_SCOPE_FIELDS', 'An ITEM offer must name exactly one inscription id.');
    }
    if (t.traitName !== undefined || t.traitValue !== undefined) {
      return refuse('TERMS_SCOPE_FIELDS', 'An ITEM offer must not carry trait fields.');
    }
  } else if (kind === 'TRAIT') {
    if (typeof t.traitName !== 'string' || t.traitName.length === 0 || t.traitName.length > 128) {
      return refuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must name one trait of at most 128 characters.');
    }
    if (typeof t.traitValue !== 'string' || t.traitValue.length === 0 || t.traitValue.length > 256) {
      return refuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must name one trait value of at most 256 characters.');
    }
    if (t.itemInscriptionId !== undefined) {
      return refuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must not carry an item inscription id.');
    }
  } else {
    if (t.itemInscriptionId !== undefined || t.traitName !== undefined || t.traitValue !== undefined) {
      return refuse('TERMS_SCOPE_FIELDS', 'A COLLECTION offer must not scope further.');
    }
  }
  if (typeof t.collectionId !== 'string' || t.collectionId.length === 0 || t.collectionId.length > 200) {
    return refuse('MALFORMED_TERMS', 'The terms must name a collection id.');
  }
  if (typeof t.collectionRoot !== 'string' || !HEX64.test(t.collectionRoot)) {
    return refuse('TERMS_ROOT_INVALID', 'The collection root must be 64 lowercase hex characters.');
  }
  if (typeof t.criteriaHash !== 'string' || !HEX64.test(t.criteriaHash)) {
    return refuse('TERMS_CRITERIA_INVALID', 'The criteria hash must be 64 lowercase hex characters.');
  }
  if (typeof t.buyerReceiveScriptHex !== 'string' || !EVEN_HEX.test(t.buyerReceiveScriptHex)) {
    return refuse('TERMS_SCRIPT_INVALID', 'The buyer receive script must be lowercase hex bytes.');
  }
  if (parseSats(t.priceSats) === null) {
    return refuse('TERMS_AMOUNT_INVALID', 'priceSats must be an exact decimal string.');
  }
  if (parseSats(t.maxNetworkFeeSats) === null) {
    return refuse('TERMS_AMOUNT_INVALID', 'maxNetworkFeeSats must be an exact decimal string.');
  }
  if (
    typeof t.expiryHeight !== 'number' ||
    !Number.isSafeInteger(t.expiryHeight) ||
    t.expiryHeight < 0 ||
    t.expiryHeight > 2147483647
  ) {
    return refuse('TERMS_EXPIRY_INVALID', 'expiryHeight must be a block height a node can carry.');
  }
  if (typeof t.buyerRecoveryKeyHex !== 'string' || !HEX64.test(t.buyerRecoveryKeyHex)) {
    return refuse('TERMS_RECOVERY_KEY_INVALID', 'The buyer recovery key must be 64 lowercase hex characters.');
  }
  return { ok: true, offerTermsHash: offerTermsHash(t as unknown as OfferTerms) };
}

export type OfferAcceptanceRefusalCode =
  | 'MALFORMED_ACCEPTANCE'
  | 'MALFORMED_OFFER'
  | 'OFFER_OUTPOINT_MISSING'
  | 'OFFER_OUTPOINT_DUPLICATED'
  | 'FELINE_OUTPOINT_MISSING'
  | 'FELINE_OUTPOINT_DUPLICATED'
  | 'SELLER_OUTPUT_MISSING'
  | 'SELLER_SCRIPT_MISMATCH'
  | 'SELLER_VALUE_MISMATCH'
  | 'INPUT_VALUE_UNKNOWN'
  | 'SAT_FLOW_SHORTFALL'
  | 'POLICY_SIGNATURES_MISSING'
  | 'TERMS_HASH_NOT_COMMITTED'
  | 'FEE_OVER_MAXIMUM'
  | 'BUYER_ASSET_OUTPUT_MISSING'
  | 'OFFER_EXPIRED';

export interface OfferAcceptanceTransaction {
  /** In transaction order. valueSats is null when the caller could not read it. */
  inputs: Array<{ txid: string; vout: number; valueSats: string | null }>;
  outputs: Array<{ scriptHex: string; valueSats: string }>;
  /** How many acceptance-leaf signatures the offer input's witness carries. */
  policySignatureCount: number;
  /** The acceptance leaf the witness reveals, lowercase hex. */
  acceptanceLeafScriptHex: string;
}

export interface OfferAcceptanceContext {
  offerOutpoint: { txid: string; vout: number };
  felineOutpoint: { txid: string; vout: number };
  offerTermsHash: string;
  sellerPaymentScriptHex: string;
  priceSats: string;
  maxNetworkFeeSats: string;
  buyerReceiveScriptHex: string;
  expiryHeight: number;
  currentHeight: number;
}

export type OfferAcceptanceVerdict =
  | { ok: true; sharedIndex: number }
  | { ok: false; code: OfferAcceptanceRefusalCode; reason: string };

const acceptanceRefuse = (code: OfferAcceptanceRefusalCode, reason: string): OfferAcceptanceVerdict => ({
  ok: false,
  code,
  reason,
});

/**
 * Verify a built acceptance against its offer. This is the structural half
 * of the seven rules in spec/offers.md; signature validity and consensus
 * rules remain the node's authority, and asset coverage remains the ord
 * index's.
 */
export function verifyOfferAcceptance(
  acceptance: OfferAcceptanceTransaction,
  offer: OfferAcceptanceContext,
): OfferAcceptanceVerdict {
  if (
    !acceptance ||
    !Array.isArray(acceptance.inputs) ||
    !Array.isArray(acceptance.outputs) ||
    !Number.isSafeInteger(acceptance.policySignatureCount)
  ) {
    return acceptanceRefuse('MALFORMED_ACCEPTANCE', 'Expected inputs, outputs, and a policy signature count.');
  }
  if (
    !offer ||
    !offer.offerOutpoint ||
    !offer.felineOutpoint ||
    typeof offer.offerTermsHash !== 'string' ||
    !HEX64.test(offer.offerTermsHash)
  ) {
    return acceptanceRefuse('MALFORMED_OFFER', 'Expected both outpoints and the terms hash.');
  }
  if (acceptance.policySignatureCount !== 2) {
    return acceptanceRefuse(
      'POLICY_SIGNATURES_MISSING',
      'A valid acceptance carries exactly one signature from each independent policy signer.',
    );
  }
  if (typeof acceptance.acceptanceLeafScriptHex !== 'string' || !EVEN_HEX.test(acceptance.acceptanceLeafScriptHex)) {
    return acceptanceRefuse('MALFORMED_ACCEPTANCE', 'The acceptance leaf must be lowercase hex bytes.');
  }
  if (!acceptance.acceptanceLeafScriptHex.includes(offer.offerTermsHash)) {
    return acceptanceRefuse(
      'TERMS_HASH_NOT_COMMITTED',
      'The revealed acceptance leaf does not commit to this offer terms hash.',
    );
  }

  if (offer.currentHeight >= offer.expiryHeight) {
    return acceptanceRefuse('OFFER_EXPIRED', 'The expiry height has passed; recovery is the only remaining path.');
  }

  const offerSpends: number[] = [];
  const felineSpends: number[] = [];
  for (let i = 0; i < acceptance.inputs.length; i += 1) {
    const input = acceptance.inputs[i];
    if (!input) continue;
    if (input.txid === offer.offerOutpoint.txid && input.vout === offer.offerOutpoint.vout) offerSpends.push(i);
    if (input.txid === offer.felineOutpoint.txid && input.vout === offer.felineOutpoint.vout) felineSpends.push(i);
  }
  if (offerSpends.length === 0) return acceptanceRefuse('OFFER_OUTPOINT_MISSING', 'No input spends the funded offer output.');
  if (offerSpends.length > 1) {
    return acceptanceRefuse('OFFER_OUTPOINT_DUPLICATED', 'The funded output appears at more than one index.');
  }
  if (felineSpends.length === 0) return acceptanceRefuse('FELINE_OUTPOINT_MISSING', 'No input spends the seller Feline output.');
  if (felineSpends.length > 1) {
    return acceptanceRefuse('FELINE_OUTPOINT_DUPLICATED', 'The Feline outpoint appears at more than one index.');
  }

  const n = felineSpends[0] as number;
  const price = parseSats(offer.priceSats);
  if (price === null) return acceptanceRefuse('MALFORMED_OFFER', 'priceSats must be an exact decimal string.');
  const maxFee = parseSats(offer.maxNetworkFeeSats);
  if (maxFee === null) return acceptanceRefuse('MALFORMED_OFFER', 'maxNetworkFeeSats must be an exact decimal string.');

  const payment = acceptance.outputs[n];
  if (!payment) {
    return acceptanceRefuse('SELLER_OUTPUT_MISSING', `No output exists at index ${n}, the index the seller signed.`);
  }
  if (payment.scriptHex !== offer.sellerPaymentScriptHex) {
    return acceptanceRefuse('SELLER_SCRIPT_MISMATCH', 'The output at the seller index does not pay the signed script.');
  }
  const paymentValue = parseSats(payment.valueSats);
  if (paymentValue === null || paymentValue !== price) {
    return acceptanceRefuse('SELLER_VALUE_MISMATCH', 'The seller payment is not the exact offer price.');
  }

  let inputsAhead = 0n;
  for (let i = 0; i < n; i += 1) {
    const value = parseSats(acceptance.inputs[i]?.valueSats);
    if (value === null) {
      return acceptanceRefuse('INPUT_VALUE_UNKNOWN', `The value of input ${i} could not be read, so the invariant cannot be proved.`);
    }
    inputsAhead += value;
  }
  const felineValue = parseSats(acceptance.inputs[n]?.valueSats);
  if (felineValue === null) {
    return acceptanceRefuse('INPUT_VALUE_UNKNOWN', 'The Feline output value could not be read, so the invariant cannot be proved.');
  }
  let outputsAhead = 0n;
  for (let i = 0; i < n; i += 1) {
    const value = parseSats(acceptance.outputs[i]?.valueSats);
    if (value === null) return acceptanceRefuse('MALFORMED_ACCEPTANCE', `Output ${i} does not carry an exact decimal value.`);
    outputsAhead += value;
  }
  if (outputsAhead < inputsAhead + felineValue) {
    return acceptanceRefuse(
      'SAT_FLOW_SHORTFALL',
      'The outputs ahead of the seller payment do not absorb the whole range the Feline occupies.',
    );
  }

  let buyerAssetOutputs = 0;
  for (let i = 0; i < n; i += 1) {
    if (acceptance.outputs[i]?.scriptHex === offer.buyerReceiveScriptHex) buyerAssetOutputs += 1;
  }
  if (buyerAssetOutputs !== 1) {
    return acceptanceRefuse(
      'BUYER_ASSET_OUTPUT_MISSING',
      'The buyer receive script must appear exactly once ahead of the seller payment.',
    );
  }

  let totalIn = 0n;
  for (const input of acceptance.inputs) {
    const value = parseSats(input?.valueSats);
    if (value === null) return acceptanceRefuse('INPUT_VALUE_UNKNOWN', 'An input value could not be read, so the fee cannot be proved.');
    totalIn += value;
  }
  let totalOut = 0n;
  for (const output of acceptance.outputs) {
    const value = parseSats(output?.valueSats);
    if (value === null) return acceptanceRefuse('MALFORMED_ACCEPTANCE', 'An output value is not an exact decimal string.');
    totalOut += value;
  }
  const fee = totalIn - totalOut;
  if (fee < 0n) return acceptanceRefuse('MALFORMED_ACCEPTANCE', 'The outputs carry more than the inputs.');
  if (fee > maxFee) {
    return acceptanceRefuse('FEE_OVER_MAXIMUM', 'The fee exceeds the maximum the terms committed to.');
  }

  return { ok: true, sharedIndex: n };
}

export type OfferRecoveryRefusalCode =
  | 'MALFORMED_RECOVERY'
  | 'MALFORMED_OFFER'
  | 'OFFER_OUTPOINT_MISSING'
  | 'OFFER_OUTPOINT_DUPLICATED'
  | 'RECOVERY_BEFORE_EXPIRY'
  | 'RECOVERY_LEAF_MISMATCH'
  | 'RECOVERY_OUTPUT_WRONG'
  | 'SEQUENCE_NOT_REPLACEABLE';

export interface OfferRecoveryTransaction {
  inputs: Array<{ txid: string; vout: number; valueSats: string | null; sequence?: number }>;
  outputs: Array<{ scriptHex: string; valueSats: string }>;
  nLockTime: number;
  recoveryLeafScriptHex: string;
}

export type OfferRecoveryVerdict =
  | { ok: true }
  | { ok: false; code: OfferRecoveryRefusalCode; reason: string };

/**
 * Verify a recovery against its offer. After the expiry height the buyer
 * signs alone; a node refuses the same transaction one block earlier, so the
 * calendar is enforced by consensus and rechecked here.
 */
export function verifyOfferRecovery(recovery: OfferRecoveryTransaction, offer: {
  offerOutpoint: { txid: string; vout: number };
  buyerRecoveryKeyHex: string;
  buyerReceiveScriptHex: string;
  expiryHeight: number;
}): OfferRecoveryVerdict {
  if (!recovery || !Array.isArray(recovery.inputs) || !Array.isArray(recovery.outputs)) {
    return { ok: false, code: 'MALFORMED_RECOVERY', reason: 'Expected inputs and outputs arrays.' };
  }
  if (!offer || !offer.offerOutpoint || typeof offer.buyerRecoveryKeyHex !== 'string') {
    return { ok: false, code: 'MALFORMED_OFFER', reason: 'Expected the offer outpoint and the recovery key.' };
  }
  const spendIndexes: number[] = [];
  for (let i = 0; i < recovery.inputs.length; i += 1) {
    const input = recovery.inputs[i];
    if (input && input.txid === offer.offerOutpoint.txid && input.vout === offer.offerOutpoint.vout) spendIndexes.push(i);
  }
  if (spendIndexes.length === 0) return { ok: false, code: 'OFFER_OUTPOINT_MISSING', reason: 'No input spends the funded output.' };
  if (spendIndexes.length > 1) return { ok: false, code: 'OFFER_OUTPOINT_DUPLICATED', reason: 'The funded output appears twice.' };
  if (recovery.nLockTime < offer.expiryHeight) {
    return { ok: false, code: 'RECOVERY_BEFORE_EXPIRY', reason: 'The locktime is below the expiry height.' };
  }
  if (recovery.nLockTime >= 500000000) {
    return { ok: false, code: 'RECOVERY_BEFORE_EXPIRY', reason: 'The locktime is a timestamp, not the block height the terms committed to.' };
  }
  const sequence = recovery.inputs[spendIndexes[0] ?? -1]?.sequence;
  if (sequence !== undefined && sequence >= 0xffffffff) {
    return { ok: false, code: 'SEQUENCE_NOT_REPLACEABLE', reason: 'A final sequence disables the locktime the recovery relies on.' };
  }
  if (typeof recovery.recoveryLeafScriptHex !== 'string' || !EVEN_HEX.test(recovery.recoveryLeafScriptHex)) {
    return { ok: false, code: 'RECOVERY_LEAF_MISMATCH', reason: 'The recovery leaf must be lowercase hex bytes.' };
  }
  if (!recovery.recoveryLeafScriptHex.includes(offer.buyerRecoveryKeyHex)) {
    return { ok: false, code: 'RECOVERY_LEAF_MISMATCH', reason: 'The revealed leaf does not carry the buyer recovery key.' };
  }
  if (!recovery.recoveryLeafScriptHex.includes('b1')) {
    return { ok: false, code: 'RECOVERY_LEAF_MISMATCH', reason: 'The revealed leaf carries no CHECKLOCKTIMEVERIFY.' };
  }
  if (recovery.outputs.length !== 1) {
    return { ok: false, code: 'RECOVERY_OUTPUT_WRONG', reason: 'A recovery pays one output, the buyer receive script.' };
  }
  const output = recovery.outputs[0];
  if (!output || output.scriptHex !== offer.buyerReceiveScriptHex) {
    return { ok: false, code: 'RECOVERY_OUTPUT_WRONG', reason: 'The recovery does not pay the buyer receive script.' };
  }
  const spent = parseSats(recovery.inputs[spendIndexes[0] ?? -1]?.valueSats);
  const paid = parseSats(output.valueSats);
  if (spent === null || paid === null || paid > spent) {
    return { ok: false, code: 'MALFORMED_RECOVERY', reason: 'The recovery values could not be proved exact.' };
  }
  return { ok: true };
}
