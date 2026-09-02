/**
 * Ordex Deterministic Scenario Engine
 * 
 * Pure reducer-driven simulation engine with step forward, step backward,
 * checkpoints, controlled failure injection, and evidence reporting.
 */

import type {
  ScenarioDefinition,
  ScenarioExecutionState,
  ScenarioStep
} from './types.js';

export function createInitialScenarioState(scenario: ScenarioDefinition): ScenarioExecutionState {
  const firstStep = scenario.steps[0];
  const initialVerdict = firstStep?.verifierCheck
    ? firstStep.verifierCheck.run()
    : { ok: true };

  return {
    scenarioId: scenario.id,
    currentStepIndex: 0,
    totalSteps: scenario.steps.length,
    activeActor: firstStep ? firstStep.actor : 'seller',
    protocolState: firstStep ? firstStep.stateTransition.from : 'INITIAL',
    artifactsGenerated: firstStep?.outputArtifact
      ? [
          {
            name: firstStep.outputArtifact.name,
            type: firstStep.outputArtifact.type,
            stepNumber: 1,
            payload: firstStep.outputArtifact.payload
          }
        ]
      : [],
    verificationVerdict: {
      ok: initialVerdict.ok,
      code: initialVerdict.code,
      reason: initialVerdict.reason,
      evidenceClass: firstStep?.evidenceClass || 'Deterministic example'
    },
    history: [
      {
        stepNumber: 1,
        state: firstStep ? firstStep.stateTransition.from : 'INITIAL',
        verdict: initialVerdict
      }
    ]
  };
}

export type ScenarioAction =
  | { type: 'STEP_FORWARD' }
  | { type: 'STEP_BACKWARD' }
  | { type: 'JUMP_TO_STEP'; stepIndex: number }
  | { type: 'RESET' }
  | { type: 'APPLY_FAILURE_INJECTION'; injectionId: string };

export function scenarioReducer(
  state: ScenarioExecutionState,
  action: ScenarioAction,
  scenario: ScenarioDefinition
): ScenarioExecutionState {
  switch (action.type) {
    case 'STEP_FORWARD': {
      if (state.currentStepIndex >= scenario.steps.length - 1) {
        return state;
      }
      const nextIndex = state.currentStepIndex + 1;
      return executeStep(state, nextIndex, scenario);
    }

    case 'STEP_BACKWARD': {
      if (state.currentStepIndex <= 0) {
        return state;
      }
      const prevIndex = state.currentStepIndex - 1;
      return executeStep(state, prevIndex, scenario);
    }

    case 'JUMP_TO_STEP': {
      const targetIndex = Math.max(0, Math.min(action.stepIndex, scenario.steps.length - 1));
      return executeStep(state, targetIndex, scenario);
    }

    case 'RESET': {
      return createInitialScenarioState(scenario);
    }

    case 'APPLY_FAILURE_INJECTION': {
      const injection = scenario.failureInjections?.find((f) => f.id === action.injectionId);
      if (!injection) return state;

      return {
        ...state,
        activeFailureInjectionId: action.injectionId,
        verificationVerdict: {
          ok: false,
          code: injection.expectedRefusalCode,
          reason: `Failure injected: ${injection.description}. Invariant violated: ${injection.affectedInvariant}`,
          evidenceClass: 'Protocol verification'
        }
      };
    }

    default:
      return state;
  }
}

function executeStep(
  state: ScenarioExecutionState,
  targetIndex: number,
  scenario: ScenarioDefinition
): ScenarioExecutionState {
  const step = scenario.steps[targetIndex];
  if (!step) return state;

  let verdict = { ok: true, code: undefined, reason: undefined };
  if (state.activeFailureInjectionId) {
    const injection = scenario.failureInjections?.find((f) => f.id === state.activeFailureInjectionId);
    if (injection) {
      verdict = {
        ok: false,
        code: injection.expectedRefusalCode as unknown as undefined,
        reason: injection.affectedInvariant as unknown as undefined
      };
    }
  } else if (step.verifierCheck) {
    const res = step.verifierCheck.run();
    verdict = { ok: res.ok, code: res.code as unknown as undefined, reason: res.reason as unknown as undefined };
  }

  // Accumulate artifacts up to target step
  const accumulatedArtifacts = [];
  for (let i = 0; i <= targetIndex; i++) {
    const s = scenario.steps[i];
    if (s?.outputArtifact) {
      accumulatedArtifacts.push({
        name: s.outputArtifact.name,
        type: s.outputArtifact.type,
        stepNumber: i + 1,
        payload: s.outputArtifact.payload
      });
    }
  }

  return {
    ...state,
    currentStepIndex: targetIndex,
    activeActor: step.actor,
    protocolState: step.stateTransition.to,
    artifactsGenerated: accumulatedArtifacts,
    verificationVerdict: {
      ok: verdict.ok,
      code: verdict.code,
      reason: verdict.reason,
      evidenceClass: step.evidenceClass
    },
    history: [
      ...state.history,
      {
        stepNumber: targetIndex + 1,
        state: step.stateTransition.to,
        verdict
      }
    ]
  };
}
