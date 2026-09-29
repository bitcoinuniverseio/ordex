import type { JSX } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { MCP_TOOLS, MCP_PROTOCOL_VERSION, BUILD_REVISION, callTool, type McpToolDefinition, type CallToolResult } from '../../lib/mcp/server.js';
import { toolExamples } from '../../lib/mcp/tool-examples.js';
import { CLIENTS, NODE_VERSION, STDIO_FILE, buildSteps, clientSetup, validationCommands } from '../../lib/mcp/client-config.mjs';
import { curlText, httpMessageText, mcpHttpRequest, runRemoteDiagnostic, sendMcpRequest } from '../../lib/mcp/http-request.mjs';
import { tabKeyHandler, tabProps, tabPanelProps } from '../../lib/a11y/tabs.js';
import { IconCopy, IconShieldCheck, IconExternalLink } from '../experience/OrdexIcons.js';

// OX-S04: Agent Bridge. Install steps use the built stdio file (dist/mcp/ordex-mcp-stdio.mjs)
// at this page's exact source revision, per client, with a setup check. Running a tool here
// executes the shared engine in this browser and is labeled local; the remote check and
// "send to endpoint" make real HTTP requests to an endpoint and show them. HTTP examples
// come from the same request builder the integration tests run against the service.

interface AgentProps {
  basePath?: string;
}

const DOCS_API_BASE: string = (import.meta.env.PUBLIC_ORDEX_DOCS_API_BASE as string | undefined) || '';
const DEFAULT_HOST_ENDPOINT = 'http://127.0.0.1:8787/mcp';

type Remote = Awaited<ReturnType<typeof runRemoteDiagnostic>>;
type Sent = Awaited<ReturnType<typeof sendMcpRequest>>;
type LocalRun = { result: CallToolResult | null; error: string | null; at: string };

const panel = { padding: '1.25rem', borderRadius: 'var(--ox-radius-md)', backgroundColor: 'var(--ox-surface-panel)', border: '1px solid var(--ox-border-default)', display: 'flex', flexDirection: 'column', gap: '0.75rem' } as const;
const pre = { margin: 0, padding: '0.75rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-inset)', fontFamily: 'var(--ox-font-mono)', fontSize: '0.75rem', color: 'var(--ox-text-primary)', overflowX: 'auto', lineHeight: 1.4, whiteSpace: 'pre' } as const;
const label = { display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-secondary)', marginBottom: '0.25rem' } as const;
const input = { width: '100%', fontFamily: 'var(--ox-font-mono)', fontSize: '0.8125rem', padding: '0.5rem', borderRadius: 'var(--ox-radius-sm)', border: '1px solid var(--ox-border-default)', backgroundColor: 'var(--ox-surface-subtle)', color: 'var(--ox-text-primary)', boxSizing: 'border-box' } as const;
const evidence = (kind: 'local' | 'remote') =>
  ({ fontSize: '0.75rem', fontWeight: 700, padding: '0.35rem 0.6rem', borderRadius: 'var(--ox-radius-sm)', border: '1px solid var(--ox-border-subtle)', backgroundColor: kind === 'local' ? 'var(--ox-surface-subtle)' : 'var(--ox-status-info-bg, var(--ox-surface-subtle))', color: 'var(--ox-text-primary)' }) as const;

function CodeBlock({ id, title, text, onCopy }: { id: string; title: string; text: string; onCopy: (text: string, what: string) => void }): JSX.Element {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <span id={`${id}-label`} style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--ox-text-secondary)' }}>
          {title}
        </span>
        <button type="button" class="btn btn-secondary" style={{ minHeight: '32px', padding: '0.2rem 0.6rem', fontSize: '0.75rem' }} onClick={() => onCopy(text, title)} aria-label={`Copy ${title}`}>
          <IconCopy size={12} />
          <span>Copy</span>
        </button>
      </div>
      <pre style={pre} aria-labelledby={`${id}-label`} tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}

