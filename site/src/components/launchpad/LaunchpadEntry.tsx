import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { MISSIONS, type MissionDefinition } from '../../lib/experience/mission-registry.js';
import { journeyStore, type OrdexJourneySession } from '../../lib/session/journey-store.js';
import {
  IconLaunchpad,
  IconSandbox,
  IconInspect,
  IconDiagnose,
  IconAgents,
  IconArrowRight,
  IconShieldCheck
} from '../experience/OrdexIcons.js';

interface GoalChoice {
  id: string;
  label: string;
  description: string;
  missionIds: string[];
}

const GOALS: GoalChoice[] = [
  {
    id: 'goal-marketplace',
    label: 'Build a marketplace integration',
    description: 'List public asks, support batch purchases, and handle buyer-funded offers.',
    missionIds: ['integrate-public-asks', 'complete-single-or-batch-purchase', 'integrate-buyer-funded-offers']
  },
  {
    id: 'goal-trade',
    label: 'Complete or support a trade',
    description: 'Compose atomic single or batch settlements and bilateral peer-to-peer swaps.',
    missionIds: ['complete-single-or-batch-purchase', 'integrate-atomic-swaps']
  },
  {
    id: 'goal-wallet',
    label: 'Protect a wallet or signing flow',
    description: 'Prevent output reordering, sighash downgrades, and unintended sat flow burns.',
    missionIds: ['protect-wallet-signing']
  },
  {
    id: 'goal-gateway',
    label: 'Operate a gateway and event integration',
    description: 'Host an Ordex gateway, run Gateway Doctor checks, and consume event streams.',
    missionIds: ['operate-gateway-and-events']
  },
  {
    id: 'goal-provenance',
    label: 'Verify assets and provenance',
    description: 'Validate creator BIP-322 Merkle proofs and Counterparty attached UTXOs.',
    missionIds: ['verify-collection-and-attached-assets']
  },
  {
    id: 'goal-diagnose',
    label: 'Diagnose a failure',
    description: 'Map refusal codes and verifier rejections to root cause and remediation.',
    missionIds: ['diagnose-protocol-failure']
  },
  {
    id: 'goal-security',
    label: 'Review protocol and security model',
    description: 'Audit trust boundaries, fail-closed verifiers, and air-gapped signing rules.',
    missionIds: ['perform-security-review']
  }
];

interface LaunchpadEntryProps {
  basePath?: string;
}

