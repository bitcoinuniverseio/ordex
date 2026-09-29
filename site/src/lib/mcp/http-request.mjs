// OX-S04 / OX-P07: requests for the MCP 2026-07-28 Streamable HTTP transport, built one way
// for the Agent Bridge examples, its remote diagnostic and the integration tests. Every
// request carries the per-request _meta and mirrors it in MCP-Protocol-Version, Mcp-Method
// and, for tools/call, resources/read and prompts/get, Mcp-Name.

export const MCP_HTTP_VERSION = '2026-07-28';
const NAME_FIELDS = { 'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name' };
const HEADER_SAFE = /^[\x20-\x7e]*$/;

/** Mcp-Name value: plain when it is printable ASCII, otherwise the Base64 sentinel form. */
export function encodeHeaderValue(value) {
  if (HEADER_SAFE.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?base64?${btoa(bin)}?=`;
}

/** { headers, body } for one JSON-RPC request. */
export function mcpHttpRequest(method, params = {}, id = 1, clientInfo = { name: 'ordex-agent-bridge', version: '1' }) {
  const message = {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_HTTP_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': clientInfo
      }
    }
  };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_HTTP_VERSION,
    'Mcp-Method': method
  };
  const field = NAME_FIELDS[method];
  if (field) headers['Mcp-Name'] = encodeHeaderValue(String(params[field]));
  return { headers, body: JSON.stringify(message) };
}

/** The request as an HTTP message, for display. */
export function httpMessageText(url, { headers, body }) {
  const u = new URL(url);
  const lines = [`POST ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', JSON.stringify(JSON.parse(body), null, 2)];
  return lines.join('\n');
}

/** The request as a curl command, POSIX shell quoting. */
export function curlText(url, { headers, body }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return ['curl -sS -X POST', q(url), ...Object.entries(headers).map(([k, v]) => `-H ${q(`${k}: ${v}`)}`), `--data ${q(body)}`].join(' \\\n  ');
}

/** A parsed endpoint URL, or an error message. */
export function parseEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint).trim());
  } catch {
    return { url: null, error: 'Enter an absolute http or https URL for the MCP endpoint.' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { url: null, error: 'The endpoint must use http or https.' };
  return { url, error: null };
}

/**
 * Send one JSON-RPC request to `endpoint` over HTTP. Returns the request, the HTTP status,
 * the parsed body and a problem string (null when the server answered 200 with a result).
 */
export async function sendMcpRequest(endpoint, method, params = {}, { id = 1, fetchImpl = fetch, timeoutMs = 10000, signal } = {}) {
  const { url, error } = parseEndpoint(endpoint);
  const request = mcpHttpRequest(method, params, id);
  const out = { method, request: { url: url?.href ?? String(endpoint), ...request }, status: null, response: null, problem: error, durationMs: 0 };
  if (error) return out;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetchImpl(url.href, { method: 'POST', headers: request.headers, body: request.body, signal: ctrl.signal });
    out.status = res.status;
    const text = await res.text();
    try {
      out.response = text ? JSON.parse(text) : null;
    } catch {
      out.response = text.slice(0, 2000);
    }
    const errorText = typeof out.response?.error === 'string' ? out.response.error : out.response?.error?.message;
    if (res.status !== 200) out.problem = `HTTP ${res.status}${errorText ? `: ${errorText}` : ''}`;
    else if (out.response?.error) out.problem = `JSON-RPC error ${out.response.error.code}: ${out.response.error.message}`;
    else if (!out.response || typeof out.response !== 'object' || !('result' in out.response)) out.problem = 'The response is not a JSON-RPC result.';
  } catch (err) {
    out.problem = signal?.aborted
      ? 'Cancelled.'
      : ctrl.signal.aborted
        ? `No response within ${timeoutMs / 1000} s.`
        : `The request failed before a response: ${err?.message || err}. The endpoint may be down, or it does not allow this page's origin.`;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    out.durationMs = Date.now() - started;
  }
  return out;
}

/**
 * Remote transport diagnostic: server/discover, tools/list, then one tools/call, each a real
 * request to `endpoint`. Returns every request and response; `passed` is true only when all
 * three returned the expected modern results.
 */
export async function runRemoteDiagnostic(endpoint, options = {}) {
  const { url, error } = parseEndpoint(endpoint);
  if (error) return { endpoint, passed: false, steps: [], error };
  const plan = [
    ['server/discover', {}, (r) => (Array.isArray(r?.supportedVersions) && r.supportedVersions.includes(MCP_HTTP_VERSION) ? null : `supportedVersions does not include ${MCP_HTTP_VERSION}`)],
    ['tools/list', {}, (r) => (Array.isArray(r?.tools) && r.tools.length > 0 ? null : 'no tools were listed')],
    ['tools/call', { name: 'ordex.explain_refusal', arguments: { code: 'SELLER_VALUE_MISMATCH' } }, (r) => (r?.isError === false && r?.structuredContent?.rule?.exactCodes?.includes('SELLER_VALUE_MISMATCH') ? null : 'the tool did not return the documented rule')]
  ];
  const steps = [];
  for (let i = 0; i < plan.length; i++) {
    const [method, params, check] = plan[i];
    const step = await sendMcpRequest(url.href, method, params, { ...options, id: i + 1 });
    if (!step.problem) step.problem = check(step.response.result);
    steps.push(step);
    if (step.problem) break;
  }
  return { endpoint: url.href, passed: steps.length === plan.length && steps.every((s) => !s.problem), steps, error: null };
}
