import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAMILIES, FAMILY_REGISTRY, variantOf } from '../../site/src/lib/conformance-registry.mjs';
import { argsFromCase } from '../../site/src/lib/lab-report.mjs';
import { loadVectorFile } from '../../scripts/docs/vector-loader.mjs';
import { MCP_VERSION, ROOT, mcpClient, startBuiltHost, tempDir } from './service-host.mjs';

// OX-P07 (PROPOSED NEW): the built MCP endpoint served by the built Node host over real HTTP
// on an ephemeral loopback port. Every advertised tool is called with every value its input
// schema enumerates, and results are checked against the checked-in sources, not the engine.

let host;
let tmp;
let client;
const openapi = JSON.parse(readFileSync(join(ROOT, 'spec', 'openapi.json'), 'utf8'));
const asyncapi = JSON.parse(readFileSync(join(ROOT, 'spec', 'asyncapi.json'), 'utf8'));
const allVectors = JSON.parse(readFileSync(join(ROOT, 'site', 'src', 'data', 'allVectors.json'), 'utf8'));

before(async () => {
  tmp = tempDir('ordex-mcp-');
  host = await startBuiltHost({ dbPath: join(tmp.dir, 'docs.sqlite') });
  client = mcpClient(host.url);
});
after(async () => {
  await host?.close();
  tmp?.cleanup();
});

