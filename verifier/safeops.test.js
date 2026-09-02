import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SAFEOPS_PLAN_SCHEMA,
  parseSats,
  safeopsPlanDigest,
  sortedJson,
  verifySafeOpsPlan,
  verifySafeOpsSignedResult,
} from './safeops.js';

const vectorsPath = fileURLToPath(new URL('../conformance/safeops-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    if (!vector.signed) {
      const verdict = verifySafeOpsPlan(vector.plan);
      assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
      if (vector.expected.ok) assert.equal(verdict.digest, vector.plan.digest);
      else assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
      return;
    }
    const verdict = verifySafeOpsSignedResult(vector.signed, vector.plan);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (!vector.expected.ok) assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
  });
}

test('the plan schema name is stable', () => {
  assert.equal(SAFEOPS_PLAN_SCHEMA, 'ordex.safeops-plan/v1');
});

test('a malformed plan is refused, never thrown on', () => {
  assert.equal(verifySafeOpsPlan(null).ok, false);
  assert.equal(verifySafeOpsPlan('plan').ok, false);
  assert.equal(verifySafeOpsPlan({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(verifySafeOpsSignedResult(null, null).ok, false);
});

test('the digest excludes findings and the digest itself', () => {
  const plan = {
    schema: SAFEOPS_PLAN_SCHEMA,
    network: 'regtest',
    operationKind: 'BTC_BATCH_SEND',
    inputs: [],
    outputs: [],
    fee: {},
    signing: {},
    findings: [{ severity: 'low', message: 'a' }],
    digest: 'x',
  };
  const withoutFindings = { ...plan, findings: [] };
  assert.equal(safeopsPlanDigest(plan), safeopsPlanDigest(withoutFindings));
  assert.equal(sortedJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('parseSats accepts only exact non-negative decimal strings', () => {
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats('546'), 546n);
  for (const bad of ['', '-1', '1.5', '01', '1e3', ' 546', '546 ', null, undefined, 546, 546n]) {
    assert.equal(parseSats(bad), null, `expected ${String(bad)} to be refused`);
  }
});
