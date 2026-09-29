import type { JSX } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import versions from '../../data/versions.json';
import { NETWORKS, normalizeGatewayOrigin, type UserSettings } from '../../lib/session/journey-schema.js';
import type { StorageState } from '../../lib/session/journey-store.js';

interface ControllerProps {
  settings: UserSettings;
  onChange: (patch: Partial<UserSettings>) => Promise<void> | void;
  buildRevision: string;
  storageState?: StorageState;
}

const NETWORK_LABEL: Record<string, string> = {
  mainnet: 'Bitcoin Mainnet',
  signet: 'Signet',
  testnet4: 'Testnet4',
  regtest: 'Regtest (local)'
};

// OX-S03: the controller shows and edits the shared settings every tool reads: network,
// gateway origin, read-only or write mode and protocol version, plus the real build. The
// label reflects what is configured; with no gateway origin, tools run locally only.
export function VersionEnvironmentController({ settings, onChange, buildRevision, storageState }: ControllerProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [originDraft, setOriginDraft] = useState(settings.gatewayOrigin);
  const [originError, setOriginError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => setOriginDraft(settings.gatewayOrigin), [settings.gatewayOrigin]);

  useEffect(() => {
    if (!isOpen) return undefined;
    dialogRef.current?.querySelector<HTMLElement>('select, input, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const close = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const applyOrigin = async () => {
    const r = normalizeGatewayOrigin(originDraft);
    if (!r.ok) {
      setOriginError(r.error);
      return;
    }
    setOriginError(null);
    setOriginDraft(r.origin);
    await onChange({ gatewayOrigin: r.origin });
  };

  const where = settings.gatewayOrigin ? new URL(settings.gatewayOrigin).host : 'local only';
  const fieldStyle = {
    width: '100%',
    padding: '0.375rem',
    borderRadius: 'var(--ox-radius-sm)',
    border: '1px solid var(--ox-border-default)',
    background: 'var(--ox-surface-panel)',
    color: 'var(--ox-text-primary)',
    fontSize: '0.8125rem'
  };
  const labelStyle = { display: 'block', fontWeight: 600, color: 'var(--ox-text-primary)', marginBottom: '0.25rem' };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        data-tour="environment"
        aria-label={`Settings: protocol ${settings.protocolVersion}, ${NETWORK_LABEL[settings.network]}, ${where}, ${settings.mode}`}
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
        <span aria-hidden="true" style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: settings.gatewayOrigin ? 'var(--ox-bitcoin-orange)' : 'var(--ox-status-success-text)' }} />
        <span>v{settings.protocolVersion}</span>
        <span style={{ color: 'var(--ox-text-secondary)' }}>
          {NETWORK_LABEL[settings.network]} ({where})
        </span>
      </button>

      {isOpen && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="false"
          aria-label="Network, gateway and protocol settings"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            width: 'min(320px, calc(100vw - 32px))',
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
            <label htmlFor="ox-network-select" style={labelStyle}>Network</label>
            <select id="ox-network-select" value={settings.network} onChange={(e) => onChange({ network: (e.target as HTMLSelectElement).value as UserSettings['network'] })} style={fieldStyle}>
              {NETWORKS.map((n) => (
                <option key={n} value={n}>{NETWORK_LABEL[n]}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="ox-gateway-origin" style={labelStyle}>Gateway origin</label>
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <input
                id="ox-gateway-origin"
                type="url"
                inputMode="url"
                placeholder="https://gateway.example (empty: local only)"
                value={originDraft}
                aria-invalid={originError ? 'true' : 'false'}
                aria-describedby={originError ? 'ox-gateway-origin-error' : 'ox-gateway-origin-help'}
                onInput={(e) => setOriginDraft((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === 'Enter' && applyOrigin()}
                style={{ ...fieldStyle, flex: 1 }}
              />
              <button type="button" onClick={applyOrigin} style={{ ...fieldStyle, width: 'auto', cursor: 'pointer', fontWeight: 600 }}>
                Save
              </button>
            </div>
            {originError ? (
              <div id="ox-gateway-origin-error" role="alert" style={{ color: 'var(--ox-status-refusal-text)', fontSize: '0.75rem', marginTop: '0.25rem' }}>{originError}</div>
            ) : (
              <div id="ox-gateway-origin-help" style={{ color: 'var(--ox-text-secondary)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                The API Playground, Event Playground and Gateway Doctor use this origin. Changing it or the network makes earlier runs stale.
              </div>
            )}
          </div>

          <div>
            <label htmlFor="ox-mode-select" style={labelStyle}>Request mode</label>
            <select id="ox-mode-select" value={settings.mode} onChange={(e) => onChange({ mode: (e.target as HTMLSelectElement).value as UserSettings['mode'] })} style={fieldStyle}>
              <option value="read-only">Read-only (no request with an effect is sent)</option>
              <option value="write">Write (each effect needs explicit confirmation)</option>
            </select>
          </div>

          <div>
            <label htmlFor="ox-version-select" style={labelStyle}>Protocol version</label>
            <select id="ox-version-select" value={settings.protocolVersion} onChange={(e) => onChange({ protocolVersion: (e.target as HTMLSelectElement).value })} style={fieldStyle}>
              {[...versions.history].reverse().map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} ({v.status})
                </option>
              ))}
            </select>
          </div>

          <div style={{ paddingTop: '0.5rem', borderTop: '1px solid var(--ox-border-subtle)', display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>
            <div>Gateway contract: <code>{versions.currentGatewayContract}</code></div>
            <div>Site build: <code>{buildRevision.slice(0, 12)}</code></div>
            {storageState && storageState !== 'ready' && <div>Saved progress: {storageState === 'ephemeral' ? 'this tab only (browser storage unavailable)' : storageState}</div>}
          </div>

          <button type="button" onClick={close} style={{ ...fieldStyle, cursor: 'pointer', fontWeight: 600 }}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
