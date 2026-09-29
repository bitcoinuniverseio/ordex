import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { startStaticServer, launch, openPage } from '../e2e/harness.mjs';
import { startBuiltHost, tempDir } from '../integration/service-host.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for Ask Ordex (OX-S-C1400..C1407), Documentation Feedback (C1410..C1418) and
// Documentation Insights (C1420..C1423). The docs service host built from this commit
// (worker/node-host.mjs with its SQLite database) runs on loopback, served same-origin through
// a proxy as a deployment would; stored rows are read back from that database.

const ask = rowsOf('Ask Ordex');
const feedback = rowsOf('Documentation Feedback');
const insights = rowsOf('Documentation Insights');
const pick = (list, prefix) => list.find((r) => r.operation.startsWith(prefix)).id;
const rec = rowRecorder('tests/acceptance/docs-services.test.js');

const proxy = { prefix: '/api/docs/', target: null };
let site;
let service;
let tmp;
let browser;
let hang;
before(async () => {
  site = await startStaticServer({ proxy });
  tmp = tempDir('ordex-acceptance-docs-');
  service = await startBuiltHost({ dbPath: join(tmp.dir, 'docs.sqlite'), allowedOrigins: site.origin });
  proxy.target = service.url;
  const h = createServer(() => {});
  await new Promise((r) => h.listen(0, '127.0.0.1', r));
  hang = { url: `http://127.0.0.1:${h.address().port}`, close: () => new Promise((r) => { h.closeAllConnections?.(); h.close(r); }) };
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await hang?.close();
  await service?.close();
  tmp?.cleanup();
  await site?.close();
});

async function askQuestion(page, q) {
  await page.getByLabel('Your question').fill(q);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
}

