/**
 * The purchase rules from spec/purchase.md, typed.
 *
 * This is the same verifier as verifier/purchase.js at the repository root,
 * ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/purchase-vectors.json, so they cannot drift apart
 * without a test failing.
 */

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Parse an exact non-negative decimal string into a bigint.
 * Anything else, including '', '-1', '1.5', '01', and non-strings, is null.
 */
export function parseSats(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

export type PurchaseRefusalCode =
  | 'MALFORMED_TRANSACTION'
  | 'MALFORMED_ORDER'
  | 'OFFERED_OUTPOINT_MISSING'
  | 'OFFERED_OUTPOINT_DUPLICATED'
  | 'SELLER_OUTPUT_MISSING'
  | 'SELLER_SCRIPT_MISMATCH'
  | 'SELLER_VALUE_MISMATCH'
  | 'INPUT_VALUE_UNKNOWN'
  | 'SAT_FLOW_SHORTFALL';

export interface PurchaseTransaction {
  /** In transaction order. valueSats is null when the caller could not read it. */
  inputs: Array<{ txid: string; vout: number; valueSats: string | null }>;
  outputs: Array<{ scriptHex: string; valueSats: string }>;
}

export interface PurchaseOrderTerms {
  offeredOutpoint: { txid: string; vout: number };
  sellerPaymentScriptHex: string;
  sellerPaymentValueSats: string;
}

export type PurchaseVerdict =
  | { ok: true; sharedIndex: number }
  | { ok: false; code: PurchaseRefusalCode; reason: string };

const refuse = (code: PurchaseRefusalCode, reason: string): PurchaseVerdict => ({
  ok: false,
  code,
  reason,
});

/**
 * Verify a final public ask completion. See spec/purchase.md for the two
 * rules and the sat flow invariant this enforces.
 */
/*
 * IMPLEMENTATION-HANDOFF [ORD-11] [A024]
 * Preparation only: executable behavior unchanged; remove only after evidenced implementation.
 * Coverage: ORD-11-01, ORD-11-02, ORD-11-03, ORD-11-04, ORD-11-05, ORD-11-06, ORD-11-07, ORD-11-08.
 * Defects/gaps: U01.
 * Current evidence (NOT TESTED): The hub List control sends users to
 * /ordex/orders?intent=listing&protocol=ordinals&side=ASK. Core pins Ordex
 * d7d1378cecdc833a96b9a2b542acf0dc4463934b while the separate checkout and remote branches have later
 * work. The public-ask sat-flow verifier exists; no Ordex end-to-end pass was performed in this
 * preparation.
 * Sources: R-ORDEX, R-TAPROOT, R-ORD in the bundled RESEARCH.md.
 * Prerequisites: ORD-04, ORD-05, ORD-09, ORD-10. Local implementation:
 * 1. Keep byte-for-byte semantic parity with verifier/purchase.js for the Core integration vectors
 * from ORD-11; use exact bigint amounts and preserve the public order terms.
 * 2. Add SDK tests for both valid Core native and Ordex padding arrangements and all invalid sat-flow
 * vectors. Do not update Core's gitlink until verifier, SDK and Core integration tests agree at an
 * accepted revision.
 * Tests: Ordex node --test verifier/purchase.test.js; SDK purchase parity suite; Core Ordex
 * authority/listing/purchase suites; real Signet public-ask round trip.
 * Acceptance: The actual List entry creates a usable signed ask; purchase preserves seller
 * input/output pairing and moves the full offered sat range to the receiver. The UI reports public-ask
 * races honestly and never claims a non-reserved public artifact is exclusively reserved.
 * Migration/rollback: Do not bump the Core gitlink to an unreviewed branch. Merge accepted Ordex
 * changes first, pin that exact commit in Core, and preserve all outstanding signed artifacts and
 * order provenance during rollout.
 */
export function verifyPublicAskCompletion(
  transaction: PurchaseTransaction,
  order: PurchaseOrderTerms,
): PurchaseVerdict {
  if (!transaction || !Array.isArray(transaction.inputs) || !Array.isArray(transaction.outputs)) {
    return refuse('MALFORMED_TRANSACTION', 'Expected inputs and outputs arrays.');
  }
  if (
    !order ||
    !order.offeredOutpoint ||
    typeof order.offeredOutpoint.txid !== 'string' ||
    !Number.isInteger(order.offeredOutpoint.vout)
  ) {
    return refuse('MALFORMED_ORDER', 'Expected an offered outpoint with txid and vout.');
  }

  const askPrice = parseSats(order.sellerPaymentValueSats);
  if (askPrice === null) {
    return refuse('MALFORMED_ORDER', 'sellerPaymentValueSats must be an exact decimal string.');
  }
  if (typeof order.sellerPaymentScriptHex !== 'string' || order.sellerPaymentScriptHex.length === 0) {
    return refuse('MALFORMED_ORDER', 'sellerPaymentScriptHex must be a nonempty hex string.');
  }

  const offered = order.offeredOutpoint;
  const matches: number[] = [];
  for (let i = 0; i < transaction.inputs.length; i += 1) {
    const input = transaction.inputs[i];
    if (input && input.txid === offered.txid && input.vout === offered.vout) matches.push(i);
  }
  if (matches.length === 0) {
    return refuse('OFFERED_OUTPOINT_MISSING', 'No input spends the offered output.');
  }
  if (matches.length > 1) {
    return refuse(
      'OFFERED_OUTPOINT_DUPLICATED',
      'The offered outpoint appears at more than one index, so one signature would answer for two positions.',
    );
  }
  const n = matches[0] as number;

  const payment = transaction.outputs[n];
  if (!payment) {
    return refuse(
      'SELLER_OUTPUT_MISSING',
      `No output exists at index ${n}, the index the seller's signed input occupies.`,
    );
  }
  if (payment.scriptHex !== order.sellerPaymentScriptHex) {
    return refuse(
      'SELLER_SCRIPT_MISMATCH',
      `The output at index ${n} does not pay the script the seller's signature commits to.`,
    );
  }
  const paymentValue = parseSats(payment.valueSats);
  if (paymentValue === null || paymentValue !== askPrice) {
    return refuse(
      'SELLER_VALUE_MISMATCH',
      `The output at index ${n} does not carry the exact asking price.`,
    );
  }

  let inputsAhead = 0n;
  for (let i = 0; i < n; i += 1) {
    const value = parseSats(transaction.inputs[i]?.valueSats);
    if (value === null) {
      return refuse(
        'INPUT_VALUE_UNKNOWN',
        `The value of input ${i} could not be read, so the sat flow invariant cannot be evaluated.`,
      );
    }
    inputsAhead += value;
  }
  const offeredValue = parseSats(transaction.inputs[n]?.valueSats);
  if (offeredValue === null) {
    return refuse(
      'INPUT_VALUE_UNKNOWN',
      'The value of the offered output could not be read, so the sat flow invariant cannot be evaluated.',
    );
  }

  let outputsAhead = 0n;
  for (let i = 0; i < n; i += 1) {
    const value = parseSats(transaction.outputs[i]?.valueSats);
    if (value === null) {
      return refuse('MALFORMED_TRANSACTION', `Output ${i} does not carry an exact decimal value.`);
    }
    outputsAhead += value;
  }

  if (outputsAhead < inputsAhead + offeredValue) {
    return refuse(
      'SAT_FLOW_SHORTFALL',
      'The outputs ahead of the seller payment do not absorb the whole range the offered output occupies, ' +
        'so part of the asset would land inside the payment going back to the seller.',
    );
  }

  return { ok: true, sharedIndex: n };
}
