import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCENARIOS, getScenarioById } from '../../site/src/lib/scenarios/registry.js';
import { createInitialScenarioState, scenarioReducer } from '../../site/src/lib/scenarios/engine.js';

test('scenario registry: all 15 required scenarios are registered and valid', () => {
  assert.equal(SCENARIOS.length, 15);

  const requiredScenarioIds = [
    'ask.publish-and-settle.success',
    'ask.wallet-output-reorder.refusal',
    'ask.race-lost.refusal',
    'purchase.batch.success',
    'purchase.batch-incompatible.refusal',
    'offer.accept.success',
    'offer.recover-after-expiry.success',
    'ask.replace-and-reprice.success',
    'safeops.consolidation.success',
    'safeops.asset-bearing-input.refusal',
    'swap.atomic-settlement.success',
    'cold-sign.returned-bytes-mismatch.refusal',
    'collection.membership.success',
    'counterparty.attachment-mismatch.refusal',
    'runes.cenotaph.refusal'
  ];

  for (const id of requiredScenarioIds) {
    const sc = getScenarioById(id);
    assert.ok(sc, `Scenario ${id} must exist in registry`);
    assert.ok(sc.steps.length > 0, `Scenario ${id} must have at least 1 step`);
    assert.ok(sc.protocolVersions.length > 0);
  }
});

test('scenario engine: stepping, checkpoints, and verifier integration', () => {
  const scenario = getScenarioById('ask.publish-and-settle.success');
  assert.ok(scenario);

  let state = createInitialScenarioState(scenario);
  assert.equal(state.currentStepIndex, 0);
  assert.equal(state.activeActor, 'seller');

  // Step forward
  state = scenarioReducer(state, { type: 'STEP_FORWARD' }, scenario);
  assert.equal(state.currentStepIndex, 1);

  // Jump to step 3
  state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: 3 }, scenario);
  assert.equal(state.currentStepIndex, 3);
  assert.equal(state.activeActor, 'buyer');
  assert.equal(state.verificationVerdict.ok, true);

  // Apply failure injection
  const injection = scenario.failureInjections?.[0];
  if (injection) {
    state = scenarioReducer(state, { type: 'APPLY_FAILURE_INJECTION', injectionId: injection.id }, scenario);
    assert.equal(state.verificationVerdict.ok, false);
    assert.equal(state.verificationVerdict.code, injection.expectedRefusalCode);
  }

  // Reset
  state = scenarioReducer(state, { type: 'RESET' }, scenario);
  assert.equal(state.currentStepIndex, 0);
});
