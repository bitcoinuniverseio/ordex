import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// OX-S04 (PROPOSED NEW): the built stdio server, copied to an empty directory outside the
// repository and run with plain Node, as an MCP client would launch it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = join(root, 'dist', 'mcp', 'ordex-mcp-stdio.mjs');
const V = '2026-07-28';
const META = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'stdio-test', version: '1' } };
const req = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } });

function launch(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = [];
  let out = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      lines.push(line);
      for (const w of waiters.splice(0)) w();
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const parsed = () => lines.map((l) => JSON.parse(l));
  async function waitFor(pred, ms = 10000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = parsed().find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no matching message; stdout lines: ${lines.length}; stderr: ${stderr.slice(-400)}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 200);
      });
    }
  }
  return { child, lines, parsed, waitFor, exited, send: (text) => child.stdin.write(`${text}\n`), stderr: () => stderr };
}

test('the self-contained stdio bundle serves the MCP surface from an empty directory', async (t) => {
  assert.ok(existsSync(bundle), 'dist/mcp/ordex-mcp-stdio.mjs is missing: run npm run build');
  const dir = mkdtempSync(join(tmpdir(), 'ordex-stdio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(bundle, join(dir, 'ordex-mcp-stdio.mjs'));
  const s = launch([join(dir, 'ordex-mcp-stdio.mjs')], dir);
  t.after(() => s.child.exitCode === null && s.child.kill());
  const buildInfo = JSON.parse(readFileSync(join(root, 'dist', 'server', 'build-info.json'), 'utf8'));

  s.send(req(1, 'server/discover'));
  const discover = await s.waitFor((m) => m.id === 1);
  assert.deepEqual(discover.result.supportedVersions, [V]);
  assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].version, buildInfo.revision);

  s.send(req(2, 'tools/list'));
  assert.equal((await s.waitFor((m) => m.id === 2)).result.tools.length, 10);

  s.send(req(3, 'tools/call', { name: 'ordex.explain_refusal', arguments: { code: 'SELLER_VALUE_MISMATCH' } }));
  const call = await s.waitFor((m) => m.id === 3);
  assert.equal(call.result.isError, false);
  assert.ok(call.result.structuredContent.rule.exactCodes.includes('SELLER_VALUE_MISMATCH'));

  s.send(req(4, 'resources/read', { uri: 'ordex://spec/openapi.json' }));
  const resource = await s.waitFor((m) => m.id === 4);
  assert.deepEqual(JSON.parse(resource.result.contents[0].text), JSON.parse(readFileSync(join(root, 'spec', 'openapi.json'), 'utf8')));

  s.send(req(5, 'prompts/get', { name: 'diagnose_refusal', arguments: { code: 'SAT_FLOW_SHORTFALL' } }));
  assert.match((await s.waitFor((m) => m.id === 5)).result.messages[0].content.text, /SAT_FLOW_SHORTFALL/);

  s.send(req(6, 'tools/call', { name: 'ordex.run_verifier', arguments: { family: 'purchase', arguments: {} } }));
  assert.equal((await s.waitFor((m) => m.id === 6)).result.isError, true, 'bad arguments are a tool error');

  s.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }));
  assert.equal((await s.waitFor((m) => m.id === 7)).error.code, -32601, 'there is no initialize handshake in 2026-07-28');

  // Malformed JSON gets a parse error with a null id; the server keeps serving.
  s.send('{"jsonrpc": "2.0", "id": 8,');
  await s.waitFor((m) => m.id === null && m.error?.code === -32700);

  // An oversized line is refused once and dropped; the next request is still answered.
  s.send(`{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{"pad":"${'x'.repeat(1024 * 1024 + 16)}"}}`);
  await s.waitFor((m) => m.id === null && m.error?.code === -32600);
  s.send(req(10, 'tools/list'));
  await s.waitFor((m) => m.id === 10);
  assert.ok(!s.parsed().some((m) => m.id === 9), 'the oversized request was not processed');

  // A cancellation that arrives with its request suppresses the response.
  s.child.stdin.write(`${req(11, 'tools/list')}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } })}\n`);
  s.send(req(12, 'tools/list'));
  await s.waitFor((m) => m.id === 12);
  assert.ok(!s.parsed().some((m) => m.id === 11), 'the cancelled request has no response');

  // A notification gets no response at all.
  const before = s.lines.length;
  s.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }));
  s.send(req(13, 'tools/list'));
  await s.waitFor((m) => m.id === 13);
  assert.equal(s.lines.length, before + 1);

  // Closing stdin shuts the server down cleanly; stdout carried protocol messages only.
  s.child.stdin.end();
  assert.equal(await s.exited, 0);
  for (const line of s.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.match(s.stderr(), /stdio server/);
});

test('the repository launcher runs the built engine from any working directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ordex-stdio-cwd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = launch([join(root, 'scripts', 'mcp-stdio-server.mjs')], dir);
  t.after(() => s.child.exitCode === null && s.child.kill());
  s.send(req(1, 'tools/call', { name: 'ordex.get_mission', arguments: { missionId: 'integrate-public-asks' } }));
  const res = await s.waitFor((m) => m.id === 1);
  assert.equal(res.result.structuredContent.mission.id, 'integrate-public-asks');
  s.child.stdin.end();
  assert.equal(await s.exited, 0);
});
