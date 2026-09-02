import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { parsePsbtBytes, payloadToBytes, type ParsedArtifactResult, type ByteRange } from '../../lib/artifacts/parser.js';
import { compareParsedArtifacts, MUTATION_FIXTURES, type ComparisonReport } from '../../lib/artifacts/comparison.js';
import { contextEngine } from '../../lib/experience/context-engine.js';
import {
  IconInspect,
  IconCopy,
  IconShieldCheck,
  IconAlertTriangle,
  IconExternalLink
} from '../experience/OrdexIcons.js';

const SAMPLE_PSBT_HEX = '70736274ff010052020000000000';

interface LensProps {
  initialPayload?: string;
  basePath?: string;
}

export function ArtifactLens({
  initialPayload = SAMPLE_PSBT_HEX,
  basePath = '/ordex'
}: LensProps): JSX.Element {
  const [rawInput, setRawInput] = useState(initialPayload);
  const [parsed, setParsed] = useState<ParsedArtifactResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'summary' | 'structure' | 'bytes' | 'io' | 'compare'>('summary');
  const [selectedRange, setSelectedRange] = useState<ByteRange | null>(null);

  // Compare mode state
  const [comparePayloadB, setComparePayloadB] = useState<string>('70736274ff010052020000000000');
  const [comparisonReport, setComparisonReport] = useState<ComparisonReport | null>(null);

  const executeParse = (input: string) => {
    try {
      const bytes = payloadToBytes(input);
      const res = parsePsbtBytes(bytes);
      setParsed(res);
      setParseError(null);

      contextEngine.setContext({
        title: `Artifact Lens: ${res.format}`,
        heading: `${res.totalByteLength} bytes, ${res.inputsCount} in / ${res.outputsCount} out`,
        evidenceClass: 'Protocol verification'
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown parsing error';
      setParseError(msg);
      setParsed(null);
    }
  };

  useEffect(() => {
    executeParse(rawInput);
  }, []);

  const handleRunCompare = (hexB: string) => {
    if (!parsed) return;
    try {
      const bytesB = payloadToBytes(hexB);
      const parsedB = parsePsbtBytes(bytesB);
      const rep = compareParsedArtifacts(parsed, parsedB);
      setComparisonReport(rep);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error comparing artifacts';
      setParseError(msg);
    }
  };

  const handleLoadMutationFixture = (fixtureId: string) => {
    const fixture = MUTATION_FIXTURES.find((f) => f.id === fixtureId);
    if (fixture) {
      setRawInput(fixture.rawFixtureHexA);
      executeParse(fixture.rawFixtureHexA);
      setComparePayloadB(fixture.rawFixtureHexB);
      const bytesB = payloadToBytes(fixture.rawFixtureHexB);
      const parsedB = parsePsbtBytes(bytesB);
      const bytesA = payloadToBytes(fixture.rawFixtureHexA);
      const parsedA = parsePsbtBytes(bytesA);
      setComparisonReport(compareParsedArtifacts(parsedA, parsedB));
      setActiveTab('compare');
    }
  };

  return (
    <div style={{ maxWidth: '1140px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header Banner */}
      <div
        style={{
          padding: '1.5rem',
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-bitcoin-orange)' }}>
            Artifact Lens
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>•</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>Read-Only Binary & Semantic Inspector</span>
        </div>

        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>
          Inspect Bitcoin PSBT & Transaction Artifacts
        </h1>

        <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.4 }}>
          Bounded 2 MiB strict parser. Preserves proprietary fields byte-for-byte. Detects overlong compact-sizes,
          output reordering, and dangerous signer mutations with zero private key touch.
        </p>

        {/* Input Textarea Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
          <label htmlFor="ox-artifact-input" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-muted)' }}>
            Raw PSBT (Hex or Base64) / Transaction Payload
          </label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <textarea
              id="ox-artifact-input"
              value={rawInput}
              onInput={(e) => setRawInput((e.target as HTMLTextAreaElement).value)}
              rows={2}
              style={{
                flex: 1,
                fontFamily: 'var(--ox-font-mono)',
                fontSize: '0.75rem',
                padding: '0.5rem',
                borderRadius: 'var(--ox-radius-sm)',
                border: '1px solid var(--ox-border-default)',
                backgroundColor: 'var(--ox-surface-subtle)',
                color: 'var(--ox-text-primary)'
              }}
            />
            <button
              type="button"
              onClick={() => executeParse(rawInput)}
              style={{
                padding: '0 1.25rem',
                backgroundColor: 'var(--ox-bitcoin-orange)',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: '0.8125rem',
                border: 'none',
                borderRadius: 'var(--ox-radius-md)',
                cursor: 'pointer'
              }}
            >
              Parse Artifact
            </button>
          </div>
        </div>

        {parseError && (
          <div
            style={{
              padding: '0.75rem',
              borderRadius: 'var(--ox-radius-sm)',
              backgroundColor: 'var(--ox-status-refusal-bg)',
              color: 'var(--ox-status-refusal-text)',
              fontSize: '0.8125rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}
          >
            <IconAlertTriangle size={16} />
            <span>{parseError}</span>
          </div>
        )}
      </div>

      {/* Main Inspection View Tabs */}
      {parsed && (
        <div
          style={{
            borderRadius: 'var(--ox-radius-lg)',
            backgroundColor: 'var(--ox-surface-panel)',
            border: '1px solid var(--ox-border-default)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {/* Tabs bar */}
          <div
            role="tablist"
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--ox-border-subtle)',
              backgroundColor: 'var(--ox-surface-subtle)',
              fontSize: '0.8125rem',
              fontWeight: 600
            }}
          >
            {[
              { id: 'summary', label: 'Summary' },
              { id: 'structure', label: 'Structure AST' },
              { id: 'bytes', label: 'Synchronized Bytes' },
              { id: 'io', label: 'Inputs & Outputs' },
              { id: 'compare', label: 'Mutation Lab (Compare)' }
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id as unknown as undefined)}
                style={{
                  padding: '0.75rem 1.25rem',
                  border: 'none',
                  background: activeTab === tab.id ? 'var(--ox-surface-panel)' : 'transparent',
                  color: activeTab === tab.id ? 'var(--ox-text-primary)' : 'var(--ox-text-muted)',
                  cursor: 'pointer',
                  borderBottom: activeTab === tab.id ? '2px solid var(--ox-bitcoin-orange)' : 'none'
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* View: Summary */}
          {activeTab === 'summary' && (
            <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '0.75rem'
                }}
              >
                <div style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-subtle)' }}>
                  <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)', textTransform: 'uppercase' }}>
                    Detected Format
                  </div>
                  <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--ox-text-primary)', marginTop: '0.2rem' }}>
                    {parsed.format}
                  </div>
                </div>

                <div style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-subtle)' }}>
                  <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)', textTransform: 'uppercase' }}>
                    Payload Size
                  </div>
                  <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--ox-text-primary)', marginTop: '0.2rem' }}>
                    {parsed.totalByteLength} bytes
                  </div>
                </div>

                <div style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-subtle)' }}>
                  <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)', textTransform: 'uppercase' }}>
                    Inputs / Outputs
                  </div>
                  <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--ox-text-primary)', marginTop: '0.2rem' }}>
                    {parsed.inputsCount} in / {parsed.outputsCount} out
                  </div>
                </div>

                <div style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-subtle)' }}>
                  <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)', textTransform: 'uppercase' }}>
                    Taproot Fields
                  </div>
                  <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--ox-text-primary)', marginTop: '0.2rem' }}>
                    {parsed.hasTaprootFields ? 'Yes' : 'None'}
                  </div>
                </div>
              </div>

              {parsed.warnings.length > 0 && (
                <div
                  style={{
                    padding: '0.875rem',
                    borderRadius: 'var(--ox-radius-md)',
                    backgroundColor: 'var(--ox-status-warning-bg)',
                    border: '1px solid var(--ox-status-warning-border)',
                    fontSize: '0.8125rem',
                    color: 'var(--ox-status-warning-text)'
                  }}
                >
                  <strong>Parser Findings ({parsed.warnings.length}):</strong>
                  <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem' }}>
                    {parsed.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-secondary)', lineHeight: 1.4 }}>
                <strong>Highest Risk Observation:</strong> All {parsed.globalMap.entries.length} global entries parsed without structural truncation.
                {parsed.hasUnknownFields ? ' Unknown proprietary fields preserved.' : ' Standard BIP-174/BIP-370 fields verified.'}
              </div>
            </div>
          )}

          {/* View: Bytes with Synchronized Highlighting */}
          {activeTab === 'bytes' && (
            <div style={{ display: 'flex', minHeight: '380px' }}>
              {/* Byte Hex Dump Panel */}
              <div
                style={{
                  flex: 1,
                  padding: '1rem',
                  fontFamily: 'var(--ox-font-mono)',
                  fontSize: '0.75rem',
                  overflowY: 'auto',
                  maxHeight: '450px',
                  backgroundColor: 'var(--ox-surface-inset)',
                  color: 'var(--ox-text-primary)',
                  lineHeight: 1.6
                }}
              >
                <div style={{ color: 'var(--ox-text-muted)', marginBottom: '0.5rem', fontWeight: 600 }}>
                  Click a byte range to inspect the semantic field definition:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                  {parsed.byteRanges.map((range, i) => {
                    const isSelected = selectedRange === range;
                    return (
                      <span
                        key={i}
                        onClick={() => setSelectedRange(range)}
                        style={{
                          padding: '0.1rem 0.25rem',
                          borderRadius: '2px',
                          backgroundColor: isSelected ? 'var(--ox-bitcoin-orange)' : 'rgba(255, 255, 255, 0.05)',
                          color: isSelected ? '#ffffff' : 'inherit',
                          cursor: 'pointer',
                          border: isSelected ? '1px solid var(--ox-bitcoin-hover)' : '1px solid transparent'
                        }}
                        title={`Offset ${range.startOffset}-${range.endOffset}: ${range.label}`}
                      >
                        {parsed.rawHex.substring(range.startOffset * 2, range.endOffset * 2)}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Selected Range Inspector */}
              <div
                style={{
                  width: '300px',
                  borderLeft: '1px solid var(--ox-border-subtle)',
                  padding: '1rem',
                  backgroundColor: 'var(--ox-surface-panel)',
                  fontSize: '0.8125rem'
                }}
              >
                <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)', marginBottom: '0.25rem' }}>
                  Field Inspector
                </div>
                {selectedRange ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ fontWeight: 700, color: 'var(--ox-text-primary)' }}>
                      {selectedRange.label}
                    </div>
                    <div>
                      Byte Range: <code>{selectedRange.startOffset} - {selectedRange.endOffset}</code> ({selectedRange.endOffset - selectedRange.startOffset} bytes)
                    </div>
                    <div>
                      Encoding: {selectedRange.isStandardEncoding ? <span style={{ color: 'var(--ox-status-success-text)' }}>Standard</span> : <span style={{ color: 'var(--ox-status-warning-text)' }}>Overlong</span>}
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--ox-text-muted)' }}>
                    Select any byte group on the left to inspect its offset, length, and field mapping.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* View: Structure AST */}
          {activeTab === 'structure' && (
            <div style={{ padding: '1.25rem', fontSize: '0.8125rem', overflowY: 'auto', maxHeight: '450px' }}>
              <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>Global Map ({parsed.globalMap.entries.length} entries)</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', marginBottom: '1.5rem' }}>
                {parsed.globalMap.entries.map((entry, idx) => (
                  <div key={idx} style={{ padding: '0.5rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)', display: 'flex', justifyContent: 'space-between' }}>
                    <div>
                      <strong>{entry.label}</strong> (KeyType 0x{entry.keyType.toString(16).padStart(2, '0')})
                    </div>
                    <div style={{ fontFamily: 'var(--ox-font-mono)', fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>
                      {entry.totalLength} bytes
                    </div>
                  </div>
                ))}
              </div>

              <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>Input Maps ({parsed.inputMaps.length} inputs)</h3>
              {parsed.inputMaps.map((im, idx) => (
                <div key={idx} style={{ marginBottom: '0.75rem', padding: '0.5rem', borderRadius: 'var(--ox-radius-sm)', border: '1px solid var(--ox-border-subtle)' }}>
                  <strong>Input [{idx}]</strong> - {im.entries.length} map entries
                </div>
              ))}
            </div>
          )}

          {/* View: Compare & Mutation Lab */}
          {activeTab === 'compare' && (
            <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.25rem 0', color: 'var(--ox-text-primary)' }}>
                  Wallet Mutation Lab
                </h3>
                <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>
                  Test how wallet mutations affect Ordex invariants before and after signing.
                </div>
              </div>

              {/* Mutation Fixture Buttons */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {MUTATION_FIXTURES.map((fixture) => (
                  <button
                    key={fixture.id}
                    type="button"
                    onClick={() => handleLoadMutationFixture(fixture.id)}
                    style={{
                      padding: '0.4rem 0.75rem',
                      borderRadius: 'var(--ox-radius-sm)',
                      backgroundColor: 'var(--ox-surface-subtle)',
                      border: '1px solid var(--ox-border-default)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    Test: {fixture.name}
                  </button>
                ))}
              </div>

              {/* Comparison Findings */}
              {comparisonReport && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div
                    style={{
                      padding: '0.75rem 1rem',
                      borderRadius: 'var(--ox-radius-md)',
                      backgroundColor: comparisonReport.hasDangerousMutations ? 'var(--ox-status-danger-bg)' : 'var(--ox-status-success-bg)',
                      color: comparisonReport.hasDangerousMutations ? 'var(--ox-status-danger-text)' : 'var(--ox-status-success-text)',
                      fontWeight: 700,
                      fontSize: '0.875rem'
                    }}
                  >
                    Overall Severity Verdict: {comparisonReport.overallVerdict}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {comparisonReport.differences.map((diff) => (
                      <div
                        key={diff.id}
                        style={{
                          padding: '0.75rem',
                          borderRadius: 'var(--ox-radius-sm)',
                          backgroundColor: 'var(--ox-surface-subtle)',
                          borderLeft: diff.severity === 'Dangerous' ? '3px solid var(--ox-status-refusal-text)' : '3px solid var(--ox-border-strong)',
                          fontSize: '0.8125rem'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong>{diff.field}</strong>
                          <span
                            style={{
                              fontSize: '0.6875rem',
                              fontWeight: 700,
                              padding: '0.1rem 0.35rem',
                              borderRadius: 'var(--ox-radius-sm)',
                              backgroundColor: diff.severity === 'Dangerous' ? 'var(--ox-status-refusal-bg)' : 'var(--ox-surface-panel)',
                              color: diff.severity === 'Dangerous' ? 'var(--ox-status-refusal-text)' : 'var(--ox-text-secondary)'
                            }}
                          >
                            {diff.severity}
                          </span>
                        </div>
                        <div style={{ color: 'var(--ox-text-secondary)', marginTop: '0.25rem', lineHeight: 1.35 }}>
                          {diff.whyItMatters}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)', marginTop: '0.25rem' }}>
                          Next Action: {diff.nextAction}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
