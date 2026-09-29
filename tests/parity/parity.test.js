import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAllVectors } from '../../site/src/lib/conformance-engine.mjs';

// The count is explicit so a vector that silently disappears fails the build.
// ORD-11 raised it from 151 by adding six purchase vectors: the Core native
// single-dummy layout and its one-sat shortfall, a nonzero asset offset,
// insufficient padding, a payout raised above the ask, and a malformed input
// entry that must produce a verdict rather than a thrown error. OX-P04 raised
// it to 220 with 63 rune vectors for ord 0.29.0 field consumption and
// allocation, OX-P10 to 236 with Counterparty v11.4.0 move vectors that
// replace the old sat-flow ones, OX-P01 to 261 with SafeOps v2 vectors that
// carry real signatures, OX-P03 to 278 with cold signing v2 results read from
// raw transactions and PSBT v0 and v2, and OX-P02 to 294 with swap acceptance
// v2 plans judged by derived asset movements.
test('294/294 official protocol vectors pass deterministically against reference verifiers', () => {
  const result = runAllVectors();
  assert.equal(result.total, 294, `Expected 294 vectors, ran ${result.total}`);
  assert.equal(result.failed, 0, `Expected 0 failures, had ${result.failed}`);
  assert.equal(result.passed, 294, `Expected 294 passed, had ${result.passed}`);
});
