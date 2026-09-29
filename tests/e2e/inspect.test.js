import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startStaticServer, launch, openPage } from './harness.mjs';
import { MUTATION_FIXTURES } from '../../site/src/lib/artifacts/mutation-fixtures.js';

// OX-S01 browser gate for /inspect: the initial artifact decodes without errors, every tab
// works from the keyboard, malformed input is reported, every mutation example produces its
// severity, and the exported digest equals an independent SHA-256. CI: npm run test:browser.

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

test('/inspect opens decoded with no errors and tabs follow the keyboard', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/inspect/'));
  await page.getByText('Decoded as PSBT_V0').waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('tab', { name: 'Summary' }).focus();
  for (const name of ['Inputs & Outputs', 'Structure', 'Bytes', 'Compare']) {
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name }).getAttribute('aria-selected'), 'true', name);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('/inspect reports malformed and truncated input as malformed', async () => {
  const { page, context } = await openPage(browser, server.url('/inspect/'));
  await page.getByLabel(/Artifact A/).fill('70736274ff0100');
  await page.getByRole('button', { name: 'Decode' }).click();
  await page.getByRole('alert').getByText(/Malformed/).waitFor();
  await page.getByLabel(/Artifact A/).fill('zz');
  await page.getByRole('button', { name: 'Decode' }).click();
  await page.getByRole('alert').getByText(/Malformed/).waitFor();
  await context.close();
});

test('/inspect mutation examples report their severity and never call changed bytes identical', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/inspect/'));
  await page.getByRole('tab', { name: 'Compare' }).click();
  for (const f of MUTATION_FIXTURES) {
    await page.getByRole('button', { name: `Example: ${f.name}` }).click();
    const expected = f.expectedSeverity === 'Dangerous' ? /Dangerous change/ : f.id === 'mut-preserve' ? /Byte-identical/ : f.expectedSeverity === 'Review required' ? /Review required/ : /Only signatures/;
    await page.getByText(expected).first().waitFor();
    if (f.id !== 'mut-preserve') assert.equal(await page.getByText(/Byte-identical/).count(), 0, f.id);
  }
  const f = MUTATION_FIXTURES.find((x) => x.id === 'mut-amount-plus-one');
  await page.getByRole('button', { name: `Example: ${f.name}` }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download comparison report (JSON)' }).click()]);
  const report = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(report.artifactB.sha256, createHash('sha256').update(Buffer.from(f.rawFixtureHexB, 'hex')).digest('hex'));
  assert.equal(report.overallVerdict, 'DANGEROUS');
  assert.deepEqual(errors, []);
  await context.close();
});
