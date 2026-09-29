/**
 * Ordex Scenario Engine Types
 *
 * Deterministic multi-actor walkthroughs whose verdicts come from the reference verifiers
 * (OX-S08). A step either runs a real verifier on explicit input, reports a labelled
 * deterministic fixture of gateway or chain state, or carries no verification at all.
 */

export type ScenarioActor = 'seller' | 'gateway' | 'buyer' | 'node';

export interface ActorLaneDefinition {
  id: ScenarioActor;
  label: string;
  roleDescription: string;
}

export type EvidenceClass = 'Chain proof' | 'Protocol verification' | 'Gateway observation' | 'Publisher claim' | 'Deterministic example';

/** A real verifier call: family and variant from the OX-S07 registry, with its exact arguments. */
export interface VerifierCheck {
  family: string;
  variant: string;
  args: Record<string, unknown>;
  /** The conformance vector the arguments come from, when they come from one. */
  vectorId?: string;
}

/**
 * Gateway or chain state the sandbox cannot observe locally. It is a labelled deterministic
 * fixture using a value the contract defines, never presented as a live observation.
 */
export interface FixtureObservation {
  label: string;
  field: string;
  value: string;
  contractRef: string;
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
    /** True when the payload illustrates a shape and is not verified bytes. */
    illustration?: boolean;
  };
  stateTransition: {
    from: string;
    to: string;
  };
  whyThisStepExists: string;
  whatCouldFail: string;
  nextRecommendedAction: string;
  evidenceClass: EvidenceClass;
  verifierCheck?: VerifierCheck;
  observation?: FixtureObservation;
}

export interface FailureInjectionOption {
  id: string;
  label: string;
  description: string;
  /** The step whose verifier input this injection changes. */
  stepId: string;
  /** A bounded deterministic change to a clone of the step's verifier arguments. */
  mutate: (args: Record<string, unknown>) => Record<string, unknown>;
  /** The code the verifier is expected to return; tests assert the actual result matches. */
  expectedRefusalCode: string;
  affectedInvariant: string;
  /** The refusal vector this mutation reproduces, when there is one. */
  vectorId?: string;
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

export type VerdictState = 'accepted' | 'refused' | 'unknown' | 'pending' | 'blocked' | 'none';

export interface StepVerdict {
  state: VerdictState;
  code?: string | null;
  reason?: string | null;
  source: 'verifier' | 'fixture' | 'none';
  /** SHA-256 of the exact verifier input, after any injected mutation. */
  inputDigest?: string;
  /** SHA-256 of the unmutated input, present when an injection changed it. */
  originalInputDigest?: string;
  changedPaths?: string[];
  raw?: unknown;
}

export interface ScenarioExecutionState {
  scenarioId: string;
  currentStepIndex: number;
  totalSteps: number;
  activeActor: ScenarioActor;
  protocolState: string;
  artifactsGenerated: Array<{
    id: string;
    name: string;
    type: string;
    stepNumber: number;
    payload: unknown;
    illustration: boolean;
  }>;
  verificationVerdict: StepVerdict & { evidenceClass: string };
  activeFailureInjectionId?: string;
  /** Verifier results keyed by step and injection, so replay never re-derives a verdict from text. */
  results: Record<string, StepVerdict>;
  history: Array<{
    stepNumber: number;
    state: string;
    verdict: VerdictState;
  }>;
}
