// OX-S04: install instructions for the built stdio server (dist/mcp/ordex-mcp-stdio.mjs) per
// MCP client. Config fields follow each client's own documentation as read on 2026-09-29:
//   Claude Code  https://code.claude.com/docs/en/mcp
//   Cursor       https://cursor.com/docs/context/mcp
//   Codex        https://developers.openai.com/codex/mcp
// Only Claude Code documents support for MCP revision 2026-07-28 (v2 runtime; stdio servers
// need MCP_PROTOCOL_NEGOTIATION=auto). The others are shown with that limit stated.

export const STDIO_FILE = 'ordex-mcp-stdio.mjs';
export const REPOSITORY = 'https://github.com/bitcoinuniverseio/ordex';
export const NODE_VERSION = '24.19.0';

const DISCOVER_LINE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'server/discover',
  params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }
});

const posixQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const powershellQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const LIMIT_NOTE =
  "This client's MCP documentation does not say it supports revision 2026-07-28. A client that only opens with the older initialize handshake receives an error naming 2026-07-28 and cannot use this server.";

export const CLIENTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' }
];

/** How to obtain the stdio file for an exact source revision. */
export function buildSteps(revision) {
  const known = typeof revision === 'string' && /^[0-9a-f]{7,40}$/.test(revision);
  return {
    known,
    commands: [`git clone ${REPOSITORY}`, 'cd ordex', ...(known ? [`git checkout ${revision}`] : []), 'npm ci', 'npm run build'],
    output: `dist/mcp/${STDIO_FILE}`
  };
}

/** A command that asks the server to describe itself; it prints one JSON line and exits. */
export function validationCommands(stdioPath) {
  return {
    posix: `printf '%s\\n' ${posixQuote(DISCOVER_LINE)} | node ${posixQuote(stdioPath)}`,
    powershell: `${powershellQuote(DISCOVER_LINE)} | node ${powershellQuote(stdioPath)}`
  };
}

/** Client-specific setup: a command, a config file and its contents, and what to check. */
export function clientSetup(clientId, { stdioPath, endpoint = '' }) {
  const stdioJson = JSON.stringify({ mcpServers: { ordex: { type: 'stdio', command: 'node', args: [stdioPath] } } }, null, 2);
  if (clientId === 'claude-code') {
    return {
      docsUrl: 'https://code.claude.com/docs/en/mcp',
      command: `claude mcp add --transport stdio ordex -- node ${posixQuote(stdioPath)}`,
      file: '.mcp.json (project scope), or use the command above',
      config: stdioJson,
      httpCommand: endpoint ? `claude mcp add --transport http ordex ${endpoint}` : null,
      notes: [
        'Needs Claude Code 2.1.274 or later on its v2 MCP runtime, which adds revision 2026-07-28.',
        'For this stdio server, start Claude Code with the environment variable MCP_PROTOCOL_NEGOTIATION=auto. Without it Claude Code opens stdio servers with the older initialize handshake, which this server refuses.',
        'Over HTTP, the v2 runtime asks the server for the newer revision by default.'
      ],
      check: 'claude mcp get ordex'
    };
  }
  if (clientId === 'cursor') {
    return {
      docsUrl: 'https://cursor.com/docs/context/mcp',
      command: null,
      file: '.cursor/mcp.json in the project, or ~/.cursor/mcp.json for every project',
      config: stdioJson,
      httpCommand: null,
      notes: [LIMIT_NOTE],
      check: null
    };
  }
  if (clientId === 'codex') {
    return {
      docsUrl: 'https://developers.openai.com/codex/mcp',
      command: `codex mcp add ordex -- node ${posixQuote(stdioPath)}`,
      file: '~/.codex/config.toml',
      config: `[mcp_servers.ordex]\ncommand = "node"\nargs = [${JSON.stringify(stdioPath)}]\n`,
      httpCommand: null,
      notes: [LIMIT_NOTE],
      check: null
    };
  }
  throw new Error(`Unknown MCP client: ${clientId}`);
}