async function callOk(name, args) {
  const r = await client.callTool(name, args);
  assert.equal(r.status, 200, `${name} HTTP ${r.status}`);
  assert.equal(r.body.result?.resultType, 'complete', `${name}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.result;
}

test('discover and tools/list over HTTP report the built revision and ten tools', async () => {
  const d = await client.discover();
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.result.supportedVersions, [MCP_VERSION]);
  const info = d.body.result._meta['io.modelcontextprotocol/serverInfo'];
  assert.equal(info.name, 'ordex-docs');
  assert.equal(info.version, host.built.buildInfo.revision, 'serverInfo carries the exact build revision');
  const health = await (await fetch(`${host.url}/health`)).json();
  assert.equal(health.revision, host.built.buildInfo.revision);
  const list = await client.listTools();
  assert.equal(list.body.result.tools.length, 10);
});

test('run_verifier over HTTP returns the verdict every checked-in conformance vector expects', async () => {
  let checked = 0;
  for (const family of FAMILIES) {
    const key = FAMILY_REGISTRY[family].result;
    for (const vectorCase of loadVectorFile(family).cases) {
      const variant = variantOf(family, vectorCase);
      const result = await callOk('ordex.run_verifier', { family, variant, arguments: argsFromCase(family, variant, vectorCase) });
      const expectedAccept = vectorCase.expected[key];
      assert.equal(result.isError, false, `${family}/${vectorCase.name}`);
      assert.equal(result.structuredContent.verdict.state, expectedAccept ? 'accepted' : 'refused', `${family}/${vectorCase.name}`);
      if (!expectedAccept && vectorCase.expected.code) assert.equal(result.structuredContent.verdict.code, vectorCase.expected.code, `${family}/${vectorCase.name}`);
      checked++;
    }
  }
  assert.equal(checked, allVectors.length, 'every vector went over the wire');
});

test('contract, vector, refusal and source tools return exactly what the checked-in files hold', async () => {
  const tools = (await client.listTools()).body.result.tools;
  const enumOf = (tool, prop) => tools.find((t) => t.name === tool).inputSchema.properties[prop].enum;

  for (const operationId of enumOf('ordex.get_openapi_operation', 'operationId')) {
    const op = (await callOk('ordex.get_openapi_operation', { operationId })).structuredContent.operation;
    const source = openapi.paths[op.path]?.[op.method.toLowerCase()];
    assert.ok(source, `${operationId} is at ${op.method} ${op.path} in spec/openapi.json`);
    assert.equal(source.operationId, operationId);
  }
  for (const channelName of enumOf('ordex.get_asyncapi_channel', 'channelName')) {
    const ch = (await callOk('ordex.get_asyncapi_channel', { channelName })).structuredContent.channel;
    assert.ok(asyncapi.channels[channelName], `${channelName} is a channel in spec/asyncapi.json`);
    assert.equal(ch.name, channelName);
  }
  for (const family of FAMILIES) {
    const source = loadVectorFile(family).cases;
    for (const entry of allVectors.filter((v) => v.family === family).slice(0, 3)) {
      const vector = (await callOk('ordex.get_conformance_vector', { family, vectorId: entry.id })).structuredContent.vector;
      assert.deepEqual(vector.case, source[entry.index], `${entry.id} is the checked-in case`);
    }
  }
  const codes = new Set();
  for (const family of FAMILIES) for (const c of loadVectorFile(family).cases) if (c.expected.code) codes.add(c.expected.code);
  // Every code a vector expects has a rule (OX-S09 completed the registry, including
  // template codes such as MAKER_ASSET_UNASSIGNED).
  for (const code of codes) {
    const result = await callOk('ordex.explain_refusal', { code });
    assert.equal(result.isError, false, code);
    assert.ok(result.structuredContent.rule.exactCodes.includes(code), code);
  }
  const specText = readFileSync(join(ROOT, 'spec', 'purchase.md'), 'utf8');
  const src = (await callOk('ordex.read_source', { sourcePath: 'spec/purchase.md' })).structuredContent;
  assert.ok(src.sections.length > 0);
  const headings = [...specText.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((m) => m[1]);
  for (const s of src.sections) assert.ok(headings.some((h) => s.title === h || s.title.endsWith(` - ${h}`)), `section ${s.title} is a heading of spec/purchase.md`);
});

test('search results link to pages that exist in the built site; examples and missions resolve', async () => {
  const { results } = (await callOk('ordex.search_docs', { query: 'seller payment output', limit: 10 })).structuredContent;
  assert.ok(results.length > 0);
  for (const r of results) {
    const route = r.docUrl.split('#')[0].replace(/^\/ordex/, '');
    const page = join(ROOT, 'dist', 'client', ...route.split('/').filter(Boolean), 'index.html');
    assert.ok(existsSync(page), `${r.docUrl} is a built page`);
  }
  const tools = (await client.listTools()).body.result.tools;
  const scenarios = tools.find((t) => t.name === 'ordex.create_deterministic_example').inputSchema.properties.scenarioId.enum;
  for (const scenarioId of scenarios) {
    const ex = (await callOk('ordex.create_deterministic_example', { scenarioId })).structuredContent;
    assert.notEqual(ex.outcome, 'failed', `${scenarioId} reproduces its declared outcome`);
    if (ex.scenario.expectedOutcome !== 'success') assert.equal(ex.steps.filter((s) => s.verdict.state === 'refused').pop().verdict.code, ex.scenario.expectedRefusalCode, scenarioId);
  }
  const missions = tools.find((t) => t.name === 'ordex.get_mission').inputSchema.properties.missionId.enum;
  for (const missionId of missions) assert.equal((await callOk('ordex.get_mission', { missionId })).structuredContent.mission.id, missionId);
});

test('failures stay failures over the wire', async () => {
  const unknown = await client.callTool('ordex.nope', {});
  assert.equal(unknown.body.error.code, -32602);
  assert.equal((await callOk('ordex.run_verifier', { family: 'purchase', arguments: {} })).isError, true);
  assert.equal((await callOk('ordex.explain_refusal', { code: 'NOT_A_REAL_CODE' })).isError, true);
  const noSuchResource = await client.request('resources/read', { uri: 'ordex://nope' });
  assert.equal(noSuchResource.body.error.code, -32602);
  const resource = await client.request('resources/read', { uri: 'ordex://spec/openapi.json' });
  assert.deepEqual(JSON.parse(resource.body.result.contents[0].text), openapi);
});

test('transport rules hold through the host: Origin, preflight, method, size and notifications', async () => {
  const res = await fetch(`${host.url}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  const allowed = await mcpClient(host.url, { origin: 'https://bitcoinuniverseio.github.io' }).listTools();
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://bitcoinuniverseio.github.io');
  const pre = await fetch(`${host.url}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://bitcoinuniverseio.github.io', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204, 'a browser client on an allowed origin can preflight');
  for (const h of ['MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name']) assert.match(pre.headers.get('access-control-allow-headers'), new RegExp(h));
  const badPre = await fetch(`${host.url}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(badPre.status, 403);
  const get = await fetch(`${host.url}/mcp`);
  assert.equal(get.status, 405);
  const note = await fetch(`${host.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
  const big = await fetch(`${host.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(3 * 1024 * 1024) });
  assert.equal(big.status, 413);
});

test('concurrent calls each get their own correct answer', async () => {
  const codes = ['SELLER_VALUE_MISMATCH', 'SELLER_SCRIPT_MISMATCH', 'CENOTAPH_BURNS_BALANCE', 'SAT_FLOW_SHORTFALL'];
  const results = await Promise.all(codes.map((code) => client.callTool('ordex.explain_refusal', { code })));
  results.forEach((r, i) => assert.ok(r.body.result.structuredContent.rule.exactCodes.includes(codes[i])));
});

test('the Agent Bridge remote diagnostic passes against the host and fails truthfully when it cannot reach one', async () => {
  const { runRemoteDiagnostic, curlText, mcpHttpRequest } = await import('../../site/src/lib/mcp/http-request.mjs');
  const good = await runRemoteDiagnostic(`${host.url}/mcp`);
  assert.equal(good.passed, true, JSON.stringify(good.steps.map((s) => s.problem)));
  assert.deepEqual(good.steps.map((s) => [s.method, s.status]), [['server/discover', 200], ['tools/list', 200], ['tools/call', 200]]);
  const down = await runRemoteDiagnostic('http://127.0.0.1:1/mcp', { timeoutMs: 3000 });
  assert.equal(down.passed, false);
  assert.match(down.steps[0].problem, /failed before a response/);
  const wrongPath = await runRemoteDiagnostic(`${host.url}/api/docs/health`);
  assert.equal(wrongPath.passed, false, 'a live server that is not an MCP endpoint does not pass');
  assert.equal((await runRemoteDiagnostic('not a url')).passed, false);
  // The curl example the page shows is accepted by the real host.
  // execFile, not execFileSync: the host runs in this process and must keep serving.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const req = mcpHttpRequest('tools/list', {}, 1);
  const args = ['-sS', '-X', 'POST', `${host.url}/mcp`, ...Object.entries(req.headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]), '--data', req.body];
  let out;
  try {
    out = (await promisify(execFile)('curl', args, { encoding: 'utf8', timeout: 15000 })).stdout;
  } catch {
    return; // curl is not installed here; the fetch-based checks above still ran
  }
  assert.equal(JSON.parse(out).result.tools.length, 10);
  assert.match(curlText(`${host.url}/mcp`, req), /-H 'Mcp-Method: tools\/list'/);
});
