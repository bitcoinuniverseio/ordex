import type { JSX } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { SCENARIOS, ACTOR_LANES, getScenarioById } from '../../lib/scenarios/registry.js';
import { createInitialScenarioState, scenarioReducer, pendingCheck, verdictFromResult, scenarioOutcome } from '../../lib/scenarios/engine.js';
import { recordToolEvidence } from '../../lib/session/evidence.js';
import type { ScenarioAction } from '../../lib/scenarios/engine.js';
import type { ScenarioDefinition, ScenarioExecutionState } from '../../lib/scenarios/types.js';
import { runVerifierJob } from '../../lib/verifier-client.mjs';
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
  // A mission may open a specific scenario with ?scenario=<id>; unknown ids fall back.
  const [selectedScenario, setSelectedScenario] = useState<ScenarioDefinition>(() => {
    const fromUrl = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('scenario') : null;
    return (fromUrl && getScenarioById(fromUrl)) || getScenarioById(initialScenarioId) || SCENARIOS[0];
  });
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

  const dispatch = (action: ScenarioAction) => setEngineState((prev) => scenarioReducer(prev, action, selectedScenario));

  // OX-S08: a pending step runs its exact verifier call in the OX-S07 Worker; the verdict is
  // whatever the verifier returns, including an honest unknown when the Worker fails.
  const pending = pendingCheck(engineState, selectedScenario);
  const pendingKey = pending?.key;
  useEffect(() => {
    if (!pending) return undefined;
    const controller = new AbortController();
    runVerifierJob({ type: 'candidate', family: pending.family, variant: pending.variant, args: pending.args }, { signal: controller.signal })
      .then((result) => dispatch({ type: 'VERIFICATION_RESULT', key: pending.key, verdict: verdictFromResult(pending, result) }))
      .catch((err) => {
        if (err?.code === 'VERIFIER_CANCELLED') return;
        dispatch({
          type: 'VERIFICATION_RESULT',
          key: pending.key,
          verdict: { state: 'unknown', code: err?.code || 'VERIFIER_ERROR', reason: String(err?.message || err), source: 'verifier', inputDigest: pending.inputDigest }
        });
      });
    return () => controller.abort();
  }, [pendingKey, selectedScenario]);

  // OX-S03: a completed uninjected walk, or an injection the verifier refused, is evidence.
  const recorded = useRef(new Set<string>());
  useEffect(() => {
    const v = engineState.verificationVerdict;
    const injection = engineState.activeFailureInjectionId;
    let key: string | null = null;
    let run: Parameters<typeof recordToolEvidence>[0] | null = null;
    if (injection && v.state === 'refused' && v.source === 'verifier') {
      key = `injection:${selectedScenario.id}:${injection}`;
      run = { tool: 'sandbox', operation: key, state: 'refused', code: v.code, reason: v.reason, evidenceClass: 'Deterministic example', inputDigest: v.inputDigest };
    } else if (!injection) {
      const outcome = scenarioOutcome(engineState, selectedScenario);
      if (outcome !== 'incomplete') {
        key = `scenario:${selectedScenario.id}`;
        run = { tool: 'sandbox', operation: key, state: outcome, reason: `Deterministic walk of ${selectedScenario.steps.length} steps with reference verifier results.`, evidenceClass: 'Deterministic example' };
      }
    }
    if (key && run && !recorded.current.has(key)) {
      recorded.current.add(key);
      recordToolEvidence(run);
    }
  }, [engineState, selectedScenario]);

  // Automated playback waits for each verifier result and stops at a refusal or the end.
  useEffect(() => {
    if (!isPlaying) return undefined;
    const v = engineState.verificationVerdict.state;
    if (v === 'pending') return undefined;
    if (v === 'refused' || v === 'unknown' || v === 'blocked' || engineState.currentStepIndex >= selectedScenario.steps.length - 1) {
      setIsPlaying(false);
      return undefined;
    }
    const timer = window.setTimeout(() => dispatch({ type: 'STEP_FORWARD' }), 1500);
    return () => clearTimeout(timer);
  }, [isPlaying, engineState.currentStepIndex, engineState.verificationVerdict.state, selectedScenario]);

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

  const handleStepForward = () => dispatch({ type: 'STEP_FORWARD' });
  const handleStepBackward = () => dispatch({ type: 'STEP_BACKWARD' });

  const handleReset = () => {
    setIsPlaying(false);
    dispatch({ type: 'RESET' });
  };

  const handleApplyFailureInjection = (injectionId: string) => {
    setIsPlaying(false);
    dispatch({ type: 'APPLY_FAILURE_INJECTION', injectionId });
  };

  const verdict = engineState.verificationVerdict;
  const verdictTone =
    verdict.state === 'accepted' ? 'success' : verdict.state === 'refused' || verdict.state === 'unknown' ? 'refusal' : 'neutral';
  const verdictLabel =
    verdict.state === 'accepted'
      ? 'Verifier accepted'
      : verdict.state === 'refused'
        ? `${verdict.source === 'fixture' ? 'Fixture refusal' : 'Verifier refused'}: ${verdict.code}`
        : verdict.state === 'pending'
          ? 'Running verifier...'
          : verdict.state === 'unknown'
            ? `No verdict: ${verdict.code || 'unknown'}`
            : verdict.state === 'blocked'
              ? 'Blocked by an earlier refusal'
              : 'No verification at this step';
  const activeInjection = selectedScenario.failureInjections?.find((f) => f.id === engineState.activeFailureInjectionId);

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
              <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-accent-text)' }}>
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
          <div style={{ minWidth: 'min(260px, 100%)' }}>
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
              data-tour="sandbox-playback"
              onClick={() => setIsPlaying(!isPlaying)}
              aria-pressed={isPlaying ? 'true' : 'false'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.35rem 0.75rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-bitcoin-orange)',
                color: 'var(--ox-action-fg)',
                border: 'none',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: 600
              }}
            >
              {isPlaying ? <IconPause size={12} color="var(--ox-action-fg)" /> : <IconPlay size={12} color="var(--ox-action-fg)" />}
              <span>{isPlaying ? 'Pause' : 'Play Simulation'}</span>
            </button>

            <button
              type="button"
              onClick={handleStepBackward}
              aria-label="Previous step"
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
              aria-label="Next step"
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
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10rem), 1fr))',
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
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: isActorActive ? 'var(--ox-accent-text)' : 'var(--ox-text-muted)' }}>
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
              role="status"
              aria-live="polite"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.35rem 0.625rem',
                borderRadius: 'var(--ox-radius-sm)',
                backgroundColor: verdictTone === 'success' ? 'var(--ox-status-success-bg)' : verdictTone === 'refusal' ? 'var(--ox-status-refusal-bg)' : 'var(--ox-surface-subtle)',
                color: verdictTone === 'success' ? 'var(--ox-status-success-text)' : verdictTone === 'refusal' ? 'var(--ox-status-refusal-text)' : 'var(--ox-text-secondary)',
                fontWeight: 600,
                fontSize: '0.75rem'
              }}
            >
              {verdictTone === 'success' ? (
                <IconShieldCheck size={16} color="var(--ox-status-success-text)" />
              ) : verdictTone === 'refusal' ? (
                <IconAlertTriangle size={16} color="var(--ox-status-refusal-text)" />
              ) : null}
              <span>{verdictLabel}</span>
            </div>
          </div>

          {/* Structured Explanations */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
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

          {/* Verdict evidence: exact input digests and the verifier's reason */}
          {(verdict.reason || verdict.inputDigest || currentStep.observation) && (
            <div style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)', fontSize: '0.75rem', color: 'var(--ox-text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {verdict.reason && <div><strong>Reason:</strong> {verdict.reason}</div>}
              {verdict.inputDigest && (
                <div style={{ wordBreak: 'break-all' }}>
                  <strong>Verifier input SHA-256:</strong> <code>{verdict.inputDigest}</code>
                </div>
              )}
              {verdict.originalInputDigest && (
                <div style={{ wordBreak: 'break-all' }}>
                  <strong>Before the injected change:</strong> <code>{verdict.originalInputDigest}</code>
                  {verdict.changedPaths?.length ? <span> (changed: {verdict.changedPaths.join(', ')})</span> : null}
                </div>
              )}
              {currentStep.observation && (
                <div>
                  <strong>Deterministic fixture:</strong> {currentStep.observation.field} = <code>{currentStep.observation.value}</code>. The sandbox cannot observe gateway or chain state; confirm it against a real node.
                </div>
              )}
              {currentStep.verifierCheck?.vectorId && (
                <div>
                  <strong>Arguments from vector:</strong> <code>{currentStep.verifierCheck.vectorId}</code>
                </div>
              )}
            </div>
          )}

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
                  {engineState.artifactsGenerated.some((a) => a.stepNumber === engineState.currentStepIndex + 1)
                    ? 'Artifact'
                    : 'Artifact not produced (the step did not complete)'}
                  : {currentStep.outputArtifact.name} ({currentStep.outputArtifact.type})
                </div>
                <div style={{ fontFamily: 'var(--ox-font-mono)', fontSize: '0.75rem', color: 'var(--ox-text-primary)', marginTop: '0.2rem' }}>
                  {JSON.stringify(currentStep.outputArtifact.payload).slice(0, 400)}
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
                  color: 'var(--ox-accent-text)',
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

              {activeInjection && (
                <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
                  <span>
                    Active: <strong>{activeInjection.label}</strong>. {activeInjection.affectedInvariant}
                  </span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'CLEAR_FAILURE_INJECTION' })}
                    style={{ padding: '0.25rem 0.5rem', borderRadius: 'var(--ox-radius-sm)', border: '1px solid var(--ox-border-default)', backgroundColor: 'var(--ox-surface-panel)', color: 'var(--ox-text-primary)', fontSize: '0.75rem', cursor: 'pointer' }}
                  >
                    Remove injection
                  </button>
                  {verdict.state === 'refused' && verdict.code && (
                    <a href={`${basePath}/diagnose/?code=${encodeURIComponent(verdict.code)}`} style={{ color: 'var(--ox-status-refusal-text)', fontWeight: 600 }}>
                      Triage in Failure Navigator
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
