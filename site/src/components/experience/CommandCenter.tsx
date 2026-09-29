import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MISSIONS } from '../../lib/experience/mission-registry.js';
import operationsData from '../../data/operations.json';
import refusalsData from '../../data/refusals.json';

// OX-S10: modal command palette following the APG combobox-with-listbox pattern. The input
// owns focus and points at the active option with aria-activedescendant; Tab is trapped in the
// dialog, Escape or a click outside closes it and focus returns to what opened it. Links use
// the base-aware routes and the OX-S05 playground deep link (?operation=).

interface CommandItem {
  id: string;
  category: 'Actions' | 'Missions' | 'API' | 'Refusals';
  title: string;
  subtitle: string;
  badge?: string;
  href?: string;
  run?: () => void;
}

interface CommandCenterProps {
  onSelectDisclosureMode?: (mode: 'plain' | 'builder' | 'proof') => void;
  onSelectProtocolVersion?: (version: string) => void;
  basePath?: string;
}

const MAX_RESULTS = 40;

const isEditable = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);

export function CommandCenter({ onSelectDisclosureMode, basePath = '/ordex' }: CommandCenterProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const route = (path: string) => `${basePath}${path.startsWith('/') ? '' : '/'}${path}`;

  const open = () => {
    returnFocusRef.current = (document.activeElement as HTMLElement) || triggerRef.current;
    setIsOpen(true);
  };
  const close = () => {
    setIsOpen(false);
    setQuery('');
    setSelectedIndex(0);
    const target = returnFocusRef.current && document.contains(returnFocusRef.current) ? returnFocusRef.current : triggerRef.current;
    requestAnimationFrame(() => target?.focus());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        // Leave the shortcut to other editable controls; inside the palette it closes it.
        if (!isOpen && isEditable(document.activeElement)) return;
        e.preventDefault();
        if (isOpen) close();
        else open();
      } else if (e.key === '/' && !isOpen && !isEditable(document.activeElement) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  const q = query.trim().toLowerCase();
  const matches = (...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));
  const all: CommandItem[] = [];
  const actions: CommandItem[] = [
    { id: 'launchpad', category: 'Actions', title: 'Open Launchpad', subtitle: 'Guided missions and tasks', badge: 'Start', href: '/' },
    { id: 'sandbox', category: 'Actions', title: 'Open Transaction Sandbox', subtitle: 'Step through trading scenarios with the reference verifiers', badge: 'Simulator', href: '/sandbox/' },
    { id: 'inspect', category: 'Actions', title: 'Open Artifact Lens', subtitle: 'Decode PSBTs and transactions and compare them', badge: 'Inspector', href: '/inspect/' },
    { id: 'diagnose', category: 'Actions', title: 'Open Failure Navigator', subtitle: 'Diagnose refusals and run their reproducers', badge: 'Triage', href: '/diagnose/' },
    { id: 'agents', category: 'Actions', title: 'Open Agent Bridge', subtitle: 'MCP server setup and tools', badge: 'MCP', href: '/agents/' },
    { id: 'playground', category: 'Actions', title: 'Open API Playground', subtitle: 'Build and send gateway requests', badge: 'API', href: '/build/playground/' },
    { id: 'mode-plain', category: 'Actions', title: 'Switch to Plain English mode', subtitle: 'Outcomes in plain language', badge: 'Mode', run: () => onSelectDisclosureMode?.('plain') },
    { id: 'mode-builder', category: 'Actions', title: 'Switch to Builder mode', subtitle: 'API fields, schemas and code', badge: 'Mode', run: () => onSelectDisclosureMode?.('builder') },
    { id: 'mode-proof', category: 'Actions', title: 'Switch to Protocol Proof mode', subtitle: 'Verifier invariants and byte offsets', badge: 'Mode', run: () => onSelectDisclosureMode?.('proof') }
  ];
  for (const a of actions) if (matches(a.title, a.subtitle)) all.push({ ...a, id: `action-${a.id}` });
  for (const m of MISSIONS) {
    if (matches(m.title, m.plainEnglishGoal)) all.push({ id: `mission-${m.id}`, category: 'Missions', title: m.title, subtitle: m.plainEnglishGoal, badge: m.category, href: `/workspace/?mission=${encodeURIComponent(m.id)}` });
  }
  for (const op of operationsData as Array<{ operationId: string; method: string; path: string; summary: string; authorityLevel: string }>) {
    if (matches(op.operationId, op.path, op.summary)) {
      all.push({ id: `op-${op.operationId}`, category: 'API', title: `${op.method} ${op.path}`, subtitle: `${op.operationId}: ${op.summary}`, badge: op.authorityLevel, href: `/build/playground/?operation=${encodeURIComponent(op.operationId)}` });
    }
  }
  for (const ref of refusalsData as Array<{ code: string; explanation: string; category: string }>) {
    if (matches(ref.code, ref.explanation)) all.push({ id: `ref-${ref.code}`, category: 'Refusals', title: ref.code, subtitle: ref.explanation, badge: ref.category, href: `/diagnose/?code=${encodeURIComponent(ref.code)}` });
  }
  const items = all.slice(0, MAX_RESULTS);
  const active = items.length ? Math.min(selectedIndex, items.length - 1) : -1;
  const optionId = (i: number) => `ox-command-option-${items[i]?.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;

  const choose = (item: CommandItem) => {
    if (item.run) {
      item.run();
      close();
      return;
    }
    setIsOpen(false);
    window.location.href = route(item.href || '/');
  };

  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, isOpen]);

  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(items.length ? (active + 1) % items.length : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(items.length ? (active - 1 + items.length) % items.length : 0);
    } else if (e.key === 'Home' && e.ctrlKey) {
      setSelectedIndex(0);
    } else if (e.key === 'End' && e.ctrlKey) {
      setSelectedIndex(Math.max(0, items.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(items[active]);
    }
  };

  const onDialogKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('input, button, a[href], [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        class="ox-command-trigger"
        data-tour="command-center"
        onClick={open}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K /"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', minHeight: '32px', padding: '0.35rem 0.625rem', borderRadius: 'var(--ox-radius-md)', border: '1px solid var(--ox-border-default)', background: 'var(--ox-surface-subtle)', color: 'var(--ox-text-secondary)', fontSize: '0.75rem', cursor: 'pointer' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span>Search or jump</span>
        <kbd aria-hidden="true" style={{ fontSize: '0.6875rem', background: 'var(--ox-surface-panel)', padding: '0.1rem 0.35rem', borderRadius: 'var(--ox-radius-sm)', border: '1px solid var(--ox-border-strong)', color: 'var(--ox-text-secondary)' }}>
          Ctrl K
        </kbd>
      </button>

      {isOpen && (
        <div
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
          style={{ position: 'fixed', inset: 0, zIndex: 9999, backgroundColor: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 1rem 1rem' }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ox-command-title"
            onKeyDown={onDialogKey}
            style={{ width: '100%', maxWidth: '640px', maxHeight: '75vh', backgroundColor: 'var(--ox-surface-panel)', borderRadius: 'var(--ox-radius-lg)', border: '1px solid var(--ox-border-strong)', boxShadow: 'var(--ox-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            <h2 id="ox-command-title" class="ox-sr-only">
              Command Center
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.875rem 1.125rem', borderBottom: '1px solid var(--ox-border-subtle)' }}>
              <label for="ox-command-input" class="ox-sr-only">
                Search commands, missions, API operations and refusal codes
              </label>
              <input
                id="ox-command-input"
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls="ox-command-listbox"
                aria-autocomplete="list"
                aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                autoComplete="off"
                spellcheck={false}
                value={query}
                onInput={(e) => {
                  setQuery((e.target as HTMLInputElement).value);
                  setSelectedIndex(0);
                }}
                onKeyDown={onInputKey}
                placeholder="Command, mission, API operation or refusal code"
                style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'var(--ox-text-primary)', fontSize: '0.9375rem', fontFamily: 'inherit' }}
              />
              <button type="button" onClick={close} aria-label="Close the Command Center" style={{ minHeight: '32px', minWidth: '44px', padding: '0.2rem 0.4rem', fontSize: '0.75rem', background: 'var(--ox-surface-subtle)', border: '1px solid var(--ox-border-default)', borderRadius: 'var(--ox-radius-sm)', cursor: 'pointer', color: 'var(--ox-text-secondary)' }}>
                Esc
              </button>
            </div>

            <ul id="ox-command-listbox" role="listbox" aria-label="Results" style={{ flex: 1, overflowY: 'auto', margin: 0, padding: '0.375rem 0', listStyle: 'none', maxHeight: '50vh' }}>
              {items.map((item, idx) => {
                const selected = idx === active;
                return (
                  <li
                    key={item.id}
                    id={optionId(idx)}
                    role="option"
                    aria-selected={selected ? 'true' : 'false'}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(item)}
                    onMouseMove={() => idx !== active && setSelectedIndex(idx)}
                    style={{ padding: '0.625rem 1.125rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', backgroundColor: selected ? 'var(--ox-surface-subtle)' : 'transparent', borderLeft: selected ? '3px solid var(--ox-bitcoin-orange)' : '3px solid transparent' }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', minWidth: 0 }}>
                        <span style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-secondary)', flexShrink: 0 }}>{item.category}</span>
                        <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--ox-text-primary)', overflowWrap: 'anywhere' }}>{item.title}</span>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.subtitle}</div>
                    </div>
                    {item.badge && (
                      <span style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '0.125rem 0.375rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-panel)', border: '1px solid var(--ox-border-default)', color: 'var(--ox-text-secondary)', flexShrink: 0 }}>{item.badge}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            {items.length === 0 && (
              <p role="status" style={{ margin: 0, padding: '1.5rem', textAlign: 'center', color: 'var(--ox-text-secondary)', fontSize: '0.875rem' }}>
                Nothing matches "{query}". Try a refusal code such as SELLER_VALUE_MISMATCH, an operation such as listOrders, or a mission name.
              </p>
            )}

            <div style={{ padding: '0.5rem 1.125rem', borderTop: '1px solid var(--ox-border-subtle)', backgroundColor: 'var(--ox-surface-subtle)', fontSize: '0.75rem', color: 'var(--ox-text-secondary)', display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span>Up and Down to move, Enter to open, Esc to close</span>
              <span role="status">{all.length > items.length ? `Showing ${items.length} of ${all.length}; type to narrow` : `${items.length} results`}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
