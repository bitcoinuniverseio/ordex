import type { JSX } from 'preact';

interface ToggleProps {
  mode: 'plain' | 'builder' | 'proof';
  onChange: (mode: 'plain' | 'builder' | 'proof') => void;
  className?: string;
}

export function ProgressiveDisclosureToggle({
  mode,
  onChange,
  className = ''
}: ToggleProps): JSX.Element {
  return (
    <div
      class={`ox-disclosure-toggle ${className}`}
      role="group"
      aria-label="Progressive Disclosure Level"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--ox-surface-subtle)',
        padding: '2px',
        borderRadius: 'var(--ox-radius-md)',
        border: '1px solid var(--ox-border-subtle)',
        fontSize: '0.75rem',
        fontWeight: 600
      }}
    >
      <button
        type="button"
        class={`ox-toggle-btn ${mode === 'plain' ? 'active' : ''}`}
        onClick={() => onChange('plain')}
        aria-pressed={mode === 'plain'}
        style={{
          padding: '0.25rem 0.625rem',
          borderRadius: 'var(--ox-radius-sm)',
          border: 'none',
          cursor: 'pointer',
          background: mode === 'plain' ? 'var(--ox-surface-panel)' : 'transparent',
          color: mode === 'plain' ? 'var(--ox-text-primary)' : 'var(--ox-text-muted)',
          boxShadow: mode === 'plain' ? 'var(--ox-shadow-sm)' : 'none',
          transition: 'all 0.15s ease'
        }}
      >
        Plain English
      </button>

      <button
        type="button"
        class={`ox-toggle-btn ${mode === 'builder' ? 'active' : ''}`}
        onClick={() => onChange('builder')}
        aria-pressed={mode === 'builder'}
        style={{
          padding: '0.25rem 0.625rem',
          borderRadius: 'var(--ox-radius-sm)',
          border: 'none',
          cursor: 'pointer',
          background: mode === 'builder' ? 'var(--ox-surface-panel)' : 'transparent',
          color: mode === 'builder' ? 'var(--ox-text-primary)' : 'var(--ox-text-muted)',
          boxShadow: mode === 'builder' ? 'var(--ox-shadow-sm)' : 'none',
          transition: 'all 0.15s ease'
        }}
      >
        Builder
      </button>

      <button
        type="button"
        class={`ox-toggle-btn ${mode === 'proof' ? 'active' : ''}`}
        onClick={() => onChange('proof')}
        aria-pressed={mode === 'proof'}
        style={{
          padding: '0.25rem 0.625rem',
          borderRadius: 'var(--ox-radius-sm)',
          border: 'none',
          cursor: 'pointer',
          background: mode === 'proof' ? 'var(--ox-surface-panel)' : 'transparent',
          color: mode === 'proof' ? 'var(--ox-text-primary)' : 'var(--ox-text-muted)',
          boxShadow: mode === 'proof' ? 'var(--ox-shadow-sm)' : 'none',
          transition: 'all 0.15s ease'
        }}
      >
        Protocol Proof
      </button>
    </div>
  );
}
