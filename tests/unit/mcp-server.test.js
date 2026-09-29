import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  MCP_TOOLS,
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCES,
  MCP_PROMPTS,
  callTool,
  dispatchMessage,
  discoverResult,
  readResource,
  JSONRPC
} from '../../site/src/lib/mcp/server.js';
import { FAMILIES, FAMILY_REGISTRY, resultKey } from '../../site/src/lib/conformance-registry.mjs';
import { argsFromCase } from '../../site/src/lib/lab-report.mjs';
import { validateSchema } from '../../site/src/lib/api/schema.mjs';

// OX-S04: the shared engine against the MCP 2026-07-28 rules and the real verifiers.

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } };
const vectors = JSON.parse(await readFile(new URL('../../site/src/data/allVectors.json', import.meta.url), 'utf8'));
const rpc = (method, params = {}, id = 1) => dispatchMessage({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } });

test('exactly the ten documented read-only tools, each with input and output schemas', () => {
  assert.deepEqual(MCP_TOOLS.map((t) => t.name), [
    'ordex.search_docs',
    'ordex.read_source',
    'ordex.list_capabilities',
    'ordex.get_openapi_operation',
    'ordex.get_asyncapi_channel',
    'ordex.run_verifier',
    'ordex.explain_refusal',
    'ordex.get_conformance_vector',
    'ordex.create_deterministic_example',
    'ordex.get_mission'
  ]);
  for (const t of MCP_TOOLS) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.outputSchema.required.includes('provenance'), t.name);
    assert.equal(t.annotations.readOnlyHint, true);
    assert.match(t.name, /^[A-Za-z0-9_.-]{1,128}$/);
  }
});

test('server/discover reports versions, capabilities and identity with no initialize handshake', () => {
  const r = rpc('server/discover');
  assert.equal(r.result.resultType, 'complete');
  assert.deepEqual(r.result.supportedVersions, [MCP_PROTOCOL_VERSION]);
  assert.deepEqual(Object.keys(r.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.equal(r.result._meta['io.modelcontextprotocol/serverInfo'].name, 'ordex-docs');
  assert.deepEqual(discoverResult().supportedVersions, ['2026-07-28']);
  const init = dispatchMessage({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} });
  assert.equal(init.error.code, JSONRPC.METHOD_NOT_FOUND);
  assert.deepEqual(init.error.data.supported, ['2026-07-28']);
});

test('per-request metadata is required and versions are checked on every request', () => {
  const noMeta = dispatchMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(noMeta.error.code, JSONRPC.INVALID_PARAMS);
  const noCaps = dispatchMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
  assert.equal(noCaps.error.code, JSONRPC.INVALID_PARAMS);
  const old = dispatchMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } });
  assert.equal(old.error.code, JSONRPC.UNSUPPORTED_PROTOCOL_VERSION);
  assert.deepEqual(old.error.data, { supported: ['2026-07-28'], requested: '1900-01-01' });
});

