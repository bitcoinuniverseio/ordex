import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { contextEngine, type ActiveContext, GLOSSARY } from '../../lib/experience/context-engine.js';
import { IconChevronRight, IconCopy, IconExternalLink, IconShieldCheck, IconAlertTriangle } from './OrdexIcons.js';

interface ContextRailProps {
  isOpen: boolean;
  onToggle: () => void;
  basePath?: string;
}

export function ContextRail({
  isOpen,
  onToggle,
  basePath = '/ordex'
}: ContextRailProps): JSX.Element {
  const [ctx, setCtx] = useState<ActiveContext>(contextEngine.getContext());
  const [activeTab, setActiveTab] = useState<'context' | 'glossary' | 'actions'>('context');
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => {
    return contextEngine.subscribe((newCtx) => {
      setCtx(newCtx);
    });
  }, []);

  const handleCopySource = () => {
    if (ctx.sourcePointer || ctx.route) {
      const textToCopy = `${window.location.origin}${basePath}${ctx.route}${ctx.heading ? '#' + ctx.heading : ''}`;
      navigator.clipboard.writeText(textToCopy);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  };

  const detectedTerm = ctx.selectedText ? contextEngine.findTermInText(ctx.selectedText) : undefined;

  return (
    <aside
      class={`ox-context-rail ${isOpen ? 'open' : 'closed'}`}
      aria-label="Context Rail"
      style={{
        width: isOpen ? 'var(--ox-context-rail-width)' : '44px',
        borderLeft: '1px solid var(--ox-border-default)',
        backgroundColor: 'var(--ox-surface-panel)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        transition: 'width 0.2s ease',
        overflow: 'hidden',
        height: '100%'
      }}
    >
      {/* Header bar */}
      <div
        style={{
          padding: '0.625rem 0.75rem',
          borderBottom: '1px solid var(--ox-border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: '44px'
        }}
      >
        {isOpen ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: 'var(--ox-text-primary)' }}>
              Context Lens
            </span>
            <span
              style={{
                fontSize: '0.625rem',
                padding: '0.1rem 0.35rem',
                borderRadius: 'var(--ox-radius-sm)',
                backgroundColor: 'var(--ox-surface-subtle)',
                color: 'var(--ox-text-muted)',
                textTransform: 'uppercase',
                fontWeight: 600
              }}
            >
              {ctx.disclosureMode}
            </span>
          </div>
        ) : (
          <span style={{ fontSize: '0.75rem', fontWeight: 600, writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            Context
          </span>
        )}

        <button
          type="button"
          onClick={onToggle}
          aria-label={isOpen ? 'Collapse Context Rail' : 'Expand Context Rail'}
          style={{
            padding: '0.25rem',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--ox-text-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <span style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s ease' }}>
            <IconChevronRight size={16} />
          </span>
        </button>
      </div>

      {isOpen && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {/* Sub Navigation Tabs */}
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--ox-border-subtle)',
              backgroundColor: 'var(--ox-surface-subtle)',
              fontSize: '0.75rem',
              fontWeight: 600
            }}
          >
            <button
              type="button"
              onClick={() => setActiveTab('context')}
              style={{
                flex: 1,
                padding: '0.5rem',
                border: 'none',
                background: activeTab === 'context' ? 'var(--ox-surface-panel)' : 'transparent',
                color: activeTab === 'context' ? 'var(--ox-text-primary)' : 'var(--ox-text-muted)',
                cursor: 'pointer',
                borderBottom: activeTab === 'context' ? '2px solid var(--ox-bitcoin-orange)' : 'none'
              }}
            >
              Active State
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('glossary')}
              style={{
                flex: 1,
                padding: '0.5rem',
                border: 'none',
                background: activeTab === 'glossary' ? 'var(--ox-surface-panel)' : 'transparent',
                color: activeTab === 'glossary' ? 'var(--ox-text-primary)' : 'var(--ox-text-muted)',
                cursor: 'pointer',
                borderBottom: activeTab === 'glossary' ? '2px solid var(--ox-bitcoin-orange)' : 'none'
              }}
            >
              Glossary
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('actions')}
              style={{
                flex: 1,
                padding: '0.5rem',
                border: 'none',
                background: activeTab === 'actions' ? 'var(--ox-surface-panel)' : 'transparent',
                color: activeTab === 'actions' ? 'var(--ox-text-primary)' : 'var(--ox-text-muted)',
                cursor: 'pointer',
                borderBottom: activeTab === 'actions' ? '2px solid var(--ox-bitcoin-orange)' : 'none'
              }}
            >
              Actions
            </button>
          </div>

          {/* Tab Content: Active State */}
          {activeTab === 'context' && (
            <div style={{ padding: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.875rem', fontSize: '0.8125rem' }}>
              <div>
                <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)', marginBottom: '0.25rem' }}>
                  Location & Subject
                </div>
                <div style={{ fontWeight: 600, color: 'var(--ox-text-primary)' }}>{ctx.title}</div>
                {ctx.heading && <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>§ {ctx.heading}</div>}
              </div>

              {ctx.evidenceClass && (
                <div
                  style={{
                    padding: '0.5rem 0.625rem',
                    borderRadius: 'var(--ox-radius-md)',
                    backgroundColor: 'var(--ox-surface-subtle)',
                    border: '1px solid var(--ox-border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.375rem'
                  }}
                >
                  <IconShieldCheck size={16} color="var(--ox-status-success-text)" />
                  <div>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)' }}>Evidence Class</div>
                    <div style={{ fontWeight: 600, color: 'var(--ox-text-primary)' }}>{ctx.evidenceClass}</div>
                  </div>
                </div>
              )}

              {/* Explanations adapted to disclosure mode */}
              <div
                style={{
                  padding: '0.625rem',
                  borderRadius: 'var(--ox-radius-md)',
                  backgroundColor: 'var(--ox-surface-subtle)',
                  border: '1px solid var(--ox-border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem'
                }}
              >
                {ctx.disclosureMode === 'plain' && (
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--ox-text-primary)', marginBottom: '0.2rem' }}>What is happening?</div>
                    <div style={{ color: 'var(--ox-text-secondary)', lineHeight: 1.4 }}>
                      You are in the {ctx.title} workspace. Protocol actions execute locally in Web Workers before presenting any signature request to your wallet.
                    </div>
                  </div>
                )}

                {ctx.disclosureMode === 'builder' && (
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--ox-text-primary)', marginBottom: '0.2rem' }}>Integration Details</div>
                    <div style={{ color: 'var(--ox-text-secondary)', lineHeight: 1.4 }}>
                      Calls adhere to OpenAPI 3.1 contracts. Endpoints return keyset cursors and fail closed with strict refusal codes when invariants fail.
                    </div>
                  </div>
                )}

                {ctx.disclosureMode === 'proof' && (
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--ox-text-primary)', marginBottom: '0.2rem' }}>Protocol Invariant</div>
                    <div style={{ color: 'var(--ox-text-secondary)', lineHeight: 1.4, fontFamily: 'var(--ox-font-mono)', fontSize: '0.75rem' }}>
                      Invariants 1 & 2: Output 0 sat flow and seller payment commitment validated by checked-in reference verifiers.
                    </div>
                  </div>
                )}
              </div>

              {/* Detected Term Popover */}
              {detectedTerm && (
                <div
                  style={{
                    padding: '0.625rem',
                    borderRadius: 'var(--ox-radius-md)',
                    backgroundColor: 'var(--ox-bitcoin-subtle)',
                    border: '1px solid var(--ox-bitcoin-border)'
                  }}
                >
                  <div style={{ fontWeight: 700, color: 'var(--ox-bitcoin-orange)', fontSize: '0.75rem' }}>
                    Term: {detectedTerm.term}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-primary)', marginTop: '0.25rem', lineHeight: 1.4 }}>
                    {ctx.disclosureMode === 'plain' && detectedTerm.plainEnglish}
                    {ctx.disclosureMode === 'builder' && detectedTerm.builder}
                    {ctx.disclosureMode === 'proof' && detectedTerm.proof}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab Content: Glossary */}
          {activeTab === 'glossary' && (
            <div style={{ padding: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.8125rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>
                Authoritative protocol terminology:
              </div>
              {Object.entries(GLOSSARY).map(([key, item]) => (
                <div
                  key={key}
                  style={{
                    padding: '0.5rem',
                    borderRadius: 'var(--ox-radius-sm)',
                    border: '1px solid var(--ox-border-subtle)',
                    backgroundColor: 'var(--ox-surface-subtle)'
                  }}
                >
                  <div style={{ fontWeight: 700, color: 'var(--ox-text-primary)', fontSize: '0.75rem' }}>
                    {item.term}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)', marginTop: '0.2rem', lineHeight: 1.35 }}>
                    {ctx.disclosureMode === 'plain' ? item.plainEnglish : ctx.disclosureMode === 'builder' ? item.builder : item.proof}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Tab Content: Actions */}
          {activeTab === 'actions' && (
            <div style={{ padding: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              <button
                type="button"
                onClick={handleCopySource}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: 'var(--ox-radius-md)',
                  border: '1px solid var(--ox-border-default)',
                  background: 'var(--ox-surface-subtle)',
                  color: 'var(--ox-text-primary)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <IconCopy size={16} />
                <span>{copyFeedback ? 'Copied to Clipboard!' : 'Copy Context Link'}</span>
              </button>

              <a
                href={`${basePath}/sandbox/`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: 'var(--ox-radius-md)',
                  border: '1px solid var(--ox-border-default)',
                  background: 'var(--ox-surface-subtle)',
                  color: 'var(--ox-text-primary)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textDecoration: 'none'
                }}
              >
                <IconExternalLink size={16} />
                <span>Simulate in Sandbox</span>
              </a>

              <a
                href={`${basePath}/inspect/`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: 'var(--ox-radius-md)',
                  border: '1px solid var(--ox-border-default)',
                  background: 'var(--ox-surface-subtle)',
                  color: 'var(--ox-text-primary)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textDecoration: 'none'
                }}
              >
                <IconExternalLink size={16} />
                <span>Inspect in Artifact Lens</span>
              </a>

              <a
                href={`${basePath}/diagnose/`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: 'var(--ox-radius-md)',
                  border: '1px solid var(--ox-border-default)',
                  background: 'var(--ox-surface-subtle)',
                  color: 'var(--ox-text-primary)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textDecoration: 'none'
                }}
              >
                <IconAlertTriangle size={16} />
                <span>Triage in Failure Navigator</span>
              </a>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
