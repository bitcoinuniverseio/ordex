import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAllVectors } from '../../site/src/lib/conformance-engine.mjs';

// The count is explicit so a vector that silently disappears fails the build.
// ORD-11 raised it from 151 by adding six purchase vectors: the Core native
// single-dummy layout and its one-sat shortfall, a nonzero asset offset,
// insufficient padding, a payout raised above the ask, and a malformed input
// entry that must produce a verdict rather than a thrown error. OX-P04 raised
// it to 220 with 63 rune vectors for ord 0.29.0 field consumption and
// allocation, and OX-P10 to 236 with Counterparty v11.4.0 move vectors that
// replace the old sat-flow ones.
test('236/236 official protocol vectors pass deterministically against reference verifiers', () => {
  const result = runAllVectors();
  assert.equal(result.total, 236, `Expected 236 vectors, ran ${result.total}`);
  assert.equal(result.failed, 0, `Expected 0 failures, had ${result.failed}`);
  assert.equal(result.passed, 236, `Expected 236 passed, had ${result.passed}`);
});
