/**
 * Ordex Deterministic Scenario Engine
 *
 * OX-S08: a pure reducer. A step's verdict is looked up from verifier results keyed by
 * step and injection; when none exists yet the step is pending and pendingCheck() names
 * the exact verifier call the page must run (in the OX-S07 Worker) or a Node caller runs
 * directly. No verdict ever originates from expected text: failure injections mutate a
 * clone of the step's arguments and the verifier decides.
 */

import type {
  ScenarioDefinition,
  ScenarioExecutionState,
  ScenarioStep,
  StepVerdict,
  FailureInjectionOption
} from './types.js';
import { inputDigest, diffPaths } from '../lab-report.mjs';

export const HISTORY_LIMIT = 100;
export const CHECKPOINT_SCHEMA = 'ordex.sandbox-checkpoint/v1';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function resultKey(step: ScenarioStep, injectionId?: string): string {
  return `${step.id}::${injectionId || 'none'}`;
}

function activeInjection(scenario: ScenarioDefinition, injectionId?: string): FailureInjectionOption | undefined {
  return injectionId ? scenario.failureInjections?.find((f) => f.id === injectionId) : undefined;
}

/**
 * The exact verifier call for a step under the active injection, with digests of the
 * original and mutated arguments. Null when the step has no verifier check.
 */
export function checkInputFor(scenario: ScenarioDefinition, step: ScenarioStep, injectionId?: string) {
  if (!step.verifierCheck) return null;
  const injection = activeInjection(scenario, injectionId);
  const applies = injection && injection.stepId === step.id;
  const original = clone(step.verifierCheck.args);
  const args = applies ? injection.mutate(clone(original)) : original;
  return {
    key: resultKey(step, applies ? injection.id : undefined),
    family: step.verifierCheck.family,
    variant: step.verifierCheck.variant,
    args,
    inputDigest: inputDigest(args),
    originalInputDigest: applies ? inputDigest(original) : undefined,
    changedPaths: applies ? diffPaths(original, args).map((d) => d.path) : undefined
  };
}

function stepVerdict(state: Pick<ScenarioExecutionState, 'results' | 'activeFailureInjectionId'>, scenario: ScenarioDefinition, index: number): StepVerdict {
  const step = scenario.steps[index];
  if (step.observation) {
    return {
      state: 'refused',
      code: step.observation.value,
      reason: `${step.observation.label}: ${step.observation.field} = ${step.observation.value} (${step.observation.contractRef}).`,
      source: 'fixture'
    };
  }
  const input = checkInputFor(scenario, step, state.activeFailureInjectionId);
  if (!input) return { state: 'none', source: 'none' };
  const found = state.results[input.key];
  if (!found) {
    return { state: 'pending', source: 'verifier', inputDigest: input.inputDigest, originalInputDigest: input.originalInputDigest, changedPaths: input.changedPaths };
  }
  return found;
}