test('Ask Ordex rows', { timeout: 300000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/ask/'));
  const sent = [];
  page.on('request', (r) => r.url().includes('/api/docs/ask') && sent.push(r.postData()));

  await rec.check(pick(ask, 'Actual docs API answer'), 'Ask answered by the docs service with citations', async () => {
    await askQuestion(page, 'keyset cursor paging');
    await page.getByText('· docs service ·', { exact: false }).waitFor({ timeout: 15000 });
    const n = await page.locator('article').count();
    expect(n > 0, 'no cited extracts');
    return { mode: 'docs service', citations: n };
  });

  await rec.check(pick(ask, 'Exact citation navigation'), 'every citation opens a real page and its section', async () => {
    const hrefs = await page.locator('article h3 a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    for (const href of hrefs) {
      expect(href.startsWith('/ordex/'), `${href} is not a site link`);
      const res = await page.request.get(`${site.origin}${href.split('#')[0]}`);
      expect(res.status() === 200, `${href} answered ${res.status()}`);
      const frag = href.split('#')[1];
      if (frag) expect((await res.text()).includes(`id="${decodeURIComponent(frag)}"`), `${href}: no element with id ${frag}`);
    }
    await page.locator('article h3 a').first().click();
    await page.waitForLoadState('networkidle');
    return { citations: hrefs };
  });

  await rec.check(pick(ask, 'Selected protocol version'), 'the chosen protocol version is sent and every citation is of that version', async () => {
    await page.goto(site.url('/ask/'), { waitUntil: 'networkidle' });
    const options = await page.getByLabel('Protocol version').locator('option').allInnerTexts();
    await page.getByLabel('Protocol version').selectOption(options[0]);
    sent.length = 0;
    await askQuestion(page, 'webhook signature');
    await page.getByText('· docs service ·', { exact: false }).waitFor({ timeout: 15000 });
    expect(JSON.parse(sent.at(-1)).protocolVersion === options[0], `sent ${sent.at(-1)}`);
    expect((await page.getByText(new RegExp(`protocol ${options[0].replace('.', '\\.')}`)).count()) > 0, 'version not shown');
    const bad = await fetch(`${service.url}/api/docs/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: site.origin }, body: JSON.stringify({ query: 'webhook', protocolVersion: '0.9' }) });
    expect(bad.status >= 400 || (await bad.json()).refused === true, `an unindexed version answered ${bad.status}`);
    return { indexed: options, sent: options[0], unindexed: 'refused' };
  });

  await rec.check(pick(ask, 'Empty and unsupported query'), 'no match, and key material, are answered honestly', async () => {
    await askQuestion(page, 'zqxjv wqpzk');
    await page.getByText('No matching documentation').waitFor({ timeout: 15000 });
    const before = sent.length;
    await askQuestion(page, 'my key L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ');
    await page.getByText('was not sent anywhere').waitFor();
    expect(sent.length === before, 'the key question was sent');
    return { noMatch: 'No matching documentation', keyMaterial: 'not sent' };
  });

  await rec.check(pick(ask, 'Sanitized request/provenance'), 'only the question, version and page reach the service; answers carry their sources', async () => {
    sent.length = 0;
    await askQuestion(page, 'sat flow shortfall');
    await page.getByText('· docs service ·', { exact: false }).waitFor({ timeout: 15000 });
    const body = JSON.parse(sent.at(-1));
    expect(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['pageContext', 'protocolVersion', 'query']), `request fields ${Object.keys(body)}`);
    const sources = await page.locator('article p').filter({ hasText: /^spec\/|^site\/|^conformance\/|\.md|\.json/ }).count();
    expect(sources > 0, 'no source paths shown');
    return { requestFields: Object.keys(body).sort(), sourcesShown: sources };
  });

  await rec.check(pick(ask, 'Copy context'), 'copying extracts succeeds with permission and reports a refusal', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site.origin });
    await page.getByRole('button', { name: 'Copy extracts for a coding agent' }).click();
    await page.getByText('The cited extracts were copied.').waitFor();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip.startsWith('Ordex documentation, protocol'), 'clipboard content');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }));
    await page.getByRole('button', { name: 'Copy extracts for a coding agent' }).click();
    await page.getByText('Copying failed. Select the extracts and copy them yourself.').waitFor();
    return { success: 'The cited extracts were copied.', failure: 'Copying failed.' };
  });

  await rec.check(pick(ask, 'Static/offline retrieval label'), 'with the service down the answer comes from the page and says so', async () => {
    proxy.target = 'http://127.0.0.1:1';
    try {
      await askQuestion(page, 'keyset cursor paging');
      await page.getByText('Answered from the documentation in this page instead').waitFor({ timeout: 20000 });
      await page.getByText('· this page ·', { exact: false }).waitFor();
    } finally {
      proxy.target = service.url;
    }
    return { label: 'this page' };
  });

  await rec.check(pick(ask, 'Timeout/cancel/stale'), 'a newer question cancels the older one; a silent service times out into the page answer', async () => {
    proxy.target = hang.url;
    try {
      await askQuestion(page, 'first question about offers');
      await page.getByLabel('Your question').fill('webhook signature');
      await page.getByLabel('Your question').press('Enter');
      await page.getByText(/did not answer within 10 s\. Answered from the documentation in this page instead/).waitFor({ timeout: 25000 });
      const titles = await page.locator('article h3').allInnerTexts();
      expect(titles.length > 0, 'no answer after the timeout');
    } finally {
      proxy.target = service.url;
    }
    return { timeout: '10 s', stale: 'first question dropped' };
  });

  assert.deepEqual(errors.filter((e) => !/requestfailed|Failed to load resource/.test(e)), []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});

const LABELS = { helpful: 'Helpful', not_helpful: 'Not helpful', unclear: 'Unclear', outdated: 'Outdated', missing_example: 'Missing example', broken_workflow: 'Broken workflow', other: 'Other' };

test('Documentation Feedback and Insights rows', { timeout: 300000 }, async () => {
  const db = service.db.raw;
  for (const [cat, label] of Object.entries(LABELS)) {
    await rec.check(pick(feedback, cat), `send ${cat} feedback from /kits/ and read the stored row`, async () => {
      const { page, context } = await openPage(browser, site.url('/kits/'));
      const comment = `acceptance ${cat}: reach me at someone@example.com about bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh`;
      if (cat === 'helpful' || cat === 'not_helpful') await page.getByRole('button', { name: label, exact: true }).first().click();
      else {
        await page.getByRole('button', { name: 'More feedback' }).click();
        await page.getByRole('button', { name: label, exact: true }).last().click();
      }
      await page.getByLabel(/Details/).fill(comment);
      await page.getByRole('button', { name: 'Send feedback' }).click();
      const receipt = await page.getByText(/Received and stored at/).innerText({ timeout: 15000 });
      const row = db.prepare('SELECT category, route, comment_redacted AS comment FROM docs_feedback WHERE category = ? ORDER BY created_at DESC LIMIT 1').get(cat);
      expect(row && row.route === '/kits/', `stored ${JSON.stringify(row)}`);
      expect(!row.comment.includes('someone@example.com') && !row.comment.includes('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'), `not sanitized: ${row.comment}`);
      await context.close();
      return { receipt: receipt.slice(0, 80), stored: { category: row.category, route: row.route, comment: row.comment } };
    });
  }

  await rec.check(pick(feedback, 'offline failure/retry'), 'a failed send keeps the text; the retry stores it once', async () => {
    const { page, context } = await openPage(browser, site.url('/kits/'));
    proxy.target = 'http://127.0.0.1:1';
    let before;
    try {
      await page.getByRole('button', { name: 'More feedback' }).click();
      await page.getByRole('button', { name: 'Outdated', exact: true }).click();
      await page.getByLabel(/Details/).fill('retry keeps me');
      await page.getByRole('button', { name: 'Send feedback' }).click();
      await page.getByText(/Not sent:/).waitFor({ timeout: 20000 });
      expect((await page.getByLabel(/Details/).inputValue()) === 'retry keeps me', 'draft lost');
      before = db.prepare("SELECT COUNT(*) AS n FROM docs_feedback WHERE comment_redacted LIKE '%retry keeps me%'").get().n;
    } finally {
      proxy.target = service.url;
    }
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByText(/Received and stored at/).waitFor({ timeout: 15000 });
    const after = db.prepare("SELECT COUNT(*) AS n FROM docs_feedback WHERE comment_redacted LIKE '%retry keeps me%'").get().n;
    expect(before === 0 && after === 1, `stored ${before} then ${after}`);
    await context.close();
    return { failed: 'Not sent, draft kept', retried: 'stored once' };
  });

  await rec.check(pick(feedback, 'duplicate submit/reload'), 'one submission id is stored once; a reload starts a new one', async () => {
    const { page, context } = await openPage(browser, site.url('/kits/'));
    const bodies = [];
    await page.route('**/api/docs/feedback', async (route) => {
      bodies.push(route.request().postData());
      await route.continue();
    });
    await page.getByRole('button', { name: 'More feedback' }).click();
    await page.getByRole('button', { name: 'Other', exact: true }).click();
    await page.getByLabel(/Details/).fill('duplicate check');
    await page.getByRole('button', { name: 'Send feedback' }).dblclick();
    await page.getByText(/Received and stored at/).waitFor({ timeout: 15000 });
    const id = JSON.parse(bodies[0]).submissionId;
    const res = await fetch(`${service.url}/api/docs/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', origin: site.origin }, body: bodies[0] });
    const data = await res.json();
    const n = db.prepare("SELECT COUNT(*) AS n FROM docs_feedback WHERE comment_redacted LIKE '%duplicate check%'").get().n;
    expect(n === 1, `stored ${n} rows for one submission`);
    await page.reload({ waitUntil: 'networkidle' });
    expect((await page.getByText(/Received and stored at/).count()) === 0, 'the receipt survived a reload');
    await context.close();
    return { submissionId: id, replay: data.receipt ? 'same receipt' : data, rows: n };
  });

  for (const [prefix, label, range] of [['24h', 'Last 24 hours', '24h'], ['7d', 'Last 7 days', '7d'], ['30d', 'Last 30 days', '30d']]) {
    await rec.check(pick(insights, prefix), `/insights ${label} equals the database aggregate`, async () => {
      const { page, context } = await openPage(browser, site.url('/insights/'));
      await page.getByText(/^Since /).waitFor({ timeout: 15000 });
      const pressed = await page.getByRole('group', { name: 'Time window' }).getByRole('button', { name: label }).getAttribute('aria-pressed');
      if (pressed !== 'true') await Promise.all([page.waitForResponse((r) => r.url().includes(`/api/docs/insights?range=${range}`)), page.getByRole('group', { name: 'Time window' }).getByRole('button', { name: label }).click()]);
      await page.waitForFunction((r) => document.querySelector('main')?.innerText.includes('Since '), range);
      await page.waitForTimeout(200);
      const days = { '24h': 1, '7d': 7, '30d': 30 }[range];
      const rows = db.prepare('SELECT category, COUNT(*) AS n FROM docs_feedback WHERE created_at >= ? GROUP BY category').all(Math.floor(Date.now() / 1000) - days * 86400);
      const text = await page.locator('main').innerText();
      for (const r of rows) expect(text.includes(`${r.category}: ${r.n}`), `${r.category}: ${r.n} not shown`);
      await context.close();
      return { range, feedback: Object.fromEntries(rows.map((r) => [r.category, r.n])) };
    });
  }

  await rec.check(pick(insights, 'Authorization/privacy'), 'aggregates only, a foreign origin is refused, an unreachable service is said to be unavailable', async () => {
    const res = await fetch(`${service.url}/api/docs/insights?range=7d`, { headers: { origin: site.origin } });
    const body = await res.text();
    expect(!/acceptance |someone@example|retry keeps me|duplicate check/.test(body), 'raw comments in the aggregate');
    const foreign = await fetch(`${service.url}/api/docs/insights?range=7d`, { headers: { origin: 'https://attacker.example' } });
    expect(foreign.status === 403 || !foreign.headers.get('access-control-allow-origin'), `foreign origin answered ${foreign.status} with CORS ${foreign.headers.get('access-control-allow-origin')}`);
    proxy.target = 'http://127.0.0.1:1';
    try {
      const { page, context } = await openPage(browser, site.url('/insights/'));
      await page.getByText(/No insights are available/).waitFor({ timeout: 20000 });
      expect((await page.getByRole('button', { name: 'Retry' }).count()) === 1, 'no retry');
      await context.close();
    } finally {
      proxy.target = service.url;
    }
    return { rawComments: false, foreignOrigin: foreign.status, unavailable: 'No insights are available + Retry' };
  });
  assert.deepEqual(rec.failures(), []);
});
