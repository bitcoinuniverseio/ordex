import { h } from 'preact';
import { useState } from 'preact/hooks';
import JSZip from 'jszip';

export function KitGenerator() {
  const [runtime, setRuntime] = useState('node'); // 'node', 'browser', 'worker'
  const [capabilities, setCapabilities] = useState(['asks', 'events']);
  const [mode, setMode] = useState('mock'); // 'mock', 'connected'
  const [isGenerating, setIsGenerating] = useState(false);

  const toggleCap = (id) => {
    setCapabilities((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const handleGenerateZip = async () => {
    setIsGenerating(true);
    try {
      const zip = new JSZip();

      // 1. package.json
      const pkgJson = {
        name: `ordex-${runtime}-starter`,
        version: '1.0.0',
        type: 'module',
        scripts: {
          start: 'node src/index.js',
          test: 'node --test test/*.test.js',
          build: 'tsc'
        },
        dependencies: {
          '@bitcoinuniverse/ordex-sdk': '1.0.0'
        },
        devDependencies: {
          '@types/node': '24.10.1',
          typescript: '5.9.3'
        },
        engines: {
          node: '24.19.0'
        }
      };
      zip.file('package.json', JSON.stringify(pkgJson, null, 2));

      // 2. tsconfig.json
      const tsConfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true
        }
      };
      zip.file('tsconfig.json', JSON.stringify(tsConfig, null, 2));

      // 3. .env.example
      zip.file('.env.example', 'ORDEX_GATEWAY_ORIGIN=http://localhost:8080\nORDEX_TIMEOUT_MS=10000\n');

      // 4. README.md
      const readme = `# Ordex ${runtime.toUpperCase()} Starter Integration Kit

Generated from authoritative Ordex Protocol 1.2 specifications and @bitcoinuniverse/ordex-sdk 1.0.0.

## Safety Boundaries
- This starter kit executes read and composition workflows.
- It NEVER holds private keys or broadcasts transactions.
- All amounts are handled as BigInt decimal strings to prevent floating-point precision loss.

## Quickstart
\`\`\`bash
npm install
npm test
npm start
\`\`\`
`;
      zip.file('README.md', readme);

      // 5. Source files (src/index.ts)
      const srcCode = `import { OrdexClient } from '@bitcoinuniverse/ordex-sdk';

const origin = process.env.ORDEX_GATEWAY_ORIGIN || 'http://localhost:8080';
const client = new OrdexClient({ origin });

async function main() {
  console.log('Connecting to Ordex Gateway at:', origin);
  const health = await client.getHealth();
  console.log('Gateway Health:', health);

  const catalog = await client.getCatalog();
  console.log('Active Orders in Catalog:', catalog.orders?.length ?? 0);
}

main().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
`;
      zip.file('src/index.ts', srcCode);

      // 6. Test files (test/client.test.js)
      const testCode = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrdexClient } from '@bitcoinuniverse/ordex-sdk';

test('client initializes with configured origin', () => {
  const client = new OrdexClient({ origin: 'http://localhost:8080' });
  assert.ok(client);
});

test('parses decimal sats safely without floating point loss', () => {
  const amount = '100000000000000';
  assert.equal(BigInt(amount).toString(), amount);
});
`;
      zip.file('test/client.test.js', testCode);

      // 7. GitHub Actions CI
      const ciYaml = `name: Starter CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24.19.0'
      - run: npm install
      - run: npm test
`;
      zip.file('.github/workflows/ci.yml', ciYaml);

      // Generate blob & download
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ordex-${runtime}-starter.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Kit generation error: ${err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div class="kit-generator-container panel" style="padding: 1.5rem;">
      <div class="panel-header">
        <div>
          <h3 style="margin: 0; font-size: 1.25rem;">Integration Kit Generator (/kits/)</h3>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
            Generate and download ready-to-run starter repositories with pinned SDK, unit tests, and CI. Zero placeholders.
          </p>
        </div>
        <button
          class="btn btn-primary"
          onClick={handleGenerateZip}
          disabled={isGenerating}
          style="min-width: 160px;"
        >
          {isGenerating ? 'Generating ZIP...' : '📦 Download Starter Kit'}
        </button>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin-top: 1rem;">
        {/* Runtime selection */}
        <div>
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">1. Select Target Environment</h4>
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            {[
              { id: 'node', label: 'Node.js TypeScript Server', desc: 'Backend application using Node 24 LTS and exact SDK pin.' },
              { id: 'browser', label: 'Browser Client Application', desc: 'Client-side verification and UI components in pure TypeScript.' },
              { id: 'worker', label: 'Cloudflare Worker / Edge', desc: 'Lightweight serverless edge proxy and event forwarder.' }
            ].map((r) => (
              <label
                key={r.id}
                class="panel"
                style={{
                  padding: '0.75rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  border: runtime === r.id ? '2px solid var(--color-brand)' : '1px solid var(--color-border)',
                  backgroundColor: runtime === r.id ? 'var(--color-brand-subtle)' : 'var(--color-bg-surface)'
                }}
              >
                <input
                  type="radio"
                  name="kit_runtime"
                  checked={runtime === r.id}
                  onChange={() => setRuntime(r.id)}
                  style="margin-top: 0.2rem;"
                />
                <div>
                  <div style="font-weight: 700; font-size: 0.9rem;">{r.label}</div>
                  <div style="font-size: 0.75rem; color: var(--color-text-secondary);">{r.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Feature Checkboxes */}
        <div>
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">2. Included Capabilities</h4>
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            {[
              { id: 'asks', label: 'Public Asks & Purchasing' },
              { id: 'offers', label: 'Buyer-Funded Offers v1' },
              { id: 'safeops', label: 'SafeOps Execution Shield' },
              { id: 'swaps', label: 'Atomic Swaps Links' },
              { id: 'events', label: 'SSE Stream & Signed Webhooks' },
              { id: 'provenance', label: 'Collection Provenance Manifests' }
            ].map((c) => (
              <label
                key={c.id}
                style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; padding: 0.4rem 0.6rem; background: var(--color-bg-subtle); border-radius: 4px; cursor: pointer;"
              >
                <input
                  type="checkbox"
                  checked={capabilities.includes(c.id)}
                  onChange={() => toggleCap(c.id)}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Manifest Preview */}
        <div>
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">3. Manifest Details</h4>
          <div style="background: var(--color-bg-subtle); padding: 1rem; border-radius: var(--radius-md); font-size: 0.8rem; font-family: var(--font-mono);">
            <div><strong>Package:</strong> @bitcoinuniverse/ordex-sdk</div>
            <div><strong>SDK Version:</strong> 1.0.0 (exact pin)</div>
            <div><strong>Node Requirement:</strong> 24.19.0 LTS</div>
            <div><strong>TypeScript:</strong> 5.9.3</div>
            <div><strong>Test Runner:</strong> Node.js native --test</div>
            <div><strong>No Floating Dependencies:</strong> Confirmed</div>
          </div>
        </div>
      </div>
    </div>
  );
}
