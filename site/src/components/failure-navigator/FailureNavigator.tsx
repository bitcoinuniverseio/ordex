import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { detectFailureInput, type DetectionResult, type DiagnosticRule } from '../../lib/diagnostics/detector.js';
import { contextEngine } from '../../lib/experience/context-engine.js';
import { journeyStore } from '../../lib/session/journey-store.js';
import {
  IconDiagnose,
  IconCopy,
  IconAlertTriangle,
  IconShieldCheck,
  IconExternalLink,
  IconArrowRight
} from '../experience/OrdexIcons.js';

interface NavigatorProps {
  initialCode?: string;
  basePath?: string;
}

export function FailureNavigator({
  initialCode = '',
  basePath = '/ordex'
}: NavigatorProps): JSX.Element {
  const [inputText, setInputText] = useState<string>(initialCode);
  const [detection, setDetection] = useState<DetectionResult>(detectFailureInput(initialCode));
  const [reproducerCode, setReproducerCode] = useState<string | null>(null);
  const [reportCopied, setReportCopied] = useState(false);

  // Sync URL query param ?code=...
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        setInputText(code);
        const res = detectFailureInput(code);
        setDetection(res);
      }
    }
  }, []);

  const handleTriage = (text: string) => {
    const res = detectFailureInput(text);
    setDetection(res);
    setReproducerCode(null);

    if (res.matchedRule) {
      contextEngine.setContext({
        title: `Failure Triage: ${res.detectedCode || 'Unknown'}`,
        selectedRefusalCode: res.detectedCode,
        heading: res.matchedRule.summary,
        evidenceClass: 'Protocol verification',
        sourcePointer: res.matchedRule.sourceRefs[0]?.path
      });

      journeyStore.logRun({
        product: 'failure-navigator',
        operation: `Diagnose Refusal: ${res.detectedCode}`,
        isDeterministic: true,
        protocolVersion: '1.2',
        outcome: 'REFUSAL',
        evidenceClass: 'Protocol verification',
        summary: res.matchedRule.summary,
        reopenRoute: `/diagnose/?code=${res.detectedCode}`
      });
    }
  };

  const generateMinimalReproducer = (rule: DiagnosticRule) => {
    const code = `// Minimal Reproducer for ${rule.exactCodes[0]}
import { ${rule.family === 'purchase' ? 'verifyPublicAskCompletion' : 'verifySafeOpsPlan'} } from '@bitcoinuniverse/ordex-sdk';

// Triggering arrangement:
const malformedInput = {
  refusalCode: "${rule.exactCodes[0]}",
  invariant: "${rule.invariant}"
};

console.log("Expected Refusal:", "${rule.exactCodes[0]}");
`;
    setReproducerCode(code);
  };

  const handleCopyReport = () => {
    if (!detection.matchedRule) return;
    const report = `# Ordex Failure Diagnosis Report
Code: ${detection.detectedCode}
Confidence: ${detection.confidence}
Invariant: ${detection.matchedRule.invariant}
Summary: ${detection.matchedRule.summary}

## Recovery Steps:
${detection.matchedRule.resolutionSteps.map(s => `${s.step}. ${s.action}`).join('\n')}

Generated from authoritative verifiers and documentation data.
`;
    navigator.clipboard.writeText(report);
    setReportCopied(true);
    setTimeout(() => setReportCopied(false), 2000);
  };

  const rule = detection.matchedRule;

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
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
            Failure Navigator
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>•</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>Deterministic Protocol & API Triage</span>
        </div>

        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>
          Protocol and Integration Failure Diagnostics
        </h1>

        <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.4 }}>
          Paste a refusal code, verifier JSON result, API error envelope, or HTTP response to identify the violated
          protocol invariant, view likely causes, and execute an ordered recovery sequence.
        </p>

        {/* Input Bar */}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <input
            type="text"
            value={inputText}
            onInput={(e) => setInputText((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && handleTriage(inputText)}
            placeholder="Enter refusal code (e.g. PAYMENT_OUTPUT_MISMATCH) or paste error JSON..."
            style={{
              flex: 1,
              padding: '0.5rem 0.75rem',
              borderRadius: 'var(--ox-radius-md)',
              border: '1px solid var(--ox-border-default)',
              backgroundColor: 'var(--ox-surface-subtle)',
              color: 'var(--ox-text-primary)',
              fontFamily: 'var(--ox-font-mono)',
              fontSize: '0.8125rem'
            }}
          />
          <button
            type="button"
            onClick={() => handleTriage(inputText)}
            style={{
              padding: '0.5rem 1.25rem',
              borderRadius: 'var(--ox-radius-md)',
              backgroundColor: 'var(--ox-bitcoin-orange)',
              color: '#ffffff',
              border: 'none',
              fontWeight: 600,
              fontSize: '0.8125rem',
              cursor: 'pointer'
            }}
          >
            Diagnose Failure
          </button>
        </div>

        {/* Quick Refusal Sample Pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap', fontSize: '0.6875rem' }}>
          <span style={{ color: 'var(--ox-text-muted)', fontWeight: 600 }}>Quick Samples:</span>
          {['PAYMENT_OUTPUT_MISMATCH', 'CENOTAPH', 'UNDERPAID_SELLER', 'INSCRIPTION_ON_CARDINAL_INPUT', 'RETURNED_BYTES_MISMATCH'].map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => {
                setInputText(sample);
                handleTriage(sample);
              }}
              style={{
                padding: '0.15rem 0.45rem',
                borderRadius: 'var(--ox-radius-sm)',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-subtle)',
                color: 'var(--ox-text-secondary)',
                cursor: 'pointer'
              }}
            >
              {sample}
            </button>
          ))}
        </div>
      </div>

      {/* Diagnosis Results Card */}
      {rule ? (
        <div
          style={{
            padding: '1.5rem',
            borderRadius: 'var(--ox-radius-lg)',
            backgroundColor: 'var(--ox-surface-panel)',
            border: '1px solid var(--ox-border-default)',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                <span style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-status-refusal-text)' }}>
                  Refusal Code
                </span>
                <span style={{ fontSize: '0.6875rem', padding: '0.1rem 0.35rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)', color: 'var(--ox-text-muted)' }}>
                  Confidence: {detection.confidence}
                </span>
              </div>
              <h2 style={{ fontSize: '1.375rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>
                {rule.exactCodes[0]}
              </h2>
            </div>

            <button
              type="button"
              onClick={handleCopyReport}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.4rem 0.75rem',
                borderRadius: 'var(--ox-radius-sm)',
                border: '1px solid var(--ox-border-default)',
                background: 'var(--ox-surface-subtle)',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <IconCopy size={13} />
              <span>{reportCopied ? 'Copied Report!' : 'Copy Sanitized Report'}</span>
            </button>
          </div>

          <div
            style={{
              padding: '0.875rem',
              borderRadius: 'var(--ox-radius-sm)',
              borderLeft: '4px solid var(--ox-status-refusal-text)',
              backgroundColor: 'var(--ox-surface-subtle)',
              fontSize: '0.875rem',
              lineHeight: 1.4,
              color: 'var(--ox-text-primary)'
            }}
          >
            <strong>Summary:</strong> {rule.summary}
          </div>

          {/* Violated Invariant */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)', marginBottom: '0.25rem' }}>
              Violated Protocol Invariant
            </div>
            <div style={{ fontFamily: 'var(--ox-font-mono)', fontSize: '0.8125rem', color: 'var(--ox-text-primary)', backgroundColor: 'var(--ox-surface-subtle)', padding: '0.625rem', borderRadius: 'var(--ox-radius-sm)' }}>
              {rule.invariant}
            </div>
          </div>

          {/* Likely Causes */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)', marginBottom: '0.375rem' }}>
              Likely Causes
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {rule.likelyCauses.map((cause, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem' }}>
                  <span style={{ color: 'var(--ox-status-warning-text)' }}>•</span>
                  <span>{cause.cause}</span>
                  <span style={{ fontSize: '0.6875rem', color: 'var(--ox-text-muted)' }}>({cause.probability} Probability)</span>
                </div>
              ))}
            </div>
          </div>

          {/* Ordered Recovery Sequence */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)', marginBottom: '0.375rem' }}>
              Ordered Recovery Sequence
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {rule.resolutionSteps.map((step) => (
                <div
                  key={step.step}
                  style={{
                    padding: '0.625rem',
                    borderRadius: 'var(--ox-radius-sm)',
                    backgroundColor: 'var(--ox-surface-subtle)',
                    border: '1px solid var(--ox-border-subtle)',
                    fontSize: '0.8125rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem'
                  }}
                >
                  <span
                    style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      backgroundColor: 'var(--ox-bitcoin-orange)',
                      color: '#ffffff',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.6875rem',
                      fontWeight: 700,
                      flexShrink: 0
                    }}
                  >
                    {step.step}
                  </span>
                  <span style={{ color: 'var(--ox-text-primary)' }}>{step.action}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Action Buttons: Reproducer, Sandbox, Lab, Doctor */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              flexWrap: 'wrap',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--ox-border-subtle)'
            }}
          >
            <button
              type="button"
              onClick={() => generateMinimalReproducer(rule)}
              style={{
                padding: '0.45rem 0.875rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-strong)',
                fontSize: '0.8125rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Generate Minimal Reproducer
            </button>

            <a
              href={`${basePath}/sandbox/`}
              style={{
                padding: '0.45rem 0.875rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-default)',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: 'var(--ox-text-primary)',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem'
              }}
            >
              <span>Open in Sandbox</span>
              <IconExternalLink size={12} />
            </a>

            <a
              href={`${basePath}/lab`}
              style={{
                padding: '0.45rem 0.875rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-default)',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: 'var(--ox-text-primary)',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem'
              }}
            >
              <span>Open Protocol Lab</span>
              <IconExternalLink size={12} />
            </a>

            {detection.inputType === 'GATEWAY_DOCTOR' && (
              <a
                href={`${basePath}/verify`}
                style={{
                  padding: '0.45rem 0.875rem',
                  borderRadius: 'var(--ox-radius-md)',
                  backgroundColor: 'var(--ox-surface-subtle)',
                  border: '1px solid var(--ox-border-default)',
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  color: 'var(--ox-text-primary)',
                  textDecoration: 'none'
                }}
              >
                Open Gateway Doctor
              </a>
            )}
          </div>

          {/* Generated Reproducer Box */}
          {reproducerCode && (
            <div
              style={{
                padding: '0.875rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-inset)',
                border: '1px solid var(--ox-border-default)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem'
              }}
            >
              <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--ox-text-muted)', textTransform: 'uppercase' }}>
                Minimal Deterministic Reproducer
              </div>
              <pre
                style={{
                  margin: 0,
                  fontFamily: 'var(--ox-font-mono)',
                  fontSize: '0.75rem',
                  color: 'var(--ox-text-primary)',
                  overflowX: 'auto',
                  lineHeight: 1.4
                }}
              >
                {reproducerCode}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            padding: '2rem',
            textAlign: 'center',
            borderRadius: 'var(--ox-radius-lg)',
            backgroundColor: 'var(--ox-surface-panel)',
            border: '1px solid var(--ox-border-default)',
            color: 'var(--ox-text-muted)'
          }}
        >
          {inputText ? (
            <div>
              <IconAlertTriangle size={32} color="var(--ox-status-warning-text)" />
              <p style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                Unknown Input: Could not conclusively identify refusal code.
              </p>
              <p style={{ fontSize: '0.8125rem', maxWidth: '480px', margin: '0.25rem auto' }}>
                Missing fields required for conclusive verdict: {detection.missingFieldsForConclusiveVerdict?.join(', ')}.
              </p>
            </div>
          ) : (
            <div>
              <IconDiagnose size={32} />
              <p style={{ marginTop: '0.5rem', fontWeight: 600 }}>Enter a refusal code above to begin diagnosis.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
