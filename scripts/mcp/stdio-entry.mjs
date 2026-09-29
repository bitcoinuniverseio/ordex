// OX-S04: entry point bundled into the self-contained dist/mcp/ordex-mcp-stdio.mjs. The
// engine is compiled in, so the file runs with plain Node from any directory.
import { dispatchMessage, MCP_PROTOCOL_VERSION, BUILD_REVISION } from '../../site/src/lib/mcp/server.ts';
import { runStdio } from './stdio-host.mjs';

process.stderr.write(`Ordex MCP ${MCP_PROTOCOL_VERSION} stdio server, build ${BUILD_REVISION}. Reading JSON-RPC from stdin.\n`);
await runStdio({ dispatch: dispatchMessage, input: process.stdin, output: process.stdout, error: process.stderr });
process.exit(0);
