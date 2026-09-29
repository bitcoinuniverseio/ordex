/**
 * OX-S10: real tour screenshots.
 *
 * Serves the built site (dist/client, from npm run build) on a loopback port under /ordex,
 * opens every tour step in Chromium through the live tour overlay, waits until the step's
 * [data-tour] target is found and highlighted, and captures the viewport in three variants.
 * A step fails the run when its target is missing, the page logs an error or a request fails;
 * nothing is drawn or simulated. Writes PNGs and site/src/data/tourCaptures.json with the
 * revision, route, viewport, theme, digest and hotspot of each capture.
 *
 *   node scripts/capture-walkthroughs.mjs                  write into site/public/assets/tours
 *   node scripts/capture-walkthroughs.mjs --out <dir>      write elsewhere (CI check), no manifest
 *
 * Needs Playwright with Chromium (npx playwright install chromium); runs on a CI runner or a
 * workstation with a browser, never as part of npm run build.
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'dist', 'client');
const BASE = '/ordex';
const args = process.argv.slice(2);
const outArg = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : null;
const outDir = outArg || join(root, 'site', 'public', 'assets', 'tours');
const writeManifest = !outArg;

export const VARIANTS = [
  { id: 'desktop-light', viewport: { width: 1280, height: 800 }, theme: 'light' },
  { id: 'desktop-dark', viewport: { width: 1280, height: 800 }, theme: 'dark' },
  { id: 'mobile-light', viewport: { width: 375, height: 812 }, theme: 'light' }
];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml', '.wasm': 'application/wasm' };

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(`${BASE}/`) && url.pathname !== BASE) return res.writeHead(404).end();
    let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || '/';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(DIST, rel));
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    const target = existsSync(file) ? file : existsSync(`${file}/index.html`) ? `${file}/index.html` : null;
    if (!target) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(target)] || 'application/octet-stream' }).end(readFileSync(target));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

function stepUrl(origin, tour, index) {
  const url = new URL(`${BASE}${tour.steps[index].route}`, origin);
  url.searchParams.set('tour', tour.id);
  url.searchParams.set('step', String(index + 1));
  return url.href;
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/client is missing: run npm run build first.');
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright is not installed. Captures run where Playwright and Chromium are available.');
  }
  const tours = JSON.parse(readFileSync(join(root, 'site', 'src', 'lib', 'experience', 'tours.json'), 'utf8'));
  const revision = (() => {
    try {
      return process.env.GITHUB_SHA || execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
    } catch {
      return 'unknown';
    }
  })();
  const site = await serve();
  const browser = await chromium.launch();
  const manifest = { schema: 'ordex.tour-captures/v1', revision, capturedAt: new Date().toISOString(), captures: {} };
  const failures = [];
  try {
    if (writeManifest) rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const tour of tours) {
      for (const [index, step] of tour.steps.entries()) {
        for (const variant of VARIANTS) {
          const context = await browser.newContext({ viewport: variant.viewport, colorScheme: variant.theme, reducedMotion: 'reduce' });
          await context.addInitScript((theme) => {
            try {
              localStorage.setItem('ordex_theme', theme);
            } catch {}
          }, variant.theme);
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
          page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
          page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
          const label = `${tour.id}/${step.id} ${variant.id}`;
          try {
            await page.goto(stepUrl(site.origin, tour, index), { waitUntil: 'networkidle' });
            await page.waitForFunction(() => [...document.querySelectorAll('astro-island')].every((el) => !el.hasAttribute('ssr')), null, { timeout: 15000 });
            const card = page.locator(`[data-tour-step="${step.id}"]`);
            await card.waitFor({ timeout: 10000 });
            await page.locator(`[data-tour-step="${step.id}"][data-tour-state="found"]`).waitFor({ timeout: 10000 });
            const box = await page.locator(`[data-tour="${step.target}"]`).first().boundingBox();
            if (!box) throw new Error('the target has no box');
            await page.waitForTimeout(150);
            if (errors.length) throw new Error(errors.join('; '));
            const png = await page.screenshot({ type: 'png' });
            const file = `assets/tours/${tour.id}/${step.id}-${variant.id}.png`;
            mkdirSync(join(outDir, tour.id), { recursive: true });
            writeFileSync(join(outDir, tour.id, `${step.id}-${variant.id}.png`), png);
            (manifest.captures[`${tour.id}/${step.id}`] ||= []).push({
              variant: variant.id,
              file,
              route: step.route,
              theme: variant.theme,
              width: variant.viewport.width,
              height: variant.viewport.height,
              sha256: createHash('sha256').update(png).digest('hex'),
              hotspot: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
            });
            console.log(`captured ${label}`);
          } catch (err) {
            failures.push(`${label}: ${err.message}`);
            console.error(`FAILED ${label}: ${err.message}`);
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
    await site.close();
  }
  if (failures.length) {
    // Never keep a partial set: a missing capture must not look like a complete tour.
    if (writeManifest) rmSync(outDir, { recursive: true, force: true });
    throw new Error(`${failures.length} capture(s) failed:\n${failures.join('\n')}`);
  }
  if (writeManifest) writeFileSync(join(root, 'site', 'src', 'data', 'tourCaptures.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Captured ${Object.values(manifest.captures).flat().length} screenshots at ${revision}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
