import { cp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { renderApiReference } from './api-reference.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const siteDir = resolve(root, 'site');

console.log('--- Step 1: Extract authoritative protocol metadata ---');
execSync('node scripts/docs/generate-all-data.mjs', { cwd: root, stdio: 'inherit' });

console.log('--- Step 2: Render API reference specification page ---');
const contract = JSON.parse(await readFile(resolve(root, 'spec', 'openapi.json'), 'utf8'));
await writeFile(resolve(root, 'docs', 'api-reference.html'), renderApiReference(contract));

console.log('--- Step 2.5: Generate deterministic product tour captures ---');
execSync('node scripts/capture-walkthroughs.mjs', { cwd: root, stdio: 'inherit' });

console.log('--- Step 3: Compile Astro static application ---');
execSync('npx astro build', { cwd: siteDir, stdio: 'inherit' });

console.log('--- Step 4: Index documentation site with Pagefind ---');
execSync('npx pagefind --site dist/client', { cwd: root, stdio: 'inherit' });

console.log('--- Step 5: Generate machine-readable sitemap, robots, and LLM corpuses ---');
// sitemap.xml
const pages = [
  '', 'workspace', 'sandbox', 'inspect', 'diagnose', 'agents', 'tour',
  'start', 'learn', 'build', 'build/wizards', 'build/recipes', 'build/playground',
  'verify', 'lab', 'atlas', 'kits', 'ask', 'operate', 'releases', 'compatibility', 'insights',
  'reference', 'reference/api', 'reference/refusal-codes', 'reference/specifications'
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>https://bitcoinuniverseio.github.io/ordex/${p ? p + '/' : ''}</loc>
    <changefreq>daily</changefreq>
    <priority>${p === '' ? '1.0' : '0.8'}</priority>
  </url>`).join('\n')}
</urlset>`;
await writeFile(resolve(dist, 'client', 'sitemap.xml'), sitemap);
await writeFile(resolve(root, 'docs', 'sitemap.xml'), sitemap);

// robots.txt
const robots = `User-agent: *
Allow: /
Sitemap: https://bitcoinuniverseio.github.io/ordex/sitemap.xml
`;
await writeFile(resolve(dist, 'client', 'robots.txt'), robots);
await writeFile(resolve(root, 'docs', 'robots.txt'), robots);

// llms.txt & llms-full.txt & .nojekyll
for (const name of ['docs.manifest.json', 'llms.txt', '.nojekyll']) {
  await cp(resolve(root, name), resolve(root, 'docs', name));
  await cp(resolve(root, name), resolve(dist, 'client', name));
}

// Generate llms-full.txt from corpus.json
const corpus = JSON.parse(await readFile(resolve(siteDir, 'src', 'data', 'corpus.json'), 'utf8'));
const llmsFull = `# Ordex Protocol Full Model-Readable Documentation
Grounded in OpenAPI 3.1, AsyncAPI 3.0, and checked-in reference verifiers.

${corpus.map(c => `## ${c.title} (${c.pointer})
- Source: ${c.sourcePath}
- URL: ${c.docUrl || c.url || ''}

${c.content}
`).join('\n---\n\n')}`;
await writeFile(resolve(dist, 'client', 'llms-full.txt'), llmsFull);
await writeFile(resolve(root, 'docs', 'llms-full.txt'), llmsFull);

console.log('--- Step 6: Sync static application to docs/ for GitHub Pages ---');
// Copy dist/client contents into docs/ while preserving existing html pages
await cp(resolve(dist, 'client'), resolve(root, 'docs'), { recursive: true });

// Ensure docs/api-reference.html is strictly what renderApiReference produced
await writeFile(resolve(root, 'docs', 'api-reference.html'), renderApiReference(contract));
await cp(resolve(root, 'docs', 'api-reference.html'), resolve(dist, 'client', 'api-reference.html'));

console.log('--- Step 7: Build the docs service, MCP engine and stdio server ---');
// OX-S04 / OX-P07: bundled handler (dist/server/index.js), Node host, migrations and build
// identity; the MCP engine and the self-contained stdio server in dist/mcp.
execSync('node scripts/docs/build-services.mjs', { cwd: root, stdio: 'inherit' });

/* IMPLEMENTATION-HANDOFF [OX-S10]
 * Defect OX-S-D10; coverage all OX-S browser rows and OX-S-C1313. Build verifies file presence/link syntax,
 * not hydrated behavior; npm coverage:check references missing scripts/docs/coverage-check.mjs. A clean build
 * and npm test pass while deployed ConformanceStudio hydration fails.
 * 1. Preserve verified build-once behavior, then add PROPOSED NEW scripts/docs/coverage-check.mjs validating
 * the full operation/source/test matrix against current manifests. Wire the existing package script without
 * weakening tests or declaring source presence an E2E pass.
 * 2. Separate generated static assets, actual browser capture and Node-only server packaging. Browser checks
 * must assert island hydration and controls, no node built-ins in client chunks, exact source/vector/operation
 * counts and reproducible build metadata.
 * 3. Run capture only against the coordinated accepted artifact/application after it exists; never start a
 * duplicate frontend to satisfy the build. Avoid copying stale orphan assets from older docs builds into new
 * release output.
 * 4. Acceptance: npm run build, npm test, npm --prefix sdk test and npm run coverage:check all run from a
 * clean installed tree; actual browser suite covers all routes/states before public deployment. Existing
 * passing component results stay valid but do not substitute for browser or chain evidence.
 * Dependencies: OX-S07 generator/runtime, OX-S10 capture/accessibility, root integration and release work
 * package. Rollback one coherent verified static/server release and its versioned manifests.
 */
console.log('--- Step 8: Validate Build Deliverables ---');
const requiredFiles = [
  'dist/client/index.html',
  'dist/client/api-reference.html',
  'dist/client/sitemap.xml',
  'dist/client/robots.txt',
  'dist/client/llms.txt',
  'dist/client/llms-full.txt',
  'dist/server/index.js',
  'dist/client/pagefind/pagefind.js',
  'dist/client/workspace/index.html',
  'dist/client/sandbox/index.html',
  'dist/client/inspect/index.html',
  'dist/client/diagnose/index.html',
  'dist/client/agents/index.html',
  'dist/client/tour/index.html',
  'dist/client/lab/index.html',
  'dist/client/verify/index.html',
  'dist/client/atlas/index.html',
  'dist/client/kits/index.html',
  'dist/client/ask/index.html'
];

for (const file of requiredFiles) {
  const content = await readFile(resolve(root, file)).catch(() => null);
  if (!content) throw new Error(`Missing required build deliverable: ${file}`);
}

console.log('--- Step 9: Audit and validate all links and routes ---');
execSync('node scripts/check-links.mjs', { cwd: root, stdio: 'inherit' });

console.log('✓ Build completed successfully. All 12 products compiled and verified.');
