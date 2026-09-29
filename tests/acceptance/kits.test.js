import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { startStaticServer, launch, openPage } from '../e2e/harness.mjs';
import { KIT_WORK_DIR, startFakeGateway, verifyKitDir } from '../../scripts/docs/verify-kits.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for Integration Kits (OX-S-C1000..C1014). For each runtime the kit is
// downloaded from /kits, extracted from the ZIP the page produced, then built, tested and
// started as its README says: offline, and in gateway mode against a local gateway on the
// selected network. A second download with other capabilities must change what the kit runs.

const rows = rowsOf('Integration Kits');
const rec = rowRecorder('tests/acceptance/kits.test.js');
const RUNTIMES = { node: 'Node.js service', browser: 'Browser app', worker: 'Fetch-handler worker' };
const CAPS = { asks: 'Public asks and purchases', offers: 'Buyer-funded offers', safeops: 'SafeOps plans and signed results', swaps: 'Swap intents and acceptances', events: 'Events and signed webhooks', provenance: 'Collection manifests and membership' };

let site;
let gateway;
let browser;
before(async () => {
  site = await startStaticServer();
  gateway = await startFakeGateway('signet');
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await gateway?.close();
  await site?.close();
});

async function download(page, runtime, caps, mode) {
  await page.goto(site.url('/kits/'), { waitUntil: 'networkidle' });
  await page.getByLabel(new RegExp(RUNTIMES[runtime])).check();
  for (const [id, label] of Object.entries(CAPS)) {
    const box = page.getByLabel(label, { exact: true });
    if ((await box.isChecked()) !== caps.includes(id)) await box.click();
  }
  if (mode === 'gateway') {
    await page.getByLabel(/Configured gateway/).check();
    await page.getByLabel('Gateway origin').fill(gateway.origin);
    await page.getByLabel('Network the gateway must serve').selectOption('signet');
  } else {
    await page.getByLabel(/^Offline/).check();
  }
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: new RegExp(`Download ordex-${runtime}-kit\\.zip`) }).click()]);
  const status = await page.getByText(new RegExp(`Download started: ordex-${runtime}-kit\\.zip`)).innerText();
  const zip = await JSZip.loadAsync(await readFile(await dl.path()));
  await mkdir(KIT_WORK_DIR, { recursive: true });
  const root = await mkdtemp(join(KIT_WORK_DIR, 'accept-'));
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const out = join(root, ...path.split('/'));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, await file.async('nodebuffer'));
  }
  return { dir: join(root, `ordex-${runtime}-kit`), root, zip, status, filename: dl.suggestedFilename() };
}

test('Integration Kit rows for every runtime', { timeout: 1200000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/kits/'));
  for (const runtime of Object.keys(RUNTIMES)) {
    const row = (s) => rows.find((r) => r.operation === `${runtime}: ${s}`);
    let offline;
    await rec.check([row('Download valid ZIP with successful feedback').id, row('Choose offline mode').id, row('Extract/build/start in target runtime').id], `/kits ${runtime}: download offline kit, extract, build, test, start`, async () => {
      offline = await download(page, runtime, ['asks', 'events'], 'offline');
      expect(offline.filename === `ordex-${runtime}-kit.zip`, offline.filename);
      const r = await verifyKitDir(offline.dir, { runtime, mode: 'offline' });
      expect(/fail 0/.test(r.testOutput), `kit tests: ${r.testOutput.slice(-400)}`);
      if (runtime === 'node') expect(/conformance cases give the recorded verdict \(asks, events\)/.test(r.startOutput), r.startOutput.slice(0, 400));
      return { status: offline.status, files: Object.keys(offline.zip.files).length, tests: (r.testOutput.match(/# pass \d+|ℹ pass \d+/) || [''])[0], start: r.startOutput.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) };
    });
    await rec.check(row('Selected capabilities affect executable kit').id, `/kits ${runtime}: other capabilities change the kit`, async () => {
      const other = await download(page, runtime, ['offers'], 'offline');
      const has = (z, f) => !!z.file(`ordex-${runtime}-kit/fixtures/${f}`);
      expect(has(other.zip, 'offer-vectors.json') && !has(other.zip, 'purchase-vectors.json') && !has(other.zip, 'event-vectors.json'), 'offers-only kit carries other fixtures');
      expect(offline && has(offline.zip, 'purchase-vectors.json') && has(offline.zip, 'event-vectors.json') && !has(offline.zip, 'offer-vectors.json'), 'asks+events kit fixtures');
      const r = await verifyKitDir(other.dir, { runtime, mode: 'offline' });
      expect(/fail 0/.test(r.testOutput), `kit tests: ${r.testOutput.slice(-400)}`);
      if (runtime === 'node') expect(/\(offers\)/.test(r.startOutput), r.startOutput.slice(0, 300));
      await rm(other.root, { recursive: true, force: true });
      return { asksEvents: ['purchase-vectors.json', 'event-vectors.json'], offers: ['offer-vectors.json'] };
    });
    if (offline) await rm(offline.root, { recursive: true, force: true });
    await rec.check(row('Choose configured gateway mode').id, `/kits ${runtime}: gateway mode reads the configured signet gateway`, async () => {
      const kit = await download(page, runtime, ['asks', 'events'], 'gateway');
      const config = await kit.zip.file(`ordex-${runtime}-kit/src/config.ts`).async('string');
      expect(config.includes(`GATEWAY_ORIGIN = '${gateway.origin}'`) && config.includes("NETWORK = 'signet'"), 'gateway origin and network not in the kit');
      const r = await verifyKitDir(kit.dir, { runtime, mode: 'gateway' });
      expect(/fail 0/.test(r.testOutput), `kit tests: ${r.testOutput.slice(-400)}`);
      if (runtime === 'node') expect(/ok {5}network: signet/.test(r.startOutput), r.startOutput.slice(0, 400));
      await rm(kit.root, { recursive: true, force: true });
      return { gatewayOrigin: gateway.origin, network: 'signet' };
    });
  }
  assert.deepEqual(errors, []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});
