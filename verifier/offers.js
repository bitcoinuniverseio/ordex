// Reference verifier for Ordex offers v1.
//
// This file restates spec/offers.md as executable checks. It is the same
// verifier as sdk/src/offers.ts, and both are run against
// conformance/offer-vectors.json, so they cannot drift apart without a test
// failing.
//
// The structural rules are checked here. Signature validity and consensus
// rules remain the node's authority, asset coverage remains the ord index's,
// and the two policy signatures come from two independent signer services
// whose independence is a deployment property, not a property of this file.
//
// Every amount is an atomic integer carried as a decimal string and handled
// as BigInt. Floating point never appears here.

import { createHash } from 'node:crypto';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const INSCRIPTION = /^[0-9a-f]{64}i[0-9]+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const KINDS = ['ITEM', 'COLLECTION', 'TRAIT'];
export const OFFER_TERMS_SCHEMA = 'ordex.offer-terms/v1';

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

/** SHA-256 over the exact serialized form of the terms, as lowercase hex. */
export function offerTermsHash(terms) {
  return createHash('sha256').update(sortedJson(terms), 'utf8').digest('hex');
}

const termsRefuse = (code, reason) => ({ ok: false, code, reason });

/*
 * IMPLEMENTATION-HANDOFF [OX-P05] Local integration steps; ANNOTATED is not implemented.
 * Coverage: OX-P-C003, OX-P-C004, OX-P-C005, OX-P-C006, OX-P-C007.
 * P-R16 accepts expiryHeight500000000 while recovery rejects it as timestamp. 1. Restrict
 * height-domain expiry to safe integer0..499999999, and align exact Hex-suffixed field names with
 * spec/offers.md. 2. Keep hash canonicalization unchanged for existing terms; version any incompatible
 * new fields. 3. Run PROPOSED NEW verifier/offers.delivery-recovery.test.js plus existing
 * verifier/offers.test.js, asserting499999999/500000000 boundary and no funded-output
 * reinterpretation. Source P-S08 BIP65 and P-S07 BIP370 height domain; Core OX-B01 policy services
 * depend on corrected terms. Test command node --test verifier/offers.test.js
 * verifier/offers.delivery-recovery.test.js unverified until new file exists. Rollback keeps
 * historical hashes and original recovery rights.
 */
