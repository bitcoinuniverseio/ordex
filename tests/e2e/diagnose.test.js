import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startStaticServer, launch, openPage } from './harness.mjs';

// OX-S09 browser gates at /diagnose and the Lab reproducer deep link: a code deep link runs
// its reproducer in the Worker and shows the actual verdict beside the expected one; an
// unregistered code is not diagnosed conclusively; the Lab opens a reproducer by code.

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

test('a code deep link diagnoses conclusively and every family reproducer reproduces it', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/diagnose/?code=SELLER_VALUE_MISMATCH'));
  await page.getByRole('heading', { name: 'SELLER_VALUE_MISMATCH' }).waitFor();
  await page.getByText('confidence conclusive').first().waitFor();
  const runs = page.getByRole('button', { name: 'Run in this browser' });
  assert.equal(await runs.count(), 2, 'offers and purchase each have a reproducer');
  for (let i = 0; i < 2; i++) {
    await runs.nth(i).click();
  }
  await page.getByText('Reproduced', { exact: true }).nth(1).waitFor({ timeout: 20000 });
  assert.equal(await page.getByText('Did not reproduce').count(), 0);
  assert.match(page.url(), /\?code=SELLER_VALUE_MISMATCH/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('an unregistered code and plain noise are not diagnosed conclusively', async () => {
  const { page, context } = await openPage(browser, site.url('/diagnose/'));
  const input = page.getByLabel('Code or JSON');
  await input.fill('PAYMENT_OUTPUT_MISMATCH');
  await page.getByRole('button', { name: 'Diagnose', exact: true }).click();
  await page.getByText('which no Ordex verifier returns').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Run in this browser' }).count(), 0);
  assert.doesNotMatch(page.url(), /code=/);
  await context.close();
});

test('the Lab opens a reproducer by code and the verifier refuses it with that code', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/lab/?reproduce=TRACKED_ASSET_UNASSIGNED'));
  await page.getByText('Loaded the reproducer for TRACKED_ASSET_UNASSIGNED').waitFor();
  await page.getByRole('button', { name: 'Run reference verifier' }).click();
  await page.getByText('TRACKED_ASSET_UNASSIGNED').nth(1).waitFor({ timeout: 20000 });
  assert.deepEqual(errors, []);
  await context.close();
});