export function LaunchpadEntry({ basePath = '/ordex' }: LaunchpadEntryProps): JSX.Element {
  const [selectedGoalId, setSelectedGoalId] = useState<string>('goal-marketplace');
  const [activeSession, setActiveSession] = useState<OrdexJourneySession | null>(null);

  useEffect(() => {
    journeyStore.getActiveSession().then((session) => {
      setActiveSession(session);
    });
  }, []);

  const currentGoal = GOALS.find((g) => g.id === selectedGoalId) || GOALS[0];
  const filteredMissions = MISSIONS.filter((m) => currentGoal.missionIds.includes(m.id));

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Hero Welcome & Value Proposition */}
      <section
        style={{
          padding: '2rem 1.5rem',
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--ox-bitcoin-orange)', fontWeight: 700, fontSize: '0.8125rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          <IconShieldCheck size={16} />
          <span>Verifiable Bitcoin Marketplace Protocol</span>
        </div>

        <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: 0, letterSpacing: '-0.03em', color: 'var(--ox-text-primary)' }}>
          Ordex Launchpad
        </h1>

        <p style={{ fontSize: '1rem', color: 'var(--ox-text-secondary)', lineHeight: 1.5, margin: 0, maxWidth: '720px' }}>
          Ordex enables trustless, portable orderbooks for Bitcoin inscriptions, runes, and digital artifacts.
          Every transaction invariant is verified locally in browser Web Workers before reaching any signer.
        </p>

        {/* Resume Active Session Card if available */}
        {activeSession && (
          <div
            style={{
              padding: '1rem 1.25rem',
              borderRadius: 'var(--ox-radius-md)',
              backgroundColor: 'var(--ox-surface-subtle)',
              border: '1px solid var(--ox-border-strong)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              marginTop: '0.5rem'
            }}
          >
            <div>
              <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)' }}>
                Resume Active Journey
              </div>
              <div style={{ fontWeight: 600, color: 'var(--ox-text-primary)', marginTop: '0.125rem' }}>
                Mission: {activeSession.missionId} (Stage: {activeSession.activeStageId})
              </div>
            </div>

            <a
              href={`${basePath}/workspace/?mission=${activeSession.missionId}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.4rem 0.875rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-bitcoin-orange)',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: '0.8125rem',
                textDecoration: 'none'
              }}
            >
              <span>Resume Mission</span>
              <IconArrowRight size={14} />
            </a>
          </div>
        )}
      </section>

      {/* Decision 1: What are you trying to do? */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.25rem 0', color: 'var(--ox-text-primary)' }}>
            What are you trying to do?
          </h2>
          <div style={{ fontSize: '0.875rem', color: 'var(--ox-text-muted)' }}>
            Select your goal to view matching verified missions.
          </div>
        </div>

        <div
          role="radiogroup"
          aria-label="High Level Goals"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '0.75rem'
          }}
        >
          {GOALS.map((goal) => {
            const isSelected = goal.id === selectedGoalId;
            return (
              <button
                key={goal.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setSelectedGoalId(goal.id)}
                style={{
                  padding: '1rem',
                  borderRadius: 'var(--ox-radius-md)',
                  border: isSelected ? '2px solid var(--ox-bitcoin-orange)' : '1px solid var(--ox-border-default)',
                  backgroundColor: isSelected ? 'var(--ox-surface-subtle)' : 'var(--ox-surface-panel)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.375rem',
                  transition: 'all 0.15s ease'
                }}
              >
                <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--ox-text-primary)' }}>
                  {goal.label}
                </div>
                <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-muted)', lineHeight: 1.35 }}>
                  {goal.description}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Decision 2: Available Missions for the selected goal */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 700, margin: '0 0 0.25rem 0', color: 'var(--ox-text-primary)' }}>
            Recommended Missions ({filteredMissions.length})
          </h3>
          <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-muted)' }}>
            Each mission provides a structured stage map, live adapters, and verifiable completion criteria.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {filteredMissions.map((mission) => (
            <div
              key={mission.id}
              style={{
                padding: '1.25rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-panel)',
                border: '1px solid var(--ox-border-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1.5rem'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-bitcoin-orange)' }}>
                    {mission.category}
                  </span>
                  <span style={{ fontSize: '0.6875rem', padding: '0.1rem 0.35rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)', color: 'var(--ox-text-muted)' }}>
                    v{mission.supportedProtocolVersions.join(', ')}
                  </span>
                </div>

                <div style={{ fontSize: '1.0625rem', fontWeight: 700, color: 'var(--ox-text-primary)' }}>
                  {mission.title}
                </div>

                <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: '0.375rem 0 0.5rem 0', lineHeight: 1.4 }}>
                  {mission.plainEnglishGoal}
                </p>

                <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                  {mission.stages.map((st) => (
                    <span
                      key={st.id}
                      style={{
                        fontSize: '0.6875rem',
                        padding: '0.15rem 0.45rem',
                        borderRadius: 'var(--ox-radius-sm)',
                        backgroundColor: 'var(--ox-surface-subtle)',
                        border: '1px solid var(--ox-border-subtle)',
                        color: 'var(--ox-text-muted)',
                        textTransform: 'capitalize'
                      }}
                    >
                      {st.id}
                    </span>
                  ))}
                </div>
              </div>

              <a
                href={`${basePath}/workspace/?mission=${mission.id}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  padding: '0.5rem 1rem',
                  borderRadius: 'var(--ox-radius-md)',
                  backgroundColor: 'var(--ox-surface-panel)',
                  border: '1px solid var(--ox-border-strong)',
                  color: 'var(--ox-text-primary)',
                  fontWeight: 600,
                  fontSize: '0.8125rem',
                  textDecoration: 'none',
                  flexShrink: 0,
                  boxShadow: 'var(--ox-shadow-sm)'
                }}
              >
                <span>Start Mission</span>
                <IconArrowRight size={14} />
              </a>
            </div>
          ))}
        </div>
      </section>

      {/* Direct Product Access Tray */}
      <section
        style={{
          padding: '1.25rem',
          borderRadius: 'var(--ox-radius-md)',
          backgroundColor: 'var(--ox-surface-subtle)',
          border: '1px solid var(--ox-border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem'
        }}
      >
        <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)' }}>
          Direct Workspace Tools
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '0.75rem'
          }}
        >
          <a
            href={`${basePath}/sandbox/`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              padding: '0.625rem 0.875rem',
              borderRadius: 'var(--ox-radius-sm)',
              backgroundColor: 'var(--ox-surface-panel)',
              border: '1px solid var(--ox-border-default)',
              textDecoration: 'none',
              color: 'var(--ox-text-primary)',
              fontSize: '0.8125rem',
              fontWeight: 600
            }}
          >
            <IconSandbox size={18} />
            <span>Transaction Sandbox</span>
          </a>

          <a
            href={`${basePath}/inspect/`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              padding: '0.625rem 0.875rem',
              borderRadius: 'var(--ox-radius-sm)',
              backgroundColor: 'var(--ox-surface-panel)',
              border: '1px solid var(--ox-border-default)',
              textDecoration: 'none',
              color: 'var(--ox-text-primary)',
              fontSize: '0.8125rem',
              fontWeight: 600
            }}
          >
            <IconInspect size={18} />
            <span>Artifact Lens</span>
          </a>

          <a
            href={`${basePath}/diagnose/`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              padding: '0.625rem 0.875rem',
              borderRadius: 'var(--ox-radius-sm)',
              backgroundColor: 'var(--ox-surface-panel)',
              border: '1px solid var(--ox-border-default)',
              textDecoration: 'none',
              color: 'var(--ox-text-primary)',
              fontSize: '0.8125rem',
              fontWeight: 600
            }}
          >
            <IconDiagnose size={18} />
            <span>Failure Navigator</span>
          </a>

          <a
            href={`${basePath}/agents/`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              padding: '0.625rem 0.875rem',
              borderRadius: 'var(--ox-radius-sm)',
              backgroundColor: 'var(--ox-surface-panel)',
              border: '1px solid var(--ox-border-default)',
              textDecoration: 'none',
              color: 'var(--ox-text-primary)',
              fontSize: '0.8125rem',
              fontWeight: 600
            }}
          >
            <IconAgents size={18} />
            <span>Agent Bridge (MCP)</span>
          </a>
        </div>
      </section>
    </div>
  );
}
