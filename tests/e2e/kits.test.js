import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import JSZip from 'jszip';
import { startStaticServer, launch, openPage } from './harness.mjs';
import { ALL_CAPABILITIES, startKit, verifyKit } from '../../scripts/docs/verify-kits.mjs';

// OX-S06 browser gates: the Kits page downloads an archive whose contents match the generator
// and whose status reports it, invalid gateway settings block the download, and a generated
// browser kit renders its checks in Chromium.

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

test('the page downloads a verified kit and reports it', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/kits/'));
  await page.getByLabel(/Fetch-handler worker/).check();
  await page.getByLabel('Buyer-funded offers').check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download ordex-worker-kit\.zip/ }).click()]);
  assert.equal(download.suggestedFilename(), 'ordex-worker-kit.zip');
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const pkg = JSON.parse(await zip.file('ordex-worker-kit/package.json').async('string'));
  assert.equal(pkg.devDependencies.esbuild, '0.28.2');
  assert.ok(zip.file('ordex-worker-kit/src/worker.ts'));
  assert.ok(zip.file('ordex-worker-kit/fixtures/offer-vectors.json'));
  await page.getByText(/Download started: ordex-worker-kit\.zip/).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('gateway mode without a valid origin blocks the download and says why', async () => {
  const { page, context } = await openPage(browser, site.url('/kits/'));
  await page.getByLabel(/Configured gateway/).check();
  await page.getByLabel('Gateway origin').fill('http://gateway.example');
  await page.getByText('Use https, or http only for a loopback host.').waitFor();
  assert.equal(await page.getByRole('button', { name: /Download/ }).isDisabled(), true);
  await context.close();
});

test('a generated browser kit renders every check as a match', { timeout: 300000 }, async () => {
  const kit = await verifyKit({ runtime: 'browser', capabilities: ALL_CAPABILITIES, mode: 'offline', network: 'mainnet', gatewayOrigin: '', revision: 'abcdef1' }, { keep: true });
  const server = await startKit(kit.dir);
  try {
    const { page, context, errors } = await openPage(browser, `${server.url}/`);
    const status = page.getByRole('status');
    await status.waitFor();
    assert.match(await status.textContent(), /^201 of 201 conformance cases give the recorded verdict/);
    assert.equal(await page.getByRole('cell', { name: 'MISMATCH', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await server.stop();
    await rm(dirname(kit.dir), { recursive: true, force: true });
  }
});
