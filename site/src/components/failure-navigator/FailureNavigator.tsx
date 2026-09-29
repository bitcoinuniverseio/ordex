import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { detectFailureInput, ruleFor, type DetectionResult, type DiagnosticReproducer, type DiagnosticRule } from '../../lib/diagnostics/detector.js';
import { reproducerArgs, reproducerScript } from '../../lib/diagnostics/reproducer.mjs';
import { runVerifierJob } from '../../lib/verifier-client.mjs';
import { contextEngine } from '../../lib/experience/context-engine.js';
import { journeyQuery, readJourneyHandoff, recordToolEvidence, SOURCE_BUILD } from '../../lib/session/evidence.js';
import { IconDiagnose, IconCopy, IconAlertTriangle, IconExternalLink } from '../experience/OrdexIcons.js';

// OX-S09: the navigator classifies what was pasted (lib/diagnostics/detector.ts), shows the
// rule generated from the verifier sources, and runs the rule's checked-in reproducer in the
// bounded verifier Worker, showing the actual verdict beside the expected one. The runnable
// script calls the reference verifier of a pinned checkout. Only published conformance data
// ever goes into a reproducer or a copied report, never the pasted input.

interface NavigatorProps {
  initialCode?: string;
  basePath?: string;
}

type RunState = { status: 'idle' | 'running' | 'done' | 'error'; expected?: string; actual?: { state: string; code: string | null; reason: string | null }; error?: string; at?: string };

const SAMPLES = ['SELLER_VALUE_MISMATCH', 'SAT_FLOW_SHORTFALL', 'CENOTAPH_BURNS_BALANCE', 'MEMBER_NOT_PROVEN', 'VALUE_NOT_CONSERVED'].filter((c) => ruleFor(c));

let vectorsPromise: Promise<Map<string, { case: Record<string, unknown> }>> | null = null;
const loadVectors = () =>
  (vectorsPromise ??= import('../../data/allVectors.json').then((m) => new Map((m.default as Array<{ id: string; case: Record<string, unknown> }>).map((v) => [v.id, v]))));

