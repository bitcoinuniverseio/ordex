// OX-S10: cross-checks what the site publishes against its sources and its tests. It proves
// agreement of counts and names, and that every route has a browser gate; it does not prove
// browser behavior (tests/e2e does that in CI) or chain acceptance.
//   node scripts/docs/coverage-check.mjs      (also run by npm run build, step 8)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_ROUTES } from '../../site/src/lib/docs/docs-contract.mjs';
import { loadAllFamilies } from './vector-loader.mjs';
import { scanRefusalSources } from './refusal-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));
const exists = (...p) => fs.existsSync(path.join(root, ...p));
const problems = [];
const rows = [];
const check = (name, ok, detail) => {
  rows.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) problems.push(`${name}: ${detail}`);
};
const pageFor = (route) => path.join('dist', 'client', ...route.split('/').filter(Boolean), 'index.html');
const built = exists('dist', 'client', 'index.html');

// 1. API operations: contract, generated data and the reference page.
const openapi = json('spec', 'openapi.json');
const contractOps = Object.values(openapi.paths).flatMap((m) => Object.values(m).map((o) => o.operationId)).filter(Boolean).sort();
const dataOps = json('site', 'src', 'data', 'operations.json').map((o) => o.operationId).sort();
check('operations in the contract and the generated data', JSON.stringify(contractOps) === JSON.stringify(dataOps), `${contractOps.length} contract, ${dataOps.length} generated`);
if (built) {
  const reference = read(pageFor('/reference/api/'));
  const missing = contractOps.filter((id) => !reference.includes(`id="${id}"`));
  check('operations on the API reference page', missing.length === 0, missing.length ? `missing ${missing.slice(0, 5).join(', ')}` : `${contractOps.length}`);
}

// 2. Conformance vectors: files, generated list and manifest.
const families = loadAllFamilies();
const sourceCount = Object.values(families).reduce((n, data) => n + (data.cases || data.vectors).length, 0);
const manifest = json('site', 'src', 'data', 'vectorManifest.json');
const allVectors = json('site', 'src', 'data', 'allVectors.json');
check('conformance vectors', sourceCount === manifest.total && sourceCount === allVectors.length, `${sourceCount} in files, ${manifest.total} in the manifest, ${allVectors.length} generated`);

// 3. Refusal codes: verifiers, rules and reproducers.
const codes = [...scanRefusalSources().keys()].sort();
const diagnostics = json('site', 'src', 'data', 'diagnostics.json');
const ruleCodes = diagnostics.map((d) => d.exactCodes[0]).sort();
check('refusal codes with diagnostic rules', JSON.stringify(codes) === JSON.stringify(ruleCodes), `${codes.length} returned by verifiers, ${ruleCodes.length} rules`);
const noRepro = diagnostics.filter((d) => !d.reproducers?.length).map((d) => d.exactCodes[0]);
check('rules with an executed reproducer', noRepro.length === 0, noRepro.length ? noRepro.join(', ') : `${diagnostics.length}`);

// 4. MCP tools: each advertised tool is exercised by the engine and the HTTP tests.
const serverSource = read('site', 'src', 'lib', 'mcp', 'server.ts');
const toolsBlock = serverSource.slice(serverSource.indexOf('export const MCP_TOOLS'), serverSource.indexOf('export const MCP_RESOURCES'));
const tools = [...toolsBlock.matchAll(/name: '(ordex\.[a-z_]+)'/g)].map((m) => m[1]);
const mcpTests = read('tests', 'unit', 'mcp-server.test.js') + read('tests', 'integration', 'mcp-worker.test.js');
const untested = tools.filter((t) => !mcpTests.includes(`'${t}'`));
check('MCP tools with tests', tools.length === 10 && untested.length === 0, `${tools.length} tools${untested.length ? `, untested ${untested.join(', ')}` : ''}`);

// 5. Routes: every published route is built and has a browser gate.
if (built) {
  const unbuilt = SITE_ROUTES.filter((r) => !exists(pageFor(r)));
  check('routes built', unbuilt.length === 0, unbuilt.length ? unbuilt.join(', ') : `${SITE_ROUTES.length}`);
}
const nav = exists('tests', 'e2e', 'navigation-accessibility.test.js') ? read('tests', 'e2e', 'navigation-accessibility.test.js') : '';
check('every route in the accessibility gate', nav.includes('SITE_ROUTES'), 'tests/e2e/navigation-accessibility.test.js iterates SITE_ROUTES');
const TOOL_GATES = {
  '/lab/': 'lab.test.js',
  '/verify/': 'doctor.test.js',
  '/sandbox/': 'sandbox.test.js',
  '/inspect/': 'inspect.test.js',
  '/diagnose/': 'diagnose.test.js',
  '/agents/': 'agents.test.js',
  '/kits/': 'kits.test.js',
  '/build/playground/': 'api-playground.test.js',
  '/workspace/': 'missions.test.js',
  '/tour/': 'tours.test.js',
  '/ask/': 'docs-services.test.js',
  '/insights/': 'docs-services.test.js',
  '/build/wizards/': 'wizards.test.js',
  '/build/recipes/': 'wizards.test.js'
};
for (const [route, file] of Object.entries(TOOL_GATES)) {
  const ok = exists('tests', 'e2e', file) && read('tests', 'e2e', file).includes(route.replace(/\/$/, ''));
  check(`functional browser gate for ${route}`, ok, `tests/e2e/${file}`);
}

// 6. Tours: every step runs on a published route; targets rendered by the server are in the page.
const tours = json('site', 'src', 'lib', 'experience', 'tours.json');
for (const tour of tours) {
  for (const step of tour.steps) {
    const route = step.route.split('?')[0];
    const onRoute = SITE_ROUTES.includes(route.endsWith('/') ? route : `${route}/`);
    let detail = route;
    let ok = onRoute;
    if (ok && built && !step.hint) {
      ok = read(pageFor(route)).includes(`data-tour="${step.target}"`);
      detail = `${route} ${ok ? 'has' : 'lacks'} data-tour="${step.target}"`;
    }
    check(`tour ${tour.id}/${step.id}`, ok, detail);
  }
}
// 7. Offline: the service worker lists exactly the built files.
if (built && exists('dist', 'client', 'sw.js')) {
  const sw = read('dist', 'client', 'sw.js');
  const m = JSON.parse(sw.match(/const MANIFEST = (\{.*?\});\n/s)[1]);
  const walk = (d) => fs.readdirSync(d).flatMap((n) => (fs.statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
  const onDisk = walk(path.join(root, 'dist', 'client')).map((f) => path.relative(path.join(root, 'dist', 'client'), f).split(path.sep).join('/')).filter((f) => f !== 'sw.js').sort();
  check('service worker precache list', JSON.stringify(onDisk) === JSON.stringify(m.files), `${m.files.length} listed, ${onDisk.length} built`);
}
const captures = json('site', 'src', 'data', 'tourCaptures.json');
const missingFiles = Object.values(captures.captures).flat().filter((c) => !exists('site', 'public', ...c.file.split('/')));
check('tour screenshots on disk', missingFiles.length === 0, `${Object.values(captures.captures).flat().length} listed${missingFiles.length ? `, missing ${missingFiles.length}` : ''}`);

console.log(rows.join('\n'));
if (problems.length) {
  console.error(`\nCoverage check failed: ${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`\nCoverage check passed (${rows.length} checks${built ? '' : '; build outputs not present, page checks skipped'}).`);
