import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import allVectors from '../../data/allVectors.json';
import vectorManifest from '../../data/vectorManifest.json';
import { SatFlowDiagram } from './SatFlowDiagram.jsx';
import { TruthLabel } from '../shell/TruthLabel.jsx';
import { FAMILY_REGISTRY, FAMILIES } from '../../lib/conformance-registry.mjs';
import { runVerifierJob } from '../../lib/verifier-client.mjs';
import { detectSecrets, safeJsonParse } from '../../lib/security/sanitizer';
import {
  argsFromCase,
  validateCandidate,
  inputDigest,
  diffPaths,
  buildLabReport,
  labReportMarkdown
} from '../../lib/lab-report.mjs';
import { resolveUrl } from '../../lib/base-url.js';
import { tabKeyHandler, tabProps, tabPanelProps } from '../../lib/a11y/tabs.js';
import { recordToolEvidence } from '../../lib/session/evidence';
import reproducerFile from '../../lib/diagnostics/reproducers.json';
import { reproducerArgs } from '../../lib/diagnostics/reproducer.mjs';

const SOURCE_BUILD = import.meta.env.PUBLIC_ORDEX_BUILD_REVISION || 'unknown';
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const TABS = ['inspect', 'compare', 'export'];
const TAB_LABELS = { inspect: 'Inspect', compare: 'Compare', export: 'Export' };

const variantsOf = (family) => Object.keys(FAMILY_REGISTRY[family].variants);
const examplesFor = (family, variant) => allVectors.filter((v) => v.family === family && v.variant === variant);
const expectationText = (family, expected) => {
  const key = FAMILY_REGISTRY[family].result;
  if (!expected) return 'no expectation';
  return expected[key] ? 'accepted' : `refused${expected.code ? ` (${expected.code})` : ''}`;
};

