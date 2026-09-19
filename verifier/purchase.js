// Reference verifier for completing an Ordex public ask.
//
// This file restates spec/purchase.md as executable checks. It takes the
// already parsed shape of a final transaction and answers whether the
// arrangement satisfies the two rules that decide who receives the asset.
// Parsing raw bytes, reading input values from a node, and consulting the
// ord index are the caller's responsibility; the gateway does all three
// before it runs these same checks.
//
// Every amount is an atomic integer carried as a decimal string and handled
// as BigInt. Floating point never appears here.

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Parse an exact non-negative decimal string into a BigInt.
 * Returns null for anything else, including '', '-1', '1.5', '01', 1, 1n.
 */
export function parseSats(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

const refuse = (code, reason) => ({ ok: false, code, reason });

/**
 * Verify a final public ask completion.
 *
 * transaction:
 *   inputs:  [{ txid, vout, valueSats }]  in transaction order.
 *            valueSats is the exact value of the output being spent, as a
 *            decimal string, or null when the caller could not read it.
 *   outputs: [{ scriptHex, valueSats }]   in transaction order.
 *
 * order:
 *   offeredOutpoint:        { txid, vout }  the output being sold.
 *   sellerPaymentScriptHex: the script the seller's signature commits to.
 *   sellerPaymentValueSats: the asking price, as a decimal string.
 *
 * Answers { ok: true, sharedIndex } or { ok: false, code, reason }.
 * Codes are stable and machine readable; reasons are for people.
 */
/*
 * IMPLEMENTATION-HANDOFF [ORD-11] [A023]
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
 * 1. Keep seller input and payment at the same index and verify the complete offered sat range is
 * absorbed before the seller payout. The Core native single-dummy layout and Ordex two-padding layout
 * need separate vectors, not one hardcoded index assertion.
 * 2. Add or connect cross-repository vectors produced by Core Ordinals construction for nonzero asset
 * offsets, duplicate offered outpoints, insufficient padding, altered seller payout and unknown
 * funding values. Reject invalid flows before network send.
 * 3. Mirror any legitimate verifier change in sdk/src/purchase.ts and its tests; retain public-ask
 * race semantics and no-sign/no-funds authority boundaries. Existing verifier is not classified
 * defective without a failing vector.
 * Tests: Ordex node --test verifier/purchase.test.js; SDK purchase parity suite; Core Ordex
 * authority/listing/purchase suites; real Signet public-ask round trip.
 * Acceptance: The actual List entry creates a usable signed ask; purchase preserves seller
 * input/output pairing and moves the full offered sat range to the receiver. The UI reports public-ask
 * races honestly and never claims a non-reserved public artifact is exclusively reserved.
 * Migration/rollback: Do not bump the Core gitlink to an unreviewed branch. Merge accepted Ordex
 * changes first, pin that exact commit in Core, and preserve all outstanding signed artifacts and
 * order provenance during rollout.
 */
export function verifyPublicAskCompletion(transaction, order) {
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

  // Rule one: the offered outpoint must appear at exactly one index.
  const offered = order.offeredOutpoint;
  const matches = [];
  for (let i = 0; i < transaction.inputs.length; i += 1) {
    const input = transaction.inputs[i];
    // A malformed entry is refused below, never dereferenced here: this
    // function answers with a verdict and must not throw on hostile input.
    if (input && input.txid === offered.txid && input.vout === offered.vout)
      matches.push(i);
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
  const n = matches[0];

  // Rule one, continued: the seller's payment output must sit at the same
  // index, with exactly the script and value the signature commits to.
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

  // Rule two: outputs ahead of the payment must absorb every sat of the
  // offered output's range. Evaluating that needs the exact value of the
  // offered input and of every input ahead of it; an unreadable value is a
  // refusal, never a guess.
  let inputsAhead = 0n;
  for (let i = 0; i < n; i += 1) {
    const value = parseSats(transaction.inputs[i] && transaction.inputs[i].valueSats);
    if (value === null) {
      return refuse(
        'INPUT_VALUE_UNKNOWN',
        `The value of input ${i} could not be read, so the sat flow invariant cannot be evaluated.`,
      );
    }
    inputsAhead += value;
  }
  const offeredValue = parseSats(
    transaction.inputs[n] && transaction.inputs[n].valueSats,
  );
  if (offeredValue === null) {
    return refuse(
      'INPUT_VALUE_UNKNOWN',
      'The value of the offered output could not be read, so the sat flow invariant cannot be evaluated.',
    );
  }

  let outputsAhead = 0n;
  for (let i = 0; i < n; i += 1) {
    const value = parseSats(transaction.outputs[i] && transaction.outputs[i].valueSats);
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
