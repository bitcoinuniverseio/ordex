import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import {
  MISSIONS,
  getMissionById,
  type MissionDefinition,
  type MissionStageDefinition,
  type StageId
} from '../../lib/experience/mission-registry.js';
import { journeyStore, type OrdexJourneySession } from '../../lib/session/journey-store.js';
import { contextEngine } from '../../lib/experience/context-engine.js';
import {
  IconCheck,
  IconArrowRight,
  IconReset,
  IconShieldCheck,
  IconExternalLink,
  IconAlertTriangle
} from '../experience/OrdexIcons.js';

interface WorkspaceProps {
  initialMissionId?: string;
  basePath?: string;
}

export function MissionWorkspace({
  initialMissionId = 'integrate-public-asks',
  basePath = '/ordex'
}: WorkspaceProps): JSX.Element {
  const [mission, setMission] = useState<MissionDefinition>(
    getMissionById(initialMissionId) || MISSIONS[0]
  );
  const [activeStageId, setActiveStageId] = useState<StageId>(mission.stages[0].id);
  const [completedStageIds, setCompletedStageIds] = useState<StageId[]>([]);
  const [session, setSession] = useState<OrdexJourneySession | null>(null);
  const [prereqStates, setPrereqStates] = useState<Record<string, boolean>>({});

  // Sync with URL query parameter
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const mId = params.get('mission');
      if (mId) {
        const found = getMissionById(mId);
        if (found) {
          setMission(found);
          setActiveStageId(found.stages[0].id);
        }
      }
    }
  }, []);

  // Load or create session
  useEffect(() => {
    const initSession = async () => {
      const existing = await journeyStore.getActiveSession();
      if (existing && existing.missionId === mission.id) {
        setSession(existing);
        setActiveStageId(existing.activeStageId as StageId);
        setCompletedStageIds(existing.completedStageIds as StageId[]);
      } else {
        const newSession: OrdexJourneySession = {
          schemaVersion: 1,
          id: `session-${Date.now()}`,
          missionId: mission.id,
          protocolVersion: '1.2',
          role: mission.roles[0] || null,
          environment: 'deterministic',
          disclosureMode: 'plain',
          activeStageId: mission.stages[0].id,
          completedStageIds: [],
          stageState: {},
          artifactReferences: [],
          runReferences: [],
          buildCommit: 'f6df565',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await journeyStore.saveSession(newSession);
        setSession(newSession);
      }
    };
    initSession();
  }, [mission.id]);

  // Update Context Rail context
  useEffect(() => {
    const currentStage = mission.stages.find((s) => s.id === activeStageId);
    contextEngine.setContext({
      missionId: mission.id,
      stageId: activeStageId,
      title: `${mission.title}: ${currentStage?.title || ''}`,
      sourcePointer: mission.sourceRefs[0]?.path
    });
  }, [mission, activeStageId]);

  const handleStageSelect = (stageId: StageId) => {
    setActiveStageId(stageId);
    if (session) {
      const updated = { ...session, activeStageId: stageId };
      setSession(updated);
      journeyStore.saveSession(updated);
    }
  };

  const handleCompleteCurrentStage = async () => {
    const nextCompleted = Array.from(new Set([...completedStageIds, activeStageId]));
    setCompletedStageIds(nextCompleted);

    // Advance to next stage if available
    const currentIndex = mission.stages.findIndex((s) => s.id === activeStageId);
    let nextStageId = activeStageId;
    if (currentIndex < mission.stages.length - 1) {
      nextStageId = mission.stages[currentIndex + 1].id;
      setActiveStageId(nextStageId);
    }

    if (session) {
      const updated: OrdexJourneySession = {
        ...session,
        activeStageId: nextStageId,
        completedStageIds: nextCompleted
      };
      setSession(updated);
      await journeyStore.saveSession(updated);
    }

    await journeyStore.logRun({
      product: 'launchpad',
      operation: `Complete Stage: ${activeStageId}`,
      isDeterministic: true,
      protocolVersion: '1.2',
      outcome: 'PASS',
      evidenceClass: 'Protocol verification',
      summary: `Completed stage ${activeStageId} in mission ${mission.id}`,
      reopenRoute: `/workspace/?mission=${mission.id}`
    });
  };

  const handleResetMission = async () => {
    setCompletedStageIds([]);
    setActiveStageId(mission.stages[0].id);
    if (session) {
      const resetSession: OrdexJourneySession = {
        ...session,
        activeStageId: mission.stages[0].id,
        completedStageIds: [],
        stageState: {}
      };
      setSession(resetSession);
      await journeyStore.saveSession(resetSession);
    }
  };

  const activeStage = mission.stages.find((s) => s.id === activeStageId) || mission.stages[0];

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header & Goal Banner */}
      <div
        style={{
          padding: '1.5rem',
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-bitcoin-orange)' }}>
              Mission Workspace
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>•</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>
              Role: {mission.roles.join(', ')}
            </span>
          </div>

          <button
            type="button"
            onClick={handleResetMission}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: '0.25rem 0.5rem',
              fontSize: '0.75rem',
              background: 'transparent',
              border: '1px solid var(--ox-border-subtle)',
              borderRadius: 'var(--ox-radius-sm)',
              color: 'var(--ox-text-muted)',
              cursor: 'pointer'
            }}
          >
            <IconReset size={12} />
            <span>Reset Mission</span>
          </button>
        </div>

        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>
          {mission.title}
        </h1>

        <p style={{ fontSize: '0.9375rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.4 }}>
          {mission.plainEnglishGoal}
        </p>

        {/* Prerequisites Checklist */}
        <div
          style={{
            marginTop: '0.5rem',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--ox-radius-md)',
            backgroundColor: 'var(--ox-surface-subtle)',
            border: '1px solid var(--ox-border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.375rem'
          }}
        >
          <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)' }}>
            Prerequisites Checklist
          </div>
          {mission.prerequisites.map((prereq) => (
            <div key={prereq.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem' }}>
              <span style={{ color: 'var(--ox-status-success-text)' }}>✓</span>
              <span style={{ color: 'var(--ox-text-secondary)' }}>{prereq.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Visual Task Stage Map */}
      <nav
        aria-label="Mission Stages"
        style={{
          display: 'flex',
          gap: '0.5rem',
          overflowX: 'auto',
          paddingBottom: '0.5rem'
        }}
      >
        {mission.stages.map((st, idx) => {
          const isActive = st.id === activeStageId;
          const isDone = completedStageIds.includes(st.id);

          return (
            <button
              key={st.id}
              type="button"
              onClick={() => handleStageSelect(st.id)}
              aria-current={isActive ? 'step' : undefined}
              style={{
                flex: '1 0 120px',
                padding: '0.75rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: isActive ? 'var(--ox-surface-panel)' : 'var(--ox-surface-subtle)',
                border: isActive
                  ? '2px solid var(--ox-bitcoin-orange)'
                  : isDone
                  ? '1px solid var(--ox-status-success-border)'
                  : '1px solid var(--ox-border-default)',
                textAlign: 'left',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem',
                transition: 'all 0.15s ease'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)' }}>
                  {idx + 1}. {st.id.toUpperCase()}
                </span>
                {isDone && <IconCheck size={14} color="var(--ox-status-success-text)" />}
              </div>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--ox-text-primary)' }}>
                {st.title}
              </div>
            </button>
          );
        })}
      </nav>

      {/* Active Stage Workbench Card */}
      <div
        style={{
          padding: '1.5rem',
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem'
        }}
      >
        <div>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-bitcoin-orange)', marginBottom: '0.25rem' }}>
            Active Stage: {activeStage.id}
          </div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: 'var(--ox-text-primary)' }}>
            {activeStage.title}
          </h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', marginTop: '0.375rem', lineHeight: 1.4 }}>
            {activeStage.description}
          </p>
        </div>

        {/* Live Adapter Link or Action */}
        {activeStage.toolRoute && (
          <div
            style={{
              padding: '1.25rem',
              borderRadius: 'var(--ox-radius-md)',
              backgroundColor: 'var(--ox-surface-subtle)',
              border: '1px solid var(--ox-border-default)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem'
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--ox-text-primary)' }}>
                Target Tool: {activeStage.toolActionLabel || 'Open Tool'}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)', marginTop: '0.125rem' }}>
                Structured state transfers seamlessly without manual copy-and-paste.
              </div>
            </div>

            <a
              href={`${basePath}${activeStage.toolRoute}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.45rem 0.875rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-panel)',
                border: '1px solid var(--ox-border-strong)',
                color: 'var(--ox-text-primary)',
                fontWeight: 600,
                fontSize: '0.8125rem',
                textDecoration: 'none'
              }}
            >
              <span>{activeStage.toolActionLabel || 'Launch Tool'}</span>
              <IconExternalLink size={14} />
            </a>
          </div>
        )}

        {/* Stage Summary Template Preview */}
        <div
          style={{
            padding: '0.875rem',
            borderRadius: 'var(--ox-radius-sm)',
            borderLeft: '3px solid var(--ox-bitcoin-orange)',
            backgroundColor: 'var(--ox-surface-subtle)',
            fontSize: '0.8125rem',
            color: 'var(--ox-text-secondary)',
            lineHeight: 1.4
          }}
        >
          <strong>Stage Invariant:</strong> {activeStage.summaryTemplate}
        </div>

        {/* Stage Navigation & Completion Action */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: '1rem',
            borderTop: '1px solid var(--ox-border-subtle)'
          }}
        >
          <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-muted)' }}>
            Completed stages: {completedStageIds.length} of {mission.stages.length}
          </div>

          <button
            type="button"
            onClick={handleCompleteCurrentStage}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: '0.5rem 1.125rem',
              borderRadius: 'var(--ox-radius-md)',
              backgroundColor: 'var(--ox-bitcoin-orange)',
              color: '#ffffff',
              border: 'none',
              fontWeight: 600,
              fontSize: '0.8125rem',
              cursor: 'pointer',
              boxShadow: 'var(--ox-shadow-sm)'
            }}
          >
            <span>Mark Stage Complete & Continue</span>
            <IconArrowRight size={14} />
          </button>
        </div>
      </div>

      {/* Completion Criteria & Verification Evidence */}
      <div
        style={{
          padding: '1.25rem',
          borderRadius: 'var(--ox-radius-md)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem'
        }}
      >
        <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)' }}>
          Mission Completion Criteria
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {mission.completionCriteria.map((crit) => (
            <div
              key={crit.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--ox-radius-sm)',
                backgroundColor: 'var(--ox-surface-subtle)',
                fontSize: '0.8125rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <IconShieldCheck size={16} color="var(--ox-status-success-text)" />
                <span style={{ color: 'var(--ox-text-primary)' }}>{crit.description}</span>
              </div>
              <span
                style={{
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  padding: '0.1rem 0.4rem',
                  borderRadius: 'var(--ox-radius-sm)',
                  backgroundColor: 'var(--ox-surface-panel)',
                  border: '1px solid var(--ox-border-subtle)',
                  color: 'var(--ox-text-muted)'
                }}
              >
                {crit.evidenceClass}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
