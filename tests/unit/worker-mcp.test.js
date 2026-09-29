import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../../worker/index.js';
import { decodeHeaderValue } from '../../worker/mcp-http.js';
import { MCP_TOOLS } from '../../site/src/lib/mcp/server.js';

// OX-P07 (PROPOSED NEW): the Streamable HTTP transport of MCP 2026-07-28 over the shared
// engine: header presence and agreement, version errors, status codes, Origin policy and
// real tool results.

const V = '2026-07-28';
const META = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {} };
function call(body, headers = {}, env = {}) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': V, ...(body?.method ? { 'mcp-method': body.method } : {}), ...headers };
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  return worker.fetch(new Request('http://svc/mcp', { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) }), env);
}
const req = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } });

test('a conformant discover, list and call sequence works', async () => {
  const d = await call(req('server/discover'));
  assert.equal(d.status, 200);
  assert.equal((await d.json()).result.supportedVersions[0], V);
  const l = await (await call(req('tools/list'))).json();
  assert.equal(l.result.tools.length, 10);
  const c = await call(req('tools/call', { name: 'ordex.explain_refusal', arguments: { code: 'SELLER_VALUE_MISMATCH' } }), { 'mcp-name': 'ordex.explain_refusal' });
  const body = await c.json();
  assert.equal(c.status, 200);
  assert.equal(body.result.isError, false);
  assert.ok(body.result.structuredContent.rule.exactCodes.includes('SELLER_VALUE_MISMATCH'));
});

test('every advertised tool is callable over HTTP with a real result', async () => {
  const args = {
    'ordex.search_docs': { query: 'cursor' },
    'ordex.read_source': { sourcePath: 'spec/events.md' },
    'ordex.list_capabilities': {},
    'ordex.get_openapi_operation': { operationId: 'listOrders' },
    'ordex.get_asyncapi_channel': { channelName: 'webhookDelivery' },
    'ordex.run_verifier': { family: 'events', variant: 'event', arguments: { event: { id: 'x' } } },
    'ordex.explain_refusal': { code: 'CENOTAPH_BURNS_BALANCE' },
    'ordex.get_conformance_vector': { family: 'swaps', vectorId: 'swaps/a-consideration-shortfall-is-refused' },
    'ordex.create_deterministic_example': { scenarioId: 'purchase.batch.success' },
    'ordex.get_mission': { missionId: 'protect-wallet-signing' }
  };
  for (const t of MCP_TOOLS) {
    const res = await call(req('tools/call', { name: t.name, arguments: args[t.name] }), { 'mcp-name': t.name });
    const body = await res.json();
    assert.equal(res.status, 200, t.name);
    assert.equal(body.result.resultType, 'complete', t.name);
    assert.equal(body.result.isError, false, `${t.name}: ${body.result.content[0].text.slice(0, 150)}`);
  }
  // The invalid event envelope above is a refusal, not an executed success.
  const ev = await (await call(req('tools/call', { name: 'ordex.run_verifier', arguments: args['ordex.run_verifier'] }), { 'mcp-name': 'ordex.run_verifier' })).json();
  assert.equal(ev.result.structuredContent.verdict.state, 'refused');
});

test('unknown tools and invalid arguments never report success', async () => {
  const unknown = await (await call(req('tools/call', { name: 'ordex.nope', arguments: {} }), { 'mcp-name': 'ordex.nope' })).json();
  assert.equal(unknown.error.code, -32602);
  const invalid = await (await call(req('tools/call', { name: 'ordex.run_verifier', arguments: {} }), { 'mcp-name': 'ordex.run_verifier' })).json();
  assert.equal(invalid.result.isError, true);
});

test('missing or mismatched metadata headers are 400 HeaderMismatch (-32020)', async () => {
  for (const [headers, why] of [
    [{ 'mcp-protocol-version': null }, 'no version header'],
    [{ 'mcp-method': null }, 'no method header'],
    [{ 'mcp-method': 'tools/call' }, 'method mismatch'],
    [{ 'mcp-protocol-version': '2025-11-25' }, 'header and body versions differ']
  ]) {
    const res = await call(req('tools/list'), headers);
    assert.equal(res.status, 400, why);
    assert.equal((await res.json()).error.code, -32020, why);
  }
  const noName = await call(req('tools/call', { name: 'ordex.get_mission', arguments: { missionId: 'integrate-public-asks' } }));
  assert.equal((await noName.json()).error.code, -32020);
  const wrongName = await call(req('tools/call', { name: 'ordex.get_mission', arguments: { missionId: 'integrate-public-asks' } }), { 'mcp-name': 'ordex.search_docs' });
  assert.equal((await wrongName.json()).error.code, -32020);
});

test('an Mcp-Name in the Base64 sentinel form is decoded before comparison', async () => {
  const encoded = `=?base64?${Buffer.from('ordex.get_mission').toString('base64')}?=`;
  assert.equal(decodeHeaderValue(encoded), 'ordex.get_mission');
  assert.equal(decodeHeaderValue('badé'), undefined);
  const res = await call(req('tools/call', { name: 'ordex.get_mission', arguments: { missionId: 'integrate-public-asks' } }), { 'mcp-name': encoded });
  assert.equal(res.status, 200);
});

test('an unsupported version is 400 with -32022 and the supported list; missing _meta is 400 -32602', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } };
  const res = await call(body, { 'mcp-protocol-version': '1900-01-01' });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, -32022);
  assert.deepEqual(data.error.data.supported, [V]);
  const noMeta = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(noMeta.status, 400);
  assert.equal((await noMeta.json()).error.code, -32602);
});

test('status codes: unknown method 404, notification 202 empty, GET 405, parse error 400, id 0 kept', async () => {
  const unknown = await call(req('resources/templates/list'));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, -32601);
  const note = await call({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
  const get = await worker.fetch(new Request('http://svc/mcp', { method: 'GET' }), {});
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  const parse = await call('{nope');
  assert.equal(parse.status, 400);
  assert.equal((await parse.json()).error.code, -32700);
  const zero = await (await call(req('tools/list', {}, 0))).json();
  assert.equal(zero.id, 0);
  const media = await worker.fetch(new Request('http://svc/mcp', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), {});
  assert.equal(media.status, 415);
});

test('Origin policy: a foreign origin is 403, an allowed origin gets CORS and the preflight allows MCP headers', async () => {
  const foreign = await call(req('tools/list'), { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const ok = await call(req('tools/list'), { origin: 'https://bitcoinuniverseio.github.io' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://bitcoinuniverseio.github.io');
  const custom = await call(req('tools/list'), { origin: 'https://docs.example' }, { ORDEX_ALLOWED_ORIGINS: 'https://docs.example' });
  assert.equal(custom.status, 200);
  const pre = await worker.fetch(new Request('http://svc/api/docs/ask', { method: 'OPTIONS', headers: { origin: 'https://bitcoinuniverseio.github.io' } }), {});
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /MCP-Protocol-Version/);
  assert.match(pre.headers.get('access-control-allow-headers'), /Mcp-Name/);
  const badPre = await worker.fetch(new Request('http://svc/api/docs/ask', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), {});
  assert.equal(badPre.status, 403);
});
