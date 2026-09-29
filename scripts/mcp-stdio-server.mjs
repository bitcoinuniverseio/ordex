#!/usr/bin/env node
/**
 * Ordex Local MCP Stdio Server (2026-07-28 Protocol)
 * 
 * Communicates via newline-delimited JSON messages over stdin/stdout.
 * Logs only to stderr. Never prints non-protocol content to stdout.
 */

import readline from 'node:readline';
/* IMPLEMENTATION-HANDOFF [OX-S04]
 * Defect OX-S-D04; coverage OX-S-C960..OX-S-C969. Documented node scripts/mcp-stdio-server.mjs exits
 * ERR_MODULE_NOT_FOUND because the imported server.js is checked in only as server.ts.
 * 1. Add a pinned build target for the shared MCP engine and import its emitted JavaScript from this
 * executable, or publish one built package/binary with an absolute entry path. Do not depend on a user's
 * current directory or unpinned npx transpiler.
 * 2. Share request dispatch with OX-S04 server.ts; validate JSON-RPC envelopes, request IDs and bounded line
 * length, process notifications without response, and isolate concurrent requests with bounded work.
 * 3. Preserve stdout as protocol-only, stderr as sanitized diagnostics. Send malformed JSON and invalid
 * request/tool errors with the codes required by MCP 2026-07-28; tool execution failures are tool-result
 * errors, not blanket internal errors.
 * 4. Update AgentBridge generated setup for actual supported client formats and build prerequisites. Test from
 * a clean unpacked package outside repo cwd, pipe discovery/list/call/resource/prompt messages and assert
 * stdout schemas; test malformed/oversized input and clean shutdown.
 * Dependencies: OX-S04 shared dispatcher, OX-S07/08 runtime imports. Run node scripts/mcp-stdio-server.mjs
 * after build and npm run test:mcp; these commands currently fail before protocol startup. Rollback deployment
 * package and config atomically, retaining an operable binary.
 */
import { executeMcpTool, handleMcpProtocolRequest, MCP_TOOLS } from '../site/src/lib/mcp/server.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

process.stderr.write('Ordex MCP 2026-07-28 stdio server started. Listening on stdin...\n');

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    const { id, method, params } = request;

    let response = { jsonrpc: '2.0', id };

    if (method === 'tools/list') {
      response.result = { tools: MCP_TOOLS };
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const toolResult = await executeMcpTool(toolName, toolArgs);
        response.result = toolResult;
      } catch (err) {
        response.error = {
          code: -32603,
          message: err instanceof Error ? err.message : 'Internal tool execution error'
        };
      }
    } else {
      const protoRes = handleMcpProtocolRequest(method, params || {}, {});
      if (protoRes.error) {
        response.error = protoRes.error;
      } else {
        response.result = protoRes.result;
      }
    }

    // Write strictly newline-delimited JSON to stdout
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (err) {
    process.stderr.write(`Malformed JSON received on stdin: ${err.message}\n`);
    const errorResponse = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    };
    process.stdout.write(JSON.stringify(errorResponse) + '\n');
  }
});
