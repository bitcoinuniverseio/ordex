import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { SCENARIOS, getScenarioById, vectorCheck, vectorDelta } from '../../site/src/lib/scenarios/registry.js';
import {
  createInitialScenarioState,
  scenarioReducer,
  pendingCheck,
  resolvePending,
  checkInputFor,
  toCheckpoint,
  fromCheckpoint,
  HISTORY_LIMIT,
  scenarioOutcome
} from '../../site/src/lib/scenarios/engine.js';
import { evaluateCandidate, FAMILY_REGISTRY } from '../../site/src/lib/conformance-engine.mjs';
import { argsFromCase } from '../../site/src/lib/lab-report.mjs';

// OX-S08: every verdict below comes from the reference verifiers through the OX-S07
// executor. resolvePending runs exactly the call the browser sends to the Worker.

const evaluate = (family, variant, args) => evaluateCandidate(family, variant, args);
const openapi = JSON.parse(await readFile(new URL('../../spec/openapi.json', import.meta.url), 'utf8'));
const vectors = JSON.parse(await readFile(new URL('../../site/src/data/allVectors.json', import.meta.url), 'utf8'));

/** Walk every step of a scenario, resolving each pending verifier call. */
function runAll(scenario, injectionId) {
  let state = createInitialScenarioState(scenario);
  if (injectionId) state = scenarioReducer(state, { type: 'APPLY_FAILURE_INJECTION', injectionId }, scenario);
  state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: 0 }, scenario);
  const verdicts = [];
  for (let i = 0; i < scenario.steps.length; i++) {
    state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: i }, scenario);
    state = resolvePending(state, scenario, evaluate);
    assert.notEqual(state.verificationVerdict.state, 'pending', `${scenario.id} step ${i + 1} stayed pending`);
    verdicts.push(state.verificationVerdict);
  }
  return { state, verdicts };
}

