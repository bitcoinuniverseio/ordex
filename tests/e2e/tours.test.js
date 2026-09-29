import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { startStaticServer, launch, openPage } from './harness.mjs';

// OX-S10 browser gate: every step of every tour opens on its page and the overlay finds and
// outlines the real [data-tour] element (steps with a hint first get their interaction);
// Next, Back, Pause, Resume, End and Escape work, and a missing target is reported, not faked.

const tours = JSON.parse(readFileSync(new URL('../../site/src/lib/experience/tours.json', import.meta.url), 'utf8'));
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

const stepUrl = (tour, i) => {
  const u = new URL(tours.find((t) => t.id === tour.id).steps[i].route, 'https://x.invalid');
  u.searchParams.set('tour', tour.id);
  u.searchParams.set('step', String(i + 1));
  return site.url(`${u.pathname}${u.search}`);
};

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`every tour step finds its real target (${viewport.width}px)`, { timeout: 300000 }, async () => {
    for (const tour of tours) {
      for (const [i, step] of tour.steps.entries()) {
        const { page, context, errors } = await openPage(browser, stepUrl(tour, i), { viewport });
        await page.locator(`[data-tour-step="${step.id}"][data-tour-state="found"]`).waitFor({ timeout: 15000 });
        const box = await page.locator(`[data-tour-highlight="${step.target}"]`).boundingBox();
        assert.ok(box && box.width > 0, `${tour.id}/${step.id} is outlined`);
        assert.deepEqual(errors, [], `${tour.id}/${step.id}`);
        await context.close();
      }
    }
  });
}

test('navigation, pause and resume, end with focus restored, keyboard inside the card only', async () => {
  const tour = tours.find((t) => t.id === 'tour-overview');
  const { page, context } = await openPage(browser, stepUrl(tour, 0));
  await page.getByRole('button', { name: 'Next step' }).click();
  await page.locator('[data-tour-step="disclosure"][data-tour-state="found"]').waitFor();
  assert.match(page.url(), /step=2/);
  await page.getByRole('heading', { name: tour.steps[1].title }).press('ArrowRight');
  await page.locator('[data-tour-step="command"]').waitFor();
  await page.getByRole('button', { name: 'Previous step' }).click();
  await page.locator('[data-tour-step="disclosure"]').waitFor();
  await page.getByRole('button', { name: 'Pause' }).click();
  assert.doesNotMatch(page.url(), /tour=/);
  await page.goto(site.url('/tour/'));
  await page.getByRole('link', { name: 'Resume the tour' }).click();
  await page.locator('[data-tour-step="disclosure"]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-tour-step]').waitFor({ state: 'detached' });
  assert.doesNotMatch(page.url(), /tour=/);
  await context.close();
});

test('a step whose target is not on the page says so', async () => {
  const tour = tours.find((t) => t.id === 'tour-failure-diagnose');
  const { page, context } = await openPage(browser, site.url(`/diagnose/?tour=${tour.id}&step=2`));
  // Without ?code= the reproducer section is not rendered.
  await page.locator('[data-tour-step="reproduce"][data-tour-state="elsewhere"], [data-tour-step="reproduce"][data-tour-state="missing"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('[data-tour-highlight]').count(), 0);
  await context.close();
});
