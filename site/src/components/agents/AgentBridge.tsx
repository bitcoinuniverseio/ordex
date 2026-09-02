import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { MCP_TOOLS, MCP_PROTOCOL_VERSION, executeMcpTool, type McpToolDefinition } from '../../lib/mcp/server.js';
import {
  IconAgents,
  IconCopy,
  IconCheck,
  IconShieldCheck,
  IconExternalLink
} from '../experience/OrdexIcons.js';

interface AgentProps {
  basePath?: string;
}

export function AgentBridge({ basePath = '/ordex' }: AgentProps): JSX.Element {
  const [selectedTool, setSelectedTool] = useState<McpToolDefinition>(MCP_TOOLS[0]);
  const [toolArgsText, setToolArgsText] = useState<string>('{\n  "query": "public ask"\n}');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [copiedConfig, setCopiedConfig] = useState(false);

  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        ordex: {
          command: 'node',
          args: ['scripts/mcp-stdio-server.mjs'],
          env: {
            NODE_ENV: 'production'
          }
        }
      }
    },
    null,
    2
  );

  const handleRunTool = async () => {
    try {
      const parsedArgs = JSON.parse(toolArgsText);
      const res = await executeMcpTool(selectedTool.name, parsedArgs);
      setTestResult(JSON.stringify(res, null, 2));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error executing tool';
      setTestResult(JSON.stringify({ error: msg }, null, 2));
    }
  };

  const handleCopyConfig = () => {
    navigator.clipboard.writeText(stdioConfig);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header Banner */}
      <div
        style={{
          padding: '1.5rem',
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-bitcoin-orange)' }}>
            Agent Bridge
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>•</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>MCP Protocol Version {MCP_PROTOCOL_VERSION}</span>
        </div>

        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>
          Ordex MCP Agent Interface & Tool Explorer
        </h1>

        <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.4 }}>
          Connect autonomous AI coding agents (Claude Code, Cursor, Codex) to the authoritative Ordex protocol dataset,
          reference verifiers, OpenAPI contracts, refusal diagnostics, and test vectors over local stdio or modern Streamable HTTP.
        </p>

        {/* Read-Only Safety Boundary Pill */}
        <div
          style={{
            padding: '0.75rem 1rem',
            borderRadius: 'var(--ox-radius-md)',
            backgroundColor: 'var(--ox-surface-subtle)',
            border: '1px solid var(--ox-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.8125rem'
          }}
        >
          <IconShieldCheck size={18} color="var(--ox-status-success-text)" />
          <div>
            <strong>Strict Read-Only Non-Custodial Boundary:</strong> Zero signing, zero private key handling, zero broadcasting, and zero gateway state mutation capabilities are exposed over MCP.
          </div>
        </div>
      </div>

      {/* Configuration Guides */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1rem'
        }}
      >
        {/* Local Stdio Config Card */}
        <div
          style={{
            padding: '1.25rem',
            borderRadius: 'var(--ox-radius-md)',
            backgroundColor: 'var(--ox-surface-panel)',
            border: '1px solid var(--ox-border-default)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, margin: 0, color: 'var(--ox-text-primary)' }}>
              Local Stdio Config (Claude Code / Cursor)
            </h3>
            <button
              type="button"
              onClick={handleCopyConfig}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                padding: '0.25rem 0.5rem',
                fontSize: '0.75rem',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-default)',
                borderRadius: 'var(--ox-radius-sm)',
                cursor: 'pointer'
              }}
            >
              <IconCopy size={12} />
              <span>{copiedConfig ? 'Copied' : 'Copy JSON'}</span>
            </button>
          </div>

          <pre
            style={{
              margin: 0,
              padding: '0.75rem',
              borderRadius: 'var(--ox-radius-sm)',
              backgroundColor: 'var(--ox-surface-inset)',
              fontFamily: 'var(--ox-font-mono)',
              fontSize: '0.75rem',
              color: 'var(--ox-text-primary)',
              overflowX: 'auto',
              lineHeight: 1.4
            }}
          >
            {stdioConfig}
          </pre>
          <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>
            Place in your <code>claude.json</code> or Cursor MCP settings file.
          </div>
        </div>

        {/* Remote Streamable HTTP Card */}
        <div
          style={{
            padding: '1.25rem',
            borderRadius: 'var(--ox-radius-md)',
            backgroundColor: 'var(--ox-surface-panel)',
            border: '1px solid var(--ox-border-default)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem'
          }}
        >
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, margin: 0, color: 'var(--ox-text-primary)' }}>
            Remote Streamable HTTP Endpoint
          </h3>
          <div style={{ fontFamily: 'var(--ox-font-mono)', fontSize: '0.8125rem', padding: '0.5rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-subtle)', border: '1px solid var(--ox-border-subtle)' }}>
            POST https://ordex.bitcoinuniverse.io/mcp
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--ox-text-secondary)', lineHeight: 1.4 }}>
            Modern MCP 2026-07-28 POST endpoint. Requires <code>MCP-Protocol-Version: 2026-07-28</code> and <code>Content-Type: application/json</code>. No protocol-level session minting required.
          </div>
        </div>
      </div>

      {/* Live Tool Explorer & Test Console */}
      <div
        style={{
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--ox-border-subtle)', backgroundColor: 'var(--ox-surface-subtle)' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, color: 'var(--ox-text-primary)' }}>
            Live Tool Explorer & In-Browser Test Console ({MCP_TOOLS.length} Tools)
          </h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', minHeight: '400px' }}>
          {/* Tool List Rail */}
          <div style={{ borderRight: '1px solid var(--ox-border-subtle)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', overflowY: 'auto' }}>
            {MCP_TOOLS.map((t) => {
              const isSelected = selectedTool.name === t.name;
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => {
                    setSelectedTool(t);
                    setTestResult(null);
                    if (t.name === 'ordex.search_docs') setToolArgsText('{\n  "query": "public ask"\n}');
                    else if (t.name === 'ordex.get_openapi_operation') setToolArgsText('{\n  "operationId": "buildAsk"\n}');
                    else if (t.name === 'ordex.explain_refusal') setToolArgsText('{\n  "code": "PAYMENT_OUTPUT_MISMATCH"\n}');
                    else if (t.name === 'ordex.get_mission') setToolArgsText('{\n  "missionId": "integrate-public-asks"\n}');
                    else setToolArgsText('{}');
                  }}
                  style={{
                    padding: '0.5rem 0.75rem',
                    textAlign: 'left',
                    borderRadius: 'var(--ox-radius-sm)',
                    border: 'none',
                    backgroundColor: isSelected ? 'var(--ox-surface-subtle)' : 'transparent',
                    borderLeft: isSelected ? '3px solid var(--ox-bitcoin-orange)' : '3px solid transparent',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                    fontWeight: isSelected ? 700 : 500,
                    color: isSelected ? 'var(--ox-text-primary)' : 'var(--ox-text-secondary)'
                  }}
                >
                  {t.name}
                </button>
              );
            })}
          </div>

          {/* Tool Details and Test Workbench */}
          <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', fontSize: '0.8125rem' }}>
            <div>
              <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-text-muted)' }}>
                Tool Name
              </div>
              <h3 style={{ fontSize: '1.125rem', fontWeight: 700, margin: '0.2rem 0', color: 'var(--ox-text-primary)' }}>
                {selectedTool.name}
              </h3>
              <p style={{ margin: 0, color: 'var(--ox-text-secondary)', lineHeight: 1.4 }}>
                {selectedTool.description}
              </p>
            </div>

            {/* Input Arguments Box */}
            <div>
              <label htmlFor="tool-args-input" style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-muted)', marginBottom: '0.25rem' }}>
                JSON Arguments
              </label>
              <textarea
                id="tool-args-input"
                value={toolArgsText}
                onInput={(e) => setToolArgsText((e.target as HTMLTextAreaElement).value)}
                rows={4}
                style={{
                  width: '100%',
                  fontFamily: 'var(--ox-font-mono)',
                  fontSize: '0.75rem',
                  padding: '0.5rem',
                  borderRadius: 'var(--ox-radius-sm)',
                  border: '1px solid var(--ox-border-default)',
                  backgroundColor: 'var(--ox-surface-subtle)',
                  color: 'var(--ox-text-primary)'
                }}
              />
            </div>

            <button
              type="button"
              onClick={handleRunTool}
              style={{
                alignSelf: 'flex-start',
                padding: '0.45rem 1rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-bitcoin-orange)',
                color: '#ffffff',
                border: 'none',
                fontWeight: 600,
                fontSize: '0.8125rem',
                cursor: 'pointer'
              }}
            >
              Test Tool Execution
            </button>

            {/* Execution Output */}
            {testResult && (
              <div>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-muted)', marginBottom: '0.25rem' }}>
                  Execution Result (Protocol JSON)
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '0.75rem',
                    borderRadius: 'var(--ox-radius-md)',
                    backgroundColor: 'var(--ox-surface-inset)',
                    fontFamily: 'var(--ox-font-mono)',
                    fontSize: '0.75rem',
                    color: 'var(--ox-text-primary)',
                    overflowX: 'auto',
                    maxHeight: '250px',
                    lineHeight: 1.4
                  }}
                >
                  {testResult}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
