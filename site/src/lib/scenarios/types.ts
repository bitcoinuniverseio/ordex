/**
 * Ordex Scenario Engine Types
 * 
 * Defines deterministic multi-actor simulation data structures,
 * state transitions, failure injection controls, and evidence tracking.
 */

export type ScenarioActor = 'seller' | 'gateway' | 'buyer' | 'node';

export interface ActorLaneDefinition {
  id: ScenarioActor;
  label: string;
  roleDescription: string;
}

export interface ScenarioStep {
  id: string;
  stepNumber: number;
  actor: ScenarioActor;
  intent: string;
  operation: string;
  inputs: Record<string, unknown>;
  outputArtifact?: {
    name: string;
    type: string;
    payload: unknown;
  };
  stateTransition: {
    from: string;
    to: string;
  };
  whyThisStepExists: string;
  whatCouldFail: string;
  nextRecommendedAction: string;
  evidenceClass: 'Chain proof' | 'Protocol verification' | 'Gateway observation' | 'Publisher claim' | 'Deterministic example';
  verifierCheck?: {
    family: string;
    run: () => { ok: boolean; code?: string; reason?: string; [key: string]: unknown };
  };
}

export interface FailureInjectionOption {
  id: string;
  label: string;
  description: string;
  variable: string;
  applyMutation: (scenarioData: unknown) => unknown;
  expectedRefusalCode: string;
  affectedInvariant: string;
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  summary: string;
  protocolVersions: string[];
  expectedOutcome: 'success' | 'refusal';
  expectedRefusalCode?: string;
  verifierFamily: string;
  steps: ScenarioStep[];
  failureInjections?: FailureInjectionOption[];
  sourceRefs: Array<{
    title: string;
    path: string;
    type: string;
  }>;
}

export interface ScenarioExecutionState {
  scenarioId: string;
  currentStepIndex: number;
  totalSteps: number;
  activeActor: ScenarioActor;
  protocolState: string;
  artifactsGenerated: Array<{
    name: string;
    type: string;
    stepNumber: number;
    payload: unknown;
  }>;
  verificationVerdict: {
    ok: boolean;
    code?: string;
    reason?: string;
    evidenceClass: string;
  };
  activeFailureInjectionId?: string;
  history: Array<{
    stepNumber: number;
    state: string;
    verdict: unknown;
  }>;
}
