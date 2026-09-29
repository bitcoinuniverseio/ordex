#!/usr/bin/env node
/**
 * Ordex MCP stdio server (MCP revision 2026-07-28).
 *
 * OX-S04: runs the engine built by `npm run build` (dist/mcp/ordex-mcp-engine.mjs), resolved
 * from this file's own location so it works from any working directory. A self-contained
 * copy for installing outside the repository is dist/mcp/ordex-mcp-stdio.mjs. Stdout carries
 * protocol messages only; diagnostics go to stderr.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runStdio } from './mcp/stdio-host.mjs';

const enginePath = fileURLToPath(new URL('../dist/mcp/ordex-mcp-engine.mjs', import.meta.url));
if (!existsSync(enginePath)) {
  process.stderr.write(`The MCP engine is not built. Run npm run build in the repository first (missing ${enginePath}).\n`);
  process.exit(1);
}
const engine = await import(pathToFileURL(enginePath).href);

process.stderr.write(`Ordex MCP ${engine.MCP_PROTOCOL_VERSION} stdio server, build ${engine.BUILD_REVISION}. Reading JSON-RPC from stdin.\n`);
await runStdio({ dispatch: engine.dispatchMessage, input: process.stdin, output: process.stdout, error: process.stderr });
process.exit(0);
