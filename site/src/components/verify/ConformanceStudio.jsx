import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import vectorFamilies from '../../data/vectorFamilies.json';
import vectorManifest from '../../data/vectorManifest.json';
import { FAMILIES, FAMILY_REGISTRY } from '../../lib/conformance-registry.mjs';
import { runVerifierJob } from '../../lib/verifier-client.mjs';
import { recordToolEvidence } from '../../lib/session/evidence';

const SOURCE_BUILD = import.meta.env.PUBLIC_ORDEX_BUILD_REVISION || 'unknown';
const OUTCOME_TEXT = {
  EXPECTED_ACCEPTANCE_MATCHED: 'Accepted, as expected',
  EXPECTED_REFUSAL_MATCHED: 'Refused, as expected',
  MISMATCH: 'Mismatch'
};

const allCases = FAMILIES.flatMap((f) => vectorFamilies[f]?.cases || []);

function expectedText(entry) {
  const key = FAMILY_REGISTRY[entry.family].result;
  const e = entry.case.expected || {};
  return e[key] ? 'Accept' : `Refuse (${e.code || 'any code'})`;
}

// OX-S07: the Studio runs the complete generated source cases in the dedicated verifier
// Worker, with cancel and a timeout, and shows exact counts from the generated data. A
// matched refusal is reported as such; nothing here is chain acceptance.
export function ConformanceStudio() {
  const [selectedFamily, setSelectedFamily] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [results, setResults] = useState({});
  const [summary, setSummary] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const familiesList = ['all', ...FAMILIES];
  const selectedFamilies = selectedFamily === 'all' ? FAMILIES : [selectedFamily];
  const selectedCount = selectedFamilies.reduce((n, f) => n + (vectorFamilies[f]?.count || 0), 0);

  const handleRun = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setError(null);
    setResults({});
    setSummary(null);
    const familiesData = Object.fromEntries(selectedFamilies.map((f) => [f, { cases: vectorFamilies[f].cases }]));
    try {
      const suite = await runVerifierJob(
        { type: 'suite', familiesData, families: selectedFamilies },
        { signal: controller.signal, timeoutMs: 30000 }
      );
      const byId = {};
      for (const r of suite.results) byId[r.id] = r;
      setResults(byId);
      setSummary({ ...suite.summary, families: selectedFamilies });
      recordToolEvidence({
        tool: 'conformance',
        operation: `suite:${selectedFamily}`,
        state: suite.summary.success ? 'passed' : 'failed',
        reason: `${suite.summary.passed} of ${suite.summary.total} vectors reached their expected verdict (vector set ${vectorManifest.vectorDigest.slice(0, 12)}).`,
        evidenceClass: 'Protocol verification'
      });
    } catch (err) {
      if (err?.code !== 'VERIFIER_CANCELLED') setError(`${err?.code || 'VERIFIER_ERROR'}: ${err?.message || err}`);
      else setError('The run was cancelled. No results are shown for a cancelled run.');
    } finally {
      if (abortRef.current === controller) setIsRunning(false);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const selectFamily = (fam) => {
    if (isRunning) return;
    setSelectedFamily(fam);
    setResults({});
    setSummary(null);
    setError(null);
  };

  const inFamily = selectedFamily === 'all' ? allCases : allCases.filter((v) => v.family === selectedFamily);
  const displayedVectors = inFamily.filter((v) => {
    const res = results[v.id];
    if (filterStatus === 'pass') return res?.passed === true;
    if (filterStatus === 'fail') return res && res.passed === false;
    return true;
  });

  const passedCount = Object.values(results).filter((r) => r.passed).length;
  const failedCount = Object.values(results).filter((r) => !r.passed).length;

  return (
    <div class="conformance-studio-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="panel">
        <div class="panel-header" style="flex-wrap: wrap; gap: 0.75rem;">
          <div>
            <h3 style="margin: 0; font-size: 1.15rem;">In-browser conformance runner</h3>
            <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
              Runs {vectorManifest.total} checked-in vectors across {vectorManifest.familyCount} families against the reference verifiers, in a Web Worker in this tab.
            </p>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-primary" type="button" onClick={handleRun} disabled={isRunning} style="min-width: 140px;">
              {isRunning ? 'Running...' : `Run ${selectedCount} vectors`}
            </button>
            {isRunning && (
              <button class="btn btn-outline" type="button" onClick={handleCancel}>Cancel</button>
            )}
          </div>
        </div>

        <div role="status" aria-live="polite" style="font-size: 0.85rem; margin: 0.5rem 0;">
          {isRunning && `Running ${selectedCount} vectors...`}
          {!isRunning && summary && (
            <span>
              {summary.success
                ? `All ${summary.total} selected vectors reached their expected verdict.`
                : summary.empty
                  ? 'The selection has no vectors, so nothing was verified.'
                  : `${summary.failed} of ${summary.total} vectors did not reach their expected verdict.`}{' '}
              Build <code>{SOURCE_BUILD.slice(0, 12)}</code>, vector set <code>{vectorManifest.vectorDigest.slice(0, 12)}</code>.
            </span>
          )}
          {error && <span role="alert" style="color: var(--color-danger);">{error}</span>}
        </div>

        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: 0.5rem;">
          <div role="group" aria-label="Verifier family" style="display: flex; flex-wrap: wrap; gap: 0.35rem;">
            {familiesList.map((fam) => (
              <button
                key={fam}
                type="button"
                aria-pressed={selectedFamily === fam ? 'true' : 'false'}
                disabled={isRunning}
                class={`btn ${selectedFamily === fam ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.55rem;"
                onClick={() => selectFamily(fam)}
              >
                {fam === 'all' ? `all (${vectorManifest.total})` : `${fam} (${vectorFamilies[fam]?.count ?? 0})`}
              </button>
            ))}
          </div>

          <div role="group" aria-label="Result filter" style="display: flex; align-items: center; gap: 0.5rem;">
            {[
              ['all', `All (${inFamily.length})`],
              ['pass', `Passed (${passedCount})`],
              ['fail', `Failed (${failedCount})`]
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filterStatus === key ? 'true' : 'false'}
                class={`btn ${filterStatus === key ? 'btn-secondary' : 'btn-outline'}`}
                style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.5rem;"
                onClick={() => setFilterStatus(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div class="panel" style="padding: 0; overflow: hidden;">
        <div tabIndex={0} role="region" aria-label="Conformance results" style="overflow-x: auto; max-height: 550px; overflow-y: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
            <caption class="ox-sr-only">Conformance vectors and their results</caption>
            <thead>
              <tr style="background: var(--color-bg-subtle); border-bottom: 2px solid var(--color-border); text-align: left;">
                <th scope="col" style="padding: 0.6rem 1rem;">Family / variant</th>
                <th scope="col" style="padding: 0.6rem 1rem;">Vector</th>
                <th scope="col" style="padding: 0.6rem 1rem;">Expected</th>
                <th scope="col" style="padding: 0.6rem 1rem;">Result</th>
                <th scope="col" style="padding: 0.6rem 1rem; text-align: right;">Duration</th>
              </tr>
            </thead>
            <tbody>
              {displayedVectors.map((v) => {
                const res = results[v.id];
                return (
                  <tr key={v.id} style="border-bottom: 1px solid var(--color-border);">
                    <td style="padding: 0.6rem 1rem; font-family: var(--font-mono); color: var(--color-text-muted);">
                      {v.family} / {v.variant}
                    </td>
                    <td style="padding: 0.6rem 1rem; font-weight: 600;">{v.title}</td>
                    <td style="padding: 0.6rem 1rem;">
                      <span class={`badge ${expectedText(v) === 'Accept' ? 'badge-verification' : 'badge-claim'}`}>{expectedText(v)}</span>
                    </td>
                    <td style="padding: 0.6rem 1rem;">
                      {!res ? (
                        <span style="color: var(--color-text-muted);">Not run</span>
                      ) : res.passed ? (
                        <span style="color: var(--color-success); font-weight: 700;">{OUTCOME_TEXT[res.outcome]}</span>
                      ) : (
                        <span style="color: var(--color-danger); font-weight: 700;">
                          Mismatch: {res.mismatches.map((m) => m.field).join(', ')}
                        </span>
                      )}
                    </td>
                    <td style="padding: 0.6rem 1rem; text-align: right; font-family: var(--font-mono); color: var(--color-text-muted);">
                      {res ? `${res.durationMs.toFixed(2)}ms` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