function download(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// OX-S07: the Lab edits the exact argument shape of each family variant, runs candidates in
// the dedicated verifier Worker without a manufactured expectation, and reports a vector
// comparison separately. Results clear on any edit and reports need a completed run.
export function ProtocolLab() {
  const [activeTab, setActiveTab] = useState('inspect');
  const [family, setFamily] = useState('purchase');
  const [variant, setVariant] = useState(variantsOf('purchase')[0]);
  const [inputText, setInputText] = useState('');
  const [loadedVector, setLoadedVector] = useState(null);
  const [inputError, setInputError] = useState(null);
  const [status, setStatus] = useState('idle');
  const [run, setRun] = useState(null);
  const [slots, setSlots] = useState({ A: null, B: null });
  const [reproNotice, setReproNotice] = useState(null);
  const abortRef = useRef(null);

  const loadVector = (entry) => {
    setReproNotice(null);
    const args = argsFromCase(entry.family, entry.variant, entry.case);
    setFamily(entry.family);
    setVariant(entry.variant);
    setInputText(JSON.stringify(args, null, 2));
    setLoadedVector(entry);
    setInputError(null);
    setRun(null);
    setStatus('idle');
  };

  // OX-S09: /lab/?reproduce=CODE&family=F opens the Failure Navigator's reproducer for that
  // refusal as an edited candidate: the base vector with the reproducer's changes applied.
  const loadReproducer = (code, familyHint) => {
    const list = reproducerFile.reproducers[code] || [];
    const repro = list.find((r) => r.family === familyHint) || list[0];
    const base = repro && allVectors.find((v) => v.id === repro.base);
    if (!repro || !base) return false;
    setFamily(repro.family);
    setVariant(repro.variant);
    setInputText(JSON.stringify(reproducerArgs(repro, base.case), null, 2));
    setLoadedVector(null);
    setInputError(null);
    setRun(null);
    setStatus('idle');
    setReproNotice(`Loaded the reproducer for ${code}: ${base.name}${repro.patch.length ? ` with ${repro.patch.length} change(s)` : ''}. Run the verifier to see the refusal.`);
    return true;
  };

  useEffect(() => {
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const code = params?.get('reproduce');
    const first = allVectors.find((v) => v.family === 'purchase' && v.case?.expected?.ok === true) || allVectors[0];
    const familyParam = params?.get('family');
    if (code && loadReproducer(code, familyParam)) {
      // opened on a reproducer
    } else if (familyParam && FAMILY_REGISTRY[familyParam]) {
      const example = examplesFor(familyParam, variantsOf(familyParam)[0])[0];
      if (example) loadVector(example);
    } else if (first) loadVector(first);
    return () => abortRef.current?.abort();
  }, []);

  const clearRun = () => {
    abortRef.current?.abort();
    setRun(null);
    setStatus('idle');
  };

  const onFamily = (next) => {
    setFamily(next);
    const nextVariant = variantsOf(next)[0];
    setVariant(nextVariant);
    const example = examplesFor(next, nextVariant)[0];
    if (example) loadVector(example);
    else {
      setInputText('{}');
      setLoadedVector(null);
      clearRun();
    }
  };

  const onVariant = (next) => {
    setVariant(next);
    const example = examplesFor(family, next)[0];
    if (example) loadVector(example);
    else {
      setLoadedVector(null);
      clearRun();
    }
  };

  const onEdit = (text) => {
    setReproNotice(null);
    setInputText(text);
    setLoadedVector(null);
    setInputError(null);
    clearRun();
  };

  const handleVerify = async () => {
    setInputError(null);
    const bytes = new TextEncoder().encode(inputText).length;
    if (bytes > MAX_INPUT_BYTES) {
      setInputError(`The input is ${bytes} bytes; the Lab accepts at most ${MAX_INPUT_BYTES} bytes.`);
      return;
    }
    const secrets = detectSecrets(inputText);
    if (secrets.hasHighConfidenceSecrets) {
      setInputError(
        `Private key material detected (${secrets.detectedSecrets.map((s) => s.type).join(', ')}). The Lab never processes keys or seed phrases. Remove them and try again.`
      );
      return;
    }
    let args;
    try {
      args = safeJsonParse(inputText, MAX_INPUT_BYTES);
    } catch (err) {
      setInputError(`The input is not valid JSON: ${err.message}`);
      return;
    }
    const check = validateCandidate(family, variant, args);
    if (!check.ok) {
      setInputError(check.error);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('running');
    setRun(null);
    const vector = loadedVector;
    try {
      const result = await runVerifierJob(
        { type: 'candidate', family, variant, args, ...(vector ? { expected: vector.case.expected } : {}) },
        { signal: controller.signal, timeoutMs: 15000 }
      );
      if (controller.signal.aborted) return;
      const digest = inputDigest(args);
      // OX-S03: the completed run is evidence for a mission stage opened from the workspace.
      recordToolEvidence({
        tool: 'lab',
        operation: `${family}/${variant}`,
        state: result.verdict.state,
        code: result.verdict.code,
        reason: result.verdict.reason,
        evidenceClass: 'Protocol verification',
        inputDigest: digest
      });
      setRun({
        family,
        variant,
        args,
        inputSha256: digest,
        verdict: result.verdict,
        raw: result.raw,
        conformance: result.conformance || null,
        vectorId: vector?.id || null,
        ranAt: new Date().toISOString(),
        durationMs: result.durationMs
      });
      setStatus('done');
    } catch (err) {
      if (err?.code === 'VERIFIER_CANCELLED') return;
      setStatus('error');
      setInputError(`${err?.code || 'VERIFIER_ERROR'}: ${err?.message || err}`);
    }
  };

  const cancelRun = () => {
    abortRef.current?.abort();
    setStatus('idle');
  };

  const exportReport = (format) => {
    if (!run) return;
    const report = buildLabReport({
      run,
      sourceBuild: SOURCE_BUILD,
      vectorDigest: vectorManifest.vectorDigest,
      context: { network: 'Not applicable: local verifier, no gateway or chain access' }
    });
    const stamp = run.ranAt.replace(/[:.]/g, '-');
    if (format === 'json') download(`ordex-lab-report-${stamp}.json`, 'application/json', JSON.stringify(report, null, 2));
    else download(`ordex-lab-report-${stamp}.md`, 'text/markdown', labReportMarkdown(report));
  };

  const verdict = run?.verdict;
  const verdictColor = verdict?.state === 'accepted' ? 'var(--color-success)' : verdict?.state === 'refused' ? 'var(--color-danger)' : 'var(--color-text-secondary)';
  const tx = run && run.family === 'purchase' ? run.args.transaction : null;
  const showSatFlow = tx && Array.isArray(tx.inputs) && Array.isArray(tx.outputs) && tx.inputs.length > 0 && tx.outputs.length > 0;
  const onTabKey = tabKeyHandler(TABS, activeTab, setActiveTab, 'lab');
  const examples = examplesFor(family, variant);
  const variantSpec = FAMILY_REGISTRY[family].variants[variant];

  return (
    <div class="protocol-lab-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="panel" style="padding: 1.25rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 0.5rem;">
          <div>
            <h2 style="margin: 0; font-size: 1.35rem;">Protocol Lab</h2>
            <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
              Run the reference verifiers on your own input. Every family and variant takes its real argument shape.
            </p>
          </div>
          <div role="tablist" aria-label="Lab mode" style="display: flex; gap: 0.5rem;">
            {TABS.map((t) => (
              <button
                key={t}
                {...tabProps('lab', t, activeTab, setActiveTab, onTabKey)}
                class={`btn ${activeTab === t ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.85rem;"
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style="background: var(--color-bg-subtle); border-left: 4px solid var(--color-focus); padding: 0.6rem 1rem; border-radius: var(--radius-md); font-size: 0.8rem; color: var(--color-text-secondary);">
        <strong>How this runs:</strong> verifiers execute in a dedicated Web Worker in this tab. Nothing is signed or broadcast and no gateway is contacted.
      </div>

      {activeTab === 'inspect' && (
        <div {...tabPanelProps('lab', 'inspect')} style="display: flex; flex-direction: column; gap: 1.5rem;">
          <div class="panel">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; margin-bottom: 0.75rem;">
              <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; font-weight: 700;">
                Verifier family
                <select class="btn btn-outline" value={family} onChange={(e) => onFamily(e.currentTarget.value)} style="font-size: 0.85rem;">
                  {FAMILIES.map((f) => (
                    <option key={f} value={f}>{FAMILY_REGISTRY[f].label}</option>
                  ))}
                </select>
              </label>
              <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; font-weight: 700;">
                Variant
                <select class="btn btn-outline" value={variant} onChange={(e) => onVariant(e.currentTarget.value)} style="font-size: 0.85rem;">
                  {variantsOf(family).map((v) => (
                    <option key={v} value={v}>{FAMILY_REGISTRY[family].variants[v].label}</option>
                  ))}
                </select>
              </label>
              <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; font-weight: 700;">
                Load a conformance vector
                <select
                  class="btn btn-outline"
                  value={loadedVector?.id || ''}
                  onChange={(e) => {
                    const entry = allVectors.find((v) => v.id === e.currentTarget.value);
                    if (entry) loadVector(entry);
                  }}
                  style="font-size: 0.85rem;"
                >
                  <option value="">{loadedVector ? 'Choose a vector' : 'Edited input (no vector)'}</option>
                  {examples.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title} (expects {expectationText(v.family, v.case.expected)})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {reproNotice && (
              <p role="status" style="margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--color-text-secondary);">
                {reproNotice}
              </p>
            )}
            <label for="lab-input" style="display: block; font-size: 0.8rem; font-weight: 700; margin-bottom: 0.25rem;">
              Input JSON. Required: {variantSpec.args.map((a) => <code key={a} style="margin-right: 0.35rem;">{a}</code>)}
              {variantSpec.optional?.length ? <span> Optional: {variantSpec.optional.map((a) => <code key={a}>{a}</code>)}</span> : null}
            </label>
            <textarea
              id="lab-input"
              rows={14}
              value={inputText}
              spellcheck={false}
              aria-describedby={inputError ? 'lab-input-error' : undefined}
              aria-invalid={inputError ? 'true' : 'false'}
              onInput={(e) => onEdit(e.currentTarget.value)}
              style="width: 100%; font-family: var(--font-mono); font-size: 0.85rem; padding: 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-subtle); color: var(--color-text-primary);"
            />
            {inputError && (
              <div id="lab-input-error" role="alert" style="margin-top: 0.5rem; background: var(--color-danger-bg); border-left: 4px solid var(--color-danger); padding: 0.6rem 1rem; border-radius: var(--radius-md); color: var(--color-danger); font-size: 0.85rem;">
                {inputError}
              </div>
            )}
            <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap;">
              <button class="btn btn-primary" type="button" onClick={handleVerify} disabled={status === 'running'}>
                {status === 'running' ? 'Running...' : 'Run reference verifier'}
              </button>
              {status === 'running' && (
                <button class="btn btn-outline" type="button" onClick={cancelRun}>Cancel</button>
              )}
              <button class="btn btn-outline" type="button" disabled={!run} onClick={() => run && setSlots((s) => ({ ...s, A: run }))}>Pin as A</button>
              <button class="btn btn-outline" type="button" disabled={!run} onClick={() => run && setSlots((s) => ({ ...s, B: run }))}>Pin as B</button>
            </div>
          </div>

          <div aria-live="polite">
            {run && (
              <div class="panel" style={{ borderColor: verdictColor }}>
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem;">
                  <div style={{ fontWeight: 800, fontSize: '1.2rem', color: verdictColor }}>
                    {verdict.state === 'accepted' ? 'Accepted by the reference verifier' : verdict.state === 'refused' ? 'Refused by the reference verifier' : 'No verdict'}
                  </div>
                  <TruthLabel level="Protocol verification" />
                </div>
                <dl style="display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; font-size: 0.85rem; margin: 0;">
                  <dt>Family / variant</dt><dd style="margin: 0;"><code>{run.family}</code> / <code>{run.variant}</code></dd>
                  {verdict.code && (<><dt>Refusal code</dt><dd style="margin: 0;"><a href={resolveUrl(`/reference/refusal-codes/#${verdict.code}`)}><code>{verdict.code}</code></a></dd></>)}
                  {verdict.reason && (<><dt>Reason</dt><dd style="margin: 0;">{verdict.reason}</dd></>)}
                  <dt>Input SHA-256</dt><dd style="margin: 0; word-break: break-all;"><code>{run.inputSha256}</code></dd>
                  {run.conformance && (
                    <>
                      <dt>Vector check</dt>
                      <dd style="margin: 0;">
                        {run.conformance.passed
                          ? `Matches the expected verdict of ${run.vectorId}.`
                          : `Differs from ${run.vectorId}: ${run.conformance.mismatches.map((m) => m.field).join(', ')}.`}
                      </dd>
                    </>
                  )}
                </dl>
                <details style="margin-top: 0.75rem;">
                  <summary style="cursor: pointer; font-size: 0.85rem;">Raw verifier output</summary>
                  <pre style="max-height: 260px; overflow: auto; font-size: 0.8em;"><code>{JSON.stringify(run.raw, null, 2)}</code></pre>
                </details>
                <p style="margin: 0.75rem 0 0 0; font-size: 0.8rem; color: var(--color-text-muted);">
                  A local verifier verdict. It is not a signed transaction, a broadcast or chain confirmation.
                </p>
              </div>
            )}
          </div>

          {showSatFlow && (
            <div class="panel">
              <SatFlowDiagram transaction={tx} order={run.args.order} sharedIndex={run.raw?.sharedIndex} />
            </div>
          )}
        </div>
      )}

      {activeTab === 'compare' && (
        <div {...tabPanelProps('lab', 'compare')} class="panel">
          <div class="panel-header">
            <h3 style="margin: 0; font-size: 1.1rem;">Compare two runs</h3>
            <span style="font-size: 0.8rem; color: var(--color-text-muted);">Pin completed runs as A and B from the Inspect tab.</span>
          </div>
          {!slots.A || !slots.B ? (
            <p style="font-size: 0.9rem; color: var(--color-text-secondary);">
              {slots.A ? 'Run B is empty.' : slots.B ? 'Run A is empty.' : 'No runs pinned yet.'} Run the verifier, then choose Pin as A or Pin as B.
            </p>
          ) : (
            <div>
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5rem;">
                {['A', 'B'].map((k) => (
                  <div key={k}>
                    <h4 style="margin: 0 0 0.35rem 0;">Run {k}: {slots[k].family} / {slots[k].variant}</h4>
                    <div style="font-size: 0.85rem;">Verdict: <strong>{slots[k].verdict.state}</strong>{slots[k].verdict.code ? ` (${slots[k].verdict.code})` : ''}</div>
                    <div style="font-size: 0.75rem; word-break: break-all; color: var(--color-text-muted);">Input SHA-256 {slots[k].inputSha256}</div>
                  </div>
                ))}
              </div>
              <h4 style="margin: 1rem 0 0.35rem 0;">Input differences</h4>
              {(() => {
                const diffs = diffPaths(slots.A.args, slots.B.args);
                if (!diffs.length) return <p style="font-size: 0.85rem;">The inputs are identical.</p>;
                return (
                  <ul style="font-size: 0.85rem; font-family: var(--font-mono);">
                    {diffs.map((d) => <li key={d.path}>{d.change}: {d.path}</li>)}
                  </ul>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {activeTab === 'export' && (
        <div {...tabPanelProps('lab', 'export')} class="panel">
          <div class="panel-header">
            <h3 style="margin: 0; font-size: 1.1rem;">Export the last run</h3>
          </div>
          <p style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 1.5rem;">
            The report holds the family, variant, a SHA-256 digest of your input, the source build and the verdict. It never includes the input itself.
          </p>
          {!run && <p role="status" style="font-size: 0.85rem;">Run the verifier first. Reports are only available for a completed run of the current input.</p>}
          <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
            <button class="btn btn-primary" type="button" disabled={!run} onClick={() => exportReport('markdown')}>
              Download Markdown (.md)
            </button>
            <button class="btn btn-secondary" type="button" disabled={!run} onClick={() => exportReport('json')}>
              Download JSON (.json)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