const REQUIRED = [
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

test('scenario registry: all 15 required scenarios are registered and valid', () => {
  assert.equal(SCENARIOS.length, 15);
  for (const id of REQUIRED) {
    const sc = getScenarioById(id);
    assert.ok(sc, `Scenario ${id} must exist in registry`);
    assert.ok(sc.steps.length > 0);
    assert.ok(sc.protocolVersions.length > 0);
  }
});

test('every verifier check names a registered family and variant with its required arguments', () => {
  for (const sc of SCENARIOS) {
    for (const step of sc.steps) {
      if (!step.verifierCheck) continue;
      const spec = FAMILY_REGISTRY[step.verifierCheck.family];
      assert.ok(spec, `${sc.id}/${step.id} family`);
      const variant = spec.variants[step.verifierCheck.variant];
      assert.ok(variant, `${sc.id}/${step.id} variant`);
      for (const arg of variant.args) assert.ok(step.verifierCheck.args[arg] !== undefined, `${sc.id}/${step.id} missing ${arg}`);
      assert.notEqual(step.evidenceClass, 'Chain proof', `${sc.id}/${step.id} claims chain proof`);
    }
    for (const step of sc.steps) assert.notEqual(step.evidenceClass, 'Chain proof', `${sc.id}/${step.id} claims chain proof without chain evidence`);
  }
});

test('every scenario reaches its declared outcome from real verifier results', () => {
  for (const sc of SCENARIOS) {
    const { verdicts } = runAll(sc);
    const decisive = verdicts.filter((v) => v.state === 'accepted' || v.state === 'refused');
    assert.ok(decisive.length > 0, `${sc.id} has no decisive step`);
    const last = decisive.at(-1);
    if (sc.expectedOutcome === 'success') {
      for (const v of verdicts) assert.ok(v.state === 'accepted' || v.state === 'none', `${sc.id}: ${v.state} ${v.code || ''}`);
    } else {
      assert.equal(last.state, 'refused', sc.id);
      assert.equal(last.code, sc.expectedRefusalCode, sc.id);
    }
  }
});

test('every failure injection changes the input and the verifier returns its refusal code', () => {
  let count = 0;
  for (const sc of SCENARIOS) {
    for (const inj of sc.failureInjections || []) {
      const step = sc.steps.find((s) => s.id === inj.stepId);
      assert.ok(step?.verifierCheck, `${sc.id}/${inj.id} targets a step without a verifier`);
      const before = checkInputFor(sc, step);
      const after = checkInputFor(sc, step, inj.id);
      assert.notEqual(after.inputDigest, before.inputDigest, `${inj.id} did not change the input`);
      assert.equal(after.originalInputDigest, before.inputDigest);
      assert.ok(after.changedPaths.length > 0);
      let state = createInitialScenarioState(sc);
      state = scenarioReducer(state, { type: 'APPLY_FAILURE_INJECTION', injectionId: inj.id }, sc);
      assert.equal(state.verificationVerdict.state, 'pending', 'an injection must wait for the verifier, never assign a code');
      state = resolvePending(state, sc, evaluate);
      assert.equal(state.verificationVerdict.state, 'refused', `${sc.id}/${inj.id}`);
      assert.equal(state.verificationVerdict.code, inj.expectedRefusalCode, `${sc.id}/${inj.id}`);
      assert.equal(state.verificationVerdict.source, 'verifier');
      assert.equal(state.protocolState, 'REFUSED');
      count++;
    }
  }
  assert.equal(count, 11, `expected 11 injections, found ${count}`);
});

test('vector-derived injections reproduce their refusal vector field by field', () => {
  for (const sc of SCENARIOS) {
    for (const inj of sc.failureInjections || []) {
      if (!inj.vectorId) continue;
      const step = sc.steps.find((s) => s.id === inj.stepId);
      const target = vectors.find((v) => v.id === inj.vectorId);
      const mutated = inj.mutate(JSON.parse(JSON.stringify(step.verifierCheck.args)));
      assert.deepEqual(mutated, argsFromCase(target.family, target.variant, target.case), inj.id);
      assert.equal(target.case.expected.code, inj.expectedRefusalCode, inj.id);
    }
  }
  assert.throws(() => vectorDelta('purchase/nope', 'purchase/arrangement-ordex-builds'), /missing/);
});

test('fixture observations use values the contract defines and are labelled as fixtures', () => {
  const nodeStatus = openapi.components.schemas.Validation.properties.nodeStatus.enum;
  for (const sc of SCENARIOS) {
    for (const step of sc.steps) {
      if (!step.observation) continue;
      assert.ok(nodeStatus.includes(step.observation.value), step.observation.value);
      assert.match(step.observation.label, /fixture/);
      const { state } = runAll(sc);
      assert.ok(state);
    }
  }
  const race = getScenarioById('ask.race-lost.refusal');
  const { verdicts } = runAll(race);
  assert.equal(verdicts[1].state, 'accepted', 'the local verifier cannot see chain state');
  assert.equal(verdicts[2].source, 'fixture');
});

test('stepping backward, replay and reset restore identical state', () => {
  const sc = getScenarioById('ask.publish-and-settle.success');
  let state = createInitialScenarioState(sc);
  state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: 3 }, sc);
  assert.equal(state.verificationVerdict.state, 'pending');
  assert.equal(state.protocolState, 'OPEN');
  assert.equal(state.artifactsGenerated.some((a) => a.name === 'settlement-arrangement.json'), false, 'no artifact before the verifier answers');
  state = resolvePending(state, sc, evaluate);
  assert.equal(state.verificationVerdict.state, 'accepted');
  assert.equal(state.protocolState, 'VERIFIED_LOCALLY');
  const atStep4 = state;
  state = scenarioReducer(state, { type: 'STEP_BACKWARD' }, sc);
  assert.equal(state.currentStepIndex, 2);
  state = scenarioReducer(state, { type: 'STEP_FORWARD' }, sc);
  assert.deepEqual(state.verificationVerdict, atStep4.verificationVerdict, 'replay is idempotent');
  assert.deepEqual(state.artifactsGenerated, atStep4.artifactsGenerated);

  state = scenarioReducer(state, { type: 'APPLY_FAILURE_INJECTION', injectionId: 'inject-underpay-seller' }, sc);
  state = resolvePending(state, sc, evaluate);
  assert.equal(state.verificationVerdict.code, 'SELLER_VALUE_MISMATCH');
  assert.equal(state.artifactsGenerated.some((a) => a.name === 'settlement-arrangement.json'), false, 'refused step produced an artifact');
  state = scenarioReducer(state, { type: 'STEP_FORWARD' }, sc);
  assert.equal(state.verificationVerdict.state, 'blocked', 'a step after a refusal cannot proceed');
  state = scenarioReducer(state, { type: 'CLEAR_FAILURE_INJECTION' }, sc);
  assert.equal(state.activeFailureInjectionId, undefined);
  state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: 3 }, sc);
  assert.equal(state.verificationVerdict.state, 'accepted', 'cleared injection restores the stored verdict');

  state = scenarioReducer(state, { type: 'RESET' }, sc);
  assert.equal(state.currentStepIndex, 0);
  assert.equal(state.activeFailureInjectionId, undefined);
  assert.equal(state.verificationVerdict.state, 'none');
});