test('JSON-RPC envelopes: id 0 is preserved, null ids and batches are invalid, notifications get no response', () => {
  assert.equal(rpc('tools/list', {}, 0).id, 0);
  assert.equal(dispatchMessage({ jsonrpc: '2.0', id: null, method: 'tools/list', params: { _meta: META } }).error.code, JSONRPC.INVALID_REQUEST);
  assert.equal(dispatchMessage([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]).error.code, JSONRPC.INVALID_REQUEST);
  assert.equal(dispatchMessage({ jsonrpc: '1.0', id: 1, method: 'tools/list' }).error.code, JSONRPC.INVALID_REQUEST);
  assert.equal(dispatchMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  assert.equal(rpc('nope/method').error.code, JSONRPC.METHOD_NOT_FOUND);
});

test('unknown tools are protocol errors; bad arguments are tool errors; results match the output schema', () => {
  assert.equal(rpc('tools/call', { name: 'ordex.nope', arguments: {} }).error.code, JSONRPC.INVALID_PARAMS);
  assert.equal(rpc('tools/call', { name: 'ordex.search_docs', arguments: [] }).error.code, JSONRPC.INVALID_PARAMS);
  for (const [name, bad] of [
    ['ordex.search_docs', {}],
    ['ordex.search_docs', { query: 'x', limit: 999 }],
    ['ordex.read_source', { sourcePath: '../etc/passwd' }],
    ['ordex.get_openapi_operation', { operationId: 'nope' }],
    ['ordex.run_verifier', { family: 'purchase' }],
    ['ordex.run_verifier', { family: 'nope', arguments: {} }],
    ['ordex.explain_refusal', { code: 'lower' }],
    ['ordex.get_mission', { missionId: 'x', extra: 1 }]
  ]) {
    const r = callTool(name, bad);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(bad)}`);
    assert.equal(r.resultType, 'complete');
  }
  const good = {
    'ordex.search_docs': { query: 'public ask seller payment', limit: 3 },
    'ordex.read_source': { sourcePath: 'spec/purchase.md' },
    'ordex.list_capabilities': { protocolVersion: '1.1', runtime: 'browser' },
    'ordex.get_openapi_operation': { operationId: 'getHealth' },
    'ordex.get_asyncapi_channel': { channelName: 'eventsStream' },
    'ordex.run_verifier': { family: 'runes', arguments: argsFromCase('runes', 'burn-safety', vectors.find((v) => v.id === 'runes/single-edict').case) },
    'ordex.explain_refusal': { code: 'SELLER_SCRIPT_MISMATCH' },
    'ordex.get_conformance_vector': { family: 'offers', vectorId: 'offers/a-valid-item-acceptance-settles-through-both-policy-signers' },
    'ordex.create_deterministic_example': { scenarioId: 'runes.cenotaph.refusal' },
    'ordex.get_mission': { missionId: 'integrate-public-asks' }
  };
  for (const t of MCP_TOOLS) {
    const r = callTool(t.name, good[t.name]);
    assert.equal(r.isError, false, `${t.name}: ${r.content[0].text.slice(0, 200)}`);
    assert.deepEqual(validateSchema(r.structuredContent, t.outputSchema, {}), [], t.name);
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  }
});

test('filters are honored', () => {
  const v11 = callTool('ordex.list_capabilities', { protocolVersion: '1.1' }).structuredContent.capabilities;
  assert.ok(v11.length > 0);
  assert.ok(v11.every((c) => Number(c.protocol.replace('+', '')) <= 1.1));
  assert.ok(!v11.some((c) => /SafeOps|Swaps/.test(c.capability)), 'SafeOps and swaps start at 1.2');
  const limited = callTool('ordex.search_docs', { query: 'offer', limit: 2 }).structuredContent;
  assert.equal(limited.results.length, 2);
  assert.ok(limited.totalMatched >= 2);
});

test('run_verifier returns the real verdict for every family and variant, accepted and refused', () => {
  let n = 0;
  for (const family of FAMILIES) {
    for (const variant of Object.keys(FAMILY_REGISTRY[family].variants)) {
      for (const accept of [true, false]) {
        const key = resultKey(family, variant);
        const v = vectors.find((x) => x.family === family && x.variant === variant && x.case.expected[key] === accept);
        if (!v) continue;
        const r = callTool('ordex.run_verifier', { family, variant, arguments: argsFromCase(family, variant, v.case) });
        assert.equal(r.isError, false, `${v.id}`);
        assert.equal(r.structuredContent.verdict.state, accept ? 'accepted' : 'refused', v.id);
        if (!accept && v.case.expected.code) assert.equal(r.structuredContent.verdict.code, v.case.expected.code, v.id);
        n++;
      }
    }
  }
  assert.ok(n >= 30, `${n} verifier cases`);
  const missing = callTool('ordex.run_verifier', { family: 'offers', variant: 'acceptance', arguments: { acceptance: {} } });
  assert.equal(missing.isError, true, 'a verifier that cannot reach a verdict is a tool error');
});

test('vectors, sources and scenarios return real data or a tool error, never an invented success', () => {
  const v = callTool('ordex.get_conformance_vector', { family: 'purchase', vectorId: 'purchase/arrangement-ordex-builds' }).structuredContent.vector;
  assert.ok(v.case.transaction, 'the complete source case is returned');
  assert.equal(callTool('ordex.get_conformance_vector', { family: 'purchase', vectorId: 'purchase/nope' }).isError, true);
  assert.equal(callTool('ordex.explain_refusal', { code: 'NOT_A_REAL_CODE' }).isError, true);
  const sc = callTool('ordex.create_deterministic_example', { scenarioId: 'ask.wallet-output-reorder.refusal' }).structuredContent;
  assert.equal(sc.outcome, 'refusal as declared');
  assert.equal(sc.steps.at(-1).verdict.code, 'SELLER_SCRIPT_MISMATCH');
  assert.equal(sc.steps.at(-1).verdict.source, 'verifier');
});

test('resources list and read with real content, unknown URIs are -32602', async () => {
  const list = rpc('resources/list');
  assert.equal(list.result.resources.length, MCP_RESOURCES.length);
  const read = rpc('resources/read', { uri: 'ordex://spec/openapi.json' });
  const text = read.result.contents[0].text;
  const openapi = await readFile(new URL('../../spec/openapi.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(text), JSON.parse(openapi));
  assert.equal(readResource('ordex://spec/openapi.json').sha256, createHash('sha256').update(text).digest('hex'));
  const miss = rpc('resources/read', { uri: 'ordex://nope' });
  assert.equal(miss.error.code, JSONRPC.INVALID_PARAMS);
  assert.deepEqual(miss.error.data, { uri: 'ordex://nope' });
});

test('prompts list and get, with required arguments enforced', () => {
  const list = rpc('prompts/list');
  assert.deepEqual(list.result.prompts.map((p) => p.name), MCP_PROMPTS.map((p) => p.name));
  const got = rpc('prompts/get', { name: 'diagnose_refusal', arguments: { code: 'SAT_FLOW_SHORTFALL' } });
  assert.match(got.result.messages[0].content.text, /SAT_FLOW_SHORTFALL/);
  assert.equal(rpc('prompts/get', { name: 'diagnose_refusal', arguments: {} }).error.code, JSONRPC.INVALID_PARAMS);
  assert.equal(rpc('prompts/get', { name: 'nope' }).error.code, JSONRPC.INVALID_PARAMS);
});

test('every list result carries a cache lifetime and scope (Claude Code 2.1.281 rejects a list without them)', () => {
  for (const method of ['tools/list', 'resources/list', 'prompts/list']) {
    const { result } = rpc(method);
    assert.equal(typeof result.ttlMs, 'number', `${method} ttlMs`);
    assert.ok(['public', 'private'].includes(result.cacheScope), `${method} cacheScope`);
  }
});

test('stdio transport bounds lines whether an oversized line arrives whole or in pieces', async () => {
  const { PassThrough } = await import('node:stream');
  const { runStdio } = await import('../../scripts/mcp/stdio-host.mjs');
  for (const pieces of [1, 7]) {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => (out += d));
    const done = runStdio({ dispatch: dispatchMessage, input, output, error: new PassThrough(), maxLineBytes: 300 });
    const big = `{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{"pad":"${'x'.repeat(400)}"}}\n`;
    const size = Math.ceil(big.length / pieces);
    for (let i = 0; i < big.length; i += size) input.write(big.slice(i, i + size));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: { _meta: META } })}\n`);
    input.end();
    await done;
    const messages = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(messages.map((m) => [m.id, m.error?.code ?? 'ok']), [[null, -32600], [10, 'ok']], `${pieces} pieces`);
  }
});

