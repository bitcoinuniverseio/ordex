import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFailureInput, getAllDiagnosticRules } from '../../site/src/lib/diagnostics/detector.js';

// OX-S09: envelope classification with no false conclusive diagnosis. Conclusive only for an
// exact registered code in a structured position or on its own.

test('every registered code on its own is a conclusive match to its rule', () => {
  const rules = getAllDiagnosticRules();
  assert.equal(rules.length, 174);
  for (const rule of rules) {
    const code = rule.exactCodes[0];
    const res = detectFailureInput(code);
    assert.equal(res.inputType, 'EXACT_REFUSAL_CODE');
    assert.equal(res.confidence, 'Conclusive');
    assert.equal(res.matchedRule, rule);
    assert.ok(res.matchedRule.resolutionSteps.length > 0);
    assert.ok(res.matchedRule.reproducers.length > 0);
  }
});

test('an unregistered code is never conclusive, however it arrives', () => {
  for (const input of ['PAYMENT_OUTPUT_MISMATCH', JSON.stringify({ ok: false, code: 'PAYMENT_OUTPUT_MISMATCH' }), JSON.stringify({ statusCode: 400, error: 'Bad Request', message: 'nope', code: 'NOT_A_CODE' })]) {
    const res = detectFailureInput(input);
    assert.notEqual(res.confidence, 'Conclusive', input);
    assert.equal(res.matchedRule, undefined, input);
  }
});

test('verifier results: raw ok/safe envelopes, Lab reports and MCP verdicts', () => {
  const raw = detectFailureInput(JSON.stringify({ ok: false, code: 'SELLER_VALUE_MISMATCH', reason: 'x' }));
  assert.equal(raw.inputType, 'VERIFIER_RESULT');
  assert.equal(raw.confidence, 'Conclusive');
  assert.equal(raw.detectedCode, 'SELLER_VALUE_MISMATCH');
  const rune = detectFailureInput(JSON.stringify({ safe: false, code: 'CENOTAPH_BURNS_BALANCE' }));
  assert.equal(rune.matchedRule?.exactCodes[0], 'CENOTAPH_BURNS_BALANCE');
  const lab = detectFailureInput(JSON.stringify({ schema: 'ordex.lab-report/v1', verdict: { state: 'refused', code: 'MEMBER_NOT_PROVEN' } }));
  assert.equal(lab.confidence, 'Conclusive');
  assert.equal(lab.detectedCode, 'MEMBER_NOT_PROVEN');
  const accepted = detectFailureInput(JSON.stringify({ ok: true, sharedIndex: 1 }));
  assert.equal(accepted.matchedRule, undefined);
  assert.match(accepted.evidenceUsed, /accepted/);
});

test('gateway error envelopes follow the OpenAPI ErrorResponse', () => {
  const known = detectFailureInput(JSON.stringify({ statusCode: 422, error: 'Unprocessable Entity', message: 'refused', code: 'SELLER_SCRIPT_MISMATCH' }));
  assert.equal(known.inputType, 'API_ERROR');
  assert.equal(known.confidence, 'Conclusive');
  const rate = detectFailureInput(JSON.stringify({ statusCode: 429, error: 'Too Many Requests', message: 'slow down', code: 'ORDEX_RATE_LIMITED' }));
  assert.equal(rate.confidence, 'Unknown');
  assert.equal(rate.nextTool?.tool, 'playground');
  const mentioned = detectFailureInput(JSON.stringify({ statusCode: 400, error: 'Bad Request', message: ['preflight refused: SAT_FLOW_SHORTFALL'] }));
  assert.equal(mentioned.confidence, 'Inferred');
  assert.equal(mentioned.detectedCode, 'SAT_FLOW_SHORTFALL');
});

test('Gateway Doctor reports, Artifact Lens comparisons and events are classified, not guessed', () => {
  const doctor = detectFailureInput(
    JSON.stringify({ schema: 'ordex.gateway-doctor-report/v1', checks: [{ id: 'reach', status: 'failed', details: 'fetch failed' }, { id: 'health-schema', status: 'blocked', details: 'needs reach' }, { id: 'cors', status: 'passed' }] })
  );
  assert.equal(doctor.inputType, 'GATEWAY_DOCTOR');
  assert.deepEqual(doctor.findings?.map((f) => f.id), ['reach', 'health-schema']);
  const lens = detectFailureInput(JSON.stringify({ overallVerdict: 'DANGEROUS', conclusive: true, differences: [{ field: 'outputs[0].value', severity: 'Dangerous', whyItMatters: 'The seller is paid less.' }, { field: 'x', severity: 'Expected' }] }));
  assert.equal(lens.inputType, 'ARTIFACT_FINDING');
  assert.deepEqual(lens.findings?.map((f) => f.id), ['outputs[0].value']);
  const event = detectFailureInput(JSON.stringify({ id: 'e1', type: 'ordex.order.published', schemaVersion: '1' }));
  assert.equal(event.inputType, 'EVENT_ENVELOPE');
  assert.equal(event.confidence, 'Unknown');
  assert.equal(event.pendingVerification?.family, 'events');
});

test('text: a contained code, network errors and HTTP statuses are inferred; noise is unknown', () => {
  const text = detectFailureInput('Error: verifier said SAT_FLOW_SHORTFALL for order 12');
  assert.equal(text.confidence, 'Inferred');
  assert.equal(text.detectedCode, 'SAT_FLOW_SHORTFALL');
  assert.equal(detectFailureInput('TypeError: Failed to fetch').inputType, 'CORS_NETWORK');
  assert.equal(detectFailureInput('the gateway answered 502').inputType, 'HTTP_STATUS');
  for (const noise of ['', 'completely unexpected random string', '{"a":1}', 'x'.repeat(300 * 1024)]) {
    const res = detectFailureInput(noise);
    assert.equal(res.confidence, 'Unknown', noise.slice(0, 20));
    assert.ok(res.missingFieldsForConclusiveVerdict?.length);
  }
});
