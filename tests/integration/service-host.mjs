// Shared setup for the service integration tests (OX-P07, OX-P08): the built handler
// (dist/server/index.js) behind the built Node host (dist/server/node-host.mjs), on an
// ephemeral loopback port, with a real SQLite file in a temporary directory.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mcpHttpRequest } from '../../site/src/lib/mcp/http-request.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SERVER_DIR = join(ROOT, 'dist', 'server');
export const MCP_VERSION = '2026-07-28';

export function requireBuild() {
  for (const f of ['index.js', 'node-host.mjs', 'build-info.json', 'migrations']) {
    if (!existsSync(join(SERVER_DIR, f))) throw new Error(`dist/server/${f} is missing: run npm run build before the integration tests`);
  }
  return JSON.parse(readFileSync(join(SERVER_DIR, 'build-info.json'), 'utf8'));
}

export async function loadBuilt() {
  const buildInfo = requireBuild();
  const { startNodeHost, createD1Database, applyMigrations } = await import(pathToFileURL(join(SERVER_DIR, 'node-host.mjs')).href);
  const handler = (await import(pathToFileURL(join(SERVER_DIR, 'index.js')).href)).default;
  return { buildInfo, startNodeHost, createD1Database, applyMigrations, handler };
}

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Start the built host. Options pass through to startNodeHost. */
export async function startBuiltHost(options = {}) {
  const built = await loadBuilt();
  const logs = [];
  const host = await built.startNodeHost({
    handler: built.handler,
    host: '127.0.0.1',
    port: 0,
    migrationsDir: join(SERVER_DIR, 'migrations'),
    revision: built.buildInfo.revision,
    log: (m) => logs.push(m),
    ...options
  });
  return { ...host, logs, built };
}

/**
 * The Streamable HTTP client the Agent Bridge uses (site/src/lib/mcp/http-request.mjs), so
 * these tests prove the page's derived headers and bodies against the real host.
 */
export function mcpClient(baseUrl, { origin } = {}) {
  let nextId = 1;
  async function request(method, params = {}) {
    const id = nextId++;
    const { headers, body } = mcpHttpRequest(method, params, id, { name: 'ordex-integration-test', version: '1' });
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { ...headers, ...(origin ? { origin } : {}) }, body });
    const parsed = await res.json();
    if (parsed.id !== id) throw new Error(`response id ${parsed.id} does not match request id ${id}`);
    return { status: res.status, headers: res.headers, body: parsed };
  }
  return {
    request,
    discover: () => request('server/discover'),
    listTools: () => request('tools/list'),
    callTool: (name, args) => request('tools/call', { name, arguments: args })
  };
}
