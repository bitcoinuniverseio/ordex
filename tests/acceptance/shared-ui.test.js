import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startStaticServer, launch, openPage } from '../e2e/harness.mjs';
import { SITE_ROUTES } from '../../site/src/lib/docs/docs-contract.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for the shared workspace UI (OX-S-C1300..C1313) on every published route:
// WCAG 2.2 AA through axe in both themes, contrast of the primary action and the small brand
// badge, reflow at 320/375/768/1440 px and at 200% zoom, the Command Center keyboard contract,
// theme persistence, clipboard failure feedback, accessible names, live regions, reduced
// motion and target size, and navigation with back, forward and direct loads.

const rows = rowsOf('Shared Workspace UI');
const row = (prefix) => rows.find((r) => r.operation.startsWith(prefix)).id;
const rec = rowRecorder('tests/acceptance/shared-ui.test.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

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

async function themed(theme, viewport = { width: 1280, height: 900 }, extra = {}) {
  const context = await browser.newContext({ colorScheme: theme, viewport, ...extra });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('ordex_theme', t);
    } catch {}
  }, theme);
  return context;
}
async function axe(page, rules = null) {
  const { AxeBuilder } = await import('@axe-core/playwright');
  let b = new AxeBuilder({ page }).withTags(TAGS);
  if (rules) b = b.withRules(rules);
  return (await b.analyze()).violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
}
async function load(context, route) {
  const page = await context.newPage();
  await page.goto(site.url(route), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => [...document.querySelectorAll('astro-island')].every((el) => !el.hasAttribute('ssr')), null, { timeout: 15000 });
  return page;
}
const ratio = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let bgEl = el;
    let bg = getComputedStyle(bgEl).backgroundColor;
    while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && bgEl.parentElement) {
      bgEl = bgEl.parentElement;
      bg = getComputedStyle(bgEl).backgroundColor;
    }
    const a = lum(getComputedStyle(el).color);
    const b = lum(bg);
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
  }, selector);