export function AgentBridge(_props: AgentProps): JSX.Element {
  const examples = useMemo(() => toolExamples(), []);
  const [announcement, setAnnouncement] = useState('');
  const [stdioPath, setStdioPath] = useState(`/path/to/${STDIO_FILE}`);
  const [client, setClient] = useState<string>(CLIENTS[0].id);
  const [endpoint, setEndpoint] = useState(DOCS_API_BASE ? `${DOCS_API_BASE}/mcp` : '');
  const [remote, setRemote] = useState<Remote | null>(null);
  const [remoteAt, setRemoteAt] = useState('');
  const [remoteRunning, setRemoteRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<McpToolDefinition>(MCP_TOOLS[0]);
  const [argsText, setArgsText] = useState(JSON.stringify(examples[MCP_TOOLS[0].name], null, 2));
  const [local, setLocal] = useState<LocalRun | null>(null);
  const [sent, setSent] = useState<{ at: string; outcome: Sent } | null>(null);
  const [sending, setSending] = useState(false);

  const steps = buildSteps(BUILD_REVISION);
  const setup = clientSetup(client, { stdioPath, endpoint });
  const checks = validationCommands(stdioPath);
  const onClientKey = tabKeyHandler(CLIENTS.map((c) => c.id), client, setClient, 'mcp-client');

  const copy = async (text: string, what: string) => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setAnnouncement(`${what} copied.`);
    } catch {
      setAnnouncement(`${what} could not be copied. Select the text and copy it yourself.`);
    }
  };

  const parsedArgs = (): { args: Record<string, unknown> | null; error: string | null } => {
    try {
      const v = JSON.parse(argsText);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { args: null, error: 'Arguments must be a JSON object.' };
      return { args: v, error: null };
    } catch (err) {
      return { args: null, error: `Arguments are not valid JSON: ${(err as Error).message}` };
    }
  };

  const selectTool = (t: McpToolDefinition) => {
    setSelected(t);
    setArgsText(JSON.stringify(examples[t.name] ?? {}, null, 2));
    setLocal(null);
    setSent(null);
  };

  const runLocal = () => {
    const at = new Date().toISOString();
    const { args, error } = parsedArgs();
    if (error) return setLocal({ result: null, error, at });
    try {
      setLocal({ result: callTool(selected.name, args), error: null, at });
    } catch (err) {
      // Unknown tools and non-object arguments are protocol errors, not tool results.
      setLocal({ result: null, error: (err as Error).message, at });
    }
  };

  const sendRemote = async () => {
    const { args, error } = parsedArgs();
    if (error) return setSent({ at: new Date().toISOString(), outcome: { method: 'tools/call', request: { url: endpoint, headers: {}, body: '' }, status: null, response: null, problem: error, durationMs: 0 } as Sent });
    setSending(true);
    const outcome = await sendMcpRequest(endpoint, 'tools/call', { name: selected.name, arguments: args });
    setSent({ at: new Date().toISOString(), outcome });
    setSending(false);
  };

  const runRemote = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRemoteRunning(true);
    setRemote(null);
    const report = await runRemoteDiagnostic(endpoint, { signal: ctrl.signal });
    setRemote(report);
    setRemoteAt(new Date().toISOString());
    setRemoteRunning(false);
    setAnnouncement(report.passed ? 'Remote check passed.' : `Remote check did not pass. ${report.error || report.steps.at(-1)?.problem || ''}`);
  };

  const exampleArgs = parsedArgs().args ?? examples[selected.name] ?? {};
  const httpRequest = mcpHttpRequest('tools/call', { name: selected.name, arguments: exampleArgs }, 1);
  const exampleUrl = endpoint.trim() || DEFAULT_HOST_ENDPOINT;
  let httpText = '';
  let curl = '';
  try {
    httpText = httpMessageText(exampleUrl, httpRequest);
    curl = curlText(exampleUrl, httpRequest);
  } catch {
    httpText = 'Enter an absolute endpoint URL to see the request.';
  }

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div class="ox-sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      <div style={{ ...panel, padding: '1.5rem', borderRadius: 'var(--ox-radius-lg)' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>
          <strong style={{ color: 'var(--ox-bitcoin-orange)', textTransform: 'uppercase' }}>Agent Bridge</strong> · MCP revision {MCP_PROTOCOL_VERSION} · build <code>{BUILD_REVISION}</code>
        </div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>Ordex MCP server</h1>
        <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.5 }}>
          Ten read-only tools over the Ordex specifications, contracts, conformance vectors, refusal codes and reference verifiers. Run it locally over stdio, or call a docs service over Streamable HTTP.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem', color: 'var(--ox-text-primary)' }}>
          <IconShieldCheck size={18} color="var(--ox-status-success-text)" />
          <span>No tool holds keys, signs, broadcasts or contacts a gateway. Verifier results are local reference checks, not chain state.</span>
        </div>
      </div>

      <section style={panel} aria-labelledby="mcp-install-heading">
        <h2 id="mcp-install-heading" style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>
          1. Build the stdio server
        </h2>
        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ox-text-secondary)', lineHeight: 1.5 }}>
          Needs Node.js {NODE_VERSION} and git. The build writes one self-contained file, <code>{steps.output}</code>, that you can copy anywhere.
          {steps.known ? ' The checkout pins the exact revision this page was built from.' : ' This page does not know its source revision, so build the revision you intend to use.'}
        </p>
        <CodeBlock id="mcp-build" title="Build commands" text={steps.commands.join('\n')} onCopy={copy} />
        <div>
          <label style={label} for="mcp-stdio-path">
            Full path where you saved {STDIO_FILE}
          </label>
          <input id="mcp-stdio-path" style={input} value={stdioPath} onInput={(e) => setStdioPath((e.target as HTMLInputElement).value)} spellcheck={false} autoComplete="off" />
        </div>
        <CodeBlock id="mcp-check-posix" title="Setup check (macOS, Linux, Git Bash)" text={checks.posix} onCopy={copy} />
        <CodeBlock id="mcp-check-ps" title="Setup check (PowerShell)" text={checks.powershell} onCopy={copy} />
        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ox-text-secondary)', lineHeight: 1.5 }}>
          A working install prints one JSON line whose <code>supportedVersions</code> is <code>["{MCP_PROTOCOL_VERSION}"]</code> and whose server version is the revision you built, then exits.
        </p>
      </section>

      <section style={panel} aria-labelledby="mcp-client-heading">
        <h2 id="mcp-client-heading" style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>
          2. Add it to your client
        </h2>
        <div role="tablist" aria-label="MCP client" style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {CLIENTS.map((c) => (
            <button {...tabProps('mcp-client', c.id, client, setClient, onClientKey)} class={`btn ${client === c.id ? 'btn-primary' : 'btn-secondary'}`} style={{ minHeight: '36px', fontSize: '0.8125rem' }}>
              {c.label}
            </button>
          ))}
        </div>
        <div {...tabPanelProps('mcp-client', client)} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.8125rem', color: 'var(--ox-text-secondary)', lineHeight: 1.5 }}>
            {setup.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {setup.command && <CodeBlock id="mcp-client-cmd" title="Command" text={setup.command} onCopy={copy} />}
          <CodeBlock id="mcp-client-config" title={`Config: ${setup.file}`} text={setup.config} onCopy={copy} />
          {setup.httpCommand && <CodeBlock id="mcp-client-http" title="Command for the HTTP endpoint" text={setup.httpCommand} onCopy={copy} />}
          {setup.check && <CodeBlock id="mcp-client-check" title="Confirm the connection" text={setup.check} onCopy={copy} />}
          <a href={setup.docsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.8125rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            Client documentation <IconExternalLink size={12} />
            <span class="ox-sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </section>

      <section style={panel} aria-labelledby="mcp-remote-heading">
        <h2 id="mcp-remote-heading" style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>
          3. Check an HTTP endpoint
        </h2>
        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ox-text-secondary)', lineHeight: 1.5 }}>
          {DOCS_API_BASE
            ? 'This build is configured with the docs service below. The check sends real requests from this browser.'
            : `This build has no hosted endpoint configured. Enter one, for example a docs service you run with node dist/server/node-host.mjs (${DEFAULT_HOST_ENDPOINT}). The check sends real requests from this browser; the service must allow this page's origin.`}
        </p>
        <div>
          <label style={label} for="mcp-endpoint">
            MCP endpoint URL
          </label>
          <input id="mcp-endpoint" style={input} value={endpoint} placeholder={DEFAULT_HOST_ENDPOINT} onInput={(e) => setEndpoint((e.target as HTMLInputElement).value)} spellcheck={false} autoComplete="off" inputMode="url" />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" class="btn btn-primary" onClick={runRemote} disabled={remoteRunning || !endpoint.trim()}>
            {remoteRunning ? 'Checking...' : 'Run remote check'}
          </button>
          {remoteRunning && (
            <button type="button" class="btn btn-secondary" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          )}
        </div>
        {remote && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={evidence('remote')}>
              Remote evidence: {remote.passed ? 'passed' : 'did not pass'}. Real HTTP requests from this browser to {remote.endpoint} at {remoteAt}.
            </div>
            {remote.error && <p style={{ margin: 0, color: 'var(--ox-status-danger-text)', fontSize: '0.8125rem' }}>{remote.error}</p>}
            {remote.steps.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                <caption class="ox-sr-only">Remote check requests and results</caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: 'left', padding: '0.25rem' }}>Request</th>
                    <th scope="col" style={{ textAlign: 'left', padding: '0.25rem' }}>HTTP</th>
                    <th scope="col" style={{ textAlign: 'left', padding: '0.25rem' }}>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {remote.steps.map((s) => (
                    <tr key={s.method} style={{ borderTop: '1px solid var(--ox-border-subtle)' }}>
                      <td style={{ padding: '0.25rem', fontFamily: 'var(--ox-font-mono)' }}>{s.method}</td>
                      <td style={{ padding: '0.25rem' }}>{s.status ?? 'none'}</td>
                      <td style={{ padding: '0.25rem', color: s.problem ? 'var(--ox-status-danger-text)' : 'var(--ox-status-success-text)' }}>{s.problem ? s.problem : `OK in ${s.durationMs} ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <section style={{ ...panel, padding: 0, overflow: 'hidden' }} aria-labelledby="mcp-tools-heading">
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--ox-border-subtle)', backgroundColor: 'var(--ox-surface-subtle)' }}>
          <h2 id="mcp-tools-heading" style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>
            Tools ({MCP_TOOLS.length})
          </h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 0 }}>
          <div role="group" aria-label="Choose a tool" style={{ padding: '0.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem', borderBottom: '1px solid var(--ox-border-subtle)' }}>
            {MCP_TOOLS.map((t) => (
              <button key={t.name} type="button" aria-pressed={selected.name === t.name ? 'true' : 'false'} class={`btn ${selected.name === t.name ? 'btn-primary' : 'btn-secondary'}`} style={{ minHeight: '32px', fontSize: '0.75rem', fontFamily: 'var(--ox-font-mono)' }} onClick={() => selectTool(t)}>
                {t.name}
              </button>
            ))}
          </div>
          <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem', fontSize: '0.8125rem', minWidth: 0 }}>
            <div>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, fontFamily: 'var(--ox-font-mono)' }}>{selected.name}</h3>
              <p style={{ margin: '0.25rem 0 0', color: 'var(--ox-text-secondary)', lineHeight: 1.5 }}>{selected.description}</p>
            </div>
            <details>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Input and output schemas</summary>
              <pre style={{ ...pre, marginTop: '0.5rem', maxHeight: '240px' }} tabIndex={0}>
                {JSON.stringify({ inputSchema: selected.inputSchema, outputSchema: selected.outputSchema }, null, 2)}
              </pre>
            </details>
            <div>
              <label style={label} for="mcp-tool-args">
                Arguments (JSON)
              </label>
              <textarea id="mcp-tool-args" value={argsText} onInput={(e) => setArgsText((e.target as HTMLTextAreaElement).value)} rows={6} spellcheck={false} style={{ ...input, fontSize: '0.75rem' }} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" class="btn btn-primary" onClick={runLocal}>
                Run locally in this browser
              </button>
              <button type="button" class="btn btn-secondary" onClick={sendRemote} disabled={sending || !endpoint.trim()} title={endpoint.trim() ? undefined : 'Enter an endpoint in step 3 first'}>
                {sending ? 'Sending...' : 'Send to the endpoint'}
              </button>
            </div>
            <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {local && (
                <>
                  <div style={evidence('local')}>
                    Local run at {local.at}: the same engine the stdio server runs (build {BUILD_REVISION}), executed in this browser. No request left this page.
                    {local.result ? (local.result.isError ? ' The tool reported an error.' : ' The tool completed.') : ' The call was refused.'}
                  </div>
                  <pre style={{ ...pre, maxHeight: '320px' }} tabIndex={0} aria-label="Local result">
                    {local.error ? JSON.stringify({ error: local.error }, null, 2) : JSON.stringify(local.result, null, 2)}
                  </pre>
                </>
              )}
              {sent && (
                <>
                  <div style={evidence('remote')}>
                    Remote call at {sent.at} to {sent.outcome.request.url}: {sent.outcome.problem ? sent.outcome.problem : `HTTP ${sent.outcome.status} in ${sent.outcome.durationMs} ms.`}
                  </div>
                  {sent.outcome.response !== null && (
                    <pre style={{ ...pre, maxHeight: '320px' }} tabIndex={0} aria-label="Remote response">
                      {JSON.stringify(sent.outcome.response, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </div>
            <details>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>This call as an HTTP request</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                <p style={{ margin: 0, color: 'var(--ox-text-secondary)', lineHeight: 1.5 }}>
                  Every request carries its protocol version and client capabilities in <code>params._meta</code>, mirrored in the <code>MCP-Protocol-Version</code>, <code>Mcp-Method</code> and <code>Mcp-Name</code> headers. There is no initialize handshake and no session.
                </p>
                <CodeBlock id="mcp-http" title="HTTP request" text={httpText} onCopy={copy} />
                {curl && <CodeBlock id="mcp-curl" title="curl" text={curl} onCopy={copy} />}
              </div>
            </details>
          </div>
        </div>
      </section>
    </div>
  );
}
