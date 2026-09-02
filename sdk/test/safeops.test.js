import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SAFEOPS_PLAN_SCHEMA,
  SAFEOPS_PROTOCOL_MIN,
  SAFEOPS_SIGNED_RESULT_SCHEMA,
  parseSats,
  safeopsPlanDigest,
  sortedJson,
  verifySafeOpsPlan,
  verifySafeOpsSignedResult,
} from '../dist/index.js';

const vectorsPath = fileURLToPath(new URL('../../conformance/safeops-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    const verdict = vector.signed
      ? verifySafeOpsSignedResult(vector.signed, vector.plan)
      : verifySafeOpsPlan(vector.plan);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (vector.expected.ok) {
      if ('digest' in vector.expected) assert.equal(verdict.digest, vector.expected.digest);
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    }
  });
}

test('the schema names are stable', () => {
  assert.equal(SAFEOPS_PLAN_SCHEMA, 'ordex.safeops-plan/v1');
  assert.equal(SAFEOPS_SIGNED_RESULT_SCHEMA, 'ordex.safeops-signed-result/v1');
  assert.equal(SAFEOPS_PROTOCOL_MIN, '1.2');
});

test('a malformed plan is refused, never thrown on', () => {
  assert.equal(verifySafeOpsPlan(null).ok, false);
  assert.equal(verifySafeOpsPlan([]).ok, false);
  assert.equal(verifySafeOpsPlan({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(verifySafeOpsSignedResult(null, {}).code, 'MALFORMED_SIGNED_RESULT');
});

test('the plan digest ignores the digest itself and the findings', () => {
  const [first] = vectors.cases;
  const plan = first.plan;
  const edited = { ...plan, findings: [{ severity: 'high', note: 'something a human should read' }] };
  assert.equal(safeopsPlanDigest(edited), plan.digest, 'findings are not part of the binding content');
  const redigested = { ...plan, digest: 'x' };
  assert.equal(safeopsPlanDigest(redigested), plan.digest, 'the digest field is not part of the binding content');
  const moved = { ...plan, network: 'testnet' };
  assert.notEqual(safeopsPlanDigest(moved), plan.digest);
});

test('sorted json orders keys recursively and parseSats refuses non decimals', () => {
  assert.equal(sortedJson({ b: 1, a: { d: 2, c: [3, { b: 4, a: 5 }] } }), '{"a":{"c":[3,{"a":5,"b":4}],"d":2},"b":1}');
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats('9007199254740993'), 9007199254740993n);
  assert.equal(parseSats('01'), null);
  assert.equal(parseSats('1.5'), null);
  assert.equal(parseSats('-1'), null);
  assert.equal(parseSats(1), null);
});
