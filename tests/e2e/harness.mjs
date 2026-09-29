// Browser gate harness (OX-S07, OX-S10). Serves the built dist/client under the /ordex base
// with a plain static file server and drives it with Playwright Chromium. These tests run
// in CI on the self-hosted runners (npm run test:browser); Playwright is not run on the
// shared development host.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST = join(ROOT, 'dist', 'client');
export const BASE = '/ordex';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.pf_meta': 'application/octet-stream',
  '.pf_index': 'application/octet-stream',
  '.pf_fragment': 'application/octet-stream'
};

export async function startStaticServer({ base = BASE, dist = DIST } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith(base)) {
        res.writeHead(404).end('not found');
        return;
      }
      let rel = decodeURIComponent(url.pathname.slice(base.length)) || '/';
      rel = normalize(rel).replace(/^([/\\])+/, '');
      let file = join(dist, rel);
      if (!file.startsWith(dist)) {
        res.writeHead(403).end();
        return;
      }
      const info = await stat(file).catch(() => null);
      if (info?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file).catch(() => null);
      if (!body) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, url: (p = '/') => `http://127.0.0.1:${port}${base}${p}`, close: () => new Promise((r) => server.close(r)) };
}

export async function launch() {
  const { chromium } = await import('playwright');
  return chromium.launch();
}

/** Open a page that records uncaught errors, console errors and failed requests. */
export async function openPage(browser, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await waitForHydration(page);
  return { page, context, errors };
}

/** Astro removes the ssr attribute from an island once it has hydrated. */
export async function waitForHydration(page, timeout = 15000) {
  await page.waitForFunction(() => [...document.querySelectorAll('astro-island')].every((el) => !el.hasAttribute('ssr')), null, { timeout });
}
