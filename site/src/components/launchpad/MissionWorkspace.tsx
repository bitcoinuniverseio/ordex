import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { MISSIONS, getMissionById, type MissionDefinition, type StageId } from '../../lib/experience/mission-registry.js';
import { evaluateStage, requirementFor, MISSION_EVIDENCE } from '../../lib/experience/mission-evidence.js';
import { journeyStore, JourneyStoreError, type OrdexJourneySession, type EvidenceRecord, type UserSettings } from '../../lib/session/journey-store.js';
import { contextFromSettings, sameContext, DEFAULT_SETTINGS, type JourneyContext } from '../../lib/session/journey-schema.js';
import { journeyQuery, recordToolEvidence, SOURCE_BUILD } from '../../lib/session/evidence.js';
import { contextEngine } from '../../lib/experience/context-engine.js';
import { IconCheck, IconArrowRight, IconReset, IconExternalLink, IconAlertTriangle } from '../experience/OrdexIcons.js';

interface WorkspaceProps {
  initialMissionId?: string;
  basePath?: string;
}

const SCENARIO_FOR: Record<string, string> = {
  'integrate-public-asks': 'ask.publish-and-settle.success',
  'complete-single-or-batch-purchase': 'purchase.batch.success',
  'integrate-buyer-funded-offers': 'offer.accept.success',
  'protect-wallet-signing': 'ask.wallet-output-reorder.refusal',
  'integrate-atomic-swaps': 'swap.atomic-settlement.success',
  'verify-collection-and-attached-assets': 'collection.membership.success',
  'diagnose-protocol-failure': 'ask.publish-and-settle.success',
  'perform-security-review': 'ask.publish-and-settle.success'
};

function missionFromUrl(fallback: string): MissionDefinition {
  if (typeof window !== 'undefined') {
    const id = new URLSearchParams(window.location.search).get('mission');
    const found = id ? getMissionById(id) : undefined;
    if (found) return found;
  }
  return getMissionById(fallback) || MISSIONS[0];
}

/* IMPLEMENTATION-HANDOFF [OX-S03] (final phase, remaining)
 * Evidence-based completion, stage adapters, durable store and context are implemented. Remaining: the
 * playground, events, doctor, kits, wizards, failure-navigator and atlas tools must record evidence with the
 * operations named in mission-evidence.ts; then prove all nine missions through eight stages in
 * tests/e2e/missions.test.js on real IndexedDB (reload, cross-tab, wrong network).
 */
/**
 * OX-S03: a stage completes only when matching evidence exists for this mission in the
 * current network, gateway, protocol and build. Completed stages whose evidence came from
 * another context are shown as needing a repeat, never as done. Tool links carry the
 * session and stage as opaque ids so the tool's run is attached to this mission.
 */