/** Project the state for a target step from stored results; replay is idempotent. */
function project(state: ScenarioExecutionState, targetIndex: number, scenario: ScenarioDefinition): ScenarioExecutionState {
  const index = Math.max(0, Math.min(targetIndex, scenario.steps.length - 1));
  const step = scenario.steps[index];
  const artifacts: ScenarioExecutionState['artifactsGenerated'] = [];
  let blockedBy: number | null = null;
  for (let i = 0; i <= index; i++) {
    const v = stepVerdict(state, scenario, i);
    const s = scenario.steps[i];
    // An artifact exists only when its step, and every step before it, did not refuse or stall.
    if (blockedBy === null && v.state !== 'refused' && v.state !== 'pending' && v.state !== 'unknown' && s.outputArtifact) {
      artifacts.push({
        id: `${scenario.id}#${s.id}:${s.outputArtifact.name}`,
        name: s.outputArtifact.name,
        type: s.outputArtifact.type,
        stepNumber: i + 1,
        payload: s.outputArtifact.payload,
        illustration: s.outputArtifact.illustration === true
      });
    }
    if (i < index && blockedBy === null && (v.state === 'refused' || v.state === 'unknown')) blockedBy = i;
  }
  let verdict = stepVerdict(state, scenario, index);
  if (blockedBy !== null) {
    verdict = {
      state: 'blocked',
      source: 'none',
      reason: `Step ${blockedBy + 1} was refused, so this step cannot proceed. Clear the injection or reset to replay.`
    };
  }
  const unexpectedRefusal = verdict.state === 'refused' && (scenario.expectedOutcome === 'success' || !!state.activeFailureInjectionId);
  const protocolState =
    verdict.state === 'pending' || verdict.state === 'blocked'
      ? step.stateTransition.from
      : unexpectedRefusal || verdict.state === 'unknown'
        ? 'REFUSED'
        : step.stateTransition.to;
  const history = [...state.history, { stepNumber: index + 1, state: protocolState, verdict: verdict.state }].slice(-HISTORY_LIMIT);
  return {
    ...state,
    currentStepIndex: index,
    totalSteps: scenario.steps.length,
    activeActor: step.actor,
    protocolState,
    artifactsGenerated: artifacts,
    verificationVerdict: { ...verdict, evidenceClass: verdict.source === 'fixture' ? 'Deterministic example' : step.evidenceClass },
    history
  };
}

export function createInitialScenarioState(scenario: ScenarioDefinition, results: Record<string, StepVerdict> = {}): ScenarioExecutionState {
  const base: ScenarioExecutionState = {
    scenarioId: scenario.id,
    currentStepIndex: 0,
    totalSteps: scenario.steps.length,
    activeActor: scenario.steps[0]?.actor || 'seller',
    protocolState: scenario.steps[0]?.stateTransition.from || 'INITIAL',
    artifactsGenerated: [],
    verificationVerdict: { state: 'none', source: 'none', evidenceClass: 'Deterministic example' },
    results,
    history: []
  };
  return project(base, 0, scenario);
}

export type ScenarioAction =
  | { type: 'STEP_FORWARD' }
  | { type: 'STEP_BACKWARD' }
  | { type: 'JUMP_TO_STEP'; stepIndex: number }
  | { type: 'RESET' }
  | { type: 'APPLY_FAILURE_INJECTION'; injectionId: string }
  | { type: 'CLEAR_FAILURE_INJECTION' }
  | { type: 'VERIFICATION_RESULT'; key: string; verdict: StepVerdict };

export function scenarioReducer(
  state: ScenarioExecutionState,
  action: ScenarioAction,
  scenario: ScenarioDefinition
): ScenarioExecutionState {
  switch (action.type) {
    case 'STEP_FORWARD':
      if (state.currentStepIndex >= scenario.steps.length - 1) return state;
      return project(state, state.currentStepIndex + 1, scenario);
    case 'STEP_BACKWARD':
      if (state.currentStepIndex <= 0) return state;
      return project(state, state.currentStepIndex - 1, scenario);
    case 'JUMP_TO_STEP':
      return project(state, action.stepIndex, scenario);
    case 'RESET':
      // Verifier results are pure functions of their inputs, so they survive a reset; the
      // injection and position do not.
      return createInitialScenarioState(scenario, state.results);
    case 'APPLY_FAILURE_INJECTION': {
      const injection = activeInjection(scenario, action.injectionId);
      if (!injection) return state;
      const target = scenario.steps.findIndex((s) => s.id === injection.stepId);
      return project({ ...state, activeFailureInjectionId: injection.id }, target, scenario);
    }
    case 'CLEAR_FAILURE_INJECTION':
      return project({ ...state, activeFailureInjectionId: undefined }, state.currentStepIndex, scenario);
    case 'VERIFICATION_RESULT': {
      const results = { ...state.results, [action.key]: action.verdict };
      // Replace the pending history entry of the current step; a late result for another
      // step is stored for replay without touching the history.
      const current = pendingCheck(state, scenario);
      const history = current && current.key === action.key ? state.history.slice(0, -1) : state.history;
      if (!current || current.key !== action.key) return { ...state, results };
      return project({ ...state, results, history }, state.currentStepIndex, scenario);
    }
    default:
      return state;
  }
}

