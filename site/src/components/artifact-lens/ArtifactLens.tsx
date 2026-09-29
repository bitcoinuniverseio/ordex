import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { parseArtifact, type ParsedArtifactResult, type ByteRange } from '../../lib/artifacts/parser.js';
import { compareParsedArtifacts, deriveFee, purchaseCandidateFrom, type ComparisonReport } from '../../lib/artifacts/comparison.js';
import { MUTATION_FIXTURES } from '../../lib/artifacts/mutation-fixtures.js';
import { UPDATED_WITH_SIGHASH } from '../../lib/artifacts/bip-fixtures.js';
import { contextEngine } from '../../lib/experience/context-engine.js';
import { runVerifierJob } from '../../lib/verifier-client.mjs';
import { safeJsonParse, sanitizeForExport } from '../../lib/security/sanitizer';
import { tabKeyHandler, tabProps, tabPanelProps } from '../../lib/a11y/tabs.js';
import { IconAlertTriangle, IconShieldCheck } from '../experience/OrdexIcons.js';

// OX-S01: Artifact Lens decodes through the strict shared parser (PSBT v0/v2 and raw
// transactions), shows malformed and unsupported input as such, compares A and B field by
// field with real SHA-256 digests, and checks purchase invariants only with an order and
// prevout amounts present. It never tells the user a changed artifact is safe.
const SAMPLE_PSBT_HEX = UPDATED_WITH_SIGHASH;

const TABS = ['summary', 'io', 'structure', 'bytes', 'compare'] as const;
type TabId = (typeof TABS)[number];
const TAB_LABELS: Record<TabId, string> = {
  summary: 'Summary',
  io: 'Inputs & Outputs',
  structure: 'Structure',
  bytes: 'Bytes',
  compare: 'Compare'
};

const VERDICT_TEXT: Record<ComparisonReport['overallVerdict'], string> = {
  IDENTICAL: 'Byte-identical: nothing changed between A and B',
  EXPECTED_SIGNER_ADDITIONS: 'Only signatures or final scripts were added',
  REVIEW_REQUIRED: 'Review required before relying on B',
  DANGEROUS: 'Dangerous change: do not sign or broadcast B',
  UNKNOWN: 'Unknown: the comparison could not be completed'
};

interface LensProps {
  initialPayload?: string;
  basePath?: string;
}

const panel = {
  borderRadius: 'var(--ox-radius-lg)',
  backgroundColor: 'var(--ox-surface-panel)',
  border: '1px solid var(--ox-border-default)'
};
const tile = { padding: '0.75rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-subtle)' };
const tileLabel = { fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)', textTransform: 'uppercase' as const };
const tileValue = { fontSize: '1rem', fontWeight: 700, color: 'var(--ox-text-primary)', marginTop: '0.2rem', wordBreak: 'break-all' as const };
const mono = { fontFamily: 'var(--ox-font-mono)', fontSize: '0.75rem', wordBreak: 'break-all' as const };
const textareaStyle = {
  flex: 1,
  width: '100%',
  fontFamily: 'var(--ox-font-mono)',
  fontSize: '0.75rem',
  padding: '0.5rem',
  borderRadius: 'var(--ox-radius-sm)',
  border: '1px solid var(--ox-border-default)',
  backgroundColor: 'var(--ox-surface-subtle)',
  color: 'var(--ox-text-primary)'
};
const buttonStyle = {
  padding: '0.45rem 1rem',
  backgroundColor: 'var(--ox-bitcoin-orange)',
  color: 'var(--ox-text-on-accent, #1a1a1a)',
  fontWeight: 700,
  fontSize: '0.8125rem',
  border: 'none',
  borderRadius: 'var(--ox-radius-md)',
  cursor: 'pointer'
};
const secondaryButton = {
  padding: '0.4rem 0.75rem',
  borderRadius: 'var(--ox-radius-sm)',
  backgroundColor: 'var(--ox-surface-subtle)',
  border: '1px solid var(--ox-border-default)',
  color: 'var(--ox-text-primary)',
  fontSize: '0.75rem',
  fontWeight: 600,
  cursor: 'pointer'
};