export function verifyOfferTerms(terms) {
  if (!terms || typeof terms !== 'object' || Array.isArray(terms)) {
    return termsRefuse('MALFORMED_TERMS', 'Expected a terms object.');
  }
  const t = terms;
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
    if (!known.has(key)) return termsRefuse('MALFORMED_TERMS', `Unknown field ${key}.`);
  }
  if (t.schema !== OFFER_TERMS_SCHEMA) {
    return termsRefuse('TERMS_SCHEMA_UNSUPPORTED', 'The terms schema is not ordex.offer-terms/v1.');
  }
  if (typeof t.protocolVersion !== 'string' || !/^1\.[1-9][0-9]*$/.test(t.protocolVersion)) {
    return termsRefuse('TERMS_PROTOCOL_UNSUPPORTED', 'The terms protocol version must be 1.1 or a later 1.x.');
  }
  if (typeof t.network !== 'string' || !NETWORKS.includes(t.network)) {
    return termsRefuse('TERMS_NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof t.offerKind !== 'string' || !KINDS.includes(t.offerKind)) {
    return termsRefuse('TERMS_KIND_UNKNOWN', 'The offer kind is not one this protocol names.');
  }
  if (t.offerKind === 'ITEM') {
    if (typeof t.itemInscriptionId !== 'string' || !INSCRIPTION.test(t.itemInscriptionId)) {
      return termsRefuse('TERMS_SCOPE_FIELDS', 'An ITEM offer must name exactly one inscription id.');
    }
    if (t.traitName !== undefined || t.traitValue !== undefined) {
      return termsRefuse('TERMS_SCOPE_FIELDS', 'An ITEM offer must not carry trait fields.');
    }
  } else if (t.offerKind === 'TRAIT') {
    if (typeof t.traitName !== 'string' || t.traitName.length === 0 || t.traitName.length > 128) {
      return termsRefuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must name one trait of at most 128 characters.');
    }
    if (typeof t.traitValue !== 'string' || t.traitValue.length === 0 || t.traitValue.length > 256) {
      return termsRefuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must name one trait value of at most 256 characters.');
    }
    if (t.itemInscriptionId !== undefined) {
      return termsRefuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must not carry an item inscription id.');
    }
  } else if (t.itemInscriptionId !== undefined || t.traitName !== undefined || t.traitValue !== undefined) {
    return termsRefuse('TERMS_SCOPE_FIELDS', 'A COLLECTION offer must not scope further.');
  }
  if (typeof t.collectionId !== 'string' || t.collectionId.length === 0 || t.collectionId.length > 200) {
    return termsRefuse('MALFORMED_TERMS', 'The terms must name a collection id.');
  }
  if (typeof t.collectionRoot !== 'string' || !HEX64.test(t.collectionRoot)) {
    return termsRefuse('TERMS_ROOT_INVALID', 'The collection root must be 64 lowercase hex characters.');
  }
  if (typeof t.criteriaHash !== 'string' || !HEX64.test(t.criteriaHash)) {
    return termsRefuse('TERMS_CRITERIA_INVALID', 'The criteria hash must be 64 lowercase hex characters.');
  }
  if (typeof t.buyerReceiveScriptHex !== 'string' || !EVEN_HEX.test(t.buyerReceiveScriptHex)) {
    return termsRefuse('TERMS_SCRIPT_INVALID', 'The buyer receive script must be lowercase hex bytes.');
  }
  if (parseSats(t.priceSats) === null) {
    return termsRefuse('TERMS_AMOUNT_INVALID', 'priceSats must be an exact decimal string.');
  }
  if (parseSats(t.maxNetworkFeeSats) === null) {
    return termsRefuse('TERMS_AMOUNT_INVALID', 'maxNetworkFeeSats must be an exact decimal string.');
  }
  if (
    typeof t.expiryHeight !== 'number' ||
    !Number.isSafeInteger(t.expiryHeight) ||
    t.expiryHeight < 0 ||
    t.expiryHeight > 2147483647
  ) {
    return termsRefuse('TERMS_EXPIRY_INVALID', 'expiryHeight must be a block height a node can carry.');
  }
  if (typeof t.buyerRecoveryKeyHex !== 'string' || !HEX64.test(t.buyerRecoveryKeyHex)) {
    return termsRefuse('TERMS_RECOVERY_KEY_INVALID', 'The buyer recovery key must be 64 lowercase hex characters.');
  }
  return { ok: true, offerTermsHash: offerTermsHash(t) };
}

const acceptanceRefuse = (code, reason) => ({ ok: false, code, reason });

