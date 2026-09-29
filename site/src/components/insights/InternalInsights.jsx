import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { callDocsApi, DOCS_API_BASE } from '../../lib/docs/docs-client.mjs';

// OX-S11: shows the docs service's aggregate counts (GET /api/docs/insights, OX-P08) for the
// chosen window: hourly event counts per event and product, and feedback per category. The
// service stores no cookies, IPs or raw comments in aggregates. When it cannot be reached the
// page says so; it never shows invented numbers.

const RANGES = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' }
];

export function InternalInsights() {
  const [range, setRange] = useState('7d');
  const [state, setState] = useState({ status: 'loading', data: null, message: '' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading', data: null, message: '' });
    callDocsApi(`/api/docs/insights?range=${range}`, { signal: ctrl.signal }).then((res) => {
      if (res.kind === 'cancelled') return;
      if (res.kind === 'ok' && res.data?.ok === true && Array.isArray(res.data.events) && Array.isArray(res.data.feedback)) setState({ status: 'ready', data: res.data, message: '' });
      else setState({ status: 'unavailable', data: null, message: res.kind === 'ok' ? 'The response is not an insights report.' : res.message });
    });
    return () => ctrl.abort();
  }, [range, reload]);

  const d = state.data;
  const total = (rows) => rows.reduce((n, r) => n + Number(r.count || 0), 0);

  return (
    <div class="insights-container panel" style="padding: 1.5rem;">
      <div class="panel-header" style="flex-wrap: wrap; gap: 0.75rem;">
        <div>
          <h2 style="margin: 0; font-size: 1.25rem;">Documentation insights</h2>
          <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">Aggregate counts from the Ordex docs service. Hours are UTC.</p>
        </div>
        <div role="group" aria-label="Time window" style="display: flex; gap: 0.25rem; flex-wrap: wrap;">
          {RANGES.map((r) => (
            <button key={r.id} type="button" aria-pressed={range === r.id ? 'true' : 'false'} class={`btn ${range === r.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div role="status" aria-live="polite" style="font-size: 0.9rem; margin: 0.75rem 0;">
        {state.status === 'loading' && 'Loading...'}
        {state.status === 'unavailable' && (
          <span>
            No insights are available: {state.message}
            {DOCS_API_BASE ? '' : ' This build has no docs service configured.'}{' '}
            <button type="button" class="btn btn-outline" style="min-height: 28px; font-size: 0.8rem;" onClick={() => setReload((n) => n + 1)}>
              Retry
            </button>
          </span>
        )}
        {state.status === 'ready' && `Since ${d.since}, generated ${d.generatedAt}.`}
      </div>

      {state.status === 'ready' && (
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 1.5rem;">
          <section aria-labelledby="insights-events">
            <h3 id="insights-events" style="font-size: 1rem; margin: 0 0 0.5rem;">Events ({total(d.events)})</h3>
            {d.events.length === 0 ? (
              <p style="margin: 0; font-size: 0.875rem; color: var(--color-text-secondary);">No events in this window.</p>
            ) : (
              <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                <thead>
                  <tr>
                    <th scope="col" style="text-align: left;">Event</th>
                    <th scope="col" style="text-align: left;">Product</th>
                    <th scope="col" style="text-align: right;">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {d.events.map((e) => (
                    <tr key={`${e.event}-${e.product}`} style="border-top: 1px solid var(--color-border);">
                      <td>{e.event}</td>
                      <td>{e.product}</td>
                      <td style="text-align: right;">{e.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section aria-labelledby="insights-feedback">
            <h3 id="insights-feedback" style="font-size: 1rem; margin: 0 0 0.5rem;">Feedback ({total(d.feedback)})</h3>
            {d.feedback.length === 0 ? (
              <p style="margin: 0; font-size: 0.875rem; color: var(--color-text-secondary);">No feedback in this window.</p>
            ) : (
              <ul style="margin: 0; padding-left: 1.2rem; font-size: 0.85rem;">
                {d.feedback.map((f) => (
                  <li key={f.category}>
                    {f.category}: {f.count}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
