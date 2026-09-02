import type { JSX } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { MISSIONS } from '../../lib/experience/mission-registry.js';
import operationsData from '../../data/operations.json';
import refusalsData from '../../data/refusals.json';

interface CommandItem {
  id: string;
  category: 'Actions' | 'Missions' | 'API' | 'Refusals';
  title: string;
  subtitle: string;
  badge?: string;
  handler: () => void;
}

interface CommandCenterProps {
  onSelectDisclosureMode?: (mode: 'plain' | 'builder' | 'proof') => void;
  onSelectProtocolVersion?: (version: string) => void;
  basePath?: string;
}

export function CommandCenter({
  onSelectDisclosureMode,
  onSelectProtocolVersion,
  basePath = '/ordex'
}: CommandCenterProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      } else if (e.key === '/' && !isOpen) {
        const active = document.activeElement;
        const isEditable = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable);
        if (!isEditable) {
          e.preventDefault();
          setIsOpen(true);
        }
      } else if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const navigateTo = (path: string) => {
    setIsOpen(false);
    const normalized = path.startsWith(basePath) ? path : `${basePath}${path.startsWith('/') ? '' : '/'}${path}`;
    window.location.href = normalized;
  };

  const q = query.trim().toLowerCase();
  const items: CommandItem[] = [];

  // Core Actions
  const coreActions: CommandItem[] = [
    {
      id: 'action-launchpad',
      category: 'Actions',
      title: 'Open Launchpad',
      subtitle: 'View guided missions and start interactive tasks',
      badge: 'Start',
      handler: () => navigateTo('/')
    },
    {
      id: 'action-sandbox',
      category: 'Actions',
      title: 'Open Transaction Sandbox',
      subtitle: 'Simulate multi-actor trading flows with deterministic verifiers',
      badge: 'Simulator',
      handler: () => navigateTo('/sandbox/')
    },
    {
      id: 'action-inspect',
      category: 'Actions',
      title: 'Open Artifact Lens',
      subtitle: 'Inspect binary PSBTs, hex payloads, and detect mutations',
      badge: 'Inspector',
      handler: () => navigateTo('/inspect/')
    },
    {
      id: 'action-diagnose',
      category: 'Actions',
      title: 'Open Failure Navigator',
      subtitle: 'Triage protocol refusals, verify causes, and generate reproducers',
      badge: 'Triage',
      handler: () => navigateTo('/diagnose/')
    },
    {
      id: 'action-agents',
      category: 'Actions',
      title: 'Open Agent Bridge',
      subtitle: 'Configure MCP 2026-07-28 server, inspect tools and resources',
      badge: 'MCP',
      handler: () => navigateTo('/agents/')
    },
    {
      id: 'action-mode-plain',
      category: 'Actions',
      title: 'Switch to Plain English Mode',
      subtitle: 'Show direct outcomes and non-technical explanations',
      badge: 'Mode',
      handler: () => {
        onSelectDisclosureMode?.('plain');
        setIsOpen(false);
      }
    },
    {
      id: 'action-mode-builder',
      category: 'Actions',
      title: 'Switch to Builder Mode',
      subtitle: 'Show API fields, schemas, and integration code',
      badge: 'Mode',
      handler: () => {
        onSelectDisclosureMode?.('builder');
        setIsOpen(false);
      }
    },
    {
      id: 'action-mode-proof',
      category: 'Actions',
      title: 'Switch to Protocol Proof Mode',
      subtitle: 'Show exact verifier invariants, evidence classes, and byte offsets',
      badge: 'Mode',
      handler: () => {
        onSelectDisclosureMode?.('proof');
        setIsOpen(false);
      }
    }
  ];

  for (const item of coreActions) {
    if (!q || item.title.toLowerCase().includes(q) || item.subtitle.toLowerCase().includes(q)) {
      items.push(item);
    }
  }

  // Missions
  for (const m of MISSIONS) {
    if (!q || m.title.toLowerCase().includes(q) || m.plainEnglishGoal.toLowerCase().includes(q)) {
      items.push({
        id: `mission-${m.id}`,
        category: 'Missions',
        title: `Mission: ${m.title}`,
        subtitle: m.plainEnglishGoal,
        badge: m.category,
        handler: () => navigateTo(`/workspace/?mission=${m.id}`)
      });
    }
  }

  // API Operations
  for (const op of (operationsData as Array<{ operationId: string; method: string; path: string; summary: string; authorityLevel: string }>)) {
    if (!q || op.operationId.toLowerCase().includes(q) || op.path.toLowerCase().includes(q) || op.summary.toLowerCase().includes(q)) {
      items.push({
        id: `op-${op.operationId}`,
        category: 'API',
        title: `${op.method} ${op.path}`,
        subtitle: `${op.operationId}: ${op.summary}`,
        badge: op.authorityLevel,
        handler: () => navigateTo(`/reference/api/#${op.operationId}`)
      });
      if (items.length > 30) break;
    }
  }

  // Refusals
  for (const ref of (refusalsData as Array<{ code: string; explanation: string; category: string }>)) {
    if (!q || ref.code.toLowerCase().includes(q) || ref.explanation.toLowerCase().includes(q)) {
      items.push({
        id: `ref-${ref.code}`,
        category: 'Refusals',
        title: ref.code,
        subtitle: ref.explanation,
        badge: ref.category,
        handler: () => navigateTo(`/diagnose/?code=${ref.code}`)
      });
      if (items.length > 40) break;
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, Math.max(0, items.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[selectedIndex]) {
        items[selectedIndex].handler();
      }
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="Open Command Center (Cmd+K)"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.35rem 0.625rem',
          borderRadius: 'var(--ox-radius-md)',
          border: '1px solid var(--ox-border-default)',
          background: 'var(--ox-surface-subtle)',
          color: 'var(--ox-text-secondary)',
          fontSize: '0.75rem',
          cursor: 'pointer'
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span>Search or Jump...</span>
        <kbd
          style={{
            fontSize: '0.6875rem',
            background: 'var(--ox-surface-panel)',
            padding: '0.1rem 0.35rem',
            borderRadius: 'var(--ox-radius-sm)',
            border: '1px solid var(--ox-border-strong)',
            color: 'var(--ox-text-muted)'
          }}
        >
          ⌘K
        </kbd>
      </button>

      {isOpen && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: '12vh'
          }}
          onClick={() => setIsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command Center"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '640px',
              maxHeight: '75vh',
              backgroundColor: 'var(--ox-surface-panel)',
              borderRadius: 'var(--ox-radius-lg)',
              border: '1px solid var(--ox-border-strong)',
              boxShadow: 'var(--ox-shadow-lg)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.875rem 1.125rem',
                borderBottom: '1px solid var(--ox-border-subtle)'
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ox-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onInput={(e) => {
                  setQuery((e.target as HTMLInputElement).value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Type a command, mission, API endpoint, or refusal code..."
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--ox-text-primary)',
                  fontSize: '0.9375rem',
                  fontFamily: 'inherit'
                }}
              />
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                style={{
                  padding: '0.2rem 0.4rem',
                  fontSize: '0.6875rem',
                  background: 'var(--ox-surface-subtle)',
                  border: '1px solid var(--ox-border-default)',
                  borderRadius: 'var(--ox-radius-sm)',
                  cursor: 'pointer',
                  color: 'var(--ox-text-muted)'
                }}
              >
                ESC
              </button>
            </div>

            <div
              role="listbox"
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '0.375rem 0',
                maxHeight: '50vh'
              }}
            >
              {items.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--ox-text-muted)' }}>
                  No matching commands found.
                </div>
              ) : (
                items.map((item, idx) => {
                  const isSelected = idx === selectedIndex;
                  return (
                    <div
                      key={item.id}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => item.handler()}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      style={{
                        padding: '0.625rem 1.125rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.75rem',
                        backgroundColor: isSelected ? 'var(--ox-surface-subtle)' : 'transparent',
                        borderLeft: isSelected ? '3px solid var(--ox-bitcoin-orange)' : '3px solid transparent'
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)' }}>
                            {item.category}
                          </span>
                          <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--ox-text-primary)' }}>
                            {item.title}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.subtitle}
                        </div>
                      </div>
                      {item.badge && (
                        <span
                          style={{
                            fontSize: '0.6875rem',
                            fontWeight: 600,
                            padding: '0.125rem 0.375rem',
                            borderRadius: 'var(--ox-radius-sm)',
                            backgroundColor: 'var(--ox-surface-panel)',
                            border: '1px solid var(--ox-border-default)',
                            color: 'var(--ox-text-secondary)',
                            flexShrink: 0
                          }}
                        >
                          {item.badge}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div
              style={{
                padding: '0.5rem 1.125rem',
                borderTop: '1px solid var(--ox-border-subtle)',
                backgroundColor: 'var(--ox-surface-subtle)',
                fontSize: '0.6875rem',
                color: 'var(--ox-text-muted)',
                display: 'flex',
                justifyContent: 'space-between'
              }}
            >
              <div>Navigate: <strong>↑</strong> <strong>↓</strong> | Select: <strong>Enter</strong></div>
              <div>{items.length} options</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