test('Agent Bridge defaults: every tool example succeeds, and client setup and HTTP examples are derived, not typed', async () => {
  const { toolExamples } = await import('../../site/src/lib/mcp/tool-examples.js');
  const { clientSetup, validationCommands, buildSteps, CLIENTS } = await import('../../site/src/lib/mcp/client-config.mjs');
  const { mcpHttpRequest, encodeHeaderValue } = await import('../../site/src/lib/mcp/http-request.mjs');
  const examples = toolExamples();
  assert.deepEqual(Object.keys(examples).sort(), MCP_TOOLS.map((t) => t.name).sort());
  for (const t of MCP_TOOLS) {
    const r = callTool(t.name, examples[t.name]);
    assert.equal(r.isError, false, `${t.name}: ${r.content[0].text.slice(0, 160)}`);
  }
  assert.equal(callTool('ordex.run_verifier', examples['ordex.run_verifier']).structuredContent.verdict.state, 'accepted');

  // HTTP requests built for the page are accepted by the engine's own metadata rules.
  const req = mcpHttpRequest('tools/call', { name: 'ordex.get_mission', arguments: { missionId: 'integrate-public-asks' } }, 7);
  assert.equal(req.headers['MCP-Protocol-Version'], MCP_PROTOCOL_VERSION);
  assert.equal(req.headers['Mcp-Method'], 'tools/call');
  assert.equal(req.headers['Mcp-Name'], 'ordex.get_mission');
  assert.equal(dispatchMessage(JSON.parse(req.body)).result.isError, false);
  assert.equal(mcpHttpRequest('resources/read', { uri: 'ordex://spec/openapi.json' }).headers['Mcp-Name'], 'ordex://spec/openapi.json');
  assert.equal(encodeHeaderValue('caf\u00e9'), `=?base64?${Buffer.from('caf\u00e9').toString('base64')}?=`);

  // Client setups name the path given, and each config parses in its own format.
  const path = "C:\\Users\\o'k\\ordex-mcp-stdio.mjs";
  for (const { id } of CLIENTS) {
    const s = clientSetup(id, { stdioPath: path });
    if (id === 'codex') assert.match(s.config, /^\[mcp_servers\.ordex\]\ncommand = "node"\nargs = \["C:\\\\Users\\\\o'k\\\\ordex-mcp-stdio\.mjs"\]/);
    else assert.deepEqual(JSON.parse(s.config).mcpServers.ordex, { type: 'stdio', command: 'node', args: [path] });
    assert.match(s.docsUrl, /^https:\/\//);
  }
  assert.match(clientSetup('claude-code', { stdioPath: path }).notes.join(' '), /MCP_PROTOCOL_NEGOTIATION=auto/);
  assert.match(validationCommands("/opt/o'x.mjs").posix, /\| node '\/opt\/o'\\''x\.mjs'$/);
  assert.match(validationCommands("C:\\o'x.mjs").powershell, /\| node 'C:\\o''x\.mjs'$/);
  assert.deepEqual(buildSteps('abcdef1234567').commands.slice(2, 3), ['git checkout abcdef1234567']);
  assert.equal(buildSteps('unknown').known, false);
});