test('history is bounded and pending checks name the exact call', () => {
  const sc = getScenarioById('purchase.batch.success');
  let state = createInitialScenarioState(sc);
  for (let i = 0; i < HISTORY_LIMIT * 2; i++) state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: i % 3 }, sc);
  assert.equal(state.history.length, HISTORY_LIMIT);
  state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: 1 }, sc);
  const check = pendingCheck(state, sc);
  assert.equal(check.family, 'purchase');
  assert.equal(check.args.order.sellerPaymentValueSats, '20000');
});

test('checkpoints round trip and stale or foreign checkpoints are rejected', () => {
  const sc = getScenarioById('offer.accept.success');
  let state = createInitialScenarioState(sc);
  state = scenarioReducer(state, { type: 'APPLY_FAILURE_INJECTION', injectionId: 'inject-change-seller-payment' }, sc);
  const cp = toCheckpoint(state, { build: 'abc' });
  const back = fromCheckpoint(JSON.parse(JSON.stringify(cp)), sc, { build: 'abc' });
  assert.equal(back.ok, true);
  assert.equal(back.state.activeFailureInjectionId, 'inject-change-seller-payment');
  assert.equal(back.state.verificationVerdict.state, 'pending', 'restored state re-runs the verifier');
  assert.equal(fromCheckpoint(cp, sc, { build: 'other' }).ok, false);
  assert.equal(fromCheckpoint(cp, getScenarioById('runes.cenotaph.refusal'), { build: 'abc' }).ok, false);
  assert.equal(fromCheckpoint({ ...cp, stepIndex: 99 }, sc, { build: 'abc' }).ok, false);
  assert.equal(fromCheckpoint({ ...cp, injectionId: 'made-up' }, sc, { build: 'abc' }).ok, false);
  assert.equal(fromCheckpoint({ ...cp, schema: 'x' }, sc, { build: 'abc' }).ok, false);
});

test('scenario fixtures built from vectors equal the vector arguments', () => {
  const check = vectorCheck('runes/unrecognized-even-tag');
  const v = vectors.find((x) => x.id === 'runes/unrecognized-even-tag');
  assert.deepEqual(check.args, argsFromCase('runes', 'burn-safety', v.case));
});

test('scenario outcome is passed only after a full walk that reaches the declared outcome', () => {
  for (const sc of SCENARIOS) {
    assert.equal(scenarioOutcome(createInitialScenarioState(sc), sc), sc.steps.some((s) => s.verifierCheck) ? 'incomplete' : scenarioOutcome(createInitialScenarioState(sc), sc));
    const { state } = runAll(sc);
    assert.equal(scenarioOutcome(state, sc), 'passed', sc.id);
  }
  const sc = getScenarioById('ask.publish-and-settle.success');
  let state = runAll(sc).state;
  state = scenarioReducer(state, { type: 'APPLY_FAILURE_INJECTION', injectionId: 'inject-underpay-seller' }, sc);
  assert.equal(scenarioOutcome(state, sc), 'incomplete', 'an injected walk is never a scenario pass');
});
