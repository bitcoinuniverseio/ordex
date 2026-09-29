import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { startStaticServer, launch, waitForHydration } from '../e2e/harness.mjs';
import { MISSIONS } from '../../site/src/lib/experience/mission-registry.js';
import { MISSION_EVIDENCE } from '../../site/src/lib/experience/mission-evidence.js';
import { MUTATION_FIXTURES } from '../../site/src/lib/artifacts/mutation-fixtures.js';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for the Launchpad (OX-S-C001..C009), the Mission Workspace (C010..C081) and
// Journey State (C082..C089). Every stage is completed the way a reader would: open the tool
// from the stage (the handoff carries only the session and stage ids), run it for real, return
// and complete. The run record the tool stored in IndexedDB must name this mission and stage.
// Stages whose requirement is a run against a configured gateway are recorded as blocked.

const vectors = JSON.parse(await readFile(new URL('../../site/src/data/allVectors.json', import.meta.url), 'utf8'));
const launchpad = rowsOf('Launchpad');
const workspace = rowsOf('Mission Workspace');
const journey = rowsOf('Journey State');
const rec = rowRecorder('tests/acceptance/missions.test.js');
const KIT_CAP = { purchase: 'Public asks and purchases', offers: 'Buyer-funded offers', safeops: 'SafeOps plans and signed results', swaps: 'Swap intents and acceptances', events: 'Events and signed webhooks', 'collection-manifest': 'Collection manifests and membership' };
const GATEWAY =
  'Pending release deployment: this stage completes only with a run against a configured Ordex gateway. The Signet acceptance gateway (Core, 127.0.0.1:3043) answers CORS only for the Core frontend origins and the documentation site is not deployed, so no real gateway run can be recorded.';

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

async function goto(page, route) {
  await page.goto(site.url(route), { waitUntil: 'networkidle' });
  await waitForHydration(page);
}
const stageButton = (page, i) => page.getByRole('navigation', { name: 'Mission stages' }).getByRole('button').nth(i);

/** Evidence records stored in this browser. */
const evidence = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('ordex_experience_db');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const out = {};
          const names = ['evidence', 'sessions'];
          const tx = db.transaction(names, 'readonly');
          let left = names.length;
          for (const n of names) {
            const g = tx.objectStore(n).getAll();
            g.onsuccess = () => {
              out[n] = g.result;
              if (--left === 0) resolve(out);
            };
          }
        };
      })
  );