/*
 * IMPLEMENTATION-HANDOFF [OX-P05] Preparation only; functional status FAIL, repair NOT IMPLEMENTED.
 * Coverage: OX-P-C003, OX-P-C004, OX-P-C005, OX-P-C006, OX-P-C007. Evidence: P-R14, P-R15, P-R16 in
 * handoff/evidence.
 * Verified cause: Buyer script occurrence before seller index does not prove Feline delivery; recovery
 * comparisons accept missing locktime; terms permit height>=500000000. Leaf substring checks do not
 * prove exact script structure/commitment.
 * Required behavior: Complete funded-offer acceptance/recovery contract. Governing refs: P-S01
 * (Ord0.29.0 applicability; handbook accessed2026-09-29); P-S05 (BIP174 at
 * bips3a10b5b5f0a7586df8928d580a3009744ebb2079); P-S06 (BIP341;
 * blob0764e6cb762b6c17d3b3430af5532e0c63365993); P-S08 (BIP65 deployed;
 * blob4bd292f8b45a2b2b68013b24f45c23e354b70e4f); complete URLs in reports/protocol.md.
 * Prerequisites/order: OX-P03, OX-P04. Related files: sdk/src/offers.ts, spec/offers.md; Core/backend
 * or site consumer named by the work package.
 * 1. Normalize offer terms with exact shared field names buyerReceiveScriptHex/buyerRecoveryKeyHex;
 * restrict height-domain expiry to safe integer0..499999999 and validate
 * currentHeight/locktime/sequence/outpoints explicitly.
 * 2. Require canonical acceptance/recovery tapscript bytes and verify committed Taproot tree/control
 * block with two independent policy keys and buyer recovery key; cryptographic witness/node validation
 * remains required before success.
 * 3. Derive actual inscription satpoint and complete co-traveling inventory; require exact
 * Feline-to-buyer interval/destination, preserve all other assets to seller, seller payout
 * index/value/script, exact funded-input position, described outputs only and fee bounds.
 * 4. Resolve currently unspecified buyer-padding spend authorization before construction: spec says
 * buyer signs only funding, yet acceptance spends buyer padding. Record and implement an explicit
 * consent/signing contract with backend policy services, no assumed signature.
 * 5. Mirror reference/SDK and correct spec/offers.md field/expiry/authorization ambiguities; retain
 * discovery-withdrawal vs on-chain recovery distinction.
 * Validation (PROPOSED NEW tests, commands unverified until implemented):
 * verifier/offers.delivery-recovery.test.js, sdk/test/offers.delivery-recovery.test.js. node --test
 * verifier/offers.test.js verifier/offers.delivery-recovery.test.js; npm --prefix sdk run build; node
 * --test sdk/test/offers.test.js sdk/test/offers.delivery-recovery.test.js.
 * Assertions/evidence: Buyer-script swap that sends Feline to other output refuses;
 * Absent/NaN/time-domain locktime, final sequence, fake opcode bytes inside data and mismatched tree
 * refuse; ITEM/COLLECTION/TRAIT wrong root/trait and extra assets fail; correct ones settle through
 * independent signers; Signet expiry boundary and buyer-only recovery confirmed;
 * reorg/retry/withdrawal semantics truthful. Offline probes are not end-to-end PASS; require actual
 * Signet transaction and indexed/consumer readback where applicable.
 * Rollback: Do not reinterpret funded output trees or terms hashes. Existing funds retain original
 * recovery terms; new schema/gated offers only after signet acceptance. Document recovery for any
 * prior funded incompatible offer.
 */
