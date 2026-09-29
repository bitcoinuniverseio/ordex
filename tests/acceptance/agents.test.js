import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStaticServer, launch, openPage, ROOT } from '../e2e/harness.mjs';
import { startBuiltHost, tempDir } from '../integration/service-host.mjs';
import { MCP_TOOLS, callTool } from '../../site/src/lib/mcp/server.ts';
import { toolExamples } from '../../site/src/lib/mcp/tool-examples.ts';
import { validateSchema } from '../../site/src/lib/api/schema.mjs';
import { mcpHttpRequest } from '../../site/src/lib/mcp/http-request.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for the Agent Bridge (OX-S-C950..C969). Every tool is run from /agents in
// the browser and its result is compared with the same engine called from Node and with the
// tool's output schema. The stdio server is started from the configuration the page shows
// and driven over MCP 2026-07-28; the HTTP transport checks run against the docs service host
// built from this commit and started on loopback.

const rows = rowsOf('Agent Bridge');
const row = (prefix) => rows.find((r) => r.operation.startsWith(prefix));
const rec = rowRecorder('tests/acceptance/agents.test.js');
const buildInfo = JSON.parse(readFileSync(join(ROOT, 'dist', 'server', 'build-info.json'), 'utf8'));
const V = '2026-07-28';
const META = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'ordex-acceptance', version: '1' } };
const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } });

let site;
let service;
let tmp;
let browser;
before(async () => {
  site = await startStaticServer();
  tmp = tempDir('ordex-acceptance-agents-');
  service = await startBuiltHost({ dbPath: join(tmp.dir, 'docs.sqlite'), allowedOrigins: site.origin });
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await service?.close();
  tmp?.cleanup();
  await site?.close();
});

