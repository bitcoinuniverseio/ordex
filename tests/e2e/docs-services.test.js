import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { join } from 'node:path';
import { startStaticServer, launch, openPage } from './harness.mjs';
import { startBuiltHost, tempDir } from '../integration/service-host.mjs';

// OX-S11 browser gates: Ask, Feedback and Insights against the built docs service with a real
// SQLite file, served same-origin through a proxy as a deployment would; then with the service
// stopped, Ask says it answered from the page and Feedback keeps the draft and reports failure.

const proxy = { prefix: '/api/docs/', target: null };
let site;
let service;
let tmp;
let browser;
before(async () => {
  site = await startStaticServer({ proxy });
  tmp = tempDir('ordex-docs-e2e-');
  service = await startBuiltHost({ dbPath: join(tmp.dir, 'docs.sqlite'), allowedOrigins: site.origin });
  proxy.target = service.url;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await service?.close();
  tmp?.cleanup();
  await site?.close();
});

test('Ask answers from the docs service with citations that open real pages', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/ask/'));
  await page.getByLabel('Your question').fill('keyset cursor paging');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByText('· docs service ·', { exact: false }).waitFor({ timeout: 15000 });
  const link = page.locator('article h3 a').first();
  const href = await link.getAttribute('href');
  assert.match(href, /^\/ordex\//);
  const res = await page.request.get(`${site.origin}${href.split('#')[0]}`);
  assert.equal(res.status(), 200);
  await page.getByLabel('Your question').fill('my key L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByText('was not sent anywhere').waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('Feedback is reported sent only with a stored receipt, and Insights reads it back', async () => {
  const { page, context } = await openPage(browser, site.url('/kits/'));
  await page.getByRole('button', { name: 'More feedback' }).click();
  await page.getByRole('button', { name: 'Unclear' }).click();
  await page.getByLabel(/Details/).fill('The capability list could say which gateway reads exist.');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  await page.getByText(/Received and stored at/).waitFor({ timeout: 15000 });
  const rows = service.db.raw.prepare("SELECT category, route FROM docs_feedback WHERE category = 'unclear'").all();
  assert.deepEqual(rows.map((r) => r.route), ['/kits/']);
  await context.close();
  const insights = await openPage(browser, site.url('/insights/'));
  await insights.page.getByText('unclear: 1').waitFor({ timeout: 15000 });
  await insights.context.close();
});

test('with the service down, Ask falls back honestly and Feedback keeps the draft', async () => {
  const saved = proxy.target;
  proxy.target = 'http://127.0.0.1:1';
  try {
    const { page, context } = await openPage(browser, site.url('/ask/'));
    await page.getByLabel('Your question').fill('keyset cursor paging');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByText('Answered from the documentation in this page instead').waitFor({ timeout: 20000 });
    await page.getByText('· this page ·', { exact: false }).waitFor();
    await context.close();
    const fb = await openPage(browser, site.url('/kits/'));
    await fb.page.getByRole('button', { name: 'More feedback' }).click();
    await fb.page.getByRole('button', { name: 'Outdated' }).click();
    await fb.page.getByLabel(/Details/).fill('keep me');
    await fb.page.getByRole('button', { name: 'Send feedback' }).click();
    await fb.page.getByText(/Not sent:/).waitFor({ timeout: 20000 });
    assert.equal(await fb.page.getByLabel(/Details/).inputValue(), 'keep me');
    assert.equal(await fb.page.getByText(/Received and stored/).count(), 0);
    await fb.context.close();
  } finally {
    proxy.target = saved;
  }
});