function sighashName(t: number | null): string {
  if (t === null) return 'not set';
  const base = t & 0x1f;
  const names: Record<number, string> = { 0: 'DEFAULT', 1: 'ALL', 2: 'NONE', 3: 'SINGLE' };
  return `${names[base] || `0x${base.toString(16)}`}${t & 0x80 ? '|ANYONECANPAY' : ''} (0x${t.toString(16)})`;
}

function StatusBanner({ parsed }: { parsed: ParsedArtifactResult }): JSX.Element {
  if (parsed.status === 'decoded') {
    return (
      <div role="status" style={{ padding: '0.6rem 0.75rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-status-success-bg)', color: 'var(--ox-status-success-text)', fontSize: '0.8125rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <IconShieldCheck size={16} />
        <span>
          Decoded as {parsed.format}. Structure only: this does not check prices, ownership or signatures.
        </span>
      </div>
    );
  }
  return (
    <div role="alert" style={{ padding: '0.6rem 0.75rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-status-refusal-bg)', color: 'var(--ox-status-refusal-text)', fontSize: '0.8125rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <IconAlertTriangle size={16} />
      <span>
        {parsed.status === 'unsupported' ? 'Unsupported' : 'Malformed'}: {parsed.errors[0] || 'the artifact could not be decoded.'}
      </span>
    </div>
  );
}

export function ArtifactLens({ initialPayload = SAMPLE_PSBT_HEX }: LensProps): JSX.Element {
  const [rawInput, setRawInput] = useState(initialPayload);
  const [parsed, setParsed] = useState<ParsedArtifactResult | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('summary');
  const [selectedRange, setSelectedRange] = useState<ByteRange | null>(null);
  const [payloadB, setPayloadB] = useState('');
  const [parsedB, setParsedB] = useState<ParsedArtifactResult | null>(null);
  const [comparisonReport, setComparisonReport] = useState<ComparisonReport | null>(null);
  const [orderText, setOrderText] = useState('');
  const [invariant, setInvariant] = useState<{ state: string; code?: string | null; reason?: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const clearDerived = () => {
    setSelectedRange(null);
    setComparisonReport(null);
    setParsedB(null);
    setInvariant(null);
    setNotice(null);
  };

  const executeParse = (input: string) => {
    clearDerived();
    const res = parseArtifact(input);
    setParsed(res);
    if (res.status === 'decoded') {
      contextEngine.setContext({
        title: `Artifact Lens: ${res.format}`,
        heading: `${res.totalByteLength} bytes, ${res.inputsCount} in / ${res.outputsCount} out`,
        evidenceClass: 'Deterministic example'
      });
    }
  };

  useEffect(() => {
    executeParse(rawInput);
  }, []);

  const runCompare = (a: ParsedArtifactResult | null, bText: string) => {
    setInvariant(null);
    if (!a) return;
    const b = parseArtifact(bText);
    setParsedB(b);
    setComparisonReport(compareParsedArtifacts(a, b));
  };

  const loadFixture = (id: string) => {
    const fixture = MUTATION_FIXTURES.find((f) => f.id === id);
    if (!fixture) return;
    setRawInput(fixture.rawFixtureHexA);
    const a = parseArtifact(fixture.rawFixtureHexA);
    clearDerived();
    setParsed(a);
    setPayloadB(fixture.rawFixtureHexB);
    runCompare(a, fixture.rawFixtureHexB);
    setActiveTab('compare');
  };

  const checkPurchase = async () => {
    setInvariant(null);
    const target = parsedB?.status === 'decoded' ? parsedB : parsed;
    if (!target || target.status !== 'decoded') return;
    let order: unknown;
    try {
      order = safeJsonParse(orderText, 64 * 1024);
    } catch (err) {
      setInvariant({ state: 'unknown', reason: `The order is not valid JSON: ${(err as Error).message}` });
      return;
    }
    const candidate = purchaseCandidateFrom(target);
    if (!candidate) {
      setInvariant({ state: 'inconclusive', reason: 'Prevout amounts are missing for at least one input, so sat flow cannot be evaluated. Add witness or non-witness UTXO data.' });
      return;
    }
    try {
      const result = await runVerifierJob({ type: 'candidate', family: 'purchase', variant: 'completion', args: { transaction: candidate.transaction, order } });
      setInvariant(result.verdict);
    } catch (err) {
      setInvariant({ state: 'unknown', code: (err as { code?: string }).code, reason: (err as Error).message });
    }
  };

  const exportReport = () => {
    if (!comparisonReport) return;
    const report = {
      schema: 'ordex.artifact-comparison/v1',
      artifactA: { sha256: comparisonReport.artifactASha256, format: parsed?.format, bytes: parsed?.totalByteLength },
      artifactB: { sha256: comparisonReport.artifactBSha256, format: parsedB?.format, bytes: parsedB?.totalByteLength },
      overallVerdict: comparisonReport.overallVerdict,
      conclusive: comparisonReport.conclusive,
      feeSats: comparisonReport.feeSats,
      differences: comparisonReport.differences,
      purchaseInvariant: invariant,
      generatedAt: new Date().toISOString()
    };
    const sanitized = sanitizeForExport(report);
    if (sanitized.blocked) {
      setNotice(sanitized.blockReason || 'Export blocked.');
      return;
    }
    const blob = new Blob([JSON.stringify(sanitized.sanitized, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ordex-artifact-comparison-${comparisonReport.artifactBSha256.slice(0, 12)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice('The report holds digests and differences only, never the artifact bytes.');
  };

  const onTabKey = tabKeyHandler([...TABS], activeTab, (id) => setActiveTab(id as TabId), 'lens');
  const fee = parsed && parsed.status === 'decoded' ? deriveFee(parsed) : null;

  return (
    <div style={{ maxWidth: '1140px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ ...panel, padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)' }}>
          Artifact Lens: read-only decoder
        </div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>Inspect PSBTs and transactions</h1>
        <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.4 }}>
          Decodes PSBT version 0 and 2 (BIP174, BIP370) and raw transactions, up to 2 MiB, in this tab. Nothing is signed or sent.
        </p>
        <label htmlFor="ox-artifact-input" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-muted)' }}>
          Artifact A: PSBT (hex or Base64) or raw transaction hex
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <textarea
            id="ox-artifact-input"
            value={rawInput}
            spellcheck={false}
            onInput={(e) => {
              setRawInput((e.target as HTMLTextAreaElement).value);
              clearDerived();
            }}
            rows={3}
            style={textareaStyle}
          />
          <button type="button" onClick={() => executeParse(rawInput)} style={buttonStyle}>
            Decode
          </button>
        </div>
        {parsed && <StatusBanner parsed={parsed} />}
      </div>

      {parsed && (
        <div style={{ ...panel, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div role="tablist" aria-label="Artifact views" style={{ display: 'flex', flexWrap: 'wrap', borderBottom: '1px solid var(--ox-border-subtle)', backgroundColor: 'var(--ox-surface-subtle)', fontSize: '0.8125rem', fontWeight: 600 }}>
            {TABS.map((id) => (
              <button
                key={id}
                {...tabProps('lens', id, activeTab, (t: string) => setActiveTab(t as TabId), onTabKey)}
                style={{
                  padding: '0.75rem 1rem',
                  border: 'none',
                  background: activeTab === id ? 'var(--ox-surface-panel)' : 'transparent',
                  color: activeTab === id ? 'var(--ox-text-primary)' : 'var(--ox-text-secondary)',
                  cursor: 'pointer',
                  borderBottom: activeTab === id ? '2px solid var(--ox-bitcoin-orange)' : '2px solid transparent'
                }}
              >
                {TAB_LABELS[id]}
              </button>
            ))}
          </div>

          {activeTab === 'summary' && (
            <div {...tabPanelProps('lens', 'summary')} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                <div style={tile}><div style={tileLabel}>Status</div><div style={tileValue}>{parsed.status}</div></div>
                <div style={tile}><div style={tileLabel}>Format</div><div style={tileValue}>{parsed.format}</div></div>
                <div style={tile}><div style={tileLabel}>Size</div><div style={tileValue}>{parsed.totalByteLength} bytes</div></div>
                <div style={tile}><div style={tileLabel}>Inputs / outputs</div><div style={tileValue}>{parsed.status === 'decoded' ? `${parsed.inputsCount} in / ${parsed.outputsCount} out` : 'not decoded'}</div></div>
                {parsed.status === 'decoded' && (
                  <>
                    <div style={tile}><div style={tileLabel}>Transaction version</div><div style={tileValue}>{parsed.version}</div></div>
                    <div style={tile}><div style={tileLabel}>Locktime</div><div style={tileValue}>{parsed.locktime === null ? 'Cannot be determined (BIP370)' : parsed.locktime}</div></div>
                    <div style={tile}>
                      <div style={tileLabel}>Fee</div>
                      <div style={tileValue}>{fee?.fee !== null && fee?.fee !== undefined ? `${fee.fee} sats` : 'Not derivable'}</div>
                      {fee?.reason && <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>{fee.reason}</div>}
                    </div>
                  </>
                )}
              </div>
              <div style={tile}>
                <div style={tileLabel}>SHA-256 of the original bytes</div>
                <div style={mono}>{parsed.sha256}</div>
                {parsed.transaction && (
                  <div style={{ ...mono, marginTop: '0.35rem' }}>
                    {parsed.format === 'RAW_BITCOIN_TX' ? 'txid' : 'Unsigned txid'}: {parsed.transaction.txid}
                  </div>
                )}
              </div>
              {parsed.errors.length > 0 && (
                <ul style={{ margin: 0, color: 'var(--ox-status-refusal-text)', fontSize: '0.8125rem' }}>
                  {parsed.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              {parsed.hasUnknownFields && (
                <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>Unknown or proprietary fields are present and kept byte for byte.</div>
              )}
            </div>
          )}

          {activeTab === 'io' && (
            <div {...tabPanelProps('lens', 'io')} style={{ padding: '1.25rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1rem', fontSize: '0.8125rem' }}>
              {parsed.status !== 'decoded' ? (
                <div>Inputs and outputs are shown only for a decoded artifact.</div>
              ) : (
                <>
                  <div>
                    <h3 style={{ fontSize: '0.9375rem', margin: '0 0 0.5rem 0' }}>Inputs ({parsed.inputs.length})</h3>
                    {parsed.inputs.map((i) => (
                      <div key={i.index} style={{ ...tile, marginBottom: '0.5rem' }}>
                        <div style={{ fontWeight: 700 }}>Input {i.index}</div>
                        <div style={mono}>{i.txid}:{i.vout}</div>
                        <div>Sequence: 0x{(i.sequence ?? 0).toString(16)}</div>
                        <div>Sighash: {sighashName(i.sighashType)}</div>
                        <div>Prevout: {i.prevoutValueSats !== null ? `${i.prevoutValueSats} sats (${i.prevoutSource})` : 'amount not carried'}</div>
                        {i.prevoutScriptHex && <div style={mono}>Script: {i.prevoutScriptHex}</div>}
                        <div>
                          Signatures: {i.partialSignaturePubkeys.length} partial{i.hasTaprootKeySignature ? ', Taproot key path' : ''}
                          {i.hasFinalScriptSig || i.hasFinalScriptWitness ? ', finalized' : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h3 style={{ fontSize: '0.9375rem', margin: '0 0 0.5rem 0' }}>Outputs ({parsed.outputs.length})</h3>
                    {parsed.outputs.map((o) => (
                      <div key={o.index} style={{ ...tile, marginBottom: '0.5rem' }}>
                        <div style={{ fontWeight: 700 }}>Output {o.index}: {o.valueSats} sats</div>
                        <div style={mono}>Script: {o.scriptHex}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'structure' && (
            <div {...tabPanelProps('lens', 'structure')} style={{ padding: '1.25rem', fontSize: '0.8125rem', overflowY: 'auto', maxHeight: '480px' }}>
              {[parsed.globalMap, ...parsed.inputMaps, ...parsed.outputMaps].map((m) => (
                <div key={`${m.mapType}-${m.index ?? 'g'}`} style={{ marginBottom: '1rem' }}>
                  <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, margin: '0 0 0.35rem 0' }}>
                    {m.mapType === 'global' ? 'Global map' : `${m.mapType === 'input' ? 'Input' : 'Output'} map ${m.index}`} ({m.entries.length} entries)
                  </h3>
                  {m.entries.map((e) => (
                    <div key={e.keyHex} style={{ ...tile, padding: '0.4rem 0.6rem', marginBottom: '0.25rem', display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span>
                        <strong>{e.label}</strong> <span style={mono}>key {e.keyHex.length > 20 ? `${e.keyHex.slice(0, 20)}...` : e.keyHex}</span>
                        {e.isUnknown && <span style={{ marginLeft: '0.35rem', color: 'var(--ox-status-warning-text)' }}>(kept as raw bytes)</span>}
                      </span>
                      <span style={mono}>offset {e.keyOffset}, {e.totalLength} bytes</span>
                    </div>
                  ))}
                </div>
              ))}
              {parsed.format === 'RAW_BITCOIN_TX' && <div>A raw transaction has no PSBT maps. See Inputs & Outputs.</div>}
            </div>
          )}

          {activeTab === 'bytes' && (
            <div {...tabPanelProps('lens', 'bytes')} style={{ display: 'flex', flexWrap: 'wrap', minHeight: '320px' }}>
              <div style={{ flex: '1 1 320px', padding: '1rem', ...mono, overflowY: 'auto', maxHeight: '450px', backgroundColor: 'var(--ox-surface-inset)', color: 'var(--ox-text-primary)', lineHeight: 1.6 }}>
                <div style={{ color: 'var(--ox-text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>Select a byte range to inspect its field:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                  {parsed.byteRanges.map((range, i) => {
                    const isSelected = selectedRange === range;
                    const bytesHex = parsed.rawHex.substring(range.startOffset * 2, range.endOffset * 2);
                    return (
                      <button
                        key={i}
                        type="button"
                        aria-pressed={isSelected ? 'true' : 'false'}
                        aria-label={`Offset ${range.startOffset} to ${range.endOffset}: ${range.label}`}
                        onClick={() => setSelectedRange(range)}
                        style={{
                          ...mono,
                          padding: '0.1rem 0.25rem',
                          borderRadius: '2px',
                          backgroundColor: isSelected ? 'var(--ox-bitcoin-orange)' : 'transparent',
                          color: isSelected ? 'var(--ox-text-on-accent, #1a1a1a)' : 'inherit',
                          cursor: 'pointer',
                          border: '1px solid var(--ox-border-subtle)'
                        }}
                      >
                        {bytesHex.length > 64 ? `${bytesHex.slice(0, 64)}...` : bytesHex}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ flex: '0 1 280px', borderLeft: '1px solid var(--ox-border-subtle)', padding: '1rem', fontSize: '0.8125rem' }} aria-live="polite">
                <div style={{ ...tileLabel, marginBottom: '0.25rem' }}>Field inspector</div>
                {selectedRange ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <strong>{selectedRange.label}</strong>
                    <div>Bytes {selectedRange.startOffset} to {selectedRange.endOffset} ({selectedRange.endOffset - selectedRange.startOffset} bytes)</div>
                    {selectedRange.fieldKey && <div style={mono}>Key {selectedRange.fieldKey}</div>}
                  </div>
                ) : (
                  <div style={{ color: 'var(--ox-text-secondary)' }}>No range selected.</div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'compare' && (
            <div {...tabPanelProps('lens', 'compare')} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.25rem 0' }}>Compare A with B</h3>
                <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>
                  Paste the artifact a wallet or signer returned, or load a BIP174-based mutation example.
                </div>
              </div>
              <label htmlFor="ox-artifact-b" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-muted)' }}>Artifact B</label>
              <textarea
                id="ox-artifact-b"
                rows={3}
                value={payloadB}
                spellcheck={false}
                onInput={(e) => {
                  setPayloadB((e.target as HTMLTextAreaElement).value);
                  setComparisonReport(null);
                  setParsedB(null);
                  setInvariant(null);
                }}
                style={textareaStyle}
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" style={buttonStyle} disabled={!payloadB.trim() || parsed.status !== 'decoded'} onClick={() => runCompare(parsed, payloadB)}>
                  Compare
                </button>
                {MUTATION_FIXTURES.map((f) => (
                  <button key={f.id} type="button" style={secondaryButton} onClick={() => loadFixture(f.id)}>
                    Example: {f.name}
                  </button>
                ))}
              </div>

              <div aria-live="polite">
                {comparisonReport && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div
                      style={{
                        padding: '0.75rem 1rem',
                        borderRadius: 'var(--ox-radius-md)',
                        backgroundColor: comparisonReport.overallVerdict === 'DANGEROUS' || comparisonReport.overallVerdict === 'UNKNOWN' ? 'var(--ox-status-refusal-bg)' : 'var(--ox-surface-subtle)',
                        color: comparisonReport.overallVerdict === 'DANGEROUS' || comparisonReport.overallVerdict === 'UNKNOWN' ? 'var(--ox-status-refusal-text)' : 'var(--ox-text-primary)',
                        fontWeight: 700,
                        fontSize: '0.875rem'
                      }}
                    >
                      {VERDICT_TEXT[comparisonReport.overallVerdict]}
                    </div>
                    <div style={{ ...mono, color: 'var(--ox-text-secondary)' }}>
                      <div>A SHA-256 {comparisonReport.artifactASha256}</div>
                      <div>B SHA-256 {comparisonReport.artifactBSha256}</div>
                      <div>Fee: {comparisonReport.feeSats.before ?? 'n/a'} to {comparisonReport.feeSats.after ?? 'n/a'} sats{comparisonReport.feeSats.reason ? ` (${comparisonReport.feeSats.reason})` : ''}</div>
                    </div>
                    {comparisonReport.differences.map((diff) => (
                      <div
                        key={diff.id}
                        style={{ ...tile, borderLeft: diff.severity === 'Dangerous' ? '3px solid var(--ox-status-refusal-text)' : '3px solid var(--ox-border-strong)', fontSize: '0.8125rem' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <strong>{diff.field}</strong>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{diff.severity}</span>
                        </div>
                        <div style={{ ...mono, marginTop: '0.25rem' }}>{diff.beforeValue} to {diff.afterValue}</div>
                        <div style={{ color: 'var(--ox-text-secondary)', marginTop: '0.25rem' }}>{diff.whyItMatters}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)', marginTop: '0.25rem' }}>Next: {diff.nextAction}</div>
                      </div>
                    ))}
                    <button type="button" style={secondaryButton} onClick={exportReport}>
                      Download comparison report (JSON)
                    </button>
                  </div>
                )}
              </div>

              <div style={{ borderTop: '1px solid var(--ox-border-subtle)', paddingTop: '1rem' }}>
                <label htmlFor="ox-order-json" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-muted)' }}>
                  Optional: public ask order terms (JSON) to check purchase invariants on {parsedB?.status === 'decoded' ? 'artifact B' : 'artifact A'}
                </label>
                <textarea
                  id="ox-order-json"
                  rows={4}
                  value={orderText}
                  spellcheck={false}
                  placeholder='{"offeredOutpoint":{"txid":"...","vout":0},"sellerPaymentScriptHex":"...","sellerPaymentValueSats":"..."}'
                  onInput={(e) => {
                    setOrderText((e.target as HTMLTextAreaElement).value);
                    setInvariant(null);
                  }}
                  style={textareaStyle}
                />
                <button type="button" style={{ ...secondaryButton, marginTop: '0.5rem' }} disabled={!orderText.trim() || parsed.status !== 'decoded'} onClick={checkPurchase}>
                  Check purchase invariants
                </button>
                <div aria-live="polite" style={{ fontSize: '0.8125rem', marginTop: '0.5rem' }}>
                  {invariant && (
                    <div>
                      Purchase verifier: <strong>{invariant.state}</strong>
                      {invariant.code ? ` (${invariant.code})` : ''}
                      {invariant.reason ? `. ${invariant.reason}` : ''}
                    </div>
                  )}
                </div>
              </div>
              {notice && <div role="status" style={{ fontSize: '0.8125rem' }}>{notice}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
