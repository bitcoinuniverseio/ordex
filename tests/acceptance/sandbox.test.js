import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startStaticServer, launch, openPage } from '../e2e/harness.mjs';
import { SCENARIOS } from '../../site/src/lib/scenarios/registry.js';
import { checkInputFor } from '../../site/src/lib/scenarios/engine.js';
import { evaluateCandidate } from '../../site/src/lib/conformance-engine.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for the Transaction Sandbox (OX-S-C200..C245). Per scenario: the timeline
// controls keep the selected scenario and step; every verifier verdict shown equals the
// reference verifier run from Node on the exact step input; the last checked step's input is
// handed to Protocol Lab by artifact reference and runs there with the same digest and verdict.

const rows = rowsOf('Transaction Sandbox');
const rec = rowRecorder('tests/acceptance/sandbox.test.js');

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

const status = (page) => page.locator('[role="status"][aria-live="polite"]').first();
const stepText = async (page) => (await page.getByText(/^Step \d+ of \d+/).first().innerText()).match(/Step (\d+) of (\d+)/).slice(1).map(Number);
async function settle(page) {
  await page.waitForFunction((el) => !el.textContent.includes('Running verifier'), await status(page).elementHandle(), { timeout: 20000 });
}

test('Transaction Sandbox rows for every scenario', { timeout: 900000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/sandbox/'));
  for (const sc of SCENARIOS) {
    const row = (suffix) => rows.find((r) => r.operation === `${sc.id}: ${suffix}`);
    await page.goto(site.url(`/sandbox/?scenario=${encodeURIComponent(sc.id)}`), { waitUntil: 'networkidle' });

    await rec.check(row('select/play/pause/step/reset').id, `/sandbox ${sc.id}: select, play, pause, step, reset`, async () => {
      await page.getByLabel('Choose Scenario').selectOption(sc.id);
      expect((await page.getByLabel('Choose Scenario').inputValue()) === sc.id, 'scenario not selected');
      const [first, total] = await stepText(page);
      expect(first === 1 && total === sc.steps.length, `starts at ${first}/${total}`);
      await settle(page);
      const trail = [];
      if (total > 1) {
        await page.getByRole('button', { name: 'Next step' }).click();
        await settle(page);
        trail.push((await stepText(page))[0]);
        await page.getByRole('button', { name: 'Previous step' }).click();
        trail.push((await stepText(page))[0]);
        expect(trail[0] === 2 && trail[1] === 1, `next/previous went ${trail.join(' -> ')}`);
      }
      await page.getByRole('button', { name: /Play Simulation/ }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Pause'), null, { timeout: 60000 }).catch(() => {});
      await page.getByRole('button', { name: /Pause|Play Simulation/ }).first().waitFor();
      const [afterPlay] = await stepText(page);
      if ((await page.getByRole('button', { name: 'Pause' }).count()) > 0) await page.getByRole('button', { name: 'Pause' }).click();
      await settle(page);
      const kept = (await page.getByLabel('Choose Scenario').inputValue()) === sc.id;
      expect(kept, 'scenario selection lost during playback');
      await page.getByRole('button', { name: 'Reset' }).click();
      const [afterReset] = await stepText(page);
      expect(afterReset === 1, `reset left step ${afterReset}`);
      return { steps: total, nextPrevious: trail, afterPlay, afterReset };
    });

    await rec.check(row('actual verifier verdict').id, `/sandbox ${sc.id}: every verdict equals the reference verifier`, async () => {
      const seen = [];
      for (let i = 0; i < sc.steps.length; i++) {
        if (i > 0) await page.getByRole('button', { name: 'Next step' }).click();
        await settle(page);
        const text = await status(page).innerText();
        const check = checkInputFor(sc, sc.steps[i]);
        if (check) {
          const direct = evaluateCandidate(check.family, check.variant, check.args).verdict;
          const want = direct.state === 'accepted' ? 'Verifier accepted' : `Verifier refused: ${direct.code}`;
          expect(text.includes(want), `step ${i + 1}: page shows "${text.slice(0, 120)}", Node verifier gives ${direct.state} ${direct.code ?? ''}`);
          seen.push({ step: i + 1, family: check.family, verdict: direct.state, code: direct.code ?? null });
        } else if (sc.steps[i].observation) {
          expect(text.includes(`Fixture refusal: ${sc.steps[i].observation.value}`), `step ${i + 1} fixture: ${text.slice(0, 120)}`);
          seen.push({ step: i + 1, fixture: sc.steps[i].observation.value });
        }
        if (text.includes('Verifier refused') || text.includes('Fixture refusal')) break;
      }
      return seen;
    });

    await rec.check(row('artifact handoff to Lens/Lab').id, `/sandbox ${sc.id}: hand the checked input to Protocol Lab`, async () => {
      await page.getByRole('button', { name: 'Reset' }).click();
      let idx = sc.steps.findIndex((s) => s.verifierCheck);
      for (let i = 0; i < idx; i++) {
        await settle(page);
        await page.getByRole('button', { name: 'Next step' }).click();
      }
      await settle(page);
      const check = checkInputFor(sc, sc.steps[idx]);
      await page.getByRole('button', { name: 'Open this input in Protocol Lab' }).click();
      await page.waitForURL(/\/lab\/\?artifact=art_/);
      await page.getByText(new RegExp(`Loaded ${sc.id.replace(/\./g, '\\.')} step ${idx + 1} from the Sandbox`)).waitFor({ timeout: 15000 });
      expect((await page.getByLabel('Verifier family').inputValue()) === check.family, 'family not carried');
      expect((await page.getByLabel('Variant').inputValue()) === check.variant, 'variant not carried');
      const args = JSON.parse(await page.getByLabel(/Input JSON/).inputValue());
      expect(JSON.stringify(args) === JSON.stringify(check.args), 'arguments were changed on the way');
      await page.getByRole('button', { name: 'Run reference verifier' }).click();
      await page.getByText(/by the reference verifier/).waitFor({ timeout: 15000 });
      const digest = (await page.locator('dt', { hasText: 'Input SHA-256' }).locator('xpath=following-sibling::dd[1]').innerText()).trim();
      expect(digest === check.inputDigest, `Lab digest ${digest} is not the Sandbox input digest ${check.inputDigest}`);
      const artifact = new URL(page.url()).searchParams.get('artifact');
      await page.goto(site.url(`/sandbox/?scenario=${encodeURIComponent(sc.id)}`), { waitUntil: 'networkidle' });
      return { step: idx + 1, family: check.family, variant: check.variant, inputDigest: check.inputDigest, artifact };
    });
  }

  const inj = rows.find((r) => r.operation.startsWith('Public ask failure injection'));
  await rec.check(inj.id, '/sandbox public ask injection: refused by the verifier, removed by reset', async () => {
    const sc = SCENARIOS.find((s) => s.id === 'ask.publish-and-settle.success');
    await page.getByLabel('Choose Scenario').selectOption(sc.id);
    const out = [];
    for (const i of sc.failureInjections) {
      await page.getByRole('button', { name: `Inject: ${i.label}` }).click();
      await status(page).getByText(`Verifier refused: ${i.expectedRefusalCode}`).waitFor({ timeout: 15000 });
      await page.getByText('Before the injected change:').waitFor();
      await page.getByRole('button', { name: 'Remove injection' }).click();
      await page.getByRole('button', { name: 'Reset' }).click();
      expect((await page.getByText('Before the injected change:').count()) === 0, 'mutation still shown after reset');
      out.push({ injection: i.id, code: i.expectedRefusalCode });
    }
    return out;
  });
  assert.deepEqual(errors, []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});
