import { cp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
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

console.log('--- Step 3: Compile Astro static application ---');
execSync('npx astro build', { cwd: siteDir, stdio: 'inherit' });

console.log('--- Step 4: Index documentation site with Pagefind ---');
execSync('npx pagefind --site dist/client', { cwd: root, stdio: 'inherit' });

console.log('--- Step 5: Generate machine-readable sitemap, robots, and LLM corpuses ---');
// sitemap.xml
const pages = [
  '', 'start', 'learn', 'build', 'build/wizards', 'build/recipes', 'build/playground',
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

// llms.txt & llms-full.txt
for (const name of ['docs.manifest.json', 'llms.txt']) {
  await cp(resolve(root, name), resolve(root, 'docs', name));
  await cp(resolve(root, name), resolve(dist, 'client', name));
}

// Generate llms-full.txt from corpus.json
const corpus = JSON.parse(await readFile(resolve(siteDir, 'src', 'data', 'corpus.json'), 'utf8'));
const llmsFull = `# Ordex Protocol Full Model-Readable Documentation
Grounded in OpenAPI 3.1, AsyncAPI 3.0, and checked-in reference verifiers.

${corpus.map(c => `## ${c.title} (${c.pointer})
- Source: ${c.sourcePath}
- URL: ${c.docUrl || c.canonicalUrl || ''}

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

console.log('--- Step 7: Prepare Server Deployment Assets ---');
await mkdir(resolve(dist, 'server'), { recursive: true });
await cp(resolve(root, 'worker', 'index.js'), resolve(dist, 'server', 'index.js'));
if (await readFile(resolve(root, 'worker', 'migrations', '0001_initial.sql')).catch(() => null)) {
  await cp(resolve(root, 'worker', 'migrations'), resolve(dist, 'server', 'migrations'), { recursive: true });
}

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

console.log('✓ Build completed successfully. All 12 products compiled and verified.');
