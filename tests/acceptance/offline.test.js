import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { launch, DIST, waitForHydration } from '../e2e/harness.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for Offline/PWA (OX-S-C1500..C1505) with the real service worker under
// /ordex. The build's sw.js can be replaced per test with a next version or with one whose
// manifest names a missing file, so updates and failed installs run through the browser's own
// service worker lifecycle.

const rows = rowsOf('Offline/PWA');
const row = (prefix) => rows.find((r) => r.operation.startsWith(prefix)).id;
const rec = rowRecorder('tests/acceptance/offline.test.js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.txt': 'text/plain', '.xml': 'application/xml' };

let site;
let browser;
let swOverride = null;
const hits = [];
before(async () => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    if (!url.pathname.startsWith('/ordex')) return res.writeHead(404).end();
    if (url.pathname === '/ordex/sw.js' && swOverride) return res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(swOverride);
    if (url.pathname.startsWith('/ordex/api/')) return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"ok":true,"live":true}');
    let rel = normalize(decodeURIComponent(url.pathname.slice('/ordex'.length)) || '/').replace(/^[/\\]+/, '');
    let file = join(DIST, rel);
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  site = { origin, url: (p) => `${origin}/ordex${p}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await site?.close();
});

const originalSw = () => readFile(join(DIST, 'sw.js'), 'utf8');
const saved = (page) => page.locator('[data-offline-state="saved"]').waitFor({ state: 'attached', timeout: 60000 });

test('Offline/PWA rows', { timeout: 600000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(site.url('/learn/'), { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await (await caches.open('another-app-cache')).put('/another-app/data.json', new Response('{"kept":true}'));
    await caches.open('ordex-static:/another-scope/:0000000000000000');
  });

  await rec.check(row('Register worker'), 'the service worker registers at /ordex/ and saves this build', async () => {
    await saved(page);
    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return { scope: r?.scope, active: !!r?.active, script: r?.active?.scriptURL };
    });
    expect(reg.scope === `${site.origin}/ordex/` && reg.active, JSON.stringify(reg));
    const names = await page.evaluate(() => caches.keys());
    const mine = names.filter((n) => n.startsWith('ordex-static:/ordex/:'));
    expect(mine.length === 1 && /^ordex-static:\/ordex\/:[0-9a-f]{16}$/.test(mine[0]), names.join(', '));
    return { ...reg, cache: mine[0] };
  });

  await rec.check(row('No API/MCP/auth/gateway'), 'only this build\'s static files are cached', async () => {
    await page.evaluate(() => fetch('/ordex/api/docs/insights?range=7d').then((r) => r.text()));
    const name = (await page.evaluate(() => caches.keys())).find((n) => n.startsWith('ordex-static:/ordex/:'));
    const paths = await page.evaluate(async (n) => (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname), name);
    const bad = paths.filter((p) => !p.startsWith('/ordex/') || p.startsWith('/ordex/api/') || p.startsWith('/ordex/mcp'));
    expect(bad.length === 0, `cached: ${bad.join(', ')}`);
    const manifest = JSON.parse((await originalSw()).match(/const MANIFEST = (\{.*\});/)[1]);
    expect(paths.length === manifest.files.length, `cached ${paths.length} of ${manifest.files.length}`);
    return { cached: paths.length, api: 'not cached' };
  });

  await rec.check(row('Offline direct navigation'), 'offline: direct navigation, search and a Lab run', async () => {
    await context.setOffline(true);
    const lab = await page.goto(site.url('/lab/'));
    expect(lab.status() === 200, `lab ${lab.status()}`);
    await page.getByText('You are offline.').waitFor({ timeout: 15000 });
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run reference verifier' }).click();
    await page.getByText(/by the reference verifier/).waitFor({ timeout: 20000 });
    const learn = await page.goto(site.url('/learn/'));
    expect(learn.status() === 200, `learn ${learn.status()}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: /Search documentation/ }).first().click();
    await page.getByRole('dialog', { name: 'Search Ordex Documentation' }).getByPlaceholder(/Search operations/).fill('sighash');
    await page.getByRole('dialog', { name: 'Search Ordex Documentation' }).locator('.search-result-item').first().waitFor({ timeout: 15000 });
    const missing = await page.goto(site.url('/no-such-page/'));
    expect(missing.status() === 503, `unsaved route ${missing.status()}`);
    await context.setOffline(false);
    return { lab: 200, learn: 200, search: 'results', unsaved: 503 };
  });

  await rec.check(row('Failed install/update/reconnect'), 'reconnect clears the banner; a failed update keeps the saved build and says so', async () => {
    await page.goto(site.url('/learn/'), { waitUntil: 'networkidle' });
    expect((await page.getByText('You are offline.').count()) === 0, 'offline banner stayed after reconnect');
    const sw = await originalSw();
    swOverride = sw.replace(/"version":"[0-9a-f]{16}"/, '"version":"ffffffffffffffff"').replace('"files":[', '"files":["no-such-file.js",');
    const before = await page.evaluate(() => caches.keys());
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update().catch(() => {}));
    await page.waitForTimeout(3000);
    const after = await page.evaluate(() => caches.keys());
    expect(!after.some((n) => n.endsWith(':ffffffffffffffff')), 'a partial cache of the failed version was kept');
    expect(after.some((n) => before.includes(n) && n.startsWith('ordex-static:/ordex/:')), 'the saved build was dropped');
    const fresh = await browser.newContext();
    const p2 = await fresh.newPage();
    await p2.goto(site.url('/learn/'), { waitUntil: 'networkidle' });
    await p2.locator('[data-offline-state="failed"]').waitFor({ state: 'attached', timeout: 60000 });
    const said = await p2.locator('[data-offline-state="failed"]').innerText();
    expect(/Offline copy unavailable/.test(said), said);
    await fresh.close();
    swOverride = null;
    return { failedUpdate: 'previous build kept', failedInstall: said.slice(0, 120) };
  });

  await rec.check(row('Build update serves coherent'), 'a new build waits, then takes over on request with a complete fresh cache', async () => {
    const sw = await originalSw();
    swOverride = sw.replace(/"version":"[0-9a-f]{16}"/, '"version":"eeeeeeeeeeeeeeee"');
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.getByText('A new version of these pages is ready.').waitFor({ timeout: 60000 });
    await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.getByRole('button', { name: 'Reload to update' }).click()]);
    await page.waitForFunction(async () => (await caches.keys()).some((n) => n.endsWith(':eeeeeeeeeeeeeeee')), null, { timeout: 30000 });
    const names = await page.evaluate(() => caches.keys());
    const ordex = names.filter((n) => n.startsWith('ordex-static:/ordex/:'));
    expect(ordex.length === 1 && ordex[0].endsWith(':eeeeeeeeeeeeeeee'), `caches ${names.join(', ')}`);
    const count = await page.evaluate(async (n) => (await (await caches.open(n)).keys()).length, ordex[0]);
    const manifest = JSON.parse(swOverride.match(/const MANIFEST = (\{.*\});/)[1]);
    expect(count === manifest.files.length, `new cache holds ${count} of ${manifest.files.length}`);
    swOverride = null;
    return { newCache: ordex[0], files: count };
  });

  await rec.check(row('Other applications'), 'caches of other applications and other scopes survive install and update', async () => {
    const names = await page.evaluate(() => caches.keys());
    expect(names.includes('another-app-cache') && names.includes('ordex-static:/another-scope/:0000000000000000'), names.join(', '));
    const kept = await page.evaluate(async () => (await (await caches.open('another-app-cache')).match('/another-app/data.json'))?.text());
    expect(kept === '{"kept":true}', `content ${kept}`);
    return { kept: ['another-app-cache', 'ordex-static:/another-scope/:0000000000000000'] };
  });

  await context.close();
  assert.deepEqual(rec.failures(), []);
});
