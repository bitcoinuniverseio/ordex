import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFailureInput, getAllDiagnosticRules } from '../../site/src/lib/diagnostics/detector.js';

test('diagnostic detector: maps all 172 refusal codes to conclusive diagnostic rules', () => {
  const rules = getAllDiagnosticRules();
  assert.equal(rules.length, 172);

  for (const rule of rules) {
    const code = rule.exactCodes[0];
    const res = detectFailureInput(code);
    assert.equal(res.inputType, 'EXACT_REFUSAL_CODE');
    assert.equal(res.confidence, 'Conclusive');
    assert.equal(res.detectedCode, code);
    assert.ok(res.matchedRule);
    assert.ok(res.matchedRule.resolutionSteps.length > 0);
  }
});

test('diagnostic detector: classifies verifier result envelopes and API errors', () => {
  const verifierEnvelope = JSON.stringify({ ok: false, code: 'PAYMENT_OUTPUT_MISMATCH', reason: 'Displaced output' });
  const res1 = detectFailureInput(verifierEnvelope);
  assert.equal(res1.inputType, 'VERIFIER_RESULT');
  assert.equal(res1.detectedCode, 'PAYMENT_OUTPUT_MISMATCH');
  assert.equal(res1.confidence, 'Conclusive');

  const apiError = JSON.stringify({ error: { code: 'CENOTAPH', message: 'Unrecognized even tag' } });
  const res2 = detectFailureInput(apiError);
  assert.equal(res2.inputType, 'API_ERROR');
  assert.equal(res2.detectedCode, 'CENOTAPH');
});

test('diagnostic detector: handles honest unknown inputs cleanly', () => {
  const res = detectFailureInput('completely unexpected random string');
  assert.equal(res.inputType, 'UNKNOWN');
  assert.equal(res.confidence, 'Unknown');
  assert.ok(res.missingFieldsForConclusiveVerdict?.length > 0);
});
