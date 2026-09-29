import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startStaticServer, launch, openPage } from './harness.mjs';
import { MISSIONS } from '../../site/src/lib/experience/mission-registry.js';

// OX-S03 browser gate on real IndexedDB: completion needs evidence, premature completion is
// refused, a tool opened from a stage attaches its run to the mission, progress survives a
// reload and another tab sees committed changes. CI: npm run test:browser.

let server;
let browser;
before(async () => {
  server = await startStaticServer();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

test('all nine missions open with eight stages and refuse completion without evidence', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/workspace/'));
  for (const m of MISSIONS) {
    await page.goto(server.url(`/workspace/?mission=${m.id}`), { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: m.title }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Mission stages' }).getByRole('button').count(), 8, m.id);
    await page.getByRole('button', { name: /2\. Prepare/ }).click();
    await page.getByRole('button', { name: 'Check evidence and complete' }).click();
    await page.getByRole('alert').getByText(/Not complete yet/).waitFor();
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('a Lab run started from the verify stage completes it, and progress survives reload and reaches another tab', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.url('/workspace/?mission=integrate-public-asks'), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /1\. Understand/ }).click();
  await page.getByRole('button', { name: 'I have read the guide' }).click();
  await page.getByRole('button', { name: 'Check evidence and complete' }).click();
  await page.getByText('Stage complete.').waitFor();

  await page.getByRole('button', { name: /5\. Run Verifier/ }).click();
  const [lab] = await Promise.all([context.waitForEvent('page').catch(() => null), page.getByRole('link', { name: /Run Verifier/ }).click()]);
  const labPage = lab || page;
  await labPage.waitForURL(/\/lab\/\?journey=ses_/);
  await labPage.getByRole('button', { name: 'Run reference verifier' }).click();
  await labPage.getByText('Accepted by the reference verifier').waitFor();

  const other = await context.newPage();
  await other.goto(server.url('/workspace/?mission=integrate-public-asks'), { waitUntil: 'networkidle' });
  await other.getByRole('button', { name: /5\. Run Verifier/ }).click();
  await other.getByRole('button', { name: 'Check evidence and complete' }).click();
  await other.getByText('Stage complete.').waitFor();

  await page.goto(server.url('/workspace/?mission=integrate-public-asks'), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /5\. Run Verifier: complete/ }).waitFor();
  await context.close();
});

test('changing the network makes completed stages stale instead of keeping them', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.url('/workspace/?mission=integrate-atomic-swaps'), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'I have read the guide' }).click();
  await page.getByRole('button', { name: 'Check evidence and complete' }).click();
  await page.getByText('Stage complete.').waitFor();
  await page.getByRole('button', { name: /^Settings:/ }).click();
  await page.getByLabel('Network').selectOption('signet');
  await page.getByRole('button', { name: /1\. Understand Mechanics: needs to be repeated/ }).waitFor();
  await context.close();
});
