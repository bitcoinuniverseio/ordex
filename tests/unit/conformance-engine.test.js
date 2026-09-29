import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  FAMILIES,
  FAMILY_REGISTRY,
  executeVector,
  evaluateCandidate,
  compareExpected,
  normalizeVerdict,
  runConformanceSuite,
  variantOf
} from '../../site/src/lib/conformance-engine.mjs';
import { familyForFile } from '../../site/src/lib/conformance-registry.mjs';
import { loadVectorFamily, loadAllFamilies } from '../../scripts/docs/vector-loader.mjs';
import { handleVerifierJob } from '../../site/src/lib/verifier-jobs.mjs';

test('conformance-engine exports all 9 vector families', () => {
  assert.equal(FAMILIES.length, 9);
  for (const f of ['purchase', 'offers', 'runes', 'safeops', 'swaps', 'events', 'collection-manifest', 'counterparty-asset', 'offline-signing']) {
    assert.ok(FAMILIES.includes(f), f);
  }
});

test('the executor module imports no Node built-ins and reads no files', async () => {
  for (const file of ['conformance-engine.mjs', 'conformance-registry.mjs', 'verifier-jobs.mjs', 'verifier-worker.mjs', 'verifier-client.mjs']) {
    const src = await readFile(new URL(`../../site/src/lib/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `${file} imports a node: module`);
    assert.doesNotMatch(src, /fileURLToPath|readFileSync/, `${file} touches the file system`);
  }
});

test('file names map to executor family names through the registry', () => {
  assert.equal(familyForFile('offer-vectors.json'), 'offers');
  assert.equal(familyForFile('event-vectors.json'), 'events');
  assert.equal(familyForFile('swap-vectors.json'), 'swaps');
  assert.equal(familyForFile('rune-burn-vectors.json'), 'runes');
  assert.equal(familyForFile('nope-vectors.json'), null);
});

test('loadVectorFamily loads purchase vectors properly', () => {
  const vectors = loadVectorFamily('purchase');
  assert.ok(vectors.length > 0);
  assert.equal(vectors[0].family, 'purchase');
  assert.ok(vectors[0].expected);
});

test('executeVector accurately passes an accepted purchase vector', () => {
  const validCase = loadVectorFamily('purchase').find((v) => v.expected?.ok === true);
  const res = executeVector('purchase', validCase);
  assert.equal(res.passed, true);
  assert.equal(res.actual.ok, true);
  assert.equal(res.outcome, 'EXPECTED_ACCEPTANCE_MATCHED');
});

test('executeVector reports a matched refusal as a refusal, not an acceptance', () => {
  const refusedCase = loadVectorFamily('purchase').find((v) => v.expected?.code === 'SAT_FLOW_SHORTFALL');
  const res = executeVector('purchase', refusedCase);
  assert.equal(res.passed, true);
  assert.equal(res.actual.ok, false);
  assert.equal(res.actual.code, 'SAT_FLOW_SHORTFALL');
  assert.equal(res.outcome, 'EXPECTED_REFUSAL_MATCHED');
  assert.equal(res.verdict.state, 'refused');
});

test('every family and every variant is exercised by at least one source vector', () => {
  const data = loadAllFamilies();
  for (const family of FAMILIES) {
    const seen = new Set(data[family].cases.map((c) => variantOf(family, c)));
    for (const variant of Object.keys(FAMILY_REGISTRY[family].variants)) {
      assert.ok(seen.has(variant), `${family}/${variant} has no vector`);
    }
  }
});

test('rune vectors compare safe, runestone and the flaw list, not a generic ok', () => {
  const cenotaph = loadVectorFamily('runes').find((c) => c.expected.flaw);
  assert.equal(executeVector('runes', cenotaph).passed, true);
  const wrongFlaw = structuredClone(cenotaph);
  wrongFlaw.expected.flaw = 'NOT_A_FLAW';
  const res = executeVector('runes', wrongFlaw);
  assert.equal(res.passed, false);
  assert.deepEqual(res.mismatches.map((m) => m.field), ['flaw']);
  const safe = loadVectorFamily('runes').find((c) => c.expected.safe === true);
  assert.equal(executeVector('runes', safe).verdict.state, 'accepted');
});

test('an expected field the engine cannot compare fails instead of being skipped', () => {
  const c = structuredClone(loadVectorFamily('swaps')[0]);
  c.expected.somethingNew = 1;
  const res = executeVector('swaps', c);
  assert.equal(res.passed, false);
  assert.ok(res.mismatches.some((m) => m.field === 'somethingNew'));
});

test('a changed expectation is detected field by field', () => {
  const c = structuredClone(loadVectorFamily('offers').find((v) => v.expected.offerTermsHash));
  c.expected.offerTermsHash = '0'.repeat(64);
  assert.equal(executeVector('offers', c).passed, false);
  const p = structuredClone(loadVectorFamily('purchase').find((v) => v.expected.sharedIndex !== undefined));
  p.expected.sharedIndex += 1;
  assert.equal(executeVector('purchase', p).passed, false);
});

test('generated entries keep the full source case and run identically', async () => {
  const generated = JSON.parse(await readFile(new URL('../../site/src/data/allVectors.json', import.meta.url), 'utf8'));
  const source = loadAllFamilies();
  let count = 0;
  for (const family of FAMILIES) {
    source[family].cases.forEach((c, i) => {
      const entry = generated.find((g) => g.family === family && g.index === i);
      assert.ok(entry, `${family} case ${i} missing from generated data`);
      assert.deepEqual(entry.case, c);
      const a = executeVector(family, c);
      const b = executeVector(family, entry);
      assert.equal(a.passed, b.passed);
      assert.deepEqual(a.verdict, b.verdict);
      assert.deepEqual(a.mismatches, b.mismatches);
      count++;
    });
  }
  assert.equal(count, generated.length);
});

test('an empty or unknown selection never reports success', () => {
  const empty = runConformanceSuite({ purchase: { cases: [] } }, ['purchase']);
  assert.equal(empty.success, false);
  assert.equal(empty.summary.empty, true);
  assert.throws(() => runConformanceSuite(loadAllFamilies(), ['nope']), /Unsupported verifier family/);
  assert.throws(() => runConformanceSuite(null), /No vector data/);
});

test('a malformed case is a failed result, not a thrown error', () => {
  const res = executeVector('purchase', { name: 'broken', transaction: null, order: null, expected: { ok: true } });
  assert.equal(res.passed, false);
  assert.equal(res.verdict.state, 'refused');
});

test('candidates run without a manufactured expectation', () => {
  const plan = loadVectorFamily('safeops').find((c) => !c.signed && c.expected.ok === true);
  const accepted = evaluateCandidate('safeops', 'plan', { plan: plan.plan });
  assert.equal(accepted.verdict.state, 'accepted');
  assert.ok(accepted.raw.digest);
  const signed = loadVectorFamily('safeops').find((c) => c.signed && c.expected.ok === true);
  assert.equal(evaluateCandidate('safeops', 'signed', { signed: signed.signed, plan: signed.plan }).verdict.state, 'accepted');
  const broken = evaluateCandidate('safeops', 'plan', { plan: { ...plan.plan, schema: 'nope' } });
  assert.equal(broken.verdict.state, 'refused');
  assert.throws(() => evaluateCandidate('safeops', 'signed', { plan: plan.plan }), /needs: signed/);
  assert.throws(() => evaluateCandidate('safeops', 'nope', {}), /Unknown safeops variant/);
});

test('normalizeVerdict maps rune safe and generic ok, and anything else is unknown', () => {
  assert.equal(normalizeVerdict('runes', { safe: true }).state, 'accepted');
  assert.equal(normalizeVerdict('runes', { ok: true }).state, 'unknown');
  assert.equal(normalizeVerdict('offers', { ok: false, code: 'X' }).code, 'X');
  assert.equal(normalizeVerdict('offers', {}).state, 'unknown');
});

test('compareExpected requires the family result field', () => {
  assert.equal(compareExpected('runes', { ok: true }, { safe: true }).passed, false);
});

test('worker jobs run suites, single cases and bounded candidates', () => {
  const data = loadAllFamilies();
  const progress = [];
  const suite = handleVerifierJob({ type: 'suite', familiesData: data, families: FAMILIES }, (p) => progress.push(p));
  assert.equal(suite.total, 356);
  assert.equal(suite.success, true);
  assert.deepEqual(progress.at(-1), { completed: 356, total: 356 });
  const one = handleVerifierJob({ type: 'case', family: 'events', vectorCase: data.events.cases[0] });
  assert.equal(one.passed, true);
  const cand = handleVerifierJob({ type: 'candidate', family: 'events', variant: 'event', args: { event: data.events.cases[0].event }, expected: data.events.cases[0].expected });
  assert.equal(cand.conformance.passed, true);
  assert.throws(() => handleVerifierJob({ type: 'nope' }), /Unknown verifier job type/);
  const huge = { plan: { blob: 'x'.repeat(3 * 1024 * 1024) } };
  assert.throws(() => handleVerifierJob({ type: 'candidate', family: 'safeops', variant: 'plan', args: huge }), /exceeds/);
});
