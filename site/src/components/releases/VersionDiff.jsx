import { h } from 'preact';
import { useState } from 'preact/hooks';
import versionsData from '../../data/versions.json';

export function VersionDiff() {
  const [baseVer, setBaseVer] = useState('1.0');
  const [targetVer, setTargetVer] = useState('1.2');

  const baseObj = versionsData.history.find((v) => v.version === baseVer) || versionsData.history[0];
  const targetObj = versionsData.history.find((v) => v.version === targetVer) || versionsData.history[2];

  return (
    <div class="version-diff-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      {/* Version Selector Panel */}
      <div class="panel">
        <div class="panel-header">
          <div>
            <h3 style="margin: 0; font-size: 1.15rem;">Interactive Protocol Version Diff Tool</h3>
            <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
              Inspect additive capabilities, schema changes, and migration steps between protocol versions.
            </p>
          </div>
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <div>
              <label style="font-size: 0.8rem; font-weight: 600; margin-right: 0.4rem;">Base:</label>
              <select
                class="btn btn-outline"
                value={baseVer}
                onChange={(e) => setBaseVer(e.target.value)}
                style="padding: 0.25rem 0.5rem; font-size: 0.85rem;"
              >
                {versionsData.history.map((v) => (
                  <option key={v.version} value={v.version}>v{v.version} ({v.status})</option>
                ))}
              </select>
            </div>

            <span style="color: var(--color-text-muted);">➔</span>

            <div>
              <label style="font-size: 0.8rem; font-weight: 600; margin-right: 0.4rem;">Target:</label>
              <select
                class="btn btn-outline"
                value={targetVer}
                onChange={(e) => setTargetVer(e.target.value)}
                style="padding: 0.25rem 0.5rem; font-size: 0.85rem;"
              >
                {versionsData.history.map((v) => (
                  <option key={v.version} value={v.version}>v{v.version} ({v.status})</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Diff Comparison Grid */}
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 1rem;">
          {/* Base Version Details */}
          <div class="panel" style="padding: 1rem; background: var(--color-bg-subtle);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <h4 style="margin: 0; font-size: 1.05rem;">{baseObj.title}</h4>
              <span class="badge badge-observation">{baseObj.status}</span>
            </div>
            <p style="font-size: 0.85rem; color: var(--color-text-secondary); margin: 0 0 1rem 0;">
              {baseObj.description}
            </p>
            <div style="font-size: 0.8rem; font-family: var(--font-mono); margin-bottom: 0.5rem; word-break: break-all;">
              Contract Digest: {baseObj.contractDigest}
            </div>
            <div>
              <strong style="font-size: 0.8rem; text-transform: uppercase; color: var(--color-text-muted);">
                Capabilities ({baseObj.addedCapabilities.length}):
              </strong>
              <ul style="margin: 0.4rem 0 0 1.2rem; padding: 0; font-size: 0.85rem;">
                {baseObj.addedCapabilities.map((c, i) => (
                  <li key={i} style="margin-bottom: 0.25rem;">{c}</li>
                ))}
              </ul>
            </div>
          </div>

          {/* Target Version Details */}
          <div class="panel" style="padding: 1rem; background: var(--color-bg-subtle); border-left: 4px solid var(--color-brand);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <h4 style="margin: 0; font-size: 1.05rem;">{targetObj.title}</h4>
              <span class="badge badge-verification">{targetObj.status}</span>
            </div>
            <p style="font-size: 0.85rem; color: var(--color-text-secondary); margin: 0 0 1rem 0;">
              {targetObj.description}
            </p>
            <div style="font-size: 0.8rem; font-family: var(--font-mono); margin-bottom: 0.5rem; word-break: break-all;">
              Contract Digest: {targetObj.contractDigest}
            </div>
            <div>
              <strong style="font-size: 0.8rem; text-transform: uppercase; color: var(--color-brand);">
                Added / Upgraded in v{targetObj.version}:
              </strong>
              <ul style="margin: 0.4rem 0 0 1.2rem; padding: 0; font-size: 0.85rem;">
                {targetObj.addedCapabilities.map((c, i) => (
                  <li key={i} style="margin-bottom: 0.25rem; font-weight: 600;">{c}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Migration Guidance Summary */}
        <div style="margin-top: 1.5rem; padding: 1rem; background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md);">
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">Migration Checklist: v{baseVer} ➔ v{targetVer}</h4>
          <p style="margin: 0 0 0.5rem 0; font-size: 0.85rem; color: var(--color-text-secondary);">
            Ordex protocol releases are backwards compatible. Handled via additive OpenAPI routes and AsyncAPI event envelopes.
          </p>
          <ul style="margin: 0 0 0 1.2rem; padding: 0; font-size: 0.85rem;">
            <li>All v{baseVer} signed PSBT portable asks continue to verify and settle without modification.</li>
            <li>Update <code>@bitcoinuniverse/ordex-sdk</code> to <code>{targetObj.sdkCompatibility}</code>.</li>
            <li>If consuming event streams, update cursor tracking to support checkpoint replaying.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
