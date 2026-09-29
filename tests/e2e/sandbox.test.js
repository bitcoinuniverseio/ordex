import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startStaticServer, launch, openPage } from './harness.mjs';
import { SCENARIOS } from '../../site/src/lib/scenarios/registry.js';

// OX-S08 browser gate for /sandbox: every scenario walked step by step with verdicts from the
// Worker, every failure injection refused with its verifier code, and reset restoring state.
// CI: npm run test:browser.

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

const status = (page) => page.locator('[role="status"][aria-live="polite"]').first();

test('/sandbox walks all 15 scenarios with real verdicts', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/sandbox/'));
  for (const sc of SCENARIOS) {
    await page.getByLabel('Choose Scenario').selectOption(sc.id);
    for (let i = 0; i < sc.steps.length; i++) {
      if (i > 0) await page.getByRole('button', { name: 'Next step' }).click();
      await page.waitForFunction((el) => !el.textContent.includes('Running verifier'), await status(page).elementHandle());
    }
    const text = await status(page).textContent();
    if (sc.expectedOutcome === 'refusal') assert.match(text, new RegExp(sc.expectedRefusalCode), sc.id);
    else assert.match(text, /Verifier accepted|No verification at this step/, sc.id);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('/sandbox injections are refused by the verifier and can be removed', async () => {
  const { page, context, errors } = await openPage(browser, server.url('/sandbox/'));
  for (const sc of SCENARIOS.filter((s) => s.failureInjections?.length)) {
    await page.getByLabel('Choose Scenario').selectOption(sc.id);
    for (const inj of sc.failureInjections) {
      await page.getByRole('button', { name: `Inject: ${inj.label}` }).click();
      await status(page).getByText(`Verifier refused: ${inj.expectedRefusalCode}`).waitFor({ timeout: 15000 });
      await page.getByText('Before the injected change:').waitFor();
      await page.getByRole('button', { name: 'Remove injection' }).click();
      await page.getByRole('button', { name: 'Reset' }).click();
    }
  }
  assert.deepEqual(errors, []);
  await context.close();
});