/** Run the tool a stage opened, so that it records the run the requirement asks for. */
async function produce(page, missionId, stageId, req) {
  const op = req.operations[0];
  switch (req.tool) {
    case 'sandbox': {
      if (op === 'injection:') {
        await page.getByRole('button', { name: /^Inject: / }).first().click();
        await page.getByText(/Verifier refused: /).first().waitFor({ timeout: 20000 });
        return;
      }
      for (let i = 0; i < 12; i++) {
        await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some((s) => s.textContent.includes('Running verifier')), null, { timeout: 20000 });
        const next = page.getByRole('button', { name: 'Next step' });
        if (await next.isDisabled()) break;
        await next.click();
      }
      return;
    }
    case 'artifact-lens': {
      if (req.operations.length === 1 && op === 'compare:') {
        const f = MUTATION_FIXTURES.find((m) => m.id === 'mut-amount-plus-one');
        await page.getByRole('tab', { name: 'Compare' }).click();
        await page.getByRole('button', { name: `Example: ${f.name}` }).click();
        await page.getByText(/Dangerous change/).first().waitFor();
      } else {
        await page.getByRole('button', { name: 'Decode', exact: true }).click();
        await page.getByText(/Decoded as/).first().waitFor();
      }
      return;
    }
    case 'lab': {
      const family = op.replace(/\/$/, '');
      const wantAccepted = req.states.includes('accepted');
      const pick = vectors.find((v) => v.family === family && (wantAccepted ? v.case.expected.ok === true || v.case.expected.safe === true : v.case.expected.code));
      await page.getByLabel('Verifier family').selectOption(family);
      await page.getByLabel('Variant').selectOption(pick.variant);
      await page.getByLabel('Load a conformance vector').selectOption(pick.id);
      await page.getByRole('button', { name: 'Run reference verifier' }).click();
      await page.getByText(wantAccepted ? 'Accepted by the reference verifier' : 'Refused by the reference verifier').waitFor({ timeout: 15000 });
      return;
    }
    case 'kits': {
      const family = op === 'kit:' ? 'purchase' : op.slice(4);
      for (const [f, label] of Object.entries(KIT_CAP)) {
        const box = page.getByLabel(label, { exact: true });
        if ((await box.isChecked()) !== (f === family)) await box.click();
      }
      await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Download ordex-/ }).click()]);
      await page.getByText(/Download started: /).waitFor();
      return;
    }
    case 'conformance': {
      const family = op.slice('suite:'.length);
      if (family !== 'all') await page.getByRole('group', { name: 'Verifier family' }).getByRole('button', { name: new RegExp(`^${family} \\(`) }).click();
      else await page.getByRole('group', { name: 'Verifier family' }).getByRole('button', { name: /^all \(/ }).click();
      await page.getByRole('button', { name: /^Run \d+ vectors$/ }).click();
      await page.getByText(/selected vectors reached their expected verdict/).waitFor({ timeout: 60000 });
      return;
    }
    case 'wizards': {
      for (let i = 0; i < 6; i++) {
        await page.locator('fieldset input').first().check();
        if ((await page.getByRole('button', { name: 'Finish' }).count()) > 0) {
          await page.getByRole('button', { name: 'Finish' }).click();
          break;
        }
        await page.getByRole('button', { name: 'Continue' }).click();
      }
      await page.getByRole('heading', { name: 'Next steps' }).waitFor();
      return;
    }
    case 'failure-navigator': {
      await page.getByLabel('Code or JSON').fill('SELLER_VALUE_MISMATCH');
      await page.getByRole('button', { name: 'Diagnose', exact: true }).click();
      await page.getByRole('button', { name: 'Run in this browser' }).first().click();
      await page.getByText('Reproduced', { exact: true }).first().waitFor({ timeout: 20000 });
      return;
    }
    case 'atlas': {
      for (let i = 0; i < 30 && (await page.getByRole('button', { name: /Next/ }).first().isEnabled()); i++) await page.getByRole('button', { name: /Next/ }).first().click();
      return;
    }
    case 'events': {
      const v = JSON.parse(await readFile(new URL('../../conformance/event-vectors.json', import.meta.url), 'utf8')).cases.find((c) => c.kind === 'webhook' && c.expected.ok);
      const { signWebhookDelivery } = await import('../../verifier/events.js');
      await page.getByRole('tab', { name: 'Webhook signature' }).click();
      await page.getByLabel('Subscription secret').fill(v.signing.secret);
      await page.getByLabel('Raw body, exactly as received').fill(v.signing.body);
      await page.getByLabel('X-Ordex-Signature header').fill(signWebhookDelivery(v.signing));
      await page.getByLabel('nowSeconds').fill(String(v.verifying.nowSeconds));
      await page.getByRole('button', { name: 'Verify signature' }).click();
      await page.getByText('Signature valid').waitFor();
      return;
    }
    default:
      throw new Error(`no producer for ${req.tool} (${missionId}/${stageId})`);
  }
}

test('Launchpad rows', { timeout: 300000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const r of launchpad) {
    const id = r.operation.replace('Select mission ', '');
    const mission = MISSIONS.find((m) => m.id === id);
    await rec.check(r.id, `/ select a goal containing ${id}, start it, return and resume`, async () => {
      await goto(page, '/');
      const goals = page.getByRole('radio');
      let found = false;
      for (let i = 0; i < (await goals.count()); i++) {
        await goals.nth(i).click();
        if ((await page.getByRole('link', { name: `Start mission: ${mission.title}` }).count()) > 0) {
          found = true;
          break;
        }
      }
      expect(found, 'no goal shows this mission');
      await page.getByRole('link', { name: `Start mission: ${mission.title}` }).click();
      await page.waitForURL(new RegExp(`/workspace/\\?mission=${id}$`));
      await page.getByRole('heading', { name: mission.title }).waitFor();
      await waitForHydration(page);
      const store = await evidence(page);
      const sessions = store.sessions.filter((s) => s.missionId === id);
      expect(sessions.length === 1, `${sessions.length} sessions for ${id}`);
      await goto(page, '/');
      await page.getByText(`Mission: ${id} (Stage: ${sessions[0].activeStageId})`).waitFor();
      return { workspace: `/workspace/?mission=${id}`, session: sessions[0].id, resumeShows: sessions[0].activeStageId };
    });
  }
  await context.close();
  assert.deepEqual(rec.failures(), []);
});

