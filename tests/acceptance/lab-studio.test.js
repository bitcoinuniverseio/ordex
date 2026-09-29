import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { startStaticServer, launch, openPage } from '../e2e/harness.mjs';
import { FAMILIES, resultKey } from '../../site/src/lib/conformance-registry.mjs';
import { runConformanceSuite } from '../../site/src/lib/conformance-engine.mjs';
import { loadAllFamilies } from '../../scripts/docs/vector-loader.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for Protocol Lab (OX-S-C900..C908), Conformance Studio (OX-S-C910..C918)
// and Gateway Doctor (OX-S-C930..C937). The Lab loads an accepted and a refused vector of each
// family, runs both in the Worker, edits the input so the verdict changes, and exports the
// report. The Studio runs each family and every row must equal the CLI runner's result.

const vectors = JSON.parse(await readFile(new URL('../../site/src/data/allVectors.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../../site/src/data/vectorManifest.json', import.meta.url), 'utf8'));
const lab = rowsOf('Protocol Lab');
const studio = rowsOf('Conformance Studio');
const doctor = rowsOf('Gateway Doctor');
const rec = rowRecorder('tests/acceptance/lab-studio.test.js');
const OUTCOME_TEXT = { EXPECTED_ACCEPTANCE_MATCHED: 'Accepted, as expected', EXPECTED_REFUSAL_MATCHED: 'Refused, as expected' };

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

test('Protocol Lab rows: load, run, edit and export per family', { timeout: 600000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/lab/'));
  for (const family of FAMILIES) {
    const r = lab.find((x) => x.operation.startsWith(`${family}:`));
    await rec.check(r.id, `/lab ${family}: load, run, edit, re-run, export`, async () => {
      await page.getByRole('tab', { name: 'Inspect' }).click();
      await page.getByLabel('Verifier family').selectOption(family);
      const cases = vectors.filter((v) => v.family === family);
      const accepted = cases.find((c) => c.case.expected[resultKey(family, c.variant)] === true);
      const refused = cases.find((c) => c.case.expected[resultKey(family, c.variant)] === false && c.case.expected.code);
      const out = {};
      for (const pick of [accepted, refused]) {
        await page.getByLabel('Variant').selectOption(pick.variant);
        await page.getByLabel('Load a conformance vector').selectOption(pick.id);
        await page.getByRole('button', { name: 'Run reference verifier' }).click();
        const expected = pick === accepted ? 'Accepted by the reference verifier' : 'Refused by the reference verifier';
        await page.getByText(expected).waitFor({ timeout: 15000 });
        await page.getByText(`Matches the expected verdict of ${pick.id}.`).waitFor();
        if (pick === refused) expect((await page.locator('main').innerText()).includes(pick.case.expected.code), `code ${pick.case.expected.code} not shown`);
        out[pick === accepted ? 'accepted' : 'refused'] = pick.id;
      }
      // Edit: the refused case's input, changed by hand, is a new candidate with no stale verdict.
      const input = page.getByLabel(/Input JSON/);
      const edited = JSON.parse(await input.inputValue());
      const firstKey = Object.keys(edited)[0];
      edited[firstKey] = typeof edited[firstKey] === 'object' ? { ...edited[firstKey], __edited: true } : `${edited[firstKey]}x`;
      await input.fill(JSON.stringify(edited, null, 2));
      expect((await page.getByText(/by the reference verifier/).count()) === 0, 'the previous verdict stayed visible after editing');
      await page.getByRole('button', { name: 'Run reference verifier' }).click();
      await page.getByText(/by the reference verifier|could not reach a verdict|Refused|Accepted/).first().waitFor({ timeout: 15000 });
      out.edited = (await page.getByText(/by the reference verifier/).first().innerText().catch(() => 'no verdict')).trim();
      await page.getByRole('tab', { name: 'Export' }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON (.json)' }).click()]);
      const report = JSON.parse(await readFile(await download.path(), 'utf8'));
      expect(report.schema === 'ordex.lab-report/v1' && report.family === family, `report ${report.schema} ${report.family}`);
      expect(/^[0-9a-f]{64}$/.test(report.inputSha256) && report.vectorDigest === manifest.vectorDigest, 'report digests');
      out.report = { verdict: report.verdict?.state, inputSha256: report.inputSha256 };
      return out;
    });
  }
  assert.deepEqual(errors, []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});

test('Conformance Studio rows: every family equals the CLI runner, row by row', { timeout: 600000 }, async () => {
  const cli = runConformanceSuite(loadAllFamilies());
  const { page, context, errors } = await openPage(browser, site.url('/verify/'));
  for (const family of FAMILIES) {
    const r = studio.find((x) => x.operation.startsWith(`${family}:`));
    await rec.check(r.id, `/verify ${family}: run, filter and inspect`, async () => {
      const mine = cli.results.filter((x) => x.family === family);
      await page.getByRole('group', { name: 'Verifier family' }).getByRole('button', { name: new RegExp(`^${family} \\(`) }).click();
      await page.getByRole('button', { name: `Run ${mine.length} vectors` }).click();
      await page.getByText(`All ${mine.length} selected vectors reached their expected verdict.`).waitFor({ timeout: 60000 });
      await page.getByRole('group', { name: 'Result filter' }).getByRole('button', { name: `Passed (${mine.length})` }).click();
      const rows = page.getByRole('region', { name: 'Conformance results' }).locator('tbody tr');
      expect((await rows.count()) === mine.length, `passed filter shows ${await rows.count()} rows`);
      const texts = await rows.allInnerTexts();
      for (const [i, res] of mine.entries()) {
        expect(texts[i].includes(res.name) && texts[i].includes(OUTCOME_TEXT[res.outcome]), `row ${i} (${res.name}) differs from the CLI: ${texts[i]}`);
      }
      await page.getByRole('group', { name: 'Result filter' }).getByRole('button', { name: 'Failed (0)' }).click();
      expect((await rows.count()) === 0, 'failed filter is not empty');
      await page.getByRole('group', { name: 'Result filter' }).getByRole('button', { name: /^All \(/ }).click();
      return { vectors: mine.length, cli: mine.length, matchesCli: true };
    });
  }
  assert.deepEqual(errors, []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});

test('Gateway Doctor rows need a gateway that serves the documentation origin', () => {
  for (const r of doctor) {
    rec.record(
      r.id,
      'BLOCKED',
      r.operation,
      'Pending release deployment: Gateway Doctor checks a Signet Ordex gateway from the documentation origin. The Signet acceptance gateway (Core, 127.0.0.1:3043) answers CORS only for the Core frontend origins and the documentation site is not deployed, so no real gateway readiness can be observed. The Doctor itself is gated in tests/e2e/doctor.test.js (a compliant local gateway passes, a wrong-network one and an unreachable one fail).'
    );
  }
});
