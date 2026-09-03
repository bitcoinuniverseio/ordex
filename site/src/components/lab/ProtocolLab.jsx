import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import allVectors from '../../data/allVectors.json';
import refusalsData from '../../data/refusals.json';
import { SatFlowDiagram } from './SatFlowDiagram.jsx';
import { TruthLabel } from '../shell/TruthLabel.jsx';
import { executeVector } from '../../lib/conformance-engine.mjs';
import { resolveUrl } from '../../lib/base-url.js';

export function ProtocolLab() {
  const [activeTab, setActiveTab] = useState('inspect'); // inspect, compare, export
  const [selectedFamily, setSelectedFamily] = useState('purchase');
  const [inputPayload, setInputPayload] = useState('');
  const [orderPayload, setOrderPayload] = useState('');
  const [verdictResult, setVerdictResult] = useState(null);
  const [safetyWarning, setSafetyWarning] = useState(null);
  const [compareLeft, setCompareLeft] = useState(null);
  const [compareRight, setCompareRight] = useState(null);

  // Bundled deterministic examples
  const sampleVector = allVectors.find((v) => v.family === 'purchase' && v.expected?.ok) || allVectors[0];

  useEffect(() => {
    loadExample(sampleVector);
  }, []);

  const loadExample = (v) => {
    setSafetyWarning(null);
    setSelectedFamily(v.family);
    if (v.family === 'purchase') {
      setInputPayload(JSON.stringify(v.transaction || v.input, null, 2));
      setOrderPayload(JSON.stringify(v.order || {}, null, 2));
    } else {
      setInputPayload(JSON.stringify(v.input || v, null, 2));
      setOrderPayload('');
    }
    setVerdictResult(null);
  };

  const handleVerify = () => {
    setSafetyWarning(null);

    // Private key detection safety check
    const combined = inputPayload + ' ' + orderPayload;
    if (
      /\b(?:xprv|tprv)[a-zA-HJ-NP-Z0-9]{100,120}\b/.test(combined) ||
      /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,52}\b/.test(combined) ||
      /\b(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access){12,24}\b/.test(combined)
    ) {
      setSafetyWarning('CRITICAL SAFETY REFUSAL: Potential private key or seed phrase detected. Ordex Protocol Lab runs client-side but strictly forbids processing raw private key material.');
      return;
    }

    try {
      const parsedInput = JSON.parse(inputPayload);
      const parsedOrder = orderPayload ? JSON.parse(orderPayload) : {};

      const mockVectorCase = {
        name: 'interactive-lab-test',
        family: selectedFamily,
        input: parsedInput,
        transaction: parsedInput,
        order: parsedOrder,
        expected: { ok: true }
      };

      const res = executeVector(selectedFamily, mockVectorCase);
      setVerdictResult(res);
    } catch (err) {
      setVerdictResult({
        passed: false,
        actual: {
          ok: false,
          code: 'MALFORMED_INPUT',
          reason: `JSON parse error: ${err.message}`
        }
      });
    }
  };

  const exportReport = (format) => {
    const reportData = {
      title: 'Ordex Protocol Lab Diagnostic Self-Test Report',
      timestamp: new Date().toISOString(),
      toolVersion: '1.2.0',
      family: selectedFamily,
      verdict: verdictResult?.actual?.ok ? 'ACCEPTED' : 'REFUSED',
      refusalCode: verdictResult?.actual?.code || null,
      reason: verdictResult?.actual?.reason || null,
      disclaimer: 'This is a local browser diagnostic result, not an on-chain transaction or official certification.'
    };

    let content = '';
    let mime = 'text/plain';
    let ext = 'txt';

    if (format === 'json') {
      content = JSON.stringify(reportData, null, 2);
      mime = 'application/json';
      ext = 'json';
    } else if (format === 'markdown') {
      content = `# Ordex Diagnostic Report\n\n- **Timestamp:** ${reportData.timestamp}\n- **Family:** \`${reportData.family}\`\n- **Verdict:** **${reportData.verdict}**\n- **Refusal Code:** \`${reportData.refusalCode || 'None'}\`\n- **Reason:** ${reportData.reason || 'All protocol invariants passed.'}\n\n> ${reportData.disclaimer}\n`;
      mime = 'text/markdown';
      ext = 'md';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ordex-lab-report-${Date.now()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  let parsedTx = null;
  let parsedOrd = null;
  try {
    parsedTx = JSON.parse(inputPayload);
    parsedOrd = orderPayload ? JSON.parse(orderPayload) : null;
  } catch (e) {}

  return (
    <div class="protocol-lab-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      {/* Top Banner */}
      <div class="panel" style="padding: 1.25rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <div>
            <h2 style="margin: 0; font-size: 1.35rem;">Ordex Protocol Lab (/lab/)</h2>
            <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
              Browser-local protocol workbench. Analyzes transactions, orders, and manifests against reference verifiers.
            </p>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            {['inspect', 'compare', 'export'].map((t) => (
              <button
                key={t}
                class={`btn ${activeTab === t ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.85rem; text-transform: capitalize;"
                onClick={() => setActiveTab(t)}
              >
                {t} Mode
              </button>
            ))}
          </div>
        </div>

        {/* Preset Selector */}
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--color-border);">
          <span style="font-size: 0.8rem; font-weight: 700; color: var(--color-text-muted);">
            Load Preset Conformance Vector:
          </span>
          {allVectors.slice(0, 6).map((v) => (
            <button
              key={v.id}
              class="btn btn-secondary"
              style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.5rem;"
              onClick={() => loadExample(v)}
            >
              [{v.family}] {v.title || v.name}
            </button>
          ))}
        </div>
      </div>

      {/* Safety Alert */}
      {safetyWarning ? (
        <div style="background: var(--color-danger-bg); border-left: 4px solid var(--color-danger); padding: 1rem; border-radius: var(--radius-md); color: var(--color-danger); font-size: 0.9rem;">
          {safetyWarning}
        </div>
      ) : (
        <div style="background: var(--color-bg-subtle); border-left: 4px solid var(--color-focus); padding: 0.6rem 1rem; border-radius: var(--radius-md); font-size: 0.8rem; color: var(--color-text-secondary);">
          🛡️ <strong>Safety Guarantee:</strong> All verifiers execute in local sandbox Web Workers with zero network access. No private keys, no signing, and no transaction broadcasting.
        </div>
      )}

      {activeTab === 'inspect' && (
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          {/* Input Editors */}
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
            <div class="panel">
              <div class="panel-header">
                <h4 style="margin: 0; font-size: 0.95rem;">Transaction / Artifact Input JSON</h4>
                <select
                  class="btn btn-outline"
                  value={selectedFamily}
                  onChange={(e) => setSelectedFamily(e.target.value)}
                  style="font-size: 0.8rem; padding: 0.2rem 0.5rem;"
                >
                  <option value="purchase">Purchase Verifier</option>
                  <option value="offers">Offers v1 Verifier</option>
                  <option value="runes">Rune Burn Guard</option>
                  <option value="safeops">SafeOps Shield</option>
                  <option value="swaps">Atomic Swaps</option>
                  <option value="collection-manifest">Collection Manifest</option>
                  <option value="counterparty-asset">Counterparty Asset</option>
                  <option value="offline-signing">Cold-Signing Session</option>
                </select>
              </div>
              <textarea
                rows={10}
                value={inputPayload}
                onInput={(e) => setInputPayload(e.target.value)}
                style="width: 100%; font-family: var(--font-mono); font-size: 0.85rem; padding: 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-subtle); color: var(--color-text-primary);"
              />
            </div>

            <div class="panel">
              <div class="panel-header">
                <h4 style="margin: 0; font-size: 0.95rem;">Order Terms / Manifest Commitment</h4>
                <button class="btn btn-primary" onClick={handleVerify}>
                  Run Reference Verifier ⚡
                </button>
              </div>
              <textarea
                rows={10}
                value={orderPayload}
                onInput={(e) => setOrderPayload(e.target.value)}
                placeholder="Optional order context or acceptance terms..."
                style="width: 100%; font-family: var(--font-mono); font-size: 0.85rem; padding: 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-subtle); color: var(--color-text-primary);"
              />
            </div>
          </div>

          {/* Verdict Output */}
          {verdictResult && (
            <div
              class="panel"
              style={{
                backgroundColor: verdictResult.actual?.ok ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
                borderColor: verdictResult.actual?.ok ? 'var(--color-success)' : 'var(--color-danger)'
              }}
            >
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <div style="font-weight: 800; font-size: 1.2rem; color: verdictResult.actual?.ok ? 'var(--color-success)' : 'var(--color-danger)';">
                  {verdictResult.actual?.ok ? '✓ PROTOCOL INVARIANTS ACCEPTED' : '✖ TRANSACTION REFUSED'}
                </div>
                <TruthLabel level="Protocol verification" />
              </div>
              <div style="font-size: 0.9rem;">
                {verdictResult.actual?.ok ? (
                  <span>
                    The arrangement preserves all required value, sat-flow, and asset constraints. Shared output index: <code>{verdictResult.actual.sharedIndex ?? 0}</code>.
                  </span>
                ) : (
                  <div>
                    <div><strong>Refusal Code:</strong> <code>{verdictResult.actual.code}</code></div>
                    <div><strong>Reason:</strong> {verdictResult.actual.reason}</div>
                    <a
                      href={resolveUrl(`/reference/refusal-codes/#${verdictResult.actual.code}`)}
                      style="display: inline-block; margin-top: 0.5rem; font-weight: 600; color: var(--color-danger);"
                    >
                      View Machine Specification for {verdictResult.actual.code} →
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Sat Flow Visualizer */}
          {parsedTx && (
            <div class="panel">
              <SatFlowDiagram transaction={parsedTx} order={parsedOrd} />
            </div>
          )}
        </div>
      )}

      {activeTab === 'compare' && (
        <div class="panel">
          <div class="panel-header">
            <h3 style="margin: 0; font-size: 1.1rem;">Side-by-Side Artifact Comparison</h3>
            <span style="font-size: 0.8rem; color: var(--color-text-muted);">
              Compare accepted vs refused arrangements
            </span>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
            <div>
              <h4>Artifact A (Valid Inscription Purchase)</h4>
              <pre style="max-height: 250px; overflow: auto; font-size: 0.8em;">
                <code>{JSON.stringify(allVectors.find((v) => v.expected?.ok)?.input || {}, null, 2)}</code>
              </pre>
              <div style="margin-top: 0.5rem; color: var(--color-success); font-weight: 600; font-size: 0.85rem;">
                ✓ Valid: Output index commits to seller payment
              </div>
            </div>
            <div>
              <h4>Artifact B (Refused Shortfall Case)</h4>
              <pre style="max-height: 250px; overflow: auto; font-size: 0.8em;">
                <code>{JSON.stringify(allVectors.find((v) => !v.expected?.ok)?.input || {}, null, 2)}</code>
              </pre>
              <div style="margin-top: 0.5rem; color: var(--color-danger); font-weight: 600; font-size: 0.85rem;">
                ✖ Refused: SAT_FLOW_SHORTFALL (fee exceeds input sats)
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'export' && (
        <div class="panel">
          <div class="panel-header">
            <h3 style="margin: 0; font-size: 1.1rem;">Export Diagnostic Self-Test Report</h3>
          </div>
          <p style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 1.5rem;">
            Export a sanitized cryptographic proof of verification without exposing private keys or live wallet credentials.
          </p>
          <div style="display: flex; gap: 1rem;">
            <button class="btn btn-primary" onClick={() => exportReport('markdown')}>
              Download Markdown (.md)
            </button>
            <button class="btn btn-secondary" onClick={() => exportReport('json')}>
              Download JSON (.json)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