test('Shared workspace UI rows', { timeout: 1800000 }, async () => {
  await rec.check([row('Primary action text contrast'), row('Small brand text contrast'), row('Tablists/popup accessible names')], 'axe WCAG 2.2 AA on every route, light and dark', async () => {
    const failures = [];
    const ratios = {};
    for (const theme of ['light', 'dark']) {
      for (const route of SITE_ROUTES) {
        const context = await themed(theme);
        const page = await load(context, route);
        const v = await axe(page);
        if (v.length) failures.push(`${theme} ${route}: ${v.join('; ')}`);
        for (const [k, sel] of [['primary', '.btn-primary, button[class*="primary"]'], ['badge', '.brand-group .badge']]) {
          const r = await ratio(page, sel);
          if (r !== null) {
            ratios[`${theme}:${k}`] = Math.min(ratios[`${theme}:${k}`] ?? 99, r);
            if (r < 4.5) failures.push(`${theme} ${route}: ${k} contrast ${r}`);
          }
        }
        await context.close();
      }
    }
    expect(failures.length === 0, failures.join('\n'));
    return { routes: SITE_ROUTES.length, themes: 2, minimumContrast: ratios };
  });

  await rec.check(row('320/375px horizontal layout'), 'no sideways scroll at 320 and 375 px, also with a 5000-character unbroken input', async () => {
    const failures = [];
    for (const width of [320, 375]) {
      for (const route of SITE_ROUTES) {
        const { page, context } = await openPage(browser, site.url(route), { viewport: { width, height: 900 } });
        const box = page.locator('textarea, input[type="text"], input:not([type])').first();
        if (await box.count()) await box.fill('x'.repeat(5000)).catch(() => {});
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) failures.push(`${route} at ${width}px overflows by ${overflow}px`);
        await context.close();
      }
    }
    expect(failures.length === 0, failures.join('\n'));
    return { widths: [320, 375], routes: SITE_ROUTES.length };
  });

  await rec.check(row('Tablet/desktop layout'), 'no sideways scroll at 768 and 1440 px and at 200% zoom of 1280 px', async () => {
    const failures = [];
    for (const [width, scale] of [[768, 1], [1440, 1], [640, 2]]) {
      for (const route of SITE_ROUTES) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: scale });
        const page = await load(context, route);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) failures.push(`${route} at ${width}px x${scale} overflows by ${overflow}px`);
        await context.close();
      }
    }
    expect(failures.length === 0, failures.join('\n'));
    return { widths: [768, 1440], zoom200: '640 CSS px at device scale 2' };
  });

  await rec.check([row('Open command palette by keyboard'), row('Filter/select/empty palette state'), row('Dialog Tab/Escape/focus restore'), row('Destination deep-link selection')], 'Command Center keyboard contract', async () => {
    const { page, context, errors } = await openPage(browser, site.url('/'));
    const trigger = page.getByRole('button', { name: /Search or jump/ });
    await trigger.focus();
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox');
    await input.waitFor();
    expect(await input.evaluate((el) => el === document.activeElement), 'the input is not focused');
    await page.keyboard.press('ArrowDown');
    const activeId = await input.getAttribute('aria-activedescendant');
    expect((await page.locator(`#${activeId}`).getAttribute('aria-selected')) === 'true', 'arrow selection');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'focus left the dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    expect(await trigger.evaluate((el) => el === document.activeElement), 'focus not restored');
    await trigger.click();
    await page.getByRole('combobox').fill('zzzz-no-such-thing');
    await page.getByText(/Nothing matches/).waitFor();
    await page.getByRole('combobox').fill('listOrders');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/build\/playground\/\?operation=listOrders/);
    await page.getByText('/api/ordex/orders', { exact: true }).first().waitFor();
    expect(errors.filter((e) => !/requestfailed/.test(e)).length === 0, errors.join('; '));
    await context.close();
    return { shortcut: 'Control+K', empty: 'Nothing matches', deepLink: '/build/playground/?operation=listOrders' };
  });

  await rec.check(row('Light/dark theme persistence'), 'the theme chosen with the toggle survives reload and navigation', async () => {
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await load(context, '/start/');
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.getByRole('button', { name: /Current theme/ }).first().click();
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(before !== after && after === 'dark', `toggle ${before} -> ${after}`);
    await page.reload({ waitUntil: 'networkidle' });
    expect((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'lost on reload');
    await page.goto(site.url('/workspace/'), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 5000 });
    await context.close();
    return { toggled: `${before} -> ${after}`, reload: 'dark', otherShell: 'dark' };
  });

  await rec.check(row('Clipboard rejection'), 'a refused clipboard write is reported, not claimed as copied', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied by the test')) }, configurable: true });
    });
    const page = await load(context, '/diagnose/?code=SELLER_VALUE_MISMATCH');
    await page.getByRole('button', { name: 'Copy report' }).click();
    const said = await page.getByText(/could not be copied/).first().innerText();
    expect(!/report copied\./i.test(await page.locator('body').innerText()), 'claimed as copied');
    await context.close();
    return { announced: said.slice(0, 160) };
  });

  await rec.check(row('Loading/error/success aria-live'), 'Lab loading, success and error states are announced in live regions', async () => {
    const { page, context } = await openPage(browser, site.url('/lab/'));
    const live = page.locator('[aria-live]');
    expect((await live.count()) > 0, 'no live region');
    await page.getByRole('button', { name: 'Run reference verifier' }).click();
    await page.getByText(/by the reference verifier/).waitFor();
    const inLive = await page.evaluate(() => [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].some((el) => /by the reference verifier/.test(el.textContent)));
    expect(inLive, 'the verdict is not inside a live region');
    await page.getByLabel(/Input JSON/).fill('{ not json');
    await page.getByRole('button', { name: 'Run reference verifier' }).click();
    await page.getByRole('alert').getByText(/not valid JSON/).waitFor();
    await context.close();
    return { success: 'status region', error: 'alert' };
  });

  await rec.check(row('Reduced motion and touch targets'), 'reduced motion removes transitions; target size holds at 375 px', async () => {
    const failures = [];
    for (const route of SITE_ROUTES) {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true });
      const page = await load(context, route);
      const v = await axe(page, ['target-size']);
      if (v.length) failures.push(`${route}: ${v.join('; ')}`);
      const moving = await page.evaluate(() => [...document.querySelectorAll('button, a')].filter((el) => {
        const s = getComputedStyle(el);
        return parseFloat(s.transitionDuration) > 0.01 || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.01);
      }).length);
      if (moving) failures.push(`${route}: ${moving} controls still animate with reduced motion`);
      await context.close();
    }
    expect(failures.length === 0, failures.join('\n'));
    return { routes: SITE_ROUTES.length, reducedMotion: 'no transitions', targetSize: 'axe target-size clean' };
  });

  await rec.check(row('Primary navigation/back/forward/direct route'), 'header navigation, back, forward and direct loads', async () => {
    const { page, context, errors } = await openPage(browser, site.url('/start/'));
    // The docs service is not part of this static build: its requests fail by design and the
    // pages say so, so only other failed responses count here.
    const failed = [];
    page.on('response', (r) => r.status() >= 400 && !new URL(r.url()).pathname.startsWith('/api/docs/') && failed.push(`${r.status()} ${r.url()}`));
    const visited = [];
    for (const name of ['Learn', 'Build', 'Verify', 'Reference']) {
      await page.getByRole('navigation', { name: 'Main Navigation' }).getByRole('link', { name, exact: true }).click();
      await page.waitForURL(new RegExp(`/${name.toLowerCase()}`));
      visited.push(new URL(page.url()).pathname);
    }
    await page.goBack();
    expect(new URL(page.url()).pathname === visited[2], `back went to ${page.url()}`);
    await page.goForward();
    expect(new URL(page.url()).pathname === visited[3], `forward went to ${page.url()}`);
    for (const route of SITE_ROUTES) {
      const res = await page.goto(site.url(route), { waitUntil: 'networkidle' });
      expect(res.status() === 200 && (await page.locator('main').count()) > 0, `${route} answered ${res.status()}`);
    }
    expect(failed.length === 0, failed.join('; '));
    expect(errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.join('; '));
    await context.close();
    return { visited, direct: SITE_ROUTES.length, failedResponses: 0 };
  });

  assert.deepEqual(rec.failures(), []);
});
