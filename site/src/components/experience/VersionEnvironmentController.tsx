import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

interface ControllerProps {
  version: string;
  onVersionChange: (version: string) => void;
  environment: string;
  onEnvironmentChange: (env: string) => void;
  buildCommit?: string;
}

export function VersionEnvironmentController({
  version,
  onVersionChange,
  environment,
  onEnvironmentChange,
  buildCommit = 'f6df565'
}: ControllerProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-label="Protocol Version and Environment Settings"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.375rem',
          padding: '0.3125rem 0.625rem',
          borderRadius: 'var(--ox-radius-md)',
          border: '1px solid var(--ox-border-default)',
          background: 'var(--ox-surface-subtle)',
          color: 'var(--ox-text-primary)',
          fontSize: '0.75rem',
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: environment === 'deterministic' ? 'var(--ox-status-success-text)' : 'var(--ox-bitcoin-orange)'
          }}
        />
        <span>v{version}</span>
        <span style={{ color: 'var(--ox-text-muted)' }}>({environment})</span>
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Version and Environment Context"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            width: '280px',
            backgroundColor: 'var(--ox-surface-panel)',
            border: '1px solid var(--ox-border-strong)',
            borderRadius: 'var(--ox-radius-lg)',
            boxShadow: 'var(--ox-shadow-lg)',
            padding: '0.875rem',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            fontSize: '0.8125rem'
          }}
        >
          <div>
            <label
              htmlFor="ox-version-select"
              style={{
                display: 'block',
                fontWeight: 600,
                color: 'var(--ox-text-primary)',
                marginBottom: '0.25rem'
              }}
            >
              Protocol Version
            </label>
            <select
              id="ox-version-select"
              value={version}
              onChange={(e) => onVersionChange((e.target as HTMLSelectElement).value)}
              style={{
                width: '100%',
                padding: '0.375rem',
                borderRadius: 'var(--ox-radius-sm)',
                border: '1px solid var(--ox-border-default)',
                background: 'var(--ox-surface-panel)',
                color: 'var(--ox-text-primary)',
                fontSize: '0.8125rem'
              }}
            >
              <option value="1.2">v1.2 (Current Production: Provenance, Heritage, Cold-Signing)</option>
              <option value="1.1">v1.1 (Stable: Offers v1, SafeOps, Swaps, Runes)</option>
              <option value="1.0">v1.0 (Baseline: Public Asks, Purchase Verifier)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="ox-env-select"
              style={{
                display: 'block',
                fontWeight: 600,
                color: 'var(--ox-text-primary)',
                marginBottom: '0.25rem'
              }}
            >
              Execution Environment
            </label>
            <select
              id="ox-env-select"
              value={environment}
              onChange={(e) => onEnvironmentChange((e.target as HTMLSelectElement).value)}
              style={{
                width: '100%',
                padding: '0.375rem',
                borderRadius: 'var(--ox-radius-sm)',
                border: '1px solid var(--ox-border-default)',
                background: 'var(--ox-surface-panel)',
                color: 'var(--ox-text-primary)',
                fontSize: '0.8125rem'
              }}
            >
              <option value="deterministic">Deterministic example (Browser isolated)</option>
              <option value="local">Offline / local mock</option>
              <option value="custom-readonly">Custom gateway (Read-only)</option>
              <option value="custom-write">Custom gateway (Explicit confirmation)</option>
            </select>
          </div>

          <div
            style={{
              paddingTop: '0.5rem',
              borderTop: '1px solid var(--ox-border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem',
              fontSize: '0.6875rem',
              color: 'var(--ox-text-muted)'
            }}
          >
            <div>Network: <strong>Bitcoin Mainnet</strong></div>
            <div>Build Commit: <code>{buildCommit}</code></div>
            <div>Trust Boundary: Local Web Workers, zero private key custody</div>
          </div>

          <button
            type="button"
            onClick={() => setIsOpen(false)}
            style={{
              padding: '0.3125rem',
              borderRadius: 'var(--ox-radius-sm)',
              border: '1px solid var(--ox-border-default)',
              background: 'var(--ox-surface-subtle)',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.75rem'
            }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
