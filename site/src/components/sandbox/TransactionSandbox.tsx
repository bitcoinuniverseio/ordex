import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { SCENARIOS, ACTOR_LANES, getScenarioById } from '../../lib/scenarios/registry.js';
import { createInitialScenarioState, scenarioReducer } from '../../lib/scenarios/engine.js';
import type { ScenarioDefinition, ScenarioExecutionState } from '../../lib/scenarios/types.js';
import { contextEngine } from '../../lib/experience/context-engine.js';
import { journeyStore } from '../../lib/session/journey-store.js';
import {
  IconPlay,
  IconPause,
  IconStepForward,
  IconStepBack,
  IconReset,
  IconShieldCheck,
  IconAlertTriangle,
  IconExternalLink
} from '../experience/OrdexIcons.js';

interface SandboxProps {
  initialScenarioId?: string;
  basePath?: string;
}

export function TransactionSandbox({
  initialScenarioId = 'ask.publish-and-settle.success',
  basePath = '/ordex'
}: SandboxProps): JSX.Element {
  const [selectedScenario, setSelectedScenario] = useState<ScenarioDefinition>(
    getScenarioById(initialScenarioId) || SCENARIOS[0]
  );
  const [engineState, setEngineState] = useState<ScenarioExecutionState>(
    createInitialScenarioState(selectedScenario)
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [disclosureMode, setDisclosureMode] = useState<'plain' | 'builder' | 'proof'>('plain');

  // Load disclosure mode
  useEffect(() => {
    journeyStore.getSettings().then((s) => {
      setDisclosureMode(s.disclosureMode);
    });
  }, []);

  // Update when scenario changes
  const handleSelectScenario = (scenarioId: string) => {
    const sc = getScenarioById(scenarioId);
    if (sc) {
      setSelectedScenario(sc);
      setEngineState(createInitialScenarioState(sc));
      setIsPlaying(false);
    }
  };

  // Automated playback
  useEffect(() => {
    let timer: number;
    if (isPlaying) {
      timer = window.setInterval(() => {
        setEngineState((prev) => {
          if (prev.currentStepIndex < selectedScenario.steps.length - 1) {
            return scenarioReducer(prev, { type: 'STEP_FORWARD' }, selectedScenario);
          } else {
            setIsPlaying(false);
            return prev;
          }
        });
      }, 2500);
    }
    return () => clearInterval(timer);
  }, [isPlaying, selectedScenario]);

  // Sync with Context Engine
  useEffect(() => {
    const step = selectedScenario.steps[engineState.currentStepIndex];
    contextEngine.setContext({
      title: `Sandbox: ${selectedScenario.title}`,
      heading: `Step ${engineState.currentStepIndex + 1}: ${step?.intent || ''}`,
      evidenceClass: step?.evidenceClass as unknown as undefined,
      sourcePointer: selectedScenario.sourceRefs[0]?.path
    });
  }, [selectedScenario, engineState.currentStepIndex]);

  const currentStep = selectedScenario.steps[engineState.currentStepIndex];

  const handleStepForward = () => {
    setEngineState((prev) => scenarioReducer(prev, { type: 'STEP_FORWARD' }, selectedScenario));
  };

  const handleStepBackward = () => {
    setEngineState((prev) => scenarioReducer(prev, { type: 'STEP_BACKWARD' }, selectedScenario));
  };

  const handleReset = () => {
    setIsPlaying(false);
    setEngineState(createInitialScenarioState(selectedScenario));
  };

  const handleApplyFailureInjection = (injectionId: string) => {
    setEngineState((prev) =>
      scenarioReducer(prev, { type: 'APPLY_FAILURE_INJECTION', injectionId }, selectedScenario)
    );
  };

  return (
    <div style={{ maxWidth: '1140px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Sandbox Header Bar */}
      <div
        style={{
          padding: '1.5rem',
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-bitcoin-orange)' }}>
                Transaction Sandbox
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>•</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>Deterministic Simulation</span>
            </div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>
              {selectedScenario.title}
            </h1>
          </div>

          {/* Scenario Selector Dropdown */}
          <div style={{ minWidth: '260px' }}>
            <label htmlFor="scenario-select" style={{ display: 'block', fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)', marginBottom: '0.25rem' }}>
              Choose Scenario
            </label>
            <select
              id="scenario-select"
              value={selectedScenario.id}
              onChange={(e) => handleSelectScenario((e.target as HTMLSelectElement).value)}
              style={{
                width: '100%',
                padding: '0.45rem',
                borderRadius: 'var(--ox-radius-md)',
                border: '1px solid var(--ox-border-default)',
                backgroundColor: 'var(--ox-surface-subtle)',
                color: 'var(--ox-text-primary)',
                fontSize: '0.8125rem',
                fontWeight: 600
              }}
            >
              {SCENARIOS.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.4 }}>
          {selectedScenario.summary}
        </p>

        {/* Playback Controls & Timeline Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: '0.75rem',
            borderTop: '1px solid var(--ox-border-subtle)',
            flexWrap: 'wrap',
            gap: '0.75rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() => setIsPlaying(!isPlaying)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.35rem 0.75rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-bitcoin-orange)',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: 600
              }}
            >
              {isPlaying ? <IconPause size={12} color="#ffffff" /> : <IconPlay size={12} color="#ffffff" />}
              <span>{isPlaying ? 'Pause' : 'Play Simulation'}</span>
            </button>

            <button
              type="button"
              onClick={handleStepBackward}
              disabled={engineState.currentStepIndex <= 0}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.35rem 0.5rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-default)',
                color: 'var(--ox-text-primary)',
                cursor: engineState.currentStepIndex <= 0 ? 'not-allowed' : 'pointer',
                opacity: engineState.currentStepIndex <= 0 ? 0.5 : 1
              }}
            >
              <IconStepBack size={14} />
            </button>

            <button
              type="button"
              onClick={handleStepForward}
              disabled={engineState.currentStepIndex >= selectedScenario.steps.length - 1}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.35rem 0.5rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-default)',
                color: 'var(--ox-text-primary)',
                cursor: engineState.currentStepIndex >= selectedScenario.steps.length - 1 ? 'not-allowed' : 'pointer',
                opacity: engineState.currentStepIndex >= selectedScenario.steps.length - 1 ? 0.5 : 1
              }}
            >
              <IconStepForward size={14} />
            </button>

            <button
              type="button"
              onClick={handleReset}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                padding: '0.35rem 0.5rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'transparent',
                border: '1px solid var(--ox-border-subtle)',
                color: 'var(--ox-text-muted)',
                fontSize: '0.75rem',
                cursor: 'pointer'
              }}
            >
              <IconReset size={12} />
              <span>Reset</span>
            </button>
          </div>

          <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--ox-text-secondary)' }}>
            Step {engineState.currentStepIndex + 1} of {selectedScenario.steps.length} | State: <code>{engineState.protocolState}</code>
          </div>
        </div>
      </div>

      {/* Synchronized 4-Actor Lanes */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '0.75rem'
        }}
      >
        {ACTOR_LANES.map((lane) => {
          const isActorActive = currentStep?.actor === lane.id;
          return (
            <div
              key={lane.id}
              style={{
                padding: '0.875rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: isActorActive ? 'var(--ox-surface-panel)' : 'var(--ox-surface-subtle)',
                border: isActorActive ? '2px solid var(--ox-bitcoin-orange)' : '1px solid var(--ox-border-default)',
                boxShadow: isActorActive ? 'var(--ox-shadow-sm)' : 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.375rem',
                transition: 'all 0.15s ease'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: isActorActive ? 'var(--ox-bitcoin-orange)' : 'var(--ox-text-muted)' }}>
                  {lane.label}
                </span>
                {isActorActive && (
                  <span
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      backgroundColor: 'var(--ox-bitcoin-orange)'
                    }}
                  />
                )}
              </div>
              <div style={{ fontSize: '0.6875rem', color: 'var(--ox-text-muted)' }}>
                {lane.roleDescription}
              </div>
            </div>
          );
        })}
      </div>

      {/* Active Step Details Stage */}
      {currentStep && (
        <div
          style={{
            padding: '1.5rem',
            borderRadius: 'var(--ox-radius-lg)',
            backgroundColor: 'var(--ox-surface-panel)',
            border: '1px solid var(--ox-border-default)',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div>
              <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)' }}>
                Active Action by {currentStep.actor.toUpperCase()}
              </div>
              <h3 style={{ fontSize: '1.125rem', fontWeight: 700, margin: '0.2rem 0', color: 'var(--ox-text-primary)' }}>
                {currentStep.intent}
              </h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>
                Operation: <code>{currentStep.operation}</code>
              </div>
            </div>

            {/* Verifier Verdict Pill */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.35rem 0.625rem',
                borderRadius: 'var(--ox-radius-sm)',
                backgroundColor: engineState.verificationVerdict.ok ? 'var(--ox-status-success-bg)' : 'var(--ox-status-refusal-bg)',
                color: engineState.verificationVerdict.ok ? 'var(--ox-status-success-text)' : 'var(--ox-status-refusal-text)',
                fontWeight: 600,
                fontSize: '0.75rem'
              }}
            >
              {engineState.verificationVerdict.ok ? (
                <IconShieldCheck size={16} color="var(--ox-status-success-text)" />
              ) : (
                <IconAlertTriangle size={16} color="var(--ox-status-refusal-text)" />
              )}
              <span>
                {engineState.verificationVerdict.ok ? 'VERIFIER: PASS' : `REFUSAL: ${engineState.verificationVerdict.code}`}
              </span>
            </div>
          </div>

          {/* Structured Explanations */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '0.75rem',
              fontSize: '0.8125rem'
            }}
          >
            <div style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)' }}>
              <div style={{ fontWeight: 700, color: 'var(--ox-text-primary)', marginBottom: '0.25rem' }}>
                Why This Step Exists
              </div>
              <div style={{ color: 'var(--ox-text-secondary)', lineHeight: 1.35 }}>
                {currentStep.whyThisStepExists}
              </div>
            </div>

            <div style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)' }}>
              <div style={{ fontWeight: 700, color: 'var(--ox-text-primary)', marginBottom: '0.25rem' }}>
                What Could Fail
              </div>
              <div style={{ color: 'var(--ox-text-secondary)', lineHeight: 1.35 }}>
                {currentStep.whatCouldFail}
              </div>
            </div>

            <div style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)' }}>
              <div style={{ fontWeight: 700, color: 'var(--ox-text-primary)', marginBottom: '0.25rem' }}>
                Next Recommended Action
              </div>
              <div style={{ color: 'var(--ox-text-secondary)', lineHeight: 1.35 }}>
                {currentStep.nextRecommendedAction}
              </div>
            </div>
          </div>

          {/* Artifact Tray */}
          {currentStep.outputArtifact && (
            <div
              style={{
                padding: '0.75rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div>
                <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)' }}>
                  Generated Artifact: {currentStep.outputArtifact.name} ({currentStep.outputArtifact.type})
                </div>
                <div style={{ fontFamily: 'var(--ox-font-mono)', fontSize: '0.75rem', color: 'var(--ox-text-primary)', marginTop: '0.2rem' }}>
                  {JSON.stringify(currentStep.outputArtifact.payload)}
                </div>
              </div>

              <a
                href={`${basePath}/inspect/`}
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  color: 'var(--ox-bitcoin-orange)',
                  textDecoration: 'none'
                }}
              >
                <span>Inspect in Lens</span>
                <IconExternalLink size={12} />
              </a>
            </div>
          )}

          {/* Controlled Failure Injection Controls */}
          {selectedScenario.failureInjections && selectedScenario.failureInjections.length > 0 && (
            <div
              style={{
                padding: '0.875rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-status-warning-bg)',
                border: '1px solid var(--ox-status-warning-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem'
              }}
            >
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-status-warning-text)' }}>
                Controlled Failure Injection
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>
                Inject one controlled mutation to see how the protocol verifier detects and refuses the transaction:
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {selectedScenario.failureInjections.map((inj) => (
                  <button
                    key={inj.id}
                    type="button"
                    onClick={() => handleApplyFailureInjection(inj.id)}
                    style={{
                      padding: '0.35rem 0.625rem',
                      borderRadius: 'var(--ox-radius-sm)',
                      backgroundColor: 'var(--ox-surface-panel)',
                      border: '1px solid var(--ox-border-default)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      color: 'var(--ox-status-refusal-text)'
                    }}
                  >
                    Inject: {inj.label}
                  </button>
                ))}
              </div>

              {engineState.activeFailureInjectionId && (
                <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', display: 'flex', gap: '0.75rem' }}>
                  <a href={`${basePath}/diagnose/?code=${engineState.verificationVerdict.code}`} style={{ color: 'var(--ox-status-refusal-text)', fontWeight: 600 }}>
                    Triage in Failure Navigator →
                  </a>
                  <a href={`${basePath}/inspect/`} style={{ color: 'var(--ox-bitcoin-orange)', fontWeight: 600 }}>
                    Compare in Artifact Lens →
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