const card = { padding: '1.25rem', borderRadius: 'var(--ox-radius-lg)', backgroundColor: 'var(--ox-surface-panel)', border: '1px solid var(--ox-border-default)', display: 'flex', flexDirection: 'column', gap: '1rem' } as const;
const heading = { fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-secondary)', margin: '0 0 0.35rem' } as const;
const linkBtn = { padding: '0.45rem 0.875rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-subtle)', border: '1px solid var(--ox-border-default)', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--ox-text-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.375rem' } as const;

// One family can reproduce a code twice: through its own branch and through a shared helper
// it reaches (covers). Runs and file names are told apart by both.
const reproducerKey = (code: string, r: DiagnosticReproducer) => `${code}|${r.family}|${r.covers || r.family}`;
function reproducerFile(code: string, rule: DiagnosticRule, r: DiagnosticReproducer) {
  if (rule.reproducers.length === 1) return `reproduce-${code}.mjs`;
  const sameFamily = rule.reproducers.filter((x) => x.family === r.family).length > 1;
  return `reproduce-${code}-${r.family}${sameFamily && r.covers ? `-via-${r.covers}` : ''}.mjs`;
}

export function FailureNavigator({ initialCode = '', basePath = '/ordex' }: NavigatorProps): JSX.Element {
  const [inputText, setInputText] = useState<string>(initialCode);
  const [detection, setDetection] = useState<DetectionResult>(detectFailureInput(initialCode));
  const [announce, setAnnounce] = useState('');
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [eventRun, setEventRun] = useState<RunState>({ status: 'idle' });
  const [scenarios, setScenarios] = useState<Array<{ id: string; title: string }>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const handoff = typeof window !== 'undefined' ? readJourneyHandoff() : null;
  const withJourney = (href: string) => {
    if (!handoff) return `${basePath}${href}`;
    const q = journeyQuery(handoff.sessionId, handoff.stageId).slice(1);
    return `${basePath}${href}${href.includes('?') ? '&' : '?'}${q}`;
  };

  const triage = (text: string, { updateUrl = true } = {}) => {
    abortRef.current?.abort();
    const res = detectFailureInput(text);
    setDetection(res);
    setRuns({});
    setEventRun({ status: 'idle' });
    setScenarios([]);
    const code = res.matchedRule?.exactCodes[0];
    if (typeof window !== 'undefined' && updateUrl) {
      // Keep a deep link for a code; never put pasted JSON or text into the URL.
      const url = new URL(window.location.href);
      if (code && res.confidence === 'Conclusive') url.searchParams.set('code', code);
      else url.searchParams.delete('code');
      window.history.replaceState(null, '', url);
    }
    if (res.matchedRule && code) {
      contextEngine.setContext({ title: `Refusal ${code}`, selectedRefusalCode: code, heading: res.matchedRule.summary, evidenceClass: 'Protocol verification', sourcePointer: res.matchedRule.causes[0]?.source.path });
      import('../../lib/scenarios/registry.js')
        .then((m) => setScenarios(m.SCENARIOS.filter((s) => s.expectedRefusalCode === code).map((s) => ({ id: s.id, title: s.title }))))
        .catch(() => setScenarios([]));
    }
    setAnnounce(res.matchedRule ? `Diagnosis: ${code}, ${res.confidence.toLowerCase()}.` : `No rule matched, confidence ${res.confidence.toLowerCase()}. The details follow the input.`);
  };

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
      setInputText(code);
      triage(code, { updateUrl: false });
    }
    return () => abortRef.current?.abort();
  }, []);

  const runReproducer = async (rule: DiagnosticRule, r: DiagnosticReproducer) => {
    const code = rule.exactCodes[0];
    const key = reproducerKey(code, r);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRuns((prev) => ({ ...prev, [key]: { status: 'running', expected: code } }));
    try {
      const base = (await loadVectors()).get(r.base);
      if (!base) throw new Error(`The base vector ${r.base} is missing from this build.`);
      const args = reproducerArgs(r, base.case);
      const result = await runVerifierJob({ type: 'candidate', family: r.family, variant: r.variant, args }, { signal: controller.signal, timeoutMs: 15000 });
      const actual = { state: result.verdict.state, code: result.verdict.code ?? null, reason: result.verdict.reason ?? null };
      const passed = actual.state === 'refused' && actual.code === code;
      setRuns((prev) => ({ ...prev, [key]: { status: 'done', expected: code, actual, at: new Date().toISOString() } }));
      setAnnounce(passed ? `Reproduced ${code}.` : `The verifier returned ${actual.state} ${actual.code ?? ''}, not ${code}.`);
      recordToolEvidence({ tool: 'failure-navigator', operation: `reproduce:${code}`, state: passed ? 'passed' : 'failed', code: actual.code, reason: actual.reason, evidenceClass: 'Protocol verification' });
    } catch (err) {
      if (controller.signal.aborted) return;
      setRuns((prev) => ({ ...prev, [key]: { status: 'error', expected: code, error: (err as Error).message } }));
      setAnnounce(`The reproducer could not run: ${(err as Error).message}`);
    }
  };

  const scriptFor = async (rule: DiagnosticRule, r: DiagnosticReproducer) => {
    const base = (await loadVectors()).get(r.base);
    if (!base) throw new Error(`The base vector ${r.base} is missing from this build.`);
    return reproducerScript({ code: rule.exactCodes[0], reproducer: r, args: reproducerArgs(r, base.case), revision: SOURCE_BUILD });
  };

  const copyText = async (what: string, make: () => string | Promise<string>) => {
    try {
      const text = await make();
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setAnnounce(`${what} copied.`);
    } catch (err) {
      setAnnounce(`${what} could not be copied (${(err as Error).message}). Use Download instead.`);
    }
  };

  const download = async (name: string, make: () => Promise<string>) => {
    try {
      const url = URL.createObjectURL(new Blob([await make()], { type: 'text/javascript' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setAnnounce(`Download started: ${name}.`);
    } catch (err) {
      setAnnounce(`The download failed: ${(err as Error).message}`);
    }
  };

  const verifyEvent = async () => {
    const pending = detection.pendingVerification;
    if (!pending) return;
    setEventRun({ status: 'running' });
    try {
      const result = await runVerifierJob({ type: 'candidate', family: pending.family, variant: pending.variant, args: pending.args }, { timeoutMs: 15000 });
      const actual = { state: result.verdict.state, code: result.verdict.code ?? null, reason: result.verdict.reason ?? null };
      setEventRun({ status: 'done', actual, at: new Date().toISOString() });
      if (actual.state === 'refused' && actual.code) {
        const rule = ruleFor(actual.code);
        setDetection({ ...detection, detectedCode: actual.code, matchedRule: rule, confidence: rule ? 'Conclusive' : 'Unknown', evidenceUsed: `The events verifier refused this event with ${actual.code}.` });
      }
      setAnnounce(`The events verifier returned ${actual.state}${actual.code ? ` ${actual.code}` : ''}.`);
    } catch (err) {
      setEventRun({ status: 'error', error: (err as Error).message });
    }
  };

  const report = (rule: DiagnosticRule) =>
    [
      '# Ordex failure diagnosis',
      `Code: ${rule.exactCodes[0]} (${detection.confidence})`,
      `Families: ${rule.families.join(', ')}; protocol ${rule.supportedProtocolVersions.join(', ')}`,
      `When: ${rule.lifecyclePhases.join('; ')}`,
      `Summary: ${rule.summary}`,
      ...(rule.invariant ? [`Specification: ${rule.invariant}`] : []),
      '',
      '## Where the verifier refuses',
      ...rule.causes.map((c) => `- ${c.family}: ${c.predicate} (${c.source.path}:${c.source.line}${c.reachable ? '' : ', unreachable'})`),
      '',
      '## Recovery',
      ...rule.resolutionSteps.map((s) => `${s.step}. ${s.action}`),
      '',
      `Build ${SOURCE_BUILD}. The pasted input is not included.`
    ].join('\n');

  const rule = detection.matchedRule;
  const code = rule?.exactCodes[0];

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div class="ox-sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      <div style={card}>
        <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-accent-text)' }}>Failure Navigator</div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>Diagnose a refusal or error</h1>
        <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.5 }}>
          Paste a refusal code, a verifier result, a gateway error, a Gateway Doctor report, an Artifact Lens comparison or an Ordex event. Nothing you paste leaves this page.
        </p>
        <label for="diagnose-input" style={{ fontSize: '0.8125rem', fontWeight: 700 }}>
          Code or JSON
        </label>
        <textarea
          id="diagnose-input"
          data-tour="diagnose-input"
          value={inputText}
          rows={inputText.includes('\n') || inputText.startsWith('{') ? 6 : 2}
          spellcheck={false}
          onInput={(e) => setInputText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !inputText.includes('\n'))) {
              e.preventDefault();
              triage(inputText);
            }
          }}
          placeholder="SELLER_VALUE_MISMATCH, or paste JSON"
          style={{ width: '100%', boxSizing: 'border-box', padding: '0.5rem 0.75rem', borderRadius: 'var(--ox-radius-md)', border: '1px solid var(--ox-border-default)', backgroundColor: 'var(--ox-surface-subtle)', color: 'var(--ox-text-primary)', fontFamily: 'var(--ox-font-mono)', fontSize: '0.8125rem' }}
        />
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" class="btn btn-primary" onClick={() => triage(inputText)}>
            Diagnose
          </button>
          <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>Try:</span>
          {SAMPLES.map((sample) => (
            <button
              key={sample}
              type="button"
              class="btn btn-secondary"
              style={{ minHeight: '32px', padding: '0.15rem 0.5rem', fontSize: '0.75rem', fontFamily: 'var(--ox-font-mono)' }}
              onClick={() => {
                setInputText(sample);
                triage(sample);
              }}
            >
              {sample}
            </button>
          ))}
        </div>
      </div>

      {(detection.findings || detection.pendingVerification || (!rule && inputText.trim())) && (
        <div style={card}>
          <div style={{ fontSize: '0.8125rem' }}>
            <strong>{detection.inputType.replace(/_/g, ' ').toLowerCase()}</strong> · confidence {detection.confidence.toLowerCase()}. {detection.evidenceUsed}
          </div>
          {detection.findings && (
            <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.8125rem' }}>
              {detection.findings.length === 0 ? <li>Nothing failed.</li> : detection.findings.map((f) => <li key={f.id}><code>{f.id}</code> {f.detail}</li>)}
            </ul>
          )}
          {detection.pendingVerification && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <button type="button" class="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={verifyEvent} disabled={eventRun.status === 'running'}>
                {eventRun.status === 'running' ? 'Verifying...' : 'Verify the event'}
              </button>
              {eventRun.status === 'done' && eventRun.actual && (
                <p style={{ margin: 0, fontSize: '0.8125rem' }}>
                  Events verifier, in this browser: <strong>{eventRun.actual.state}</strong> {eventRun.actual.code} {eventRun.actual.reason}
                </p>
              )}
              {eventRun.status === 'error' && <p role="alert" style={{ margin: 0 }}>{eventRun.error}</p>}
            </div>
          )}
          {!rule && detection.missingFieldsForConclusiveVerdict && (
            <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>
              <IconAlertTriangle size={14} color="var(--ox-status-warning-text)" /> For a conclusive diagnosis, provide: {detection.missingFieldsForConclusiveVerdict.join('; ')}.
            </p>
          )}
          {detection.nextTool && (
            <a style={{ ...linkBtn, alignSelf: 'flex-start' }} href={withJourney(detection.nextTool.href)}>
              {detection.nextTool.label} <IconExternalLink size={12} />
            </a>
          )}
        </div>
      )}

      {rule && code ? (
        <div style={card} aria-labelledby="diagnosis-code">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>
                Refusal code · confidence {detection.confidence.toLowerCase()} · {rule.families.join(', ')} · protocol {rule.supportedProtocolVersions.join(', ')}
              </div>
              <h2 id="diagnosis-code" style={{ fontSize: '1.375rem', fontWeight: 800, margin: '0.2rem 0 0', fontFamily: 'var(--ox-font-mono)' }}>
                {code}
              </h2>
            </div>
            <button type="button" class="btn btn-secondary" onClick={() => copyText('The diagnosis report', () => report(rule))}>
              <IconCopy size={13} /> Copy report
            </button>
          </div>
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>{detection.evidenceUsed}</p>

          <div style={{ padding: '0.875rem', borderRadius: 'var(--ox-radius-sm)', borderLeft: '4px solid var(--ox-status-refusal-text)', backgroundColor: 'var(--ox-surface-subtle)', fontSize: '0.9rem', lineHeight: 1.5 }}>{rule.summary}</div>

          {rule.invariant && (
            <div>
              <h3 style={heading}>What the specification requires</h3>
              <p style={{ margin: 0, fontSize: '0.875rem' }}>{rule.invariant}</p>
            </div>
          )}

          <div>
            <h3 style={heading}>When this is checked</h3>
            <p style={{ margin: 0, fontSize: '0.875rem' }}>{rule.lifecyclePhases.join('. ')}.</p>
          </div>

          <div>
            <h3 style={heading}>Where the verifier refuses</h3>
            <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.8125rem', lineHeight: 1.6 }}>
              {rule.causes.map((c) => (
                <li key={`${c.source.path}:${c.source.line}`}>
                  {c.predicate}{' '}
                  <code style={{ color: 'var(--ox-text-secondary)' }}>
                    {c.source.path}:{c.source.line}
                    {c.source.symbol ? ` ${c.source.symbol}` : ''}
                  </code>
                  {!c.reachable && <em> (cannot be reached: {rule.unreachable.find((u) => u.family === c.family)?.reason})</em>}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 style={heading}>Evidence to collect</h3>
            <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.8125rem' }}>
              {rule.evidenceRequirements.map((e) => (
                <li key={e.evidenceType}>{e.evidenceType}</li>
              ))}
            </ul>
          </div>

          <div>
            <h3 style={heading}>Recovery</h3>
            <ol style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.875rem', lineHeight: 1.6 }}>
              {rule.resolutionSteps.map((s) => (
                <li key={s.step}>{s.action}</li>
              ))}
            </ol>
          </div>

          <div>
            <h3 style={heading} data-tour="diagnose-reproduce">Reproduce it</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {rule.reproducers.map((r) => {
                const key = reproducerKey(code, r);
                const run = runs[key] || { status: 'idle' };
                const matched = run.actual && run.actual.state === 'refused' && run.actual.code === code;
                const file = reproducerFile(code, rule, r);
                return (
                  <div key={key} style={{ padding: '0.75rem', borderRadius: 'var(--ox-radius-md)', border: '1px solid var(--ox-border-subtle)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ fontSize: '0.8125rem' }}>
                      <strong>{r.family}</strong> ({r.variant}): conformance case <code>{r.base}</code>
                      {r.patch.length ? ` with ${r.patch.map((p) => `${p.op} ${p.path}`).join('; ')}` : ', unchanged'}.{r.note ? ` ${r.note}` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <button type="button" class="btn btn-primary" onClick={() => runReproducer(rule, r)} disabled={run.status === 'running'}>
                        {run.status === 'running' ? 'Running...' : 'Run in this browser'}
                      </button>
                      <button type="button" class="btn btn-secondary" onClick={() => copyText('The reproducer script', () => scriptFor(rule, r))}>
                        <IconCopy size={13} /> Copy script
                      </button>
                      <button type="button" class="btn btn-secondary" onClick={() => download(file, () => scriptFor(rule, r))}>
                        Download {file}
                      </button>
                    </div>
                    {run.status === 'done' && run.actual && (
                      <table style={{ fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                        <caption class="ox-sr-only">Expected and actual verdict</caption>
                        <tbody>
                          <tr>
                            <th scope="row" style={{ textAlign: 'left', paddingRight: '1rem' }}>Expected</th>
                            <td>refused {code}</td>
                          </tr>
                          <tr>
                            <th scope="row" style={{ textAlign: 'left', paddingRight: '1rem' }}>Actual</th>
                            <td>
                              {run.actual.state} {run.actual.code} <span style={{ color: 'var(--ox-text-secondary)' }}>{run.actual.reason}</span>
                            </td>
                          </tr>
                          <tr>
                            <th scope="row" style={{ textAlign: 'left', paddingRight: '1rem' }}>Result</th>
                            <td style={{ color: matched ? 'var(--ox-status-success-text)' : 'var(--ox-status-danger-text)', fontWeight: 700 }}>{matched ? 'Reproduced' : 'Did not reproduce'}</td>
                          </tr>
                        </tbody>
                      </table>
                    )}
                    {run.status === 'error' && (
                      <p role="alert" style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ox-status-danger-text)' }}>
                        {run.error}
                      </p>
                    )}
                  </div>
                );
              })}
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>
                The script runs the reference verifier from a checkout of the repository at build {SOURCE_BUILD}. It contains only published conformance data.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', paddingTop: '0.75rem', borderTop: '1px solid var(--ox-border-subtle)' }}>
            {rule.nextTools.map((t) => (
              <a key={t.href} style={linkBtn} href={withJourney(t.href)}>
                {t.label} <IconExternalLink size={12} />
              </a>
            ))}
            {scenarios.map((s) => (
              <a key={s.id} style={linkBtn} href={withJourney(`/sandbox/?scenario=${encodeURIComponent(s.id)}`)}>
                Replay in the Sandbox: {s.title} <IconExternalLink size={12} />
              </a>
            ))}
          </div>
        </div>
      ) : (
        !inputText.trim() && (
          <div style={{ ...card, alignItems: 'center', color: 'var(--ox-text-secondary)' }}>
            <IconDiagnose size={32} />
            <p style={{ margin: 0, fontWeight: 600 }}>Enter a refusal code or paste a result to begin.</p>
          </div>
        )
      )}
    </div>
  );
}
