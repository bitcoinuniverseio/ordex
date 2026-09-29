import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startStaticServer, launch, openPage, ROOT } from '../e2e/harness.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for the Failure Navigator (OX-S-C300..C671): every listed code is looked up
// through its /diagnose deep link and compared with the published rule, and every reproducer
// of the rule is run in the browser Worker and downloaded, then the downloaded script is run
// with Node from this checkout and must print the code.

const diagnostics = JSON.parse(await readFile(new URL('../../site/src/data/diagnostics.json', import.meta.url), 'utf8'));
const RULES = new Map(diagnostics.map((d) => [d.exactCodes[0], d]));
// Codes the verifiers stopped returning when the protocol stream replaced the branch.
const RETIRED = {
  ASSET_TRANSITION_DUPLICATED: 'OX-P02 (6cb053a)',
  TRANSITION_SAT_FLOW_MISMATCH: 'OX-P02 (6cb053a)',
  TRANSITION_SOURCE_MISMATCH: 'OX-P02 (6cb053a)',
  FELINE_OUTPOINT_DUPLICATED: 'OX-P05 (fda462b)',
  OFFER_OUTPOINT_DUPLICATED: 'OX-P05 (fda462b)',
  SEQUENCE_NOT_REPLACEABLE: 'OX-P05 (fda462b)',
  TERMS_HASH_NOT_COMMITTED: 'OX-P05 (fda462b)',
  INPUT_VALUE_CHANGED: 'OX-P01 (19e983e)',
  UNEXPECTED_SIGNATURE: 'OX-P01 (19e983e)',
  OUTPUT_VALUE_UNKNOWN: 'OX-P10 (6dc0322)'
};

const rows = rowsOf('Failure Navigator');
const codeOf = (r) => r.operation.replace(/^(Lookup|Generate and execute reproducer for) /, '');
const rec = rowRecorder('tests/acceptance/navigator.test.js');

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

test('every Failure Navigator row: lookup and reproducers', { timeout: 1800000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/diagnose/'));
  const codes = [...new Set(rows.map(codeOf))];
  for (const code of codes) {
    const lookup = rows.find((r) => r.operation === `Lookup ${code}`);
    const repro = rows.find((r) => r.operation === `Generate and execute reproducer for ${code}`);
    await page.goto(site.url(`/diagnose/?code=${code}`), { waitUntil: 'networkidle' });
    const rule = RULES.get(code);
    if (!rule) {
      const text = await page.locator('main').innerText();
      const honest = text.includes('which no Ordex verifier returns') && !text.includes('confidence conclusive');
      const reason = `${code} is no longer returned by any reference verifier: retired by ${RETIRED[code] || 'the protocol stream'}.`;
      if (honest && RETIRED[code]) {
        rec.record(lookup.id, 'NOT APPLICABLE', `/diagnose/?code=${code}`, `${reason} The lookup reports it as a code no Ordex verifier returns, not a conclusive diagnosis.`, { shown: 'not conclusive' });
        rec.record(repro.id, 'NOT APPLICABLE', `/diagnose/?code=${code}`, `${reason} No verifier branch exists to reproduce.`);
      } else {
        await rec.check([lookup.id, repro.id], `/diagnose/?code=${code}`, async () => expect(false, `unknown code ${code} is not reported honestly`));
      }
      continue;
    }
    await rec.check(lookup.id, `/diagnose/?code=${code}`, async () => {
      await page.getByRole('heading', { name: code, exact: true }).waitFor();
      const card = page.locator('[aria-labelledby="diagnosis-code"]');
      const text = await card.innerText();
      expect(text.includes('confidence conclusive'), 'not conclusive');
      expect(text.includes(rule.summary), 'summary differs from the rule');
      if (rule.invariant) expect(text.includes(rule.invariant), 'specification requirement differs');
      for (const c of rule.causes) expect(text.includes(`${c.source.path}:${c.source.line}`), `source ${c.source.path}:${c.source.line} missing`);
      for (const s of rule.resolutionSteps) expect(text.includes(s.action), `recovery step missing: ${s.action}`);
      for (const e of rule.evidenceRequirements) expect(text.includes(e.evidenceType), `evidence missing: ${e.evidenceType}`);
      return { families: rule.families, causes: rule.causes.length, recoverySteps: rule.resolutionSteps.length, invariant: !!rule.invariant };
    });
    await rec.check(repro.id, `/diagnose/?code=${code} reproducers`, async () => {
      const card = page.locator('[aria-labelledby="diagnosis-code"]');
      const out = [];
      for (const [i, r] of rule.reproducers.entries()) {
        await card.getByRole('button', { name: 'Run in this browser' }).nth(i).click();
        const cell = card.getByRole('row', { name: /^Result/ }).nth(i);
        await cell.waitFor({ timeout: 20000 });
        const result = (await cell.innerText()).trim();
        expect(/Reproduced$/.test(result), `${r.family}: ${result}`);
        const file = `reproduce-${code}${rule.reproducers.length > 1 ? `-${r.family}` : ''}.mjs`;
        const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: `Download ${file}` }).click()]);
        const script = await readFile(await download.path(), 'utf8');
        const target = join(ROOT, `.acceptance-${file}`);
        await writeFile(target, script);
        try {
          const printed = execFileSync(process.execPath, [target], { cwd: ROOT, encoding: 'utf8' }).trim();
          expect(printed.startsWith(`${code} reproduced:`), `${r.family} script printed: ${printed}`);
          out.push({ family: r.family, variant: r.variant, base: r.base, worker: 'Reproduced', script: printed });
        } finally {
          await rm(target, { force: true });
        }
      }
      return out;
    });
  }
  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});
