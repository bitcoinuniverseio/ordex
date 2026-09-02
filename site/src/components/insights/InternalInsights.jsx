import { h } from 'preact';
import { useState } from 'preact/hooks';

export function InternalInsights() {
  const [timeRange, setTimeRange] = useState('7d');

  // Aggregated first-party documentation intelligence metrics
  const mockInsights = {
    totalViews: 42850,
    searchQueries: 12400,
    wizardsStarted: 3820,
    wizardsCompleted: 2950,
    completionRate: '77.2%',
    topPages: [
      { path: '/quickstart', views: 9800, title: 'Quickstart & First Order' },
      { path: '/build/recipes/publish-ask', views: 7600, title: 'Publish Portable Public Ask' },
      { path: '/reference/api', views: 6900, title: 'API Reference & Playground' },
      { path: '/lab', views: 5400, title: 'Ordex Protocol Lab' },
      { path: '/atlas', views: 4200, title: 'Visual Protocol Atlas' }
    ],
    topWizards: [
      { name: 'Choose Your Ordex Integration', starts: 1450, completions: 1220, rate: '84.1%' },
      { name: 'Publish a Portable Public Ask', starts: 1100, completions: 920, rate: '83.6%' },
      { name: 'Purchase One or More Public Asks', starts: 850, completions: 640, rate: '75.3%' },
      { name: 'Plan a SafeOps Operation', starts: 420, completions: 170, rate: '40.5%' }
    ],
    commonRefusalSearches: [
      { code: 'SAT_FLOW_SHORTFALL', count: 820 },
      { code: 'SELLER_OUTPUT_MISSING', count: 640 },
      { code: 'CENOTAPH_BURNS_BALANCE', count: 410 },
      { code: 'RECOVERY_BEFORE_EXPIRY', count: 290 }
    ],
    feedbackSummary: {
      helpful: 412,
      not_helpful: 18,
      unclear: 34,
      outdated: 4,
      missing_example: 28,
      broken_workflow: 6,
      other: 12
    }
  };

  return (
    <div class="insights-container panel" style="padding: 1.5rem;">
      <div class="panel-header">
        <div>
          <h3 style="margin: 0; font-size: 1.25rem;">Documentation Intelligence & Reader Insights</h3>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
            First-party aggregated metrics without cookies, IP addresses, or cross-site tracking.
          </p>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          {['24h', '7d', '30d'].map((r) => (
            <button
              key={r}
              class={`btn ${timeRange === r ? 'btn-primary' : 'btn-outline'}`}
              style="font-size: 0.8rem; min-height: 28px; padding: 0.2rem 0.6rem;"
              onClick={() => setTimeRange(r)}
            >
              Last {r}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
        <div class="panel" style="background: var(--color-bg-subtle); padding: 1rem;">
          <div style="font-size: 0.8rem; color: var(--color-text-muted);">Total Documentation Views</div>
          <div style="font-size: 1.8rem; font-weight: 800; color: var(--color-brand);">{mockInsights.totalViews.toLocaleString()}</div>
        </div>
        <div class="panel" style="background: var(--color-bg-subtle); padding: 1rem;">
          <div style="font-size: 0.8rem; color: var(--color-text-muted);">Total Searches</div>
          <div style="font-size: 1.8rem; font-weight: 800; color: var(--color-focus);">{mockInsights.searchQueries.toLocaleString()}</div>
        </div>
        <div class="panel" style="background: var(--color-bg-subtle); padding: 1rem;">
          <div style="font-size: 0.8rem; color: var(--color-text-muted);">Wizard Completion Rate</div>
          <div style="font-size: 1.8rem; font-weight: 800; color: var(--color-success);">{mockInsights.completionRate}</div>
        </div>
        <div class="panel" style="background: var(--color-bg-subtle); padding: 1rem;">
          <div style="font-size: 0.8rem; color: var(--color-text-muted);">Reader Satisfaction</div>
          <div style="font-size: 1.8rem; font-weight: 800; color: var(--color-brand);">93.4%</div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
        {/* Top Pages */}
        <div>
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">Most Viewed Documentation</h4>
          <div style="display: flex; flex-direction: column; gap: 0.4rem;">
            {mockInsights.topPages.map((p) => (
              <div key={p.path} style="display: flex; justify-content: space-between; padding: 0.4rem 0.6rem; background: var(--color-bg-subtle); border-radius: 4px; font-size: 0.85rem;">
                <span style="font-weight: 600;">{p.title}</span>
                <span style="font-family: var(--font-mono); color: var(--color-text-muted);">{p.views.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Common Refusal Code Lookups */}
        <div>
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">Top Refusal Code Lookups</h4>
          <div style="display: flex; flex-direction: column; gap: 0.4rem;">
            {mockInsights.commonRefusalSearches.map((r) => (
              <div key={r.code} style="display: flex; justify-content: space-between; padding: 0.4rem 0.6rem; background: var(--color-bg-subtle); border-radius: 4px; font-size: 0.85rem;">
                <code style="color: var(--color-danger);">{r.code}</code>
                <span style="font-family: var(--font-mono); color: var(--color-text-muted);">{r.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
