import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAllVectors } from '../../site/src/lib/conformance-engine.mjs';

test('151/151 official protocol vectors pass deterministically against reference verifiers', () => {
  const result = runAllVectors();
  assert.equal(result.total, 151, `Expected 151 vectors, ran ${result.total}`);
  assert.equal(result.failed, 0, `Expected 0 failures, had ${result.failed}`);
  assert.equal(result.passed, 151, `Expected 151 passed, had ${result.passed}`);
});
