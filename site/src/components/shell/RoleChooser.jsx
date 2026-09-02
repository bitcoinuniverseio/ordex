import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export const ROLES = [
  { id: 'marketplace', title: 'Marketplace Integrator', icon: '🏪', desc: 'Listing orders, executing single & batch purchases, streaming orderbook events.' },
  { id: 'wallet', title: 'Wallet / Signer', icon: '🔑', desc: 'Pre-flight invariant checking, sat-flow verification, cold-signing manifests.' },
  { id: 'gateway', title: 'Gateway Operator', icon: '⚙️', desc: 'Deploying self-hosted gateways, configuring webhooks, indexing contracts.' },
  { id: 'protocol', title: 'Protocol Implementer', icon: '📐', desc: 'Reference verifier rules, wire formats, conformance vectors, test parity.' },
  { id: 'security', title: 'Security Reviewer', icon: '🔍', desc: 'SafeOps execution shield invariants, Rune cenotaph protections, Taproot offer recovery.' },
  { id: 'collection', title: 'Collection Creator', icon: '🎨', desc: 'Publishing BIP-322 creator manifests and Merkle membership proofs.' }
];

export function RoleChooser({ onRoleChange }) {
  const [selectedRole, setSelectedRole] = useState(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('ordex_role');
      if (saved) {
        setSelectedRole(saved);
        if (onRoleChange) onRoleChange(saved);
      }
    } catch (e) {}
  }, []);

  const selectRole = (id) => {
    const next = selectedRole === id ? null : id;
    setSelectedRole(next);
    try {
      if (next) {
        localStorage.setItem('ordex_role', next);
      } else {
        localStorage.removeItem('ordex_role');
      }
    } catch (e) {}
    window.dispatchEvent(new CustomEvent('ordex:role-changed', { detail: { role: next } }));
    if (onRoleChange) onRoleChange(next);
  };

  return (
    <div class="role-chooser-panel panel">
      <div class="panel-header">
        <div>
          <h3 style="margin: 0; font-size: 1.1rem;">Personalize by Your Role</h3>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-muted);">
            Reorders recommended guides and recipes. Stored locally without an account. Never hides full docs.
          </p>
        </div>
        {selectedRole && (
          <button
            class="btn btn-outline"
            style="font-size: 0.8rem; padding: 0.25rem 0.6rem; min-height: 32px;"
            onClick={() => selectRole(selectedRole)}
          >
            Reset Role
          </button>
        )}
      </div>

      <div class="role-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem;">
        {ROLES.map((r) => {
          const isActive = selectedRole === r.id;
          return (
            <button
              key={r.id}
              class={`role-card btn ${isActive ? 'btn-primary' : 'btn-secondary'}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                textAlign: 'left',
                padding: '0.85rem',
                height: 'auto',
                borderColor: isActive ? 'var(--color-brand)' : 'var(--color-border)',
                backgroundColor: isActive ? 'var(--color-brand-subtle)' : 'var(--color-bg-surface)',
                color: 'var(--color-text-primary)'
              }}
              onClick={() => selectRole(r.id)}
              aria-pressed={isActive}
            >
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem; font-weight: 700;">
                <span style="font-size: 1.25rem;">{r.icon}</span>
                <span>{r.title}</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--color-text-secondary); line-height: 1.35;">
                {r.desc}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