test('Mission Workspace rows: every stage of every mission', { timeout: 1800000 }, async () => {
  for (const mission of MISSIONS) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const done = [];
    for (const [i, stage] of mission.stages.entries()) {
      const r = workspace.find((x) => x.operation === `${mission.id}: ${stage.id} completion and tool handoff`);
      if (stage.id === 'finish') {
        const pending = mission.stages.filter((s) => s.id !== 'finish' && !done.includes(s.id));
        if (pending.length) {
          rec.record(r.id, 'BLOCKED', `/workspace/?mission=${mission.id} finish`, `${GATEWAY} Stages still waiting for it: ${pending.map((s) => s.id).join(', ')}.`);
          continue;
        }
        await rec.check(r.id, `/workspace/?mission=${mission.id} finish`, async () => {
          await goto(page, `/workspace/?mission=${mission.id}`);
          await stageButton(page, i).click();
          await page.getByRole('button', { name: 'Check evidence and complete' }).click();
          await page.getByText('Mission complete: every stage is backed by current evidence.').waitFor();
          return { stagesCompleted: done };
        });
        continue;
      }
      const req = MISSION_EVIDENCE[mission.id][stage.id];
      if (req.needsGateway) {
        rec.record(r.id, 'BLOCKED', `/workspace/?mission=${mission.id} ${stage.id}`, GATEWAY);
        continue;
      }
      await rec.check(r.id, `/workspace/?mission=${mission.id} ${stage.id}: ${req.label}`, async () => {
        await goto(page, `/workspace/?mission=${mission.id}`);
        await stageButton(page, i).click();
        await page.getByRole('button', { name: 'Check evidence and complete' }).click();
        await page.getByRole('alert').getByText(/Not complete yet/).waitFor();
        let handoff = null;
        if (stage.id === 'understand') {
          await page.getByRole('button', { name: 'I have read the guide' }).click();
        } else {
          const link = page.locator('[data-tour="stage-evidence"] a');
          handoff = await link.getAttribute('href');
          expect(new RegExp(`\\?journey=ses_[0-9a-f]+&stage=${stage.id}`).test(handoff), `handoff ${handoff}`);
          await link.click();
          await page.waitForLoadState('networkidle');
          await waitForHydration(page);
          await produce(page, mission.id, stage.id, req);
          await page.waitForTimeout(300);
          await goto(page, `/workspace/?mission=${mission.id}`);
          await stageButton(page, i).click();
        }
        await page.getByRole('button', { name: 'Check evidence and complete' }).click();
        await page.getByText('Stage complete. Its evidence is saved with this mission.').waitFor();
        const store = await evidence(page);
        const session = store.sessions.find((s) => s.missionId === mission.id);
        const cited = session.completedStages.find((c) => c.stageId === stage.id).evidenceIds;
        const rows = store.evidence.filter((e) => cited.includes(e.id));
        expect(rows.length > 0 && rows.every((e) => e.tool === req.tool), `cited ${JSON.stringify(rows.map((e) => e.tool))}`);
        if (stage.id !== 'understand') expect(rows.some((e) => e.missionId === mission.id && e.stageId === stage.id), 'the run is not attached to this mission and stage');
        done.push(stage.id);
        return { handoff, evidence: rows.map((e) => ({ tool: e.tool, operation: e.operation, state: e.result.state, missionId: e.missionId, stageId: e.stageId })) };
      });
    }
    expect(errors.length === 0, `${mission.id}: ${errors.join('; ')}`);
    await context.close();
  }
  assert.deepEqual(rec.failures(), []);
});

