import { h } from 'preact';
import { useState } from 'preact/hooks';
import allVectors from '../../data/allVectors.json';
import vectorFamilies from '../../data/vectorFamilies.json';
import { FAMILIES, executeVector } from '../../lib/conformance-engine.mjs';

export function ConformanceStudio() {
  const [selectedFamily, setSelectedFamily] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all'); // all, pass, fail
  const [results, setResults] = useState({});
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const familiesList = ['all', ...FAMILIES];

  const handleRunAll = () => {
    setIsRunning(true);
    setProgress(0);
    const newResults = {};

    const vectorsToRun = selectedFamily === 'all'
      ? allVectors
      : allVectors.filter((v) => v.family === selectedFamily);

    let completed = 0;
    const total = vectorsToRun.length;

    const runNext = (index) => {
      if (index >= total) {
        setIsRunning(false);
        return;
      }

      const v = vectorsToRun[index];
      const res = executeVector(v.family, v);
      newResults[v.id] = res;
      completed++;

      setProgress(Math.round((completed / total) * 100));
      setResults({ ...newResults });

      setTimeout(() => runNext(index + 1), 5);
    };

    runNext(0);
  };

  const displayedVectors = (selectedFamily === 'all'
    ? allVectors
    : allVectors.filter((v) => v.family === selectedFamily)
  ).filter((v) => {
    const res = results[v.id];
    if (filterStatus === 'all') return true;
    if (filterStatus === 'pass') return res?.passed === true;
    if (filterStatus === 'fail') return res && res.passed === false;
    return true;
  });

  const passedCount = Object.values(results).filter((r) => r.passed).length;
  const failedCount = Object.values(results).filter((r) => !r.passed).length;

  return (
    <div class="conformance-studio-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      {/* Control Panel */}
      <div class="panel">
        <div class="panel-header">
          <div>
            <h3 style="margin: 0; font-size: 1.15rem;">In-Browser Conformance Vector Runner</h3>
            <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
              Executes all 151 official conformance vectors directly in the browser against reference verifiers.
            </p>
          </div>
          <button
            class="btn btn-primary"
            onClick={handleRunAll}
            disabled={isRunning}
            style="min-width: 140px;"
          >
            {isRunning ? `Running (${progress}%)...` : '▶ Run Conformance Suite'}
          </button>
        </div>

        {/* Progress bar */}
        {isRunning && (
          <div style="width: 100%; height: 6px; background: var(--color-bg-muted); border-radius: 3px; overflow: hidden; margin-bottom: 1rem;">
            <div style={{ width: `${progress}%`, height: '100%', background: 'var(--color-brand)', transition: 'width 0.1s' }} />
          </div>
        )}

        {/* Filters */}
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: 0.5rem;">
          <div style="display: flex; flex-wrap: wrap; gap: 0.35rem;">
            {familiesList.map((fam) => (
              <button
                key={fam}
                class={`btn ${selectedFamily === fam ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.55rem;"
                onClick={() => setSelectedFamily(fam)}
              >
                {fam}
              </button>
            ))}
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <button
              class={`btn ${filterStatus === 'all' ? 'btn-secondary' : 'btn-outline'}`}
              style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.5rem;"
              onClick={() => setFilterStatus('all')}
            >
              All ({displayedVectors.length})
            </button>
            <button
              class={`btn ${filterStatus === 'pass' ? 'btn-secondary' : 'btn-outline'}`}
              style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.5rem; color: var(--color-success);"
              onClick={() => setFilterStatus('pass')}
            >
              Passed ({passedCount})
            </button>
            <button
              class={`btn ${filterStatus === 'fail' ? 'btn-secondary' : 'btn-outline'}`}
              style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.5rem; color: var(--color-danger);"
              onClick={() => setFilterStatus('fail')}
            >
              Failed ({failedCount})
            </button>
          </div>
        </div>
      </div>

      {/* Results Table */}
      <div class="panel" style="padding: 0; overflow: hidden;">
        <div style="overflow-x: auto; max-height: 550px; overflow-y: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
            <thead>
              <tr style="background: var(--color-bg-subtle); border-bottom: 2px solid var(--color-border); text-align: left;">
                <th style="padding: 0.6rem 1rem;">Family</th>
                <th style="padding: 0.6rem 1rem;">Vector Name</th>
                <th style="padding: 0.6rem 1rem;">Expected Verdict</th>
                <th style="padding: 0.6rem 1rem;">Actual Verdict</th>
                <th style="padding: 0.6rem 1rem; text-align: right;">Duration</th>
              </tr>
            </thead>
            <tbody>
              {displayedVectors.map((v) => {
                const res = results[v.id];
                const hasRun = !!res;
                return (
                  <tr key={v.id} style="border-bottom: 1px solid var(--color-border);">
                    <td style="padding: 0.6rem 1rem; font-family: var(--font-mono); color: var(--color-text-muted);">
                      {v.family}
                    </td>
                    <td style="padding: 0.6rem 1rem; font-weight: 600;">
                      {v.title}
                    </td>
                    <td style="padding: 0.6rem 1rem;">
                      {v.expected?.ok ? (
                        <span class="badge badge-verification">PASS</span>
                      ) : (
                        <span class="badge badge-claim">REFUSE ({v.expected?.code})</span>
                      )}
                    </td>
                    <td style="padding: 0.6rem 1rem;">
                      {!hasRun ? (
                        <span style="color: var(--color-text-muted);">Not Run</span>
                      ) : res.passed ? (
                        <span style="color: var(--color-success); font-weight: 700;">✓ PASS</span>
                      ) : (
                        <span style="color: var(--color-danger); font-weight: 700;">✖ FAIL ({res.actual?.code})</span>
                      )}
                    </td>
                    <td style="padding: 0.6rem 1rem; text-align: right; font-family: var(--font-mono); color: var(--color-text-muted);">
                      {hasRun ? `${res.durationMs.toFixed(2)}ms` : '-'}
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
