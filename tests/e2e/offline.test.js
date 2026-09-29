import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startStaticServer, launch } from './harness.mjs';

// OX-S12 browser gate with a real service worker under /ordex: first visit saves the build,
// offline direct navigation to another route works, an unsaved route is an honest 503, and
// the cache holds only this site's own static files.

let site;
let browser;
before(async () => {
  site = await startStaticServer();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await site?.close();
});

test('first visit saves the build; offline navigation uses it; nothing else is cached', { timeout: 120000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(site.url('/learn/'), { waitUntil: 'networkidle' });
  await page.locator('[data-offline-state="saved"]').waitFor({ timeout: 60000 });
  const cacheNames = await page.evaluate(() => caches.keys());
  assert.equal(cacheNames.length, 1);
  assert.match(cacheNames[0], /^ordex-static:\/ordex\/:[0-9a-f]{16}$/);
  const cachedPaths = await page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname), cacheNames[0]);
  assert.ok(cachedPaths.includes('/ordex/lab/index.html'));
  // Site pages such as /ordex/reference/api/ are cached; the docs service API under /ordex/api/ is not.
  assert.ok(cachedPaths.every((p) => p.startsWith('/ordex/') && !p.startsWith('/ordex/api/')));
  assert.ok(cachedPaths.includes('/ordex/reference/api/index.html'));

  await context.setOffline(true);
  const lab = await page.goto(site.url('/lab/'));
  assert.equal(lab.status(), 200);
  await page.getByText('You are offline.').waitFor().catch(async (err) => {
    // Say what the page saw, so a failure here names its cause.
    const seen = await page.evaluate(() => ({ onLine: navigator.onLine, controlled: !!navigator.serviceWorker.controller, status: document.querySelector('[data-offline-state]')?.outerHTML ?? null, islands: [...document.querySelectorAll('astro-island[ssr]')].map((i) => i.getAttribute('component-url')) }));
    throw new Error(`${err.message}\n${JSON.stringify(seen)}`);
  });
  await page.getByText(/pages, search and verifiers are saved/).waitFor();
  const missing = await page.goto(site.url('/no-such-page/'));
  assert.equal(missing.status(), 503);
  await context.close();
});