function stdio(file, cwd) {
  const child = spawn(process.execPath, [file], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const call = async (id, method, params) => {
    child.stdin.write(`${rpc(id, method, params)}\n`);
    const deadline = Date.now() + 10000;
    for (;;) {
      const hit = lines.find((m) => m.id === id);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no answer to ${method}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { child, call, close: () => child.stdin.end() };
}

test('Agent Bridge rows', { timeout: 300000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/agents/'));
  const examples = toolExamples();

  for (const tool of MCP_TOOLS) {
    const r = row(`${tool.name} local explorer execution`);
    await rec.check(r.id, `/agents/ run ${tool.name} locally`, async () => {
      await page.getByRole('button', { name: tool.name, exact: true }).click();
      const args = await page.getByLabel('Arguments (JSON)').inputValue();
      await page.getByRole('button', { name: 'Run locally in this browser' }).click();
      const note = page.getByText(/No request left this page/);
      await note.waitFor();
      expect((await note.innerText()).includes(`build ${buildInfo.revision}`), 'build revision not shown');
      const shown = JSON.parse(await page.getByLabel('Local result').innerText());
      const direct = await callTool(tool.name, JSON.parse(args));
      expect(shown.isError === false, `tool error: ${JSON.stringify(shown).slice(0, 300)}`);
      // The provenance carries the build that ran it; everything else must be identical.
      const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'buildRevision' ? undefined : x)));
      const revisions = JSON.stringify(shown.structuredContent).match(/"buildRevision":"([^"]*)"/g) || [];
      for (const r of revisions) expect(r.includes(buildInfo.revision), `provenance ${r} is not the build ${buildInfo.revision}`);
      expect(JSON.stringify(strip(shown.structuredContent)) === JSON.stringify(strip(direct.structuredContent)), 'browser result differs from the engine called from Node');
      if (tool.outputSchema) {
        const errs = validateSchema(shown.structuredContent, tool.outputSchema, { components: {} });
        expect(errs.length === 0, `output schema: ${JSON.stringify(errs.slice(0, 3))}`);
      }
      return { arguments: JSON.parse(args), example: examples[tool.name] ? 'published example' : 'default', isError: false };
    });
  }

  // Stdio: the configuration shown on the page, pointing at a copy of the built server.
  const dir = tempDir('ordex-acceptance-stdio-');
  const target = join(dir.dir, 'ordex-mcp-stdio.mjs');
  copyFileSync(join(ROOT, 'dist', 'mcp', 'ordex-mcp-stdio.mjs'), target);
  let server;
  await rec.check(row('Clean stdio install/start').id, 'start the stdio server from the configuration copied from /agents', async () => {
    await page.getByLabel('Full path where you saved ordex-mcp-stdio.mjs').fill(target);
    await page.getByRole('tab', { name: 'Claude Code' }).click();
    const configText = await page.locator('pre').filter({ hasText: '"mcpServers"' }).first().innerText();
    const cfg = JSON.parse(configText).mcpServers.ordex;
    expect(cfg.command === 'node' && cfg.args[0] === target, `config: ${configText}`);
    server = stdio(cfg.args[0], dir.dir);
    const d = await server.call(1, 'server/discover');
    expect(d.result.supportedVersions.includes(V), 'discover');
    return { command: cfg.command, args: cfg.args, supportedVersions: d.result.supportedVersions };
  });
  await rec.check(row('Modern server/discover').id, 'server/discover over stdio', async () => {
    const d = await server.call(2, 'server/discover');
    const info = d.result._meta['io.modelcontextprotocol/serverInfo'];
    expect(info.version === buildInfo.revision, `serverInfo ${info.version}`);
    return { serverInfo: info, supportedVersions: d.result.supportedVersions };
  }, { evidenceClass: 'component' });
  await rec.check(row('tools/list schema').id, 'tools/list over stdio', async () => {
    const l = await server.call(3, 'tools/list');
    expect(l.result.tools.length === MCP_TOOLS.length, `tools ${l.result.tools.length}`);
    for (const t of l.result.tools) expect(t.inputSchema && t.name.startsWith('ordex.'), `tool ${t.name}`);
    return { tools: l.result.tools.map((t) => t.name) };
  }, { evidenceClass: 'component' });
  await rec.check(row('tools/call invalid').id, 'tools/call with invalid arguments and an unknown tool over stdio', async () => {
    const bad = await server.call(4, 'tools/call', { name: 'ordex.run_verifier', arguments: { family: 'purchase', arguments: {} } });
    expect(bad.result?.isError === true, 'invalid arguments were not a tool error');
    const unknown = await server.call(5, 'tools/call', { name: 'ordex.no_such_tool', arguments: {} });
    expect(!!unknown.error || unknown.result?.isError === true, 'unknown tool accepted');
    return { invalidArguments: 'isError', unknownTool: unknown.error ? `error ${unknown.error.code}` : 'isError' };
  }, { evidenceClass: 'component' });
  await rec.check(row('resources/read').id, 'resources/list and resources/read over stdio', async () => {
    const l = await server.call(6, 'resources/list');
    const out = [];
    for (const [i, res] of l.result.resources.entries()) {
      const read = await server.call(100 + i, 'resources/read', { uri: res.uri });
      expect(read.result?.contents?.[0]?.text?.length > 0, `${res.uri} empty`);
      out.push(res.uri);
    }
    const spec = await server.call(7, 'resources/read', { uri: 'ordex://spec/openapi.json' });
    expect(JSON.stringify(JSON.parse(spec.result.contents[0].text)) === JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'spec', 'openapi.json'), 'utf8'))), 'openapi resource differs');
    return { resources: out };
  }, { evidenceClass: 'component' });
  await rec.check(row('prompts/get').id, 'prompts/list and prompts/get over stdio', async () => {
    const l = await server.call(8, 'prompts/list');
    const out = [];
    for (const [i, p] of l.result.prompts.entries()) {
      const args = Object.fromEntries((p.arguments || []).filter((a) => a.required).map((a) => [a.name, a.name === 'code' ? 'SAT_FLOW_SHORTFALL' : a.name === 'missionId' ? 'integrate-public-asks' : 'purchase']));
      const got = await server.call(200 + i, 'prompts/get', { name: p.name, arguments: args });
      expect(got.result?.messages?.length > 0, `${p.name}: ${JSON.stringify(got.error || got.result).slice(0, 200)}`);
      out.push(p.name);
    }
    return { prompts: out };
  }, { evidenceClass: 'component' });
  server?.close();
  dir.cleanup();

  // HTTP: the docs service host built from this commit, on loopback.
  const endpoint = `${service.url}/mcp`;
  const post = (method, headers = {}) => {
    const m = mcpHttpRequest(method, {}, 1);
    return fetch(endpoint, { method: 'POST', headers: { ...m.headers, ...headers }, body: m.body });
  };
  await rec.check(row('HTTP metadata/version/header').id, 'HTTP transport metadata, version and header rules on the built host', async () => {
    const ok = await post('server/discover');
    const body = await ok.json();
    expect(ok.status === 200 && body.result._meta['io.modelcontextprotocol/serverInfo'].version === buildInfo.revision, `discover ${ok.status}`);
    const wrong = await post('tools/list', { 'MCP-Protocol-Version': '2024-11-05' });
    expect(wrong.status >= 400, `an old protocol version header answered ${wrong.status}`);
    const get = await fetch(endpoint, { method: 'GET' });
    expect(get.status === 405, `GET answered ${get.status}`);
    return { discover: 200, oldVersionHeader: wrong.status, get: get.status, revision: buildInfo.revision };
  }, { evidenceClass: 'component' });
  await rec.check(row('Origin restrictions').id, 'Origin allowlist and read-only tool surface on the built host', async () => {
    const foreign = await post('tools/list', { origin: 'https://attacker.example' });
    expect(foreign.status === 403, `a foreign Origin answered ${foreign.status}`);
    const allowed = await post('tools/list', { origin: site.origin });
    const list = await allowed.json();
    expect(allowed.status === 200, `the site origin answered ${allowed.status}`);
    for (const t of list.result.tools) expect(t.annotations?.readOnlyHint !== false, `${t.name} is not read-only`);
    return { foreignOrigin: 403, siteOrigin: 200, tools: list.result.tools.length };
  }, { evidenceClass: 'component' });

  await rec.check(row('Copied config and truthful').id, '/agents copy feedback and remote status against a live and a closed endpoint', async () => {
    await page.getByRole('button', { name: 'Copy Build commands' }).click();
    const copied = await page.getByRole('status').filter({ hasText: /Build commands (copied|could not be copied)/ }).first().innerText();
    await page.getByLabel('MCP endpoint URL').fill(endpoint);
    await page.getByRole('button', { name: 'Run remote check' }).click();
    await page.getByText('Remote evidence: passed').waitFor({ timeout: 20000 });
    await page.getByLabel('MCP endpoint URL').fill('http://127.0.0.1:1/mcp');
    await page.getByRole('button', { name: 'Run remote check' }).click();
    await page.getByText('Remote evidence: did not pass').waitFor({ timeout: 20000 });
    return { copyFeedback: copied, live: 'passed', closedPort: 'did not pass' };
  });

  rec.record(row('Actual installed-client remote call').id, 'BLOCKED', row('Actual installed-client remote call').operation, 'Needs an installed third-party MCP client with revision 2026-07-28 support (Claude Code v2 runtime) calling the deployed docs service; neither exists on the CI runners, and the docs service is pending release deployment.');
  assert.deepEqual(errors.filter((e) => !/requestfailed|Failed to load resource|ERR_CONNECTION_REFUSED/.test(e)), []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});
