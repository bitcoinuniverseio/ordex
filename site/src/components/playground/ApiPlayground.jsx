import { h } from 'preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import operationsData from '../../data/operations.json';
import openapi from '../../../../spec/openapi.json';
import { TruthLabel } from '../shell/TruthLabel.jsx';
import { journeyStore, DEFAULT_SETTINGS } from '../../lib/session/journey-store';
import { recordToolEvidence } from '../../lib/session/evidence';
import {
  buildRequestPlan,
  authorizePlan,
  planFingerprint,
  executePlan,
  curlFor,
  operationParameters,
  effectOf,
  contractOperation
} from '../../lib/api/request-plan.mjs';

const EFFECT_TEXT = {
  read: 'Read: no effect',
  write: 'Write: changes gateway state',
  broadcast: 'Broadcast: sends a transaction to the network',
  operator: 'Operator only'
};

function initialOperationId(fallback) {
  if (typeof window !== 'undefined') {
    const id = new URLSearchParams(window.location.search).get('operation');
    if (id && operationsData.some((op) => op.operationId === id)) return id;
  }
  return fallback || operationsData[0]?.operationId;
}

// OX-S05: requests are built from the OpenAPI 3.1 contract and the shared settings, checked
// before sending, sent only when the mode and network allow their effect (writes need an
// approval bound to the exact request), and every response is checked against the schema
// documented for its status, separately from HTTP success.
export function ApiPlayground({ initialOperationId: fallbackId = null }) {
  const [selectedOpId, setSelectedOpId] = useState(() => initialOperationId(fallbackId));
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [values, setValues] = useState({ path: {}, query: {}, header: {} });
  const [bodyText, setBodyText] = useState('');
  const [approval, setApproval] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [result, setResult] = useState(null);
  const [showExample, setShowExample] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState(null);
  const abortRef = useRef(null);
  const seqRef = useRef(0);

  const op = operationsData.find((o) => o.operationId === selectedOpId) || operationsData[0];
  const raw = contractOperation(openapi, op);
  const params = useMemo(() => operationParameters(openapi, op), [op.operationId]);
  const effect = effectOf(op, raw || {});

  useEffect(() => {
    let live = true;
    const load = () => journeyStore.getSettings().then((s) => live && setSettings(s)).catch(() => {});
    load();
    const off = journeyStore.subscribe((e) => e.type === 'settings' && load());
    return () => {
      live = false;
      off();
    };
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    setValues({ path: {}, query: {}, header: {} });
    setBodyText(op.requestExample ? JSON.stringify(op.requestExample, null, 2) : '');
    setResult(null);
    setShowExample(false);
    setApproval(null);
    setReviewing(false);
    setNotice(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('operation', op.operationId);
      window.history.replaceState(null, '', url);
    }
  }, [selectedOpId]);

  const plan = buildRequestPlan({ doc: openapi, operation: op, origin: settings.gatewayOrigin, values, bodyText });
  const auth = authorizePlan(plan, settings, approval);

  const setValue = (loc, name, v) => {
    setValues((prev) => ({ ...prev, [loc]: { ...prev[loc], [name]: v } }));
    setResult(null);
  };

  const send = async () => {
    if (running || !auth.allowed) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    setRunning(true);
    setResult(null);
    setReviewing(false);
    const res = await executePlan({ doc: openapi, operation: op, plan, signal: controller.signal });
    if (seq !== seqRef.current) return; // a newer request superseded this one
    setRunning(false);
    setResult(res);
    setApproval(null);
    if (res.ok) {
      const conforms = res.schema.state === 'valid';
      recordToolEvidence({
        tool: 'playground',
        operation: `api:${op.operationId}`,
        state: !conforms ? 'failed' : res.http.ok ? 'passed' : 'refused',
        code: `HTTP_${res.status}`,
        reason: conforms ? `HTTP ${res.status} with a body matching the documented schema.` : res.schema.errors[0]?.message || res.schema.errors[0] || 'Schema check failed',
        evidenceClass: 'Gateway observation'
      });
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    seqRef.current++;
    setRunning(false);
    setResult({ ok: false, code: 'CANCELLED', message: 'Cancelled. No result is shown for a cancelled request.' });
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied.');
    } catch {
      setNotice('Copy failed. Select the text and copy it manually.');
    }
  };

  const curl = plan.url ? curlFor(plan) : null;
  const statusTone = result?.ok ? (result.schema.state === 'valid' ? 'var(--color-success)' : 'var(--color-danger)') : 'var(--color-danger)';

  return (
    <div class="api-playground-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="panel" style="padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
        <label style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; font-weight: 700; font-size: 0.95rem;">
          Operation
          <select class="btn btn-outline" value={selectedOpId} onChange={(e) => setSelectedOpId(e.currentTarget.value)} style="padding: 0.4rem 0.8rem; font-family: var(--font-mono); font-size: 0.85rem; max-width: 100%;">
            {operationsData.map((o) => (
              <option key={o.operationId} value={o.operationId}>
                [{o.method}] {o.path} ({o.operationId})
              </option>
            ))}
          </select>
        </label>
        <div style="font-size: 0.85rem; color: var(--color-text-secondary);">
          Gateway: <strong>{settings.gatewayOrigin || 'none configured'}</strong> · Network: <strong>{settings.network}</strong> · Mode: <strong>{settings.mode}</strong>. Change these in the settings menu at the top of the page.
        </div>
      </div>

      <div style="background: var(--color-bg-subtle); border-left: 4px solid var(--color-focus); padding: 0.75rem 1rem; border-radius: var(--radius-md); font-size: 0.85rem;">
        <strong>What this sends:</strong> read operations go to the configured gateway. Writes and broadcasts are sent only in write mode, only to Signet, Testnet4 or Regtest, and only after you confirm the exact request. Nothing is signed here.
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 1.5rem;">
        <div class="panel">
          <div class="panel-header" style="flex-wrap: wrap; gap: 0.5rem;">
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; flex-wrap: wrap;">
                <code style="font-weight: 800;">{op.method}</code>
                <code style="font-size: 0.9rem; word-break: break-all;">{op.path}</code>
              </div>
              <p style="margin: 0; font-size: 0.85rem; color: var(--color-text-secondary);">{op.summary}</p>
              <p style="margin: 0.25rem 0 0 0; font-size: 0.8rem; font-weight: 700;">{EFFECT_TEXT[effect]}</p>
            </div>
            <TruthLabel level={op.authorityLevel} />
          </div>

          {params.length > 0 && (
            <fieldset style="border: none; padding: 0; margin: 0 0 1rem 0;">
              <legend style="font-size: 0.85rem; text-transform: uppercase; color: var(--color-text-secondary); margin-bottom: 0.5rem;">Parameters</legend>
              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                {params.map((p) => {
                  const id = `param-${p.in}-${p.name}`;
                  const schema = p.schema?.$ref ? null : p.schema || {};
                  return (
                    <div key={id} style="display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem;">
                      <label for={id}>
                        <code>{p.name}</code> <span style="color: var(--color-text-secondary);">({p.in}{p.required || p.in === 'path' ? ', required' : ''})</span>
                      </label>
                      {Array.isArray(schema?.enum) ? (
                        <select id={id} value={values[p.in]?.[p.name] || ''} onChange={(e) => setValue(p.in, p.name, e.currentTarget.value)} style="padding: 0.35rem; font-family: var(--font-mono);">
                          <option value="">(not set)</option>
                          {schema.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                        </select>
                      ) : (
                        <input
                          id={id}
                          type="text"
                          value={values[p.in]?.[p.name] || ''}
                          placeholder={schema?.pattern ? `pattern ${schema.pattern}` : schema?.type || 'value'}
                          onInput={(e) => setValue(p.in, p.name, e.currentTarget.value)}
                          style="padding: 0.35rem 0.5rem; font-family: var(--font-mono); font-size: 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm);"
                        />
                      )}
                      {p.description && <span style="font-size: 0.75rem; color: var(--color-text-secondary);">{p.description}</span>}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          )}

          {raw?.requestBody && (
            <div style="margin-bottom: 1rem;">
              <label for="api-body" style="display: block; font-size: 0.85rem; text-transform: uppercase; color: var(--color-text-secondary); margin-bottom: 0.4rem;">
                JSON request body (amounts as decimal strings)
              </label>
              {!op.requestExample && op.requestExampleIssue && (
                <p style="font-size: 0.8rem; color: var(--color-text-secondary); margin: 0 0 0.35rem 0;">No validated example is available: {op.requestExampleIssue}.</p>
              )}
              <textarea
                id="api-body"
                rows={10}
                value={bodyText}
                spellcheck={false}
                onInput={(e) => {
                  setBodyText(e.currentTarget.value);
                  setResult(null);
                }}
                style="width: 100%; font-family: var(--font-mono); font-size: 0.85rem; padding: 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-subtle); color: var(--color-text-primary);"
              />
            </div>
          )}

          <div aria-live="polite">
            {!plan.ok && (
              <div role="alert">
                <ul style="margin: 0 0 0.75rem 0; font-size: 0.8rem; color: var(--color-danger);">
                  {plan.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}
                </ul>
              </div>
            )}
            {!auth.allowed && !auth.needsApproval && (plan.ok || auth.reason !== plan.errors[0]) && (
              <p role="status" style="font-size: 0.85rem; color: var(--color-danger); margin: 0 0 0.75rem 0;">{auth.reason}</p>
            )}
          </div>

          {reviewing && auth.needsApproval && (
            <div role="group" aria-label="Confirm this request" style="border: 2px solid var(--color-danger); border-radius: var(--radius-md); padding: 0.75rem; margin-bottom: 0.75rem; font-size: 0.85rem;">
              <strong>Confirm this exact request</strong>
              <dl style="display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 0.75rem; margin: 0.5rem 0;">
                <dt>Effect</dt><dd style="margin: 0;">{EFFECT_TEXT[effect]}</dd>
                <dt>Network</dt><dd style="margin: 0;">{settings.network}</dd>
                <dt>Request</dt><dd style="margin: 0; word-break: break-all;"><code>{plan.method} {plan.url}</code></dd>
              </dl>
              {plan.body && <pre style="max-height: 160px; overflow: auto; font-size: 0.75rem;"><code>{plan.body}</code></pre>}
              <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                <button class="btn btn-danger" type="button" onClick={() => setApproval(planFingerprint(plan, settings))}>Confirm</button>
                <button class="btn btn-outline" type="button" onClick={() => setReviewing(false)}>Back</button>
              </div>
              {approval && <p role="status" style="margin: 0.5rem 0 0 0;">Confirmed. Any change to the request clears this confirmation.</p>}
            </div>
          )}

          <div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--color-border);">
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
              <button class="btn btn-outline" type="button" disabled={!curl} onClick={() => copy(curl)} style="font-size: 0.8rem;">Copy cURL</button>
              <button class="btn btn-outline" type="button" onClick={() => setShowExample((v) => !v)} aria-pressed={showExample ? 'true' : 'false'} style="font-size: 0.8rem;">
                Contract example
              </button>
            </div>
            <div style="display: flex; gap: 0.5rem;">
              {running && <button class="btn btn-outline" type="button" onClick={cancel}>Cancel</button>}
              {auth.needsApproval && !approval ? (
                <button class="btn btn-danger" type="button" onClick={() => setReviewing(true)}>Review request</button>
              ) : (
                <button class="btn btn-primary" type="button" onClick={send} disabled={running || !auth.allowed} style="min-width: 130px;">
                  {running ? 'Sending...' : 'Send to gateway'}
                </button>
              )}
            </div>
          </div>
          {notice && <p role="status" style="font-size: 0.8rem; margin: 0.5rem 0 0 0;">{notice}</p>}
          {curl && (
            <details style="margin-top: 0.75rem;">
              <summary style="cursor: pointer; font-size: 0.85rem;">cURL</summary>
              <pre style="font-size: 0.75rem; overflow: auto;"><code>{curl}</code></pre>
            </details>
          )}
        </div>

        <div class="panel" aria-live="polite">
          <div class="panel-header">
            <h3 style="margin: 0; font-size: 1.1rem;">Response</h3>
          </div>
          {showExample && (
            <div style="margin-bottom: 1rem;">
              <p style="font-size: 0.8rem; margin: 0 0 0.35rem 0;">
                <strong>Contract example</strong> for the {op.successStatus || 'success'} response. It validates against the schema; no request was sent.
              </p>
              {op.responseExample !== null ? (
                <pre style="max-height: 240px; overflow: auto; font-size: 0.8em;"><code>{JSON.stringify(op.responseExample, null, 2)}</code></pre>
              ) : (
                <p style="font-size: 0.85rem;">No example is available: {op.responseExampleIssue}.</p>
              )}
            </div>
          )}
          {!result && !showExample && (
            <p style="font-size: 0.9rem; color: var(--color-text-secondary);">Send a request to see the gateway's answer and whether it matches the contract.</p>
          )}
          {result && !result.ok && (
            <div role="alert" style="font-size: 0.9rem; color: var(--color-danger);">
              <strong>{result.code}</strong>: {result.message}
            </div>
          )}
          {result && result.ok && (
            <div>
              <div style="display: flex; flex-direction: column; gap: 0.35rem; padding: 0.6rem 0.85rem; margin-bottom: 0.75rem; background: var(--color-bg-subtle); border-radius: var(--radius-sm); font-size: 0.85rem;">
                <div>
                  <strong>HTTP:</strong> {result.status} {result.statusText} ({result.durationMs} ms)
                </div>
                <div style={{ color: statusTone }}>
                  <strong>Contract check:</strong>{' '}
                  {result.schema.state === 'valid'
                    ? 'the body matches the documented schema'
                    : result.schema.state === 'not-validated'
                      ? result.schema.errors[0]
                      : `does not match: ${result.schema.errors.map((e) => (typeof e === 'string' ? e : `${e.path} ${e.message}`)).slice(0, 3).join('; ')}`}
                </div>
                <div style="font-size: 0.8rem; color: var(--color-text-secondary);">A gateway answer is an observation of that gateway. It is not chain confirmation.</div>
              </div>
              <pre style="max-height: 280px; margin: 0 0 1rem 0; font-size: 0.8em; overflow: auto;">
                <code>{typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)}</code>
              </pre>
              <details>
                <summary style="cursor: pointer; font-size: 0.85rem;">Response headers</summary>
                <div style="font-size: 0.8rem; font-family: var(--font-mono);">
                  {Object.entries(result.headers).map(([k, v]) => (
                    <div key={k}>
                      {k}: {v}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
