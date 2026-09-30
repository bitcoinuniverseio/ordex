import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  argsFromCase,
  validateCandidate,
  inputDigest,
  stableJson,
  diffPaths,
  buildLabReport,
  labReportMarkdown,
  assetOutputIndex
} from '../../site/src/lib/lab-report.mjs';
import { evaluateCandidate, FAMILIES, variantOf } from '../../site/src/lib/conformance-engine.mjs';
import { loadAllFamilies } from '../../scripts/docs/vector-loader.mjs';
import { resultKey } from '../../site/src/lib/conformance-registry.mjs';

// OX-S07: every accepted and refused example the Lab offers, for every family and variant,
// reaches the same verdict as a candidate that it reaches as a conformance vector.
test('Lab candidates built from vector arguments reproduce every vector verdict', () => {
  const data = loadAllFamilies();
  let n = 0;
  for (const family of FAMILIES) {
    for (const c of data[family].cases) {
      const variant = variantOf(family, c);
      const args = argsFromCase(family, variant, c);
      assert.equal(validateCandidate(family, variant, args).ok, true, `${family}/${c.name}`);
      const res = evaluateCandidate(family, variant, args);
      const expectAccept = c.expected[resultKey(family, variant)] === true;
      assert.equal(res.verdict.state, expectAccept ? 'accepted' : 'refused', `${family}/${c.name}`);
      if (!expectAccept && c.expected.code) assert.equal(res.verdict.code, c.expected.code, `${family}/${c.name}`);
      n++;
    }
  }
  assert.equal(n, 356);
});

test('candidate validation rejects missing, unknown and non-object input', () => {
  assert.match(validateCandidate('offers', 'acceptance', { acceptance: {} }).error, /offer/);
  assert.match(validateCandidate('offers', 'terms', { terms: {}, extra: 1 }).error, /extra/);
  assert.equal(validateCandidate('offers', 'terms', []).ok, false);
  assert.equal(validateCandidate('offers', 'nope', {}).ok, false);
  assert.equal(validateCandidate('runes', 'burn-safety', { outputScriptsHex: [], inputs: [], outputCount: 1 }).ok, true);
});

test('input digests are stable across key order and equal to an independent SHA-256', () => {
  const a = { b: 1, a: [1, { d: 2, c: 3 }] };
  const b = { a: [1, { c: 3, d: 2 }], b: 1 };
  assert.equal(inputDigest(a), inputDigest(b));
  assert.equal(inputDigest(a), createHash('sha256').update(stableJson(a)).digest('hex'));
  assert.notEqual(inputDigest(a), inputDigest({ ...a, b: 2 }));
});

test('diffPaths reports changed, added and removed paths', () => {
  const d = diffPaths({ x: 1, y: { z: [1, 2] }, gone: 1 }, { x: 2, y: { z: [1, 3] }, fresh: 1 });
  assert.deepEqual(d, [
    { path: 'x', change: 'changed' },
    { path: 'y.z[1]', change: 'changed' },
    { path: 'gone', change: 'removed' },
    { path: 'fresh', change: 'added' }
  ]);
  assert.deepEqual(diffPaths({ a: 1 }, { a: 1 }), []);
});

test('the exported report carries the digest, build and verdict but never the input', () => {
  const run = {
    family: 'purchase',
    variant: 'completion',
    args: { transaction: { secretish: 'bc1qexampleaddressvalue000000000000000' } },
    inputSha256: 'ab'.repeat(32),
    verdict: { state: 'refused', code: 'SAT_FLOW_SHORTFALL', reason: 'short' },
    conformance: { passed: true, mismatches: [] },
    vectorId: 'purchase/x',
    ranAt: '2026-09-29T00:00:00.000Z'
  };
  const report = buildLabReport({ run, sourceBuild: 'abc123', vectorDigest: 'dd', context: { network: 'n/a' } });
  assert.equal(report.inputSha256, run.inputSha256);
  assert.equal(report.sourceBuild, 'abc123');
  assert.equal(report.verdict.code, 'SAT_FLOW_SHORTFALL');
  assert.ok(!JSON.stringify(report).includes('bc1qexample'));
  assert.match(labReportMarkdown(report), /REFUSED/);
  assert.match(labReportMarkdown(report), /expected verdict matched/);
});

test('sat flow places the asset by first-in first-out value, not a fixed index', () => {
  const tx = loadAllFamilies().purchase.cases[0].transaction;
  // Padding 600 + 600 lands in output 0 (1200); the offered input's first sat is sat 1200, in output 1.
  assert.equal(assetOutputIndex(tx.inputs, tx.outputs, 2), 1);
  assert.equal(assetOutputIndex([{ valueSats: '10' }], [{ valueSats: '10' }], 0), 0);
  assert.equal(assetOutputIndex([{ valueSats: 'x' }, { valueSats: '1' }], [{ valueSats: '5' }], 1), -1);
  assert.equal(assetOutputIndex([{ valueSats: '10' }, { valueSats: '1' }], [{ valueSats: '5' }], 1), -1);
});
