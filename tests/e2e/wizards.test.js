import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startStaticServer, launch, openPage } from './harness.mjs';

// OX-S11 browser gates: a wizard needs answers to continue, keeps them across a reload, finishes
// into real links, and its kit link reaches the Kits page with the chosen runtime; recipes open
// by id and report an unknown one.

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

test('integration wizard: required answers, reload keeps progress, kit link carries the runtime', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/build/wizards/?wizard=integration-path'));
  const next = page.getByRole('button', { name: 'Continue' });
  assert.equal(await next.isDisabled(), true);
  await page.getByLabel(/Wallet or Signer/).check();
  await next.click();
  await page.getByLabel(/Fetch-handler worker/).check();
  await page.reload();
  await page.getByText('Step 2 of 3').waitFor();
  assert.equal(await page.getByLabel(/Fetch-handler worker/).isChecked(), true);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel(/Atomic Swaps|Swaps/).first().check();
  await page.getByRole('button', { name: 'Finish' }).click();
  const kitLink = page.getByRole('link', { name: /Generate a worker starter kit/ });
  await kitLink.click();
  await page.waitForURL(/\/kits\/\?runtime=worker/);
  await page.getByLabel(/Fetch-handler worker/).waitFor();
  assert.equal(await page.getByLabel(/Fetch-handler worker/).isChecked(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('recipes open by id, report an unknown id, and switch code views by keyboard', async () => {
  const { page, context } = await openPage(browser, site.url('/build/recipes/?recipe=no-such-recipe'));
  await page.getByText('There is no recipe called "no-such-recipe"').waitFor();
  await page.goto(site.url('/build/recipes/?recipe=publish-and-purchase'));
  await page.getByRole('heading', { name: 'Publish a public ask, then check a purchase' }).waitFor();
  await page.getByRole('tab', { name: 'SDK (TypeScript)' }).press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'fetch (TypeScript)' }).getAttribute('aria-selected'), 'true');
  await page.getByText("call('POST', `/api/ordex/orders/build`").waitFor();
  await context.close();
});