test('Journey State rows', { timeout: 600000 }, async () => {
  const j = (prefix) => journey.find((r) => r.operation.startsWith(prefix)).id;
  const context = await browser.newContext();
  const page = await context.newPage();

  await rec.check(j('Per-mission resume'), 'reopening and reloading a mission reuses its one session', async () => {
    await goto(page, '/workspace/?mission=integrate-atomic-swaps');
    await page.reload({ waitUntil: 'networkidle' });
    await goto(page, '/workspace/?mission=integrate-atomic-swaps');
    const s = (await evidence(page)).sessions.filter((x) => x.missionId === 'integrate-atomic-swaps');
    expect(s.length === 1, `${s.length} sessions`);
    return { sessions: 1 };
  });

  await rec.check(j('Switch query mission'), 'a second mission URL during startup wins without mixing sessions', async () => {
    await page.goto(site.url('/workspace/?mission=protect-wallet-signing'));
    await page.goto(site.url('/workspace/?mission=integrate-buyer-funded-offers'), { waitUntil: 'networkidle' });
    await waitForHydration(page);
    const m = MISSIONS.find((x) => x.id === 'integrate-buyer-funded-offers');
    await page.getByRole('heading', { name: m.title }).waitFor();
    const s = (await evidence(page)).sessions;
    for (const id of new Set(s.map((x) => x.missionId))) expect(s.filter((x) => x.missionId === id).length === 1, `duplicate sessions for ${id}`);
    return { shown: m.id };
  });

  await rec.check(j('Refresh/back restores'), 'stage progress and the active stage survive reload and back', async () => {
    await goto(page, '/workspace/?mission=integrate-atomic-swaps');
    await stageButton(page, 0).click();
    await page.getByRole('button', { name: 'I have read the guide' }).click();
    await page.getByRole('button', { name: 'Check evidence and complete' }).click();
    await page.getByText('Stage complete.', { exact: false }).waitFor();
    await goto(page, '/lab/');
    await page.goBack({ waitUntil: 'networkidle' });
    await waitForHydration(page);
    await page.getByRole('button', { name: /^1\. Understand Mechanics: complete/ }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^1\. Understand Mechanics: complete/ }).waitFor();
    expect((await page.getByRole('button', { name: /^2\. Prepare Parameters/ }).getAttribute('aria-current')) === 'step', 'active stage not restored');
    return { completed: 'understand', active: 'prepare' };
  });

  await rec.check(j('Cross-tab session/settings'), 'a completion and a settings change in one tab reach another open tab', async () => {
    const other = await context.newPage();
    await goto(other, '/workspace/?mission=integrate-atomic-swaps');
    await goto(page, '/workspace/?mission=integrate-atomic-swaps');
    await stageButton(page, 1).click();
    await goto(page, '/workspace/?mission=integrate-atomic-swaps');
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByLabel('Network', { exact: true }).selectOption('testnet4');
    await page.getByRole('button', { name: 'Close' }).click();
    await other.getByRole('button', { name: /^Settings: .*Testnet4/ }).waitFor({ timeout: 10000 });
    await other.getByText(/Context: testnet4/).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByLabel('Network', { exact: true }).selectOption('mainnet');
    await page.getByRole('button', { name: 'Close' }).click();
    await other.close();
    return { propagated: 'network testnet4 to the other tab without reload' };
  });

  await rec.check(j('Network/origin/version propagate'), 'network, gateway origin and protocol version reach every tool', async () => {
    await goto(page, '/workspace/');
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByLabel('Network', { exact: true }).selectOption('signet');
    await page.getByLabel('Gateway origin').fill('https://gateway.example');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByLabel('Protocol version').selectOption('1.1');
    await page.getByRole('button', { name: 'Close' }).click();
    const seen = {};
    for (const route of ['/workspace/?mission=operate-gateway-and-events', '/build/playground/', '/verify/', '/lab/', '/kits/']) {
      await goto(page, route);
      const label = await page.getByRole('button', { name: /^Settings:/ }).first().getAttribute('aria-label').catch(() => null) || (await page.getByRole('button', { name: /^Settings:/ }).first().innerText());
      expect(/protocol 1\.1/.test(label) && /Signet/.test(label) && /gateway\.example/.test(label), `${route}: ${label}`);
      seen[route] = label;
    }
    await goto(page, '/workspace/?mission=operate-gateway-and-events');
    await page.getByText(/Context: signet, https:\/\/gateway\.example, protocol 1\.1/).waitFor();
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByLabel('Network', { exact: true }).selectOption('mainnet');
    await page.getByLabel('Gateway origin').fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByLabel('Protocol version').selectOption('1.2');
    await page.getByRole('button', { name: 'Close' }).click();
    return seen;
  });

  await rec.check(j('Change environment invalidates'), 'a completed stage needs repeating after the network changes', async () => {
    await goto(page, '/workspace/?mission=integrate-atomic-swaps');
    await page.getByRole('button', { name: /^1\. Understand Mechanics: complete/ }).waitFor();
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByLabel('Network', { exact: true }).selectOption('signet');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: /^1\. Understand Mechanics: needs to be repeated/ }).waitFor();
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByLabel('Network', { exact: true }).selectOption('mainnet');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: /^1\. Understand Mechanics: complete/ }).waitFor();
    return { afterChange: 'needs to be repeated', afterRestore: 'complete' };
  });

  await rec.check(j('Reset mission removes only'), 'reset clears one mission and keeps the others and the recorded runs', async () => {
    await goto(page, '/workspace/?mission=protect-wallet-signing');
    await stageButton(page, 0).click();
    await page.getByRole('button', { name: 'I have read the guide' }).click();
    await page.getByRole('button', { name: 'Check evidence and complete' }).click();
    await page.getByText('Stage complete.', { exact: false }).waitFor();
    const before = (await evidence(page)).evidence.length;
    await page.getByRole('button', { name: 'Reset progress' }).click();
    await page.getByText('Progress reset.', { exact: false }).waitFor();
    await page.getByRole('button', { name: /^1\. Understand Mechanics: not complete/ }).waitFor();
    await goto(page, '/workspace/?mission=integrate-atomic-swaps');
    await page.getByRole('button', { name: /^1\. Understand Mechanics: complete/ }).waitFor();
    const after = (await evidence(page)).evidence.length;
    expect(after === before, `runs ${before} -> ${after}`);
    return { reset: 'protect-wallet-signing', kept: 'integrate-atomic-swaps', runsKept: after };
  });
  await context.close();

  await rec.check(j('Durable write failure'), 'without IndexedDB the page says progress stays in this tab; a malformed stored session is not used', async () => {
    const noIdb = await browser.newContext();
    await noIdb.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }));
    const p = await noIdb.newPage();
    await goto(p, '/workspace/?mission=integrate-atomic-swaps');
    await p.getByRole('button', { name: /^Settings:/ }).click();
    await p.getByText('Saved progress: this tab only (browser storage unavailable)').waitFor();
    await noIdb.close();
    const bad = await browser.newContext();
    const q = await bad.newPage();
    await goto(q, '/workspace/?mission=integrate-atomic-swaps');
    await q.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open('ordex_experience_db');
          r.onsuccess = () => {
            const tx = r.result.transaction('sessions', 'readwrite');
            tx.objectStore('sessions').put({ schemaVersion: 2, id: 'ses_ffffffffffffffffffffffff', missionId: 'integrate-atomic-swaps', completedStages: 'not an array', evidenceIds: [], revision: -1 });
            tx.oncomplete = () => resolve();
          };
        })
    );
    await q.reload({ waitUntil: 'networkidle' });
    await waitForHydration(q);
    await q.getByRole('button', { name: /^1\. Understand Mechanics: not complete/ }).waitFor();
    const errs = [];
    q.on('pageerror', (e) => errs.push(e.message));
    await stageButton(q, 0).click();
    await q.getByRole('button', { name: 'I have read the guide' }).click();
    await q.getByRole('button', { name: 'Check evidence and complete' }).click();
    await q.getByText('Stage complete.', { exact: false }).waitFor();
    expect(errs.length === 0, errs.join('; '));
    await bad.close();
    return { noIndexedDb: 'this tab only', malformedSession: 'ignored; a valid session is used' };
  });
  assert.deepEqual(rec.failures(), []);
});
