import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startStaticServer, launch, openPage } from './harness.mjs';
import { SITE_ROUTES } from '../../site/src/lib/docs/docs-contract.mjs';

// OX-S10 browser gate: axe (WCAG 2.0/2.1/2.2 A and AA rules) on every published route in light
// and dark themes, no document-level horizontal overflow from 320 to 1440 px, and the Command
// Center keyboard contract (open, move, trap Tab, Escape restores focus, empty state, deep link).

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

async function axe(page) {
  const { AxeBuilder } = await import('@axe-core/playwright');
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

for (const theme of ['light', 'dark']) {
  test(`every route passes axe in the ${theme} theme`, { timeout: 600000 }, async () => {
    const failures = [];
    for (const route of SITE_ROUTES) {
      const context = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 900 } });
      await context.addInitScript((t) => {
        try {
          localStorage.setItem('ordex_theme', t);
        } catch {}
      }, theme);
      const page = await context.newPage();
      await page.goto(site.url(route), { waitUntil: 'networkidle' });
      await page.waitForFunction(() => [...document.querySelectorAll('astro-island')].every((el) => !el.hasAttribute('ssr')), null, { timeout: 15000 });
      const violations = await axe(page);
      if (violations.length) failures.push(`${route}: ${violations.join('; ')}`);
      await context.close();
    }
    assert.deepEqual(failures, []);
  });
}

test('no route scrolls the whole page sideways from 320 to 1440 px', { timeout: 600000 }, async () => {
  const failures = [];
  for (const width of [320, 375, 768, 1440]) {
    for (const route of SITE_ROUTES) {
      const { page, context } = await openPage(browser, site.url(route), { viewport: { width, height: 900 } });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) failures.push(`${route} at ${width}px overflows by ${overflow}px`);
      await context.close();
    }
  }
  assert.deepEqual(failures, []);
});

test('Command Center: shortcut, arrows, Tab trap, Escape restores focus, empty state and deep links', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/'));
  const trigger = page.getByRole('button', { name: /Search or jump/ });
  await trigger.focus();
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox');
  await input.waitFor();
  assert.equal(await input.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  const activeId = await input.getAttribute('aria-activedescendant');
  assert.equal(await page.locator(`#${activeId}`).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true, 'focus stays in the dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate((el) => el === document.activeElement), true, 'focus returns to the trigger');
  await trigger.click();
  await page.getByRole('combobox').fill('zzzz-no-such-thing');
  await page.getByText(/Nothing matches/).waitFor();
  await page.getByRole('combobox').fill('listOrders');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/build\/playground\/\?operation=listOrders/);
  assert.deepEqual(errors.filter((e) => !/requestfailed/.test(e)), []);
  await context.close();
});
