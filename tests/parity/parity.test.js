import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runConformanceSuite, FAMILIES } from '../../site/src/lib/conformance-engine.mjs';
import { loadAllFamilies, buildVectorManifest } from '../../scripts/docs/vector-loader.mjs';

// The count is explicit so a vector that silently disappears fails the build.
// ORD-11 raised it from 151 by adding six purchase vectors: the Core native
// single-dummy layout and its one-sat shortfall, a nonzero asset offset,
// insufficient padding, a payout raised above the ask, and a malformed input
// entry that must produce a verdict rather than a thrown error. OX-P04 raised
// it to 220 with 63 rune vectors for ord 0.29.0 field consumption and
// allocation, OX-P10 to 236 with Counterparty v11.4.0 move vectors that
// replace the old sat-flow ones, OX-P01 to 261 with SafeOps v2 vectors that
// carry real signatures, OX-P03 to 278 with cold signing v2 results read from
// raw transactions and PSBT v0 and v2, OX-P02 to 294 with swap acceptance
// v2 plans judged by derived asset movements, OX-P05 to 337 with funded
// offer acceptances and recoveries proved from signed transaction bytes,
// OX-P09 to 342 with revocations bound to their network and collection, and
// OX-P11 to 349 with webhook rotation overlap and hash-as-key refusals.
test('349/349 official protocol vectors pass deterministically against reference verifiers', () => {
  const result = runConformanceSuite(loadAllFamilies());
  assert.equal(result.total, 349, `Expected 349 vectors, ran ${result.total}`);
  assert.equal(result.failed, 0, `Expected 0 failures, had ${result.failed}`);
  assert.equal(result.passed, 349, `Expected 349 passed, had ${result.passed}`);
});

// OX-S07: the browser runs generated data, the CLI runs source files. Both go through the
// same executor and must agree case by case on every field, not only on totals.
test('generated data and source files give identical results case by case', async () => {
  const generated = JSON.parse(await readFile(new URL('../../site/src/data/vectorFamilies.json', import.meta.url), 'utf8'));
  const fromSource = runConformanceSuite(loadAllFamilies(), FAMILIES);
  const fromGenerated = runConformanceSuite(generated, FAMILIES);
  assert.equal(fromGenerated.total, fromSource.total);
  assert.equal(fromGenerated.total, buildVectorManifest().total);
  fromSource.results.forEach((a, i) => {
    const b = fromGenerated.results[i];
    assert.equal(b.family, a.family);
    assert.equal(b.variant, a.variant);
    assert.equal(b.name, a.name);
    assert.equal(b.passed, a.passed, `${a.family}/${a.name}`);
    assert.equal(b.outcome, a.outcome, `${a.family}/${a.name}`);
    assert.deepEqual(b.verdict, a.verdict, `${a.family}/${a.name}`);
    assert.deepEqual(b.actual, a.actual, `${a.family}/${a.name}`);
  });
});
