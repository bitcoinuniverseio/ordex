import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStaticServer, launch, openPage, DIST } from './harness.mjs';
import { FAMILIES, FAMILY_REGISTRY, resultKey } from '../../site/src/lib/conformance-registry.mjs';

// OX-S07 browser gate for /lab and /verify. Proves the islands hydrate with no errors, the
// Worker runs every family and variant, and exact counts come from the built data.

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

const vectors = JSON.parse(await readFile(join(DIST, '..', '..', 'site', 'src', 'data', 'allVectors.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(DIST, '..', '..', 'site', 'src', 'data', 'vectorManifest.json'), 'utf8'));

test('/verify hydrates and runs every vector in the Worker with the exact count', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/verify/'));
  const run = page.getByRole('button', { name: `Run ${manifest.total} vectors` });
  await run.click();
  await page.getByText(`All ${manifest.total} selected vectors reached their expected verdict.`).waitFor({ timeout: 30000 });
  assert.equal(await page.getByText('Mismatch:').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('/lab hydrates and runs an accepted and a refused example for every family and variant', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/lab/'));
  for (const family of FAMILIES) {
    await page.getByLabel('Verifier family').selectOption(family);
    for (const variant of Object.keys(FAMILY_REGISTRY[family].variants)) {
      await page.getByLabel('Variant').selectOption(variant);
      const key = resultKey(family, variant);
      const cases = vectors.filter((v) => v.family === family && v.variant === variant);
      const picks = [cases.find((c) => c.case.expected[key] === true), cases.find((c) => c.case.expected[key] === false)].filter(Boolean);
      assert.ok(picks.length > 0, `${family}/${variant} has no example`);
      for (const pick of picks) {
        await page.getByLabel('Load a conformance vector').selectOption(pick.id);
        await page.getByRole('button', { name: 'Run reference verifier' }).click();
        const expected = pick.case.expected[key] ? 'Accepted by the reference verifier' : 'Refused by the reference verifier';
        await page.getByText(expected).waitFor({ timeout: 15000 });
        await page.getByText(`Matches the expected verdict of ${pick.id}.`).waitFor();
      }
    }
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('/lab refuses malformed, oversized and secret-bearing input and clears stale results', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/lab/'));
  const input = page.getByLabel(/Input JSON/);
  await page.getByRole('button', { name: 'Run reference verifier' }).click();
  await page.getByText('Accepted by the reference verifier').waitFor();
  await input.fill('{ not json');
  assert.equal(await page.getByText('Accepted by the reference verifier').count(), 0, 'stale result stayed visible');
  await page.getByRole('button', { name: 'Run reference verifier' }).click();
  await page.getByRole('alert').getByText(/not valid JSON/).waitFor();
  await input.fill(JSON.stringify({ transaction: { pad: 'x'.repeat(2 * 1024 * 1024 + 10) }, order: {} }));
  await page.getByRole('button', { name: 'Run reference verifier' }).click();
  await page.getByRole('alert').getByText(/at most/).waitFor();
  await input.fill(JSON.stringify({ transaction: { note: 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi' }, order: {} }));
  await page.getByRole('button', { name: 'Run reference verifier' }).click();
  await page.getByRole('alert').getByText(/Private key material detected/).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('/lab compares two pinned runs and exports a report only after a completed run', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/lab/'));
  await page.getByRole('tab', { name: 'Export' }).click();
  assert.equal(await page.getByRole('button', { name: 'Download JSON (.json)' }).isDisabled(), true);
  await page.getByRole('tab', { name: 'Inspect' }).click();
  const purchase = vectors.filter((v) => v.family === 'purchase');
  await page.getByLabel('Load a conformance vector').selectOption(purchase[0].id);
  await page.getByRole('button', { name: 'Run reference verifier' }).click();
  await page.getByText(/by the reference verifier/).waitFor();
  await page.getByRole('button', { name: 'Pin as A' }).click();
  const refused = purchase.find((v) => v.case.expected.ok === false);
  await page.getByLabel('Load a conformance vector').selectOption(refused.id);
  await page.getByRole('button', { name: 'Run reference verifier' }).click();
  await page.getByText('Refused by the reference verifier').waitFor();
  await page.getByRole('button', { name: 'Pin as B' }).click();
  await page.getByRole('tab', { name: 'Compare' }).click();
  await page.getByText('Input differences').waitFor();
  await page.getByRole('tab', { name: 'Export' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON (.json)' }).click()]);
  const report = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(report.schema, 'ordex.lab-report/v1');
  assert.equal(report.family, 'purchase');
  assert.match(report.inputSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.verdict.state, 'refused');
  assert.equal(report.vectorDigest, manifest.vectorDigest);
  assert.deepEqual(errors, []);
  await context.close();
});

test('/lab tabs follow the keyboard tablist pattern', async () => {
  const { page, context } = await openPage(browser, server.url('/lab/'));
  await page.getByRole('tab', { name: 'Inspect' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Compare' }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: 'Export' }).getAttribute('aria-selected'), 'true');
  await context.close();
});