/** The verifier call the current step is waiting for, if any. */
export function pendingCheck(state: ScenarioExecutionState, scenario: ScenarioDefinition) {
  if (state.verificationVerdict.state !== 'pending') return null;
  return checkInputFor(scenario, scenario.steps[state.currentStepIndex], state.activeFailureInjectionId);
}

export type CandidateEvaluator = (family: string, variant: string, args: Record<string, unknown>) => {
  verdict: { state: 'accepted' | 'refused' | 'unknown'; code?: string | null; reason?: string | null };
  raw: unknown;
};

/** Turn a verifier result into the stored verdict for a pending check. */
export function verdictFromResult(check: NonNullable<ReturnType<typeof checkInputFor>>, result: ReturnType<CandidateEvaluator>): StepVerdict {
  return {
    state: result.verdict.state,
    code: result.verdict.code ?? null,
    reason: result.verdict.reason ?? null,
    source: 'verifier',
    inputDigest: check.inputDigest,
    originalInputDigest: check.originalInputDigest,
    changedPaths: check.changedPaths,
    raw: result.raw
  };
}

/** Resolve the current step's pending check synchronously (Node callers and tests). */
export function resolvePending(state: ScenarioExecutionState, scenario: ScenarioDefinition, evaluate: CandidateEvaluator): ScenarioExecutionState {
  const check = pendingCheck(state, scenario);
  if (!check) return state;
  return scenarioReducer(state, { type: 'VERIFICATION_RESULT', key: check.key, verdict: verdictFromResult(check, evaluate(check.family, check.variant, check.args)) }, scenario);
}

/**
 * A versioned checkpoint for OX-S03 persistence: position, injection and the digests of
 * stored results. Results themselves are recomputed, never trusted from storage.
 */
export function toCheckpoint(state: ScenarioExecutionState, meta: { build: string }) {
  return {
    schema: CHECKPOINT_SCHEMA,
    scenarioId: state.scenarioId,
    build: meta.build,
    stepIndex: state.currentStepIndex,
    injectionId: state.activeFailureInjectionId || null
  };
}

export function fromCheckpoint(
  checkpoint: unknown,
  scenario: ScenarioDefinition,
  meta: { build: string }
): { ok: true; state: ScenarioExecutionState } | { ok: false; reason: string } {
  const cp = checkpoint as Record<string, unknown> | null;
  if (!cp || typeof cp !== 'object' || cp.schema !== CHECKPOINT_SCHEMA) return { ok: false, reason: 'Unsupported checkpoint schema.' };
  if (cp.scenarioId !== scenario.id) return { ok: false, reason: 'The checkpoint belongs to a different scenario.' };
  if (cp.build !== meta.build) return { ok: false, reason: 'The checkpoint was saved by a different site build; replay from the start.' };
  if (!Number.isInteger(cp.stepIndex) || (cp.stepIndex as number) < 0 || (cp.stepIndex as number) >= scenario.steps.length) {
    return { ok: false, reason: 'The checkpoint step is out of range.' };
  }
  if (cp.injectionId !== null && !scenario.failureInjections?.some((f) => f.id === cp.injectionId)) {
    return { ok: false, reason: 'The checkpoint names an injection this scenario does not offer.' };
  }
  let state = createInitialScenarioState(scenario);
  if (cp.injectionId) state = { ...state, activeFailureInjectionId: cp.injectionId as string };
  state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: cp.stepIndex as number }, scenario);
  return { ok: true, state };
}
