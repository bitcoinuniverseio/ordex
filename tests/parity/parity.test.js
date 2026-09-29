import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAllVectors } from '../../site/src/lib/conformance-engine.mjs';

// The count is explicit so a vector that silently disappears fails the build.
// ORD-11 raised it from 151 by adding six purchase vectors: the Core native
// single-dummy layout and its one-sat shortfall, a nonzero asset offset,
// insufficient padding, a payout raised above the ask, and a malformed input
// entry that must produce a verdict rather than a thrown error.
test('220/220 official protocol vectors pass deterministically against reference verifiers', () => {
  const result = runAllVectors();
  assert.equal(result.total, 220, `Expected 220 vectors, ran ${result.total}`);
  assert.equal(result.failed, 0, `Expected 0 failures, had ${result.failed}`);
  assert.equal(result.passed, 220, `Expected 220 passed, had ${result.passed}`);
});