export function verifyOfferAcceptance(acceptance, offer) {
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

  const offerSpends = [];
  const felineSpends = [];
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

  const n = felineSpends[0];
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
    const value = parseSats(acceptance.inputs[i] && acceptance.inputs[i].valueSats);
    if (value === null) {
      return acceptanceRefuse('INPUT_VALUE_UNKNOWN', `The value of input ${i} could not be read, so the invariant cannot be proved.`);
    }
    inputsAhead += value;
  }
  const felineValue = parseSats(acceptance.inputs[n] && acceptance.inputs[n].valueSats);
  if (felineValue === null) {
    return acceptanceRefuse('INPUT_VALUE_UNKNOWN', 'The Feline output value could not be read, so the invariant cannot be proved.');
  }
  let outputsAhead = 0n;
  for (let i = 0; i < n; i += 1) {
    const value = parseSats(acceptance.outputs[i] && acceptance.outputs[i].valueSats);
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
    if (acceptance.outputs[i] && acceptance.outputs[i].scriptHex === offer.buyerReceiveScriptHex) buyerAssetOutputs += 1;
  }
  if (buyerAssetOutputs !== 1) {
    return acceptanceRefuse(
      'BUYER_ASSET_OUTPUT_MISSING',
      'The buyer receive script must appear exactly once ahead of the seller payment.',
    );
  }

  let totalIn = 0n;
  for (const input of acceptance.inputs) {
    const value = parseSats(input && input.valueSats);
    if (value === null) return acceptanceRefuse('INPUT_VALUE_UNKNOWN', 'An input value could not be read, so the fee cannot be proved.');
    totalIn += value;
  }
  let totalOut = 0n;
  for (const output of acceptance.outputs) {
    const value = parseSats(output && output.valueSats);
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

const recoveryRefuse = (code, reason) => ({ ok: false, code, reason });

/*
 * IMPLEMENTATION-HANDOFF [OX-P05] Local integration steps; ANNOTATED is not implemented.
 * Coverage: OX-P-C003, OX-P-C004, OX-P-C005, OX-P-C006, OX-P-C007.
 * P-R15 accepts absent nLockTime; substring tests can mistake key/opcode bytes inside pushed data for
 * script policy. 1. Parse/validate safe integer locktime<500000000, expiry, nonfinal uint32 sequence
 * and exact outpoints before comparisons. 2. Rebuild canonical <expiry> CLTV DROP <buyerKey> CHECKSIG
 * and verify Taproot leaf/control-block commitment plus node-valid signature; no substring acceptance.
 * 3. Require exact permitted input/output set and fee contract. Related verifyOfferTerms,
 * sdk/src/offers.ts, spec/offers.md, Core OX-B01. Sources P-S06/P-S08. PROPOSED NEW
 * verifier/offers.delivery-recovery.test.js; node --test verifier/offers.test.js
 * verifier/offers.delivery-recovery.test.js (unverified). Test missing/NaN/timestamp/final-sequence
 * and Signet expiry recovery. Rollback never alters existing funded trees/recovery rights.
 */
export function verifyOfferRecovery(recovery, offer) {
  if (!recovery || !Array.isArray(recovery.inputs) || !Array.isArray(recovery.outputs)) {
    return recoveryRefuse('MALFORMED_RECOVERY', 'Expected inputs and outputs arrays.');
  }
  if (!offer || !offer.offerOutpoint || typeof offer.buyerRecoveryKeyHex !== 'string') {
    return recoveryRefuse('MALFORMED_OFFER', 'Expected the offer outpoint and the recovery key.');
  }
  const spendIndexes = [];
  for (let i = 0; i < recovery.inputs.length; i += 1) {
    const input = recovery.inputs[i];
    if (input && input.txid === offer.offerOutpoint.txid && input.vout === offer.offerOutpoint.vout) spendIndexes.push(i);
  }
  if (spendIndexes.length === 0) return recoveryRefuse('OFFER_OUTPOINT_MISSING', 'No input spends the funded output.');
  if (spendIndexes.length > 1) return recoveryRefuse('OFFER_OUTPOINT_DUPLICATED', 'The funded output appears twice.');
  if (recovery.nLockTime < offer.expiryHeight) {
    return recoveryRefuse('RECOVERY_BEFORE_EXPIRY', 'The locktime is below the expiry height.');
  }
  if (recovery.nLockTime >= 500000000) {
    return recoveryRefuse('RECOVERY_BEFORE_EXPIRY', 'The locktime is a timestamp, not the block height the terms committed to.');
  }
  const sequence = recovery.inputs[spendIndexes[0]] && recovery.inputs[spendIndexes[0]].sequence;
  if (sequence !== undefined && sequence >= 0xffffffff) {
    return recoveryRefuse('SEQUENCE_NOT_REPLACEABLE', 'A final sequence disables the locktime the recovery relies on.');
  }
  if (typeof recovery.recoveryLeafScriptHex !== 'string' || !EVEN_HEX.test(recovery.recoveryLeafScriptHex)) {
    return recoveryRefuse('RECOVERY_LEAF_MISMATCH', 'The recovery leaf must be lowercase hex bytes.');
  }
  if (!recovery.recoveryLeafScriptHex.includes(offer.buyerRecoveryKeyHex)) {
    return recoveryRefuse('RECOVERY_LEAF_MISMATCH', 'The revealed leaf does not carry the buyer recovery key.');
  }
  if (!recovery.recoveryLeafScriptHex.includes('b1')) {
    return recoveryRefuse('RECOVERY_LEAF_MISMATCH', 'The revealed leaf carries no CHECKLOCKTIMEVERIFY.');
  }
  if (recovery.outputs.length !== 1) {
    return recoveryRefuse('RECOVERY_OUTPUT_WRONG', 'A recovery pays one output, the buyer receive script.');
  }
  const output = recovery.outputs[0];
  if (!output || output.scriptHex !== offer.buyerReceiveScriptHex) {
    return recoveryRefuse('RECOVERY_OUTPUT_WRONG', 'The recovery does not pay the buyer receive script.');
  }
  const spent = parseSats(recovery.inputs[spendIndexes[0]] && recovery.inputs[spendIndexes[0]].valueSats);
  const paid = parseSats(output.valueSats);
  if (spent === null || paid === null || paid > spent) {
    return recoveryRefuse('MALFORMED_RECOVERY', 'The recovery values could not be proved exact.');
  }
  return { ok: true };
}
