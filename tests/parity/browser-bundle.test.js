import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { runConformanceSuite, FAMILIES } from '../../site/src/lib/conformance-engine.mjs';
import { loadAllFamilies } from '../../scripts/docs/vector-loader.mjs';

// OX-S07 / OX-S10: checks against the built client bundle (npm run build first). Deployed
// /verify and /lab failed to hydrate because Vite replaced node:url and node:fs with empty
// stubs; these gates fail on any such stub and run the shipped verifier Worker bundle in a
// context with no Node globals, comparing it case by case with the CLI.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = join(root, 'dist', 'client', 'assets');

async function builtAssets() {
  await access(assets).catch(() => {
    throw new Error('dist/client/assets is missing: run npm run build before npm test');
  });
  return (await readdir(assets)).filter((f) => f.endsWith('.js'));
}

test('no client chunk imports a Node built-in or a Vite browser-external stub', async () => {
  const offenders = [];
  const files = await builtAssets();
  for (const file of files.filter((f) => f.startsWith('__vite-browser-external'))) offenders.push(`${file}: stub chunk emitted`);
  for (const file of files) {
    const src = await readFile(join(assets, file), 'utf8');
    if (/__vite-browser-external/.test(src)) offenders.push(`${file}: vite browser-external stub`);
    // Minified import statements look like from"node:fs" or import("node:fs"); template text
    // inside generated starter kits (import x from 'node:test') is content, not an import.
    if (/from"node:|import\("node:/.test(src)) offenders.push(`${file}: node: import`);
  }
  assert.deepEqual(offenders, []);
});

async function loadWorkerBundle() {
  const files = (await builtAssets()).filter((f) => f.startsWith('verifier-worker'));
  assert.equal(files.length, 1, `expected one verifier Worker bundle, found ${files.join(', ')}`);
  const src = await readFile(join(assets, files[0]), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s|\bimport\s*\{|export\s*\{/m, 'the Worker bundle must be self-contained');
  return { file: files[0], src };
}

// A browser-like global scope: no process, Buffer, require or node:crypto.
function runInBrowserLikeWorker(src, job) {
  const posted = [];
  const self = { postMessage: (m) => posted.push(structuredClone(m)), onmessage: null };
  const context = vm.createContext({
    self,
    TextEncoder,
    TextDecoder,
    performance: { now: () => performance.now() },
    btoa,
    atob,
    console
  });
  vm.runInContext(src, context, { timeout: 30000 });
  assert.equal(typeof self.onmessage, 'function', 'the Worker bundle did not install onmessage');
  self.onmessage({ data: { id: 1, job } });
  return posted;
}

test('the shipped Worker bundle runs every vector with the exact CLI verdicts', async () => {
  const { src } = await loadWorkerBundle();
  const data = loadAllFamilies();
  const posted = runInBrowserLikeWorker(src, { type: 'suite', familiesData: data, families: FAMILIES });
  const final = posted.at(-1);
  assert.equal(final.type, 'result', JSON.stringify(final.error || {}));
  const browser = final.result;
  const cli = runConformanceSuite(data, FAMILIES);
  assert.equal(browser.total, 157);
  assert.equal(browser.total, cli.total);
  assert.equal(browser.failed, 0);
  cli.results.forEach((a, i) => {
    const b = browser.results[i];
    assert.equal(b.name, a.name);
    assert.equal(b.variant, a.variant);
    assert.equal(b.passed, a.passed, `${a.family}/${a.name}`);
    assert.deepEqual(b.verdict, a.verdict, `${a.family}/${a.name}`);
    assert.deepEqual(b.actual, a.actual, `${a.family}/${a.name}`);
  });
});

test('the shipped Worker bundle refuses malformed and oversized candidates with typed errors', async () => {
  const { src } = await loadWorkerBundle();
  const missing = runInBrowserLikeWorker(src, { type: 'candidate', family: 'offers', variant: 'acceptance', args: { acceptance: {} } }).at(-1);
  assert.equal(missing.type, 'error');
  assert.equal(missing.error.code, 'MISSING_ARGUMENTS');
  const huge = runInBrowserLikeWorker(src, { type: 'candidate', family: 'safeops', variant: 'plan', args: { plan: { x: 'y'.repeat(3 * 1024 * 1024) } } }).at(-1);
  assert.equal(huge.error.code, 'INPUT_TOO_LARGE');
  const unknown = runInBrowserLikeWorker(src, { type: 'case', family: 'nope', vectorCase: {} }).at(-1);
  assert.equal(unknown.error.code, 'UNKNOWN_FAMILY');
});

test('the Lab and Studio islands load the verifier through the Worker, not on the page thread', async () => {
  const files = await builtAssets();
  for (const prefix of ['ProtocolLab', 'ConformanceStudio']) {
    const file = files.find((f) => f.startsWith(prefix));
    assert.ok(file, `${prefix} chunk missing`);
    const src = await readFile(join(assets, file), 'utf8');
    assert.doesNotMatch(src, /Expected inputs and outputs arrays./, `${prefix} bundles verifier code on the page thread`);
  }
  const client = files.find((f) => f.startsWith('verifier-client'));
  const clientSrc = await readFile(join(assets, client), 'utf8');
  assert.match(clientSrc, /new Worker\(new URL\([`'"]\/ordex\/assets\/verifier-worker-[^`'"]+\.js[`'"]/);
});
