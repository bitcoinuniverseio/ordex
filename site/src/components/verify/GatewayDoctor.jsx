import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import operations from '../../data/operations.json';
import openapi from '../../../../spec/openapi.json';
import { runGatewayDoctor, CHECKS } from '../../lib/doctor/gateway-doctor.mjs';
import { journeyStore, DEFAULT_SETTINGS } from '../../lib/session/journey-store';
import { normalizeGatewayOrigin } from '../../lib/session/journey-schema';
import { recordToolEvidence, SOURCE_BUILD } from '../../lib/session/evidence';

const STATUS_TEXT = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', cancelled: 'Cancelled', running: 'Running', 'not-run': 'Not run' };
const STATUS_COLOR = { passed: 'var(--color-success)', failed: 'var(--color-danger)', blocked: 'var(--color-text-secondary)', cancelled: 'var(--color-text-secondary)', running: 'var(--color-text-primary)', 'not-run': 'var(--color-text-secondary)' };

// OX-S02: every check is a real read-only request with exact assertions; an unreachable,
// invalid, stale or wrong-network gateway fails, dependent checks are blocked, and the
// report digest is SHA-256 over the report the user can download.
export function GatewayDoctor() {
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [originInput, setOriginInput] = useState('');
  const [originError, setOriginError] = useState(null);
  const [checks, setChecks] = useState([]);
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      journeyStore
        .getSettings()
        .then((s) => {
          if (!live) return;
          setSettings(s);
          setOriginInput((cur) => cur || s.gatewayOrigin);
        })
        .catch(() => {});
    load();
    const off = journeyStore.subscribe((e) => e.type === 'settings' && load());
    return () => {
      live = false;
      off();
      abortRef.current?.abort();
    };
  }, []);

  const run = async () => {
    const o = normalizeGatewayOrigin(originInput);
    if (!o.ok || !o.origin) {
      setOriginError(o.ok ? 'Enter the gateway origin to check.' : o.error);
      return;
    }
    setOriginError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setReport(null);
    setChecks([]);
    // The run uses a snapshot of the origin and network taken now.
    const result = await runGatewayDoctor({
      doc: openapi,
      operations,
      origin: o.origin,
      network: settings.network,
      protocolVersion: settings.protocolVersion,
      sourceBuild: SOURCE_BUILD,
      signal: controller.signal,
      onProgress: setChecks
    });
    if (abortRef.current !== controller) return;
    setRunning(false);
    setChecks(result.checks);
    setReport(result);
    recordToolEvidence({
      tool: 'doctor',
      operation: `doctor:${o.origin}`,
      state: result.success ? 'passed' : 'failed',
      reason: `${result.passed} passed, ${result.failed} failed, ${result.blocked} blocked. Report SHA-256 ${result.digest}.`,
      evidenceClass: 'Gateway observation',
      gatewayOrigin: o.origin
    });
  };

  const cancel = () => abortRef.current?.abort();

  const download = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ordex-gateway-doctor-${report.digest.slice(0, 12)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shown = checks.length ? checks : CHECKS.map((c) => ({ ...c, status: 'not-run', details: '' }));

  return (
    <div class="gateway-doctor-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="panel">
        <div class="panel-header" style="flex-wrap: wrap; gap: 0.5rem;">
          <div>
            <h3 style="margin: 0; font-size: 1.15rem;">Gateway Doctor</h3>
            <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
              {CHECKS.length} read-only checks against the contract. Network: <strong>{settings.network}</strong>, protocol <strong>{settings.protocolVersion}</strong> (from settings). Nothing is written.
            </p>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-primary" type="button" onClick={run} disabled={running}>
              {running ? 'Checking...' : 'Run Gateway Doctor'}
            </button>
            {running && <button class="btn btn-outline" type="button" onClick={cancel}>Cancel</button>}
          </div>
        </div>
        <label for="doctor-origin" style="display: block; font-size: 0.85rem; font-weight: 600; margin-top: 0.5rem;">Gateway origin</label>
        <input
          id="doctor-origin"
          type="url"
          value={originInput}
          placeholder="https://gateway.example"
          aria-invalid={originError ? 'true' : 'false'}
          aria-describedby={originError ? 'doctor-origin-error' : undefined}
          onInput={(e) => setOriginInput(e.currentTarget.value)}
          style="width: 100%; max-width: 420px; padding: 0.35rem 0.65rem; font-family: var(--font-mono); font-size: 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm);"
        />
        {originError && <div id="doctor-origin-error" role="alert" style="color: var(--color-danger); font-size: 0.8rem; margin-top: 0.25rem;">{originError}</div>}
      </div>

      <div class="panel" style="padding: 1rem;">
        <h4 style="margin: 0 0 0.75rem 0; font-size: 1rem;">Checks</h4>
        <ol style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem;">
          {shown.map((c) => (
            <li key={c.id} style="padding: 0.6rem 0.85rem; background: var(--color-bg-subtle); border-radius: var(--radius-sm); font-size: 0.85rem;">
              <div style="display: flex; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;">
                <span style="font-weight: 600;">{c.name}</span>
                <span style={{ fontWeight: 700, color: STATUS_COLOR[c.status] }}>{STATUS_TEXT[c.status] || c.status}</span>
              </div>
              {c.details && <div style="font-size: 0.8rem; color: var(--color-text-secondary); margin-top: 0.2rem;">{c.details}</div>}
              {c.evidence?.response && (
                <details style="margin-top: 0.25rem;">
                  <summary style="cursor: pointer; font-size: 0.75rem;">Request and response</summary>
                  <div style="font-family: var(--font-mono); font-size: 0.75rem; word-break: break-all;">
                    <div>{c.evidence.request.method} {c.evidence.request.url}</div>
                    <div>{c.evidence.response.error ? `${c.evidence.response.error}: ${c.evidence.response.message}` : `HTTP ${c.evidence.response.status} ${c.evidence.response.contentType || ''} body SHA-256 ${c.evidence.response.bodySha256}`}</div>
                    {c.evidence.response.excerpt && <pre style="white-space: pre-wrap; margin: 0.25rem 0 0 0;">{c.evidence.response.excerpt}</pre>}
                  </div>
                </details>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div aria-live="polite">
        {report && (
          <div class="panel" style={{ borderColor: report.success ? 'var(--color-success)' : 'var(--color-danger)' }}>
            <div style={{ fontWeight: 800, fontSize: '1.1rem', color: report.success ? 'var(--color-success)' : 'var(--color-danger)', marginBottom: '0.5rem' }}>
              {report.success ? 'Every check passed' : 'The gateway is not compatible'}
            </div>
            <p style="margin: 0; font-size: 0.85rem;">
              {report.origin}: {report.passed} passed, {report.failed} failed, {report.blocked} blocked{report.cancelled ? `, ${report.cancelled} cancelled` : ''}. Build <code>{report.sourceBuild.slice(0, 12)}</code>, {report.finishedAt}.
            </p>
            <p style="margin: 0.35rem 0 0 0; font-size: 0.8rem; word-break: break-all;">Report SHA-256: <code>{report.digest}</code></p>
            <p style="margin: 0.35rem 0 0 0; font-size: 0.75rem; color: var(--color-text-secondary);">A self-check of one gateway at one moment. It is not an audit and proves nothing about chain state.</p>
            <button class="btn btn-outline" type="button" onClick={download} style="margin-top: 0.5rem;">Download report (JSON)</button>
          </div>
        )}
      </div>
    </div>
  );
}
