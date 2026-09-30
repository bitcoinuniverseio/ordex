import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticServer, launch, openPage, ROOT } from '../e2e/harness.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for Product Tours (OX-S-C1100..C1134). Each tour is started from /tour, every
// step's real target is found and outlined, Previous and Next work from the keyboard, the tour
// pauses and resumes from /tour, and scripts/capture-walkthroughs.mjs captures every step in
// desktop light, desktop dark and mobile light from this build; the PNGs are read back here.

const tours = JSON.parse(readFileSync(new URL('../../site/src/lib/experience/tours.json', import.meta.url), 'utf8'));
const rows = rowsOf('Product Tours');
const rec = rowRecorder('tests/acceptance/tours.test.js');

let site;
let browser;
let captures;
before(async () => {
  site = await startStaticServer();
  browser = await launch();
  captures = mkdtempSync(join(tmpdir(), 'ordex-tour-captures-'));
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'capture-walkthroughs.mjs'), '--out', captures], { cwd: ROOT, stdio: 'inherit', timeout: 900000 });
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (captures) rmSync(captures, { recursive: true, force: true });
});

const stepUrl = (tour, i) => {
  const u = new URL(tour.steps[i].route, 'https://x.invalid');
  u.searchParams.set('tour', tour.id);
  u.searchParams.set('step', String(i + 1));
  return site.url(`${u.pathname}${u.search}`);
};
function png(file) {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString() === 'PNG', `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
}

test('Product Tour rows', { timeout: 900000 }, async () => {
  for (const tour of tours) {
    const row = (s) => rows.find((r) => r.operation === `${tour.id}: ${s}`).id;

    await rec.check(row('Select tour'), `/tour start ${tour.id}`, async () => {
      const { page, context } = await openPage(browser, site.url('/tour/'));
      await page.getByRole('link', { name: `Start the tour: ${tour.title}` }).click();
      await page.locator(`[data-tour-step="${tour.steps[0].id}"][data-tour-state="found"]`).waitFor({ timeout: 15000 });
      expect(new RegExp(`tour=${tour.id}`).test(page.url()) && /step=1/.test(page.url()), page.url());
      await context.close();
      return { url: new URL(page.url()).pathname + new URL(page.url()).search };
    });

    await rec.check(row('Interactive DOM highlight'), `${tour.id}: every step outlines its real target`, async () => {
      const out = [];
      for (const [i, step] of tour.steps.entries()) {
        for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
          const { page, context, errors } = await openPage(browser, stepUrl(tour, i), { viewport });
          await page.locator(`[data-tour-step="${step.id}"][data-tour-state="found"]`).waitFor({ timeout: 15000 });
          const box = await page.locator(`[data-tour-highlight="${step.target}"]`).boundingBox();
          expect(box && box.width > 0 && box.height > 0, `${step.id} at ${viewport.width}px is not outlined`);
          expect(errors.length === 0, `${step.id}: ${errors.join('; ')}`);
          out.push({ step: step.id, width: viewport.width, box: { w: Math.round(box.width), h: Math.round(box.height) } });
          await context.close();
        }
      }
      return out;
    });

    for (const [variant, label, w, h] of [['desktop-light', 'Desktop light real capture', 1280, 800], ['desktop-dark', 'Desktop dark real capture', 1280, 800], ['mobile-light', 'Mobile light real capture', 375, 812]]) {
      await rec.check(row(label), `${tour.id}: ${variant} captures from scripts/capture-walkthroughs.mjs`, async () => {
        const out = [];
        for (const step of tour.steps) {
          const file = join(captures, tour.id, `${step.id}-${variant}.png`);
          expect(existsSync(file), `${step.id}-${variant}.png was not captured`);
          const p = png(file);
          expect(p.width === w && p.height === h, `${step.id}: ${p.width}x${p.height}`);
          expect(p.bytes > 8000, `${step.id}: ${p.bytes} bytes looks blank`);
          if (variant === 'desktop-dark') {
            const light = png(join(captures, tour.id, `${step.id}-desktop-light.png`));
            expect(light.sha256 !== p.sha256, `${step.id}: dark capture equals light`);
          }
          out.push({ step: step.id, width: p.width, height: p.height, sha256: p.sha256 });
        }
        return out;
      });
    }

    await rec.check(row('Previous/next accessible controls'), `${tour.id}: Next and Previous by button and keyboard`, async () => {
      const { page, context } = await openPage(browser, stepUrl(tour, 0));
      await page.locator(`[data-tour-step="${tour.steps[0].id}"][data-tour-state="found"]`).waitFor({ timeout: 15000 });
      const seen = [tour.steps[0].id];
      if (tour.steps.length > 1) {
        await page.getByRole('button', { name: 'Next step' }).click();
        await page.locator(`[data-tour-step="${tour.steps[1].id}"]`).waitFor({ timeout: 15000 });
        seen.push(tour.steps[1].id);
        await page.locator(`[data-tour-step="${tour.steps[1].id}"]`).getByRole('heading', { name: tour.steps[1].title }).press('ArrowLeft');
        await page.locator(`[data-tour-step="${tour.steps[0].id}"]`).waitFor({ timeout: 15000 });
        seen.push(tour.steps[0].id);
      }
      await page.keyboard.press('Escape');
      await page.locator('[data-tour-step]').waitFor({ state: 'detached' });
      await context.close();
      return { sequence: seen, escapeCloses: true };
    });

    await rec.check(row('Pause/resume/reopen progress'), `${tour.id}: pause, reopen /tour, resume at the same step`, async () => {
      const i = Math.min(1, tour.steps.length - 1);
      const { page, context } = await openPage(browser, stepUrl(tour, i));
      await page.locator(`[data-tour-step="${tour.steps[i].id}"]`).waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: 'Pause' }).click();
      // The tour leaves the URL once the paused step is stored.
      await page.waitForURL((url) => !/tour=/.test(String(url)), { timeout: 15000 }).catch(() => {});
      expect(!/tour=/.test(page.url()), 'the tour stayed in the URL after pausing');
      await page.goto(site.url('/tour/'), { waitUntil: 'networkidle' });
      await page.getByRole('link', { name: 'Resume the tour' }).click();
      await page.locator(`[data-tour-step="${tour.steps[i].id}"]`).waitFor({ timeout: 15000 });
      expect(new RegExp(`step=${i + 1}`).test(page.url()), page.url());
      await context.close();
      return { pausedAt: i + 1, resumedAt: i + 1 };
    });
  }
  assert.deepEqual(rec.failures(), []);
});
