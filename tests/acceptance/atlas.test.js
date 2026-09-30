import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { startStaticServer, launch, openPage } from '../e2e/harness.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for the Visual Protocol Atlas (OX-S-C1200..C1263). Each diagram is selected
// and compared with its published data (site/src/data/atlas.json, generated from sourced steps:
// every step names the specification section or contract operation it follows); every actor
// and step label must render; Previous, Next, Play and Pause move through the exact steps; the
// Source, Verifier and Transcript panels show that step's source; the exported SVG must be a
// standalone file with the diagram's labels and resolved colors.

const atlas = JSON.parse(await readFile(new URL('../../site/src/data/atlas.json', import.meta.url), 'utf8'));
const rows = rowsOf('Visual Protocol Atlas');
const rec = rowRecorder('tests/acceptance/atlas.test.js');

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

const heading = (page) => page.locator('h4').filter({ hasText: /^Step \d+ of \d+:/ }).first();
const svgText = (page) => page.locator('#protocol-atlas-svg').evaluate((svg) => [...svg.querySelectorAll('text')].map((t) => t.textContent));

test('Visual Protocol Atlas rows', { timeout: 600000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/atlas/'));
  for (const d of atlas) {
    const row = (s) => rows.find((r) => r.operation === `${d.id}: ${s}`).id;
    await rec.check(row('Select and render diagram'), `/atlas select ${d.id}`, async () => {
      await page.getByRole('button', { name: d.title, exact: true }).click();
      await page.getByRole('heading', { name: d.title }).waitFor();
      const texts = await svgText(page);
      for (const a of d.actors) expect(texts.includes(a), `actor ${a} not rendered`);
      expect(texts.includes(`Step 1: ${d.steps[0].label}`), `first step label not rendered: ${texts.join(' | ')}`);
      expect(d.sources?.length > 0 && d.steps.every((s) => s.ref), 'a step has no published source');
      for (const s of d.steps) expect(d.actors.includes(s.from) && d.actors.includes(s.to), `step ${s.step} names an unknown actor`);
      return { actors: d.actors.length, steps: d.steps.length, sources: d.sources.map((s) => `${s.path}#${s.heading}`) };
    });

    await rec.check(row('Play/pause/previous/next steps'), `/atlas ${d.id} step controls`, async () => {
      const seen = [];
      for (let i = 0; i < d.steps.length; i++) {
        const h = await heading(page).innerText();
        expect(h === `Step ${d.steps[i].step} of ${d.steps.length}: ${d.steps[i].label}`, `step ${i + 1}: ${h}`);
        const texts = await svgText(page);
        expect(texts.includes(`Step ${d.steps[i].step}: ${d.steps[i].label}`), `svg label for step ${i + 1}`);
        seen.push(d.steps[i].step);
        if (i < d.steps.length - 1) await page.getByRole('button', { name: /Next/ }).first().click();
      }
      expect(await page.getByRole('button', { name: /Next/ }).first().isDisabled(), 'Next is enabled on the last step');
      await page.getByRole('button', { name: /Prev/ }).first().click();
      expect((await heading(page).innerText()).startsWith(`Step ${d.steps.at(-2)?.step ?? 1} of`), 'Prev did not go back');
      for (let i = 0; i < d.steps.length; i++) if (await page.getByRole('button', { name: /Prev/ }).first().isEnabled()) await page.getByRole('button', { name: /Prev/ }).first().click();
      await page.getByRole('button', { name: /Play/ }).first().click();
      await page.waitForFunction(() => /^Step [2-9]/.test(document.querySelector('h4')?.textContent || '') || [...document.querySelectorAll('h4')].some((h) => /^Step [2-9]/.test(h.textContent)), null, { timeout: 8000 });
      await page.getByRole('button', { name: /Pause/ }).first().click();
      const paused = await heading(page).innerText();
      await page.waitForTimeout(3000);
      expect((await heading(page).innerText()) === paused, 'playback continued after Pause');
      return { steps: seen, pausedAt: paused.split(':')[0] };
    });

    await rec.check(row('Wire/verifier/transcript panel'), `/atlas ${d.id} source, verifier and transcript panels`, async () => {
      const group = page.getByRole('group', { name: 'Step details' });
      const panel = group.locator('xpath=following-sibling::div[1]');
      const i = Number((await heading(page).innerText()).match(/^Step (\d+)/)[1]) - 1;
      const s = d.steps[i];
      await group.getByRole('button', { name: 'Source' }).click();
      const src = await panel.innerText();
      if (s.ref.operationId) expect(src.includes(s.ref.operationId) && src.includes(`${s.ref.method} ${s.ref.path}`), `source panel: ${src}`);
      else if (s.ref.channel) expect(src.includes(s.ref.channel), `source panel: ${src}`);
      else expect(src.includes(s.ref.path) && src.includes(s.ref.heading), `source panel: ${src}`);
      await group.getByRole('button', { name: 'Verifier' }).click();
      const ver = await panel.innerText();
      expect(s.verifier ? ver.includes(s.verifier) : /No reference verifier runs at this step/.test(ver), `verifier panel: ${ver}`);
      await group.getByRole('button', { name: 'Text Transcript' }).click();
      const tr = await panel.innerText();
      for (const st of d.steps) expect(tr.includes(`${st.step}. ${st.from} to ${st.to}: ${st.label}`), `transcript misses step ${st.step}`);
      return { step: s.step, source: s.ref, verifier: s.verifier || null };
    });

    await rec.check(row('Export readable standalone SVG'), `/atlas ${d.id} export`, async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /SVG/ }).first().click()]);
      const svg = await readFile(await dl.path(), 'utf8');
      expect(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg), 'no xmlns on the root');
      expect(/ width="\d+"/.test(svg) && / height="\d+"/.test(svg), 'no size');
      expect(!svg.includes('var(--'), 'unresolved CSS variables in the file');
      expect(svg.includes(`<title>${d.title.replace(/&/g, '&amp;')}`), 'no title');
      for (const a of d.actors) expect(svg.includes(a.replace(/&/g, '&amp;')), `actor ${a} missing in the file`);
      const view = await browser.newContext();
      const p = await view.newPage();
      await p.setContent(svg);
      const box = await p.locator('svg').boundingBox();
      expect(box && box.width > 100 && box.height > 50, 'the file does not render standalone');
      await view.close();
      return { file: dl.suggestedFilename(), bytes: svg.length };
    });
  }
  assert.deepEqual(errors, []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});
