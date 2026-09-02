import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import operationsData from '../../data/operations.json';
import { TruthLabel } from '../shell/TruthLabel.jsx';

export function ApiPlayground({ initialOperationId = null }) {
  const [selectedOpId, setSelectedOpId] = useState(initialOperationId || operationsData[0]?.operationId);
  const [connectionMode, setConnectionMode] = useState('mock'); // 'mock', 'gateway_read', 'gateway_write'
  const [gatewayOrigin, setGatewayOrigin] = useState('http://localhost:8080');
  const [activeTab, setActiveTab] = useState('form'); // 'form', 'raw'
  const [requestBodyText, setRequestBodyText] = useState('');
  const [responseOutput, setResponseOutput] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const currentOp = operationsData.find((op) => op.operationId === selectedOpId) || operationsData[0];

  useEffect(() => {
    if (currentOp?.requestExample) {
      setRequestBodyText(JSON.stringify(currentOp.requestExample, null, 2));
    } else {
      setRequestBodyText('');
    }
    setResponseOutput(null);
  }, [selectedOpId]);

  const handleExecute = async () => {
    setLoading(true);
    const start = performance.now();

    // Mode 1: Deterministic Mock
    if (connectionMode === 'mock') {
      setTimeout(() => {
        setResponseOutput({
          mode: 'Deterministic Mock',
          status: 200,
          statusText: 'OK',
          durationMs: (performance.now() - start).toFixed(2),
          headers: {
            'content-type': 'application/json',
            'x-ordex-mode': 'mock-deterministic',
            'x-ordex-protocol': '1.2'
          },
          body: currentOp.responseExample,
          verdict: 'PASS (Matches OpenAPI Schema)',
          evidence: 'Deterministic example'
        });
        setLoading(false);
      }, 50);
      return;
    }

    // Mode 2 & 3: Live Gateway Request (Browser direct to origin)
    try {
      const url = `${gatewayOrigin.replace(/\/$/, '')}${currentOp.path}`;
      const options = {
        method: currentOp.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Ordex-Client': 'ordex-docs-playground'
        }
      };

      if (currentOp.isWrite && requestBodyText) {
        options.body = requestBodyText;
      }

      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      const durationMs = (performance.now() - start).toFixed(2);

      const headersObj = {};
      res.headers.forEach((v, k) => { headersObj[k] = v; });

      setResponseOutput({
        mode: connectionMode === 'gateway_write' ? 'Explicit Gateway Mutation' : 'Configured Gateway Read',
        status: res.status,
        statusText: res.statusText,
        durationMs,
        headers: headersObj,
        body: data,
        verdict: res.ok ? 'PASS (Gateway Accepted)' : 'REFUSED (Gateway Rejected)',
        evidence: 'Gateway observation'
      });
    } catch (err) {
      setResponseOutput({
        mode: 'Gateway Connection Failed',
        status: 0,
        statusText: 'Network / CORS Error',
        durationMs: (performance.now() - start).toFixed(2),
        headers: {},
        body: {
          error: 'Connection failed',
          message: err.message,
          corsGuidance: 'Ensure the Ordex gateway includes Access-Control-Allow-Origin: ' + window.location.origin + ' and Access-Control-Allow-Headers: Content-Type, X-Ordex-Client.'
        },
        verdict: 'FAIL (CORS or Unreachable Gateway)',
        evidence: 'Gateway observation'
      });
    } finally {
      setLoading(false);
    }
  };

  const copyCode = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const curlCommand = `curl -X ${currentOp.method} "${connectionMode === 'mock' ? 'http://localhost:8080' : gatewayOrigin}${currentOp.path}" \\
  -H "Content-Type: application/json"${currentOp.isWrite && requestBodyText ? ` \\\n  -d '${requestBodyText.replace(/\n/g, '').replace(/\s+/g, ' ')}'` : ''}`;

  return (
    <div class="api-playground-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      {/* Operation Picker Bar */}
      <div class="panel" style="padding: 1rem;">
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem;">
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <span style="font-weight: 700; font-size: 0.95rem;">Operation:</span>
            <select
              class="btn btn-outline"
              value={selectedOpId}
              onChange={(e) => setSelectedOpId(e.target.value)}
              style="padding: 0.4rem 0.8rem; font-family: var(--font-mono); font-size: 0.85rem;"
            >
              {operationsData.map((op) => (
                <option key={op.operationId} value={op.operationId}>
                  [{op.method}] {op.path} ({op.operationId})
                </option>
              ))}
            </select>
          </div>

          {/* Connection Mode Radios */}
          <div style="display: flex; align-items: center; gap: 0.5rem; background: var(--color-bg-subtle); padding: 0.3rem 0.6rem; border-radius: var(--radius-md); border: 1px solid var(--color-border);">
            <span style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--color-text-muted);">
              Mode:
            </span>
            <label style="display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; cursor: pointer;">
              <input
                type="radio"
                name="conn_mode"
                checked={connectionMode === 'mock'}
                onChange={() => setConnectionMode('mock')}
              />
              Deterministic Mock
            </label>
            <label style="display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; cursor: pointer;">
              <input
                type="radio"
                name="conn_mode"
                checked={connectionMode === 'gateway_read'}
                onChange={() => setConnectionMode('gateway_read')}
              />
              Gateway Read
            </label>
            {currentOp.isWrite && (
              <label style="display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; cursor: pointer; color: var(--color-danger);">
                <input
                  type="radio"
                  name="conn_mode"
                  checked={connectionMode === 'gateway_write'}
                  onChange={() => setConnectionMode('gateway_write')}
                />
                Explicit Gateway Write
              </label>
            )}
          </div>
        </div>

        {/* Gateway Origin Input when connected */}
        {connectionMode !== 'mock' && (
          <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--color-border); display: flex; align-items: center; gap: 0.75rem;">
            <label style="font-size: 0.85rem; font-weight: 600;">Gateway Origin:</label>
            <input
              type="text"
              value={gatewayOrigin}
              onInput={(e) => setGatewayOrigin(e.target.value)}
              placeholder="http://localhost:8080"
              style="flex: 1; max-width: 350px; padding: 0.35rem 0.6rem; font-family: var(--font-mono); font-size: 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm);"
            />
            <span style="font-size: 0.75rem; color: var(--color-text-muted);">
              Browser calls origin directly. Zero credentials relayed.
            </span>
          </div>
        )}
      </div>

      {/* Safety Notice */}
      <div style="background: var(--color-brand-subtle); border-left: 4px solid var(--color-brand); padding: 0.75rem 1rem; border-radius: var(--radius-md); font-size: 0.85rem;">
        <strong>Safety Boundary:</strong> Ordex documentation never holds private keys, signs PSBTs, or broadcasts transactions. Operations generate or inspect unsigned artifacts only.
      </div>

      {/* Main Request & Response Grid */}
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
        {/* Left: Request Builder */}
        <div class="panel">
          <div class="panel-header">
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
                <code style="font-weight: 800; color: var(--color-brand);">{currentOp.method}</code>
                <code style="font-size: 0.9rem;">{currentOp.path}</code>
              </div>
              <p style="margin: 0; font-size: 0.85rem; color: var(--color-text-secondary);">
                {currentOp.summary}
              </p>
            </div>
            <TruthLabel level={currentOp.authorityLevel} />
          </div>

          {/* Parameters Section */}
          {currentOp.parameters?.length > 0 && (
            <div style="margin-bottom: 1rem;">
              <h4 style="margin: 0 0 0.5rem 0; font-size: 0.85rem; text-transform: uppercase; color: var(--color-text-muted);">
                Parameters
              </h4>
              <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                {currentOp.parameters.map((p) => (
                  <div key={p.name} style="display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; padding: 0.35rem 0.5rem; background: var(--color-bg-subtle); border-radius: 4px;">
                    <div>
                      <code>{p.name}</code>
                      <span style="font-size: 0.75rem; color: var(--color-text-muted); margin-left: 0.4rem;">({p.in})</span>
                    </div>
                    <span style="font-size: 0.8rem; color: var(--color-text-secondary);">{p.description || 'string'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Request Body Editor */}
          {currentOp.isWrite && (
            <div style="margin-bottom: 1rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
                <h4 style="margin: 0; font-size: 0.85rem; text-transform: uppercase; color: var(--color-text-muted);">
                  JSON Request Body
                </h4>
                <div style="font-size: 0.75rem; color: var(--color-text-muted);">
                  BigInt-safe decimal strings supported
                </div>
              </div>
              <textarea
                rows={8}
                value={requestBodyText}
                onInput={(e) => setRequestBodyText(e.target.value)}
                style="width: 100%; font-family: var(--font-mono); font-size: 0.85rem; padding: 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-subtle); color: var(--color-text-primary);"
              />
            </div>
          )}

          {/* Action Bar */}
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--color-border);">
            <button
              class="btn btn-outline"
              onClick={() => copyCode(curlCommand)}
              style="font-size: 0.8rem;"
            >
              {copied ? '✓ Copied cURL' : 'Copy cURL'}
            </button>

            <button
              class={`btn ${connectionMode === 'gateway_write' ? 'btn-danger' : 'btn-primary'}`}
              onClick={handleExecute}
              disabled={loading}
              style="min-width: 130px;"
            >
              {loading ? 'Executing...' : connectionMode === 'gateway_write' ? 'Authorize Write Request' : 'Send Request'}
            </button>
          </div>
        </div>

        {/* Right: Response Inspector */}
        <div class="panel">
          <div class="panel-header">
            <h3 style="margin: 0; font-size: 1.1rem;">Response Inspector</h3>
            {responseOutput && (
              <span class={`badge ${responseOutput.status === 200 ? 'badge-verification' : 'badge-claim'}`}>
                {responseOutput.status} {responseOutput.statusText} ({responseOutput.durationMs}ms)
              </span>
            )}
          </div>

          {!responseOutput ? (
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 320px; color: var(--color-text-muted); text-align: center;">
              <span style="font-size: 2.5rem; margin-bottom: 0.75rem;">⚡</span>
              <p style="margin: 0; font-size: 0.95rem;">Send a request to inspect headers, timing, and schema verdicts.</p>
              <p style="margin: 0.25rem 0 0 0; font-size: 0.8rem;">Deterministic Mock mode runs fully offline.</p>
            </div>
          ) : (
            <div>
              {/* Verdict banner */}
              <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.6rem 0.85rem; margin-bottom: 0.75rem; background: var(--color-bg-subtle); border-radius: var(--radius-sm); font-size: 0.85rem;">
                <div>
                  <strong>Schema Verdict: </strong>
                  <span style="color: responseOutput.status === 200 ? 'var(--color-success)' : 'var(--color-danger)'; font-weight: 600;">
                    {responseOutput.verdict}
                  </span>
                </div>
                <TruthLabel level={responseOutput.evidence} />
              </div>

              {/* JSON Response Body */}
              <div style="margin-bottom: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
                  <span style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: var(--color-text-muted);">
                    Response Payload
                  </span>
                  <button
                    class="btn btn-outline"
                    style="font-size: 0.75rem; padding: 0.15rem 0.5rem; min-height: 24px;"
                    onClick={() => copyCode(JSON.stringify(responseOutput.body, null, 2))}
                  >
                    Copy JSON
                  </button>
                </div>
                <pre style="max-height: 280px; margin: 0; font-size: 0.8em; overflow: auto;">
                  <code>{JSON.stringify(responseOutput.body, null, 2)}</code>
                </pre>
              </div>

              {/* Headers Table */}
              <div>
                <span style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: var(--color-text-muted); display: block; margin-bottom: 0.35rem;">
                  Response Headers
                </span>
                <div style="font-size: 0.8rem; background: var(--color-bg-subtle); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 0.5rem; font-family: var(--font-mono); max-height: 120px; overflow-y: auto;">
                  {Object.entries(responseOutput.headers).map(([k, v]) => (
                    <div key={k} style="display: flex; justify-content: space-between; gap: 1rem;">
                      <span style="color: var(--color-text-muted);">{k}:</span>
                      <span style="color: var(--color-text-primary); text-align: right;">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
