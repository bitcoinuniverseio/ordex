import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { join } from 'node:path';
import { startStaticServer, launch, openPage } from './harness.mjs';
import { startBuiltHost, tempDir } from '../integration/service-host.mjs';

// OX-S04 / OX-P07 browser gate at /agents: a local run is labeled local, the remote check
// makes real requests to the built docs service on loopback and passes only when it
// answers, and an unreachable endpoint does not pass.

let site;
let service;
let tmp;
let browser;
before(async () => {
  site = await startStaticServer();
  tmp = tempDir('ordex-agents-');
  service = await startBuiltHost({ dbPath: join(tmp.dir, 'docs.sqlite'), allowedOrigins: site.origin });
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await service?.close();
  tmp?.cleanup();
  await site?.close();
});

test('a local tool run is labeled local and returns the real result', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/agents/'));
  await page.getByRole('button', { name: 'ordex.explain_refusal' }).click();
  await page.getByRole('button', { name: 'Run locally in this browser' }).click();
  await page.getByText('No request left this page').waitFor();
  assert.match(await page.getByLabel('Local result').textContent(), /SELLER_VALUE_MISMATCH/);
  await page.getByLabel('Arguments (JSON)').fill('{"code": "NOT_A_REAL_CODE"}');
  await page.getByRole('button', { name: 'Run locally in this browser' }).click();
  await page.getByText('The tool reported an error.').waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('the remote check passes against the running service and fails against a closed port', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/agents/'));
  await page.getByLabel('MCP endpoint URL').fill(`${service.url}/mcp`);
  await page.getByRole('button', { name: 'Run remote check' }).click();
  await page.getByText('Remote evidence: passed').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'ordex.get_mission' }).click();
  await page.getByRole('button', { name: 'Send to the endpoint' }).click();
  await page.getByText(/Remote call at .* HTTP 200/).waitFor({ timeout: 20000 });
  assert.match(await page.getByLabel('Remote response').textContent(), /integrate-public-asks/);
  await page.getByLabel('MCP endpoint URL').fill('http://127.0.0.1:1/mcp');
  await page.getByRole('button', { name: 'Run remote check' }).click();
  await page.getByText('Remote evidence: did not pass').waitFor({ timeout: 20000 });
  assert.deepEqual(errors.filter((e) => !/requestfailed|Failed to load resource|ERR_CONNECTION_REFUSED/.test(e)), []);
  await context.close();
});

test('client setup follows the path you enter and the copy result is announced', async () => {
  const { page, context } = await openPage(browser, site.url('/agents/'));
  await page.getByLabel('Full path where you saved ordex-mcp-stdio.mjs').fill('/opt/ordex/ordex-mcp-stdio.mjs');
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByText('args = ["/opt/ordex/ordex-mcp-stdio.mjs"]').waitFor();
  await page.getByRole('tab', { name: 'Codex' }).press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: 'Cursor' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Copy Build commands' }).click();
  await page.getByRole('status').filter({ hasText: /Build commands (copied|could not be copied)/ }).waitFor();
  await context.close();
});
