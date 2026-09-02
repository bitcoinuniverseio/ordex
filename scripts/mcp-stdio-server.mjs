#!/usr/bin/env node
/**
 * Ordex Local MCP Stdio Server (2026-07-28 Protocol)
 * 
 * Communicates via newline-delimited JSON messages over stdin/stdout.
 * Logs only to stderr. Never prints non-protocol content to stdout.
 */

import readline from 'node:readline';
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
