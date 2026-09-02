import { h } from 'preact';
import { useState } from 'preact/hooks';
import compatibilityData from '../../data/compatibility.json';

export function CompatibilityMatrix() {
  const [filterQuery, setFilterQuery] = useState('');

  const filtered = compatibilityData.filter((item) =>
    item.capability.toLowerCase().includes(filterQuery.toLowerCase()) ||
    item.protocol.toLowerCase().includes(filterQuery.toLowerCase()) ||
    item.authority.toLowerCase().includes(filterQuery.toLowerCase())
  );

  const exportCsv = () => {
    const headers = ['Capability', 'Protocol', 'Gateway', 'SDK', 'Browser', 'Node', 'Offline', 'Transport', 'Authority', 'Signing'];
    const rows = filtered.map((r) => [
      `"${r.capability}"`,
      `"${r.protocol}"`,
      `"${r.gateway}"`,
      `"${r.sdk}"`,
      `"${r.browser}"`,
      `"${r.node}"`,
      `"${r.offline}"`,
      `"${r.transport}"`,
      `"${r.authority}"`,
      `"${r.signing}"`
    ]);
    const csvContent = [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ordex-compatibility-matrix-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ordex-compatibility-matrix-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="compatibility-matrix-container panel" style="padding: 1.25rem;">
      <div class="panel-header">
        <div>
          <h3 style="margin: 0; font-size: 1.15rem;">Protocol & Platform Compatibility Matrix</h3>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
            Complete capability matrix across protocol releases, runtimes, transports, and verifiers.
          </p>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <input
            type="text"
            value={filterQuery}
            onInput={(e) => setFilterQuery(e.target.value)}
            placeholder="Filter capabilities..."
            style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm);"
          />
          <button class="btn btn-outline" onClick={exportCsv} style="font-size: 0.8rem;">
            Export CSV
          </button>
          <button class="btn btn-outline" onClick={exportJson} style="font-size: 0.8rem;">
            Export JSON
          </button>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead>
            <tr style="background: var(--color-bg-subtle); border-bottom: 2px solid var(--color-border); text-align: left;">
              <th style="padding: 0.6rem 0.75rem;">Capability</th>
              <th style="padding: 0.6rem 0.75rem;">Protocol</th>
              <th style="padding: 0.6rem 0.75rem;">Gateway</th>
              <th style="padding: 0.6rem 0.75rem;">SDK</th>
              <th style="padding: 0.6rem 0.75rem;">Browser</th>
              <th style="padding: 0.6rem 0.75rem;">Node.js</th>
              <th style="padding: 0.6rem 0.75rem;">Offline</th>
              <th style="padding: 0.6rem 0.75rem;">Transport</th>
              <th style="padding: 0.6rem 0.75rem;">Authority</th>
              <th style="padding: 0.6rem 0.75rem;">Signing Boundary</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item, idx) => (
              <tr key={idx} style="border-bottom: 1px solid var(--color-border);">
                <td style="padding: 0.6rem 0.75rem; font-weight: 600;">{item.capability}</td>
                <td style="padding: 0.6rem 0.75rem; font-family: var(--font-mono);">{item.protocol}</td>
                <td style="padding: 0.6rem 0.75rem;"><span class="badge badge-verification">{item.gateway}</span></td>
                <td style="padding: 0.6rem 0.75rem;"><span class="badge badge-verification">{item.sdk}</span></td>
                <td style="padding: 0.6rem 0.75rem;">{item.browser}</td>
                <td style="padding: 0.6rem 0.75rem;">{item.node}</td>
                <td style="padding: 0.6rem 0.75rem;">{item.offline}</td>
                <td style="padding: 0.6rem 0.75rem;"><code>{item.transport}</code></td>
                <td style="padding: 0.6rem 0.75rem;"><span class="badge badge-observation">{item.authority}</span></td>
                <td style="padding: 0.6rem 0.75rem; color: var(--color-text-secondary); font-size: 0.8em;">{item.signing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