export function MissionWorkspace({ initialMissionId = 'integrate-public-asks', basePath = '/ordex' }: WorkspaceProps): JSX.Element {
  const [mission] = useState<MissionDefinition>(() => missionFromUrl(initialMissionId));
  const [session, setSession] = useState<OrdexJourneySession | null>(null);
  const [settings, setSettings] = useState<UserSettings>({ ...DEFAULT_SETTINGS });
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [activeStageId, setActiveStageId] = useState<StageId>(mission.stages[0].id);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const context: JourneyContext = contextFromSettings(settings, SOURCE_BUILD);

  // Load settings, the saved session for this mission (never another mission's), and its
  // evidence; follow commits from other tabs. Stale async loads are ignored.
  useEffect(() => {
    let live = true;
    const loadEvidence = async () => {
      const list = await journeyStore.listEvidence({ missionId: mission.id }).catch(() => []);
      if (live) setEvidence(list);
    };
    const loadSession = async (id?: string) => {
      const s = id ? await journeyStore.getSession(id) : await journeyStore.getSessionForMission(mission.id);
      if (live && s && s.missionId === mission.id) {
        setSession(s);
        setActiveStageId(s.activeStageId as StageId);
      }
      return s;
    };
    (async () => {
      try {
        const s = await journeyStore.getSettings();
        if (!live) return;
        setSettings(s);
        const existing = await loadSession();
        if (!existing && live) {
          const created = await journeyStore.createSession(mission.id, contextFromSettings(s, SOURCE_BUILD), { role: mission.roles[0] || null });
          if (live) setSession(created);
        }
        await loadEvidence();
      } catch (err) {
        if (live) setMessage({ tone: 'error', text: `Progress cannot be saved in this browser: ${(err as Error).message}` });
      }
    })();
    const unsubscribe = journeyStore.subscribe((event) => {
      if (event.type === 'evidence') loadEvidence();
      if (event.type === 'settings') journeyStore.getSettings().then((s) => live && setSettings(s));
      if (event.type === 'session') setSession((cur) => {
        if (cur && event.id === cur.id && event.revision !== cur.revision) loadSession(cur.id);
        return cur;
      });
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [mission.id]);

  useEffect(() => {
    const stage = mission.stages.find((s) => s.id === activeStageId);
    contextEngine.setContext({ missionId: mission.id, stageId: activeStageId, title: `${mission.title}: ${stage?.title || ''}`, sourcePointer: mission.sourceRefs[0]?.path });
  }, [mission, activeStageId]);

  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  /** A recorded completion counts only while its evidence exists and matches the current context and build. */
  const completionCurrent = (stageId: StageId): boolean => {
    const c = session?.completedStages.find((x) => x.stageId === stageId);
    if (!c) return false;
    return c.evidenceIds.every((id) => {
      const e = evidenceById.get(id);
      return !!e && sameContext(e.context, context) && e.context.sourceBuild === context.sourceBuild;
    });
  };
  const nonFinish = mission.stages.filter((s) => s.id !== 'finish');
  const currentCount = mission.stages.filter((s) => completionCurrent(s.id)).length;

  const mutate = async (fn: (s: OrdexJourneySession) => OrdexJourneySession) => {
    if (!session) return null;
    try {
      const saved = await journeyStore.updateSession(session.id, session.revision, fn);
      setSession(saved);
      return saved;
    } catch (err) {
      if (err instanceof JourneyStoreError && err.code === 'REVISION_CONFLICT') {
        const fresh = await journeyStore.getSession(session.id);
        if (fresh) setSession(fresh);
        setMessage({ tone: 'error', text: 'This mission changed in another tab. The latest progress is now shown; try again.' });
      } else {
        setMessage({ tone: 'error', text: `Not saved: ${(err as Error).message}` });
      }
      return null;
    }
  };

  const selectStage = (stageId: StageId) => {
    setActiveStageId(stageId);
    setMessage(null);
    mutate((s) => ({ ...s, activeStageId: stageId }));
  };

  const acknowledgeReading = async () => {
    setBusy(true);
    const ev = await recordToolEvidence(
      { tool: 'learn', operation: `read:${mission.id}`, state: 'read', evidenceClass: 'Deterministic example', reason: 'The reader acknowledged the mission guide.' },
      session ? { sessionId: session.id, stageId: 'understand', artifactId: null } : null
    );
    setBusy(false);
    if (!ev) setMessage({ tone: 'error', text: 'The acknowledgement could not be saved in this browser.' });
    else setEvidence(await journeyStore.listEvidence({ missionId: mission.id }));
  };

  const completeStage = async () => {
    setMessage(null);
    if (!session) return;
    const idx = mission.stages.findIndex((s) => s.id === activeStageId);
    let evidenceIds: string[];
    if (activeStageId === 'finish') {
      const missing = nonFinish.filter((s) => !completionCurrent(s.id));
      if (missing.length) {
        setMessage({ tone: 'error', text: `Not complete yet. These stages still need current evidence: ${missing.map((s) => s.title).join(', ')}.` });
        return;
      }
      evidenceIds = nonFinish.flatMap((s) => session.completedStages.find((c) => c.stageId === s.id)!.evidenceIds);
    } else {
      const evaluation = evaluateStage(mission.id, activeStageId, evidence, context);
      if (!evaluation.satisfied) {
        setMessage({ tone: 'error', text: `Not complete yet. ${evaluation.reason}` });
        return;
      }
      evidenceIds = evaluation.evidenceIds;
    }
    const next = mission.stages[Math.min(idx + 1, mission.stages.length - 1)].id;
    const saved = await mutate((s) => ({
      ...s,
      activeStageId: next,
      evidenceIds: Array.from(new Set([...s.evidenceIds, ...evidenceIds])),
      completedStages: [
        ...s.completedStages.filter((c) => c.stageId !== activeStageId),
        { stageId: activeStageId, evidenceIds: Array.from(new Set(evidenceIds)), completedAt: new Date().toISOString() }
      ]
    }));
    if (saved) {
      setActiveStageId(next);
      setMessage({ tone: 'info', text: activeStageId === 'finish' ? 'Mission complete: every stage is backed by current evidence.' : 'Stage complete. Its evidence is saved with this mission.' });
    }
  };

  const resetMission = async () => {
    const saved = await mutate((s) => ({ ...s, activeStageId: 'understand', completedStages: [], acknowledgedStageIds: [] }));
    if (saved) {
      setActiveStageId('understand');
      setMessage({ tone: 'info', text: 'Progress reset. Recorded runs are kept and can be used again.' });
    }
  };

  const activeStage = mission.stages.find((s) => s.id === activeStageId) || mission.stages[0];
  const requirement = requirementFor(mission.id, activeStage.id);
  const evaluation = activeStage.id === 'finish' ? null : evaluateStage(mission.id, activeStage.id, evidence, context);
  const toolHref = (() => {
    if (!session || !activeStage.toolRoute || activeStage.id === 'finish') return null;
    const route = activeStage.toolRoute.endsWith('/') ? activeStage.toolRoute : `${activeStage.toolRoute}/`;
    let q = journeyQuery(session.id, activeStage.id);
    if (activeStage.id === 'simulate' && SCENARIO_FOR[mission.id]) q += `&scenario=${encodeURIComponent(SCENARIO_FOR[mission.id])}`;
    return `${basePath}${route}${q}`;
  })();
  const contextChanged = session && !sameContext(session.context, context);
  const prereqState = (check?: string): { text: string; ok: boolean | null } => {
    if (check === 'gateway-origin') return settings.gatewayOrigin ? { text: `Configured: ${settings.gatewayOrigin}`, ok: true } : { text: 'Not configured. Set a gateway origin in settings.', ok: false };
    if (check === 'web-worker') return typeof Worker !== 'undefined' ? { text: 'Available in this browser', ok: true } : { text: 'This browser cannot start a Web Worker', ok: false };
    return { text: 'Not checked by Ordex; confirm it yourself', ok: null };
  };
  const panel = { padding: '1.5rem', borderRadius: 'var(--ox-radius-lg)', backgroundColor: 'var(--ox-surface-panel)', border: '1px solid var(--ox-border-default)' };

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ ...panel, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-secondary)' }}>
            Mission Workspace · {mission.roles.join(', ')}
          </span>
          <button type="button" onClick={resetMission} disabled={!session} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'transparent', border: '1px solid var(--ox-border-default)', borderRadius: 'var(--ox-radius-sm)', color: 'var(--ox-text-secondary)', cursor: 'pointer' }}>
            <IconReset size={12} />
            <span>Reset progress</span>
          </button>
        </div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>{mission.title}</h1>
        <p style={{ fontSize: '0.9375rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.4 }}>{mission.plainEnglishGoal}</p>
        <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>
          Context: <strong>{context.network}</strong>, {context.gatewayOrigin || 'no gateway (local runs only)'}, protocol {context.protocolVersion}, build <code>{context.sourceBuild.slice(0, 12)}</code>
        </div>
        {contextChanged && (
          <div role="status" style={{ fontSize: '0.8125rem', color: 'var(--ox-status-warning-text)' }}>
            Settings changed since this mission started. Stages need evidence recorded in the current context.
          </div>
        )}
        <div style={{ marginTop: '0.5rem', padding: '0.75rem 1rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-subtle)', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-secondary)' }}>Prerequisites</div>
          {mission.prerequisites.map((p) => {
            const st = prereqState(p.check);
            return (
              <div key={p.id} style={{ fontSize: '0.8125rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                <span style={{ color: 'var(--ox-text-primary)' }}>{p.label}:</span>
                <span style={{ color: st.ok === true ? 'var(--ox-status-success-text)' : st.ok === false ? 'var(--ox-status-refusal-text)' : 'var(--ox-text-secondary)' }}>{st.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      <nav aria-label="Mission stages" data-tour="mission-stages" style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.5rem' }}>
        {mission.stages.map((st, idx) => {
          const isActive = st.id === activeStageId;
          const done = completionCurrent(st.id);
          const staleDone = !done && !!session?.completedStages.some((c) => c.stageId === st.id);
          return (
            <button
              key={st.id}
              type="button"
              onClick={() => selectStage(st.id)}
              aria-current={isActive ? 'step' : undefined}
              aria-label={`${idx + 1}. ${st.title}: ${done ? 'complete' : staleDone ? 'needs to be repeated' : 'not complete'}`}
              style={{ flex: '1 0 120px', padding: '0.75rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: isActive ? 'var(--ox-surface-panel)' : 'var(--ox-surface-subtle)', border: isActive ? '2px solid var(--ox-bitcoin-orange)' : done ? '1px solid var(--ox-status-success-border)' : '1px solid var(--ox-border-default)', textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '0.25rem', color: 'var(--ox-text-primary)' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-secondary)' }}>
                {idx + 1}. {st.id.toUpperCase()}
                {done && <IconCheck size={14} color="var(--ox-status-success-text)" />}
                {staleDone && <IconAlertTriangle size={14} color="var(--ox-status-warning-text)" />}
              </span>
              <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{st.title}</span>
            </button>
          );
        })}
      </nav>

      <div style={{ ...panel, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-secondary)', marginBottom: '0.25rem' }}>Stage: {activeStage.id}</div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: 'var(--ox-text-primary)' }}>{activeStage.title}</h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', marginTop: '0.375rem', lineHeight: 1.4 }}>{activeStage.description}</p>
        </div>

        <div data-tour="stage-evidence" style={{ padding: '1rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-subtle)', display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8125rem' }}>
          <div>
            <strong>What completes this stage:</strong>{' '}
            {activeStage.id === 'finish' ? 'Every other stage complete with evidence from the current context.' : requirement?.label || 'No requirement defined.'}
          </div>
          {evaluation && (
            <div role="status" style={{ color: evaluation.satisfied ? 'var(--ox-status-success-text)' : 'var(--ox-text-secondary)' }}>
              {evaluation.satisfied ? evaluation.reason : `Waiting for evidence. ${evaluation.stale.length ? `${evaluation.stale.length} earlier run(s) are from another context.` : ''}`}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {activeStage.id === 'understand' && (
              <button type="button" disabled={busy || !session} onClick={acknowledgeReading} style={{ padding: '0.45rem 0.875rem', borderRadius: 'var(--ox-radius-md)', border: '1px solid var(--ox-border-strong)', background: 'var(--ox-surface-panel)', color: 'var(--ox-text-primary)', fontWeight: 600, cursor: 'pointer' }}>
                I have read the guide
              </button>
            )}
            {toolHref && (
              <a href={toolHref} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', padding: '0.45rem 0.875rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-panel)', border: '1px solid var(--ox-border-strong)', color: 'var(--ox-text-primary)', fontWeight: 600, textDecoration: 'none' }}>
                <span>{activeStage.toolActionLabel || 'Open tool'}</span>
                <IconExternalLink size={14} />
              </a>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', paddingTop: '1rem', borderTop: '1px solid var(--ox-border-subtle)' }}>
          <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>
            Complete with current evidence: {currentCount} of {mission.stages.length}
          </div>
          <button type="button" onClick={completeStage} disabled={!session} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1.125rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-bitcoin-orange)', color: 'var(--ox-text-on-accent, #1a1a1a)', border: 'none', fontWeight: 700, fontSize: '0.8125rem', cursor: 'pointer' }}>
            <span>Check evidence and complete</span>
            <IconArrowRight size={14} />
          </button>
        </div>
        <div aria-live="polite">
          {message && (
            <div role={message.tone === 'error' ? 'alert' : 'status'} style={{ fontSize: '0.8125rem', color: message.tone === 'error' ? 'var(--ox-status-refusal-text)' : 'var(--ox-status-success-text)' }}>
              {message.text}
            </div>
          )}
        </div>
      </div>

      <div style={{ ...panel, padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-secondary)' }}>Mission completion criteria</div>
        {mission.completionCriteria.map((crit) => {
          const text =
            crit.evidenceClass === 'Chain proof'
              ? 'Needs chain evidence from a real Signet or Testnet4 transaction; this workspace cannot confirm it.'
              : crit.evidenceClass === 'Gateway observation'
                ? completionCurrent('validate') || completionCurrent('prepare')
                  ? 'Backed by a recorded gateway run.'
                  : 'Needs a run against a configured gateway.'
                : crit.verifierRef
                  ? completionCurrent('verify')
                    ? `Backed by a recorded ${crit.verifierRef} verifier run.`
                    : `Needs a ${crit.verifierRef} verifier run.`
                  : completionCurrent('inspect')
                    ? 'Backed by a recorded Artifact Lens run.'
                    : 'Needs an Artifact Lens run.';
          return (
            <div key={crit.id} style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)', fontSize: '0.8125rem' }}>
              <span style={{ color: 'var(--ox-text-primary)' }}>{crit.description}</span>
              <span style={{ color: 'var(--ox-text-secondary)' }}>
                {crit.evidenceClass}: {text}
              </span>
            </div>
          );
        })}
        {!MISSION_EVIDENCE[mission.id] && <div role="alert">This mission has no evidence adapters.</div>}
      </div>
    </div>
  );
}
