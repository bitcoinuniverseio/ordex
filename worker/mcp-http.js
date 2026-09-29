// OX-P07: MCP 2026-07-28 Streamable HTTP transport for the shared engine
// (site/src/lib/mcp/server.ts). POST only; Origin validated; MCP-Protocol-Version, Mcp-Method
// and (for tools/call, resources/read, prompts/get) Mcp-Name are required and must match the
// body, with Base64 sentinel values decoded first. Status codes follow the transport page:
// 400 for header mismatch (-32020), unsupported version (-32022) and malformed requests,
// 404 for unknown methods (-32601), 202 with no body for accepted notifications.

import { dispatchMessage, checkRequestMeta, JSONRPC, McpError } from '../site/src/lib/mcp/server.ts';
import { checkOrigin, json, readBody } from './http.js';

const MAX_MCP_BODY = 1024 * 1024;
const NAME_METHODS = { 'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name' };
const HEADER_SAFE = /^[\x20-\x7e]*$/;

/** Decode an Mcp-Name or Mcp-Param value: plain ASCII, or the =?base64?...?= sentinel. */
export function decodeHeaderValue(value) {
  if (value === null) return null;
  if (!HEADER_SAFE.test(value)) return undefined;
  const m = value.match(/^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/);
  if (!m) return value;
  try {
    const bin = atob(m[1]);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

export async function handleMcpHttp(request, env) {
  const { ok: originOk, origin } = checkOrigin(request, env);
  if (!originOk) return json({ jsonrpc: '2.0', error: { code: JSONRPC.INVALID_REQUEST, message: 'Origin not allowed' } }, 403, null);
  const cors = origin;
  if (request.method !== 'POST') return json(rpcError(null, JSONRPC.INVALID_REQUEST, 'The MCP endpoint accepts POST only'), 405, cors, { Allow: 'POST' });
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') return json(rpcError(null, JSONRPC.INVALID_REQUEST, 'Content-Type must be application/json'), 415, cors);
  const accept = request.headers.get('Accept');
  if (accept && !/application\/json|\*\/\*/.test(accept)) return json(rpcError(null, JSONRPC.INVALID_REQUEST, 'Accept must allow application/json'), 406, cors);

  const text = await readBody(request, MAX_MCP_BODY);
  if (text === null) return json(rpcError(null, JSONRPC.INVALID_REQUEST, `The body exceeds ${MAX_MCP_BODY} bytes`), 413, cors);
  let message;
  try {
    message = JSON.parse(text);
  } catch (err) {
    return json(rpcError(null, JSONRPC.PARSE_ERROR, `Parse error: ${err.message}`), 400, cors);
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return json(rpcError(null, JSONRPC.INVALID_REQUEST, 'The body must be a single JSON-RPC request or notification'), 400, cors);
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = typeof message.id === 'string' || (typeof message.id === 'number' && Number.isInteger(message.id)) ? message.id : null;
  if (!hasId) {
    // A notification: nothing in this revision needs processing, so accept it without a body.
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return json(rpcError(null, JSONRPC.INVALID_REQUEST, 'Invalid notification'), 400, cors);
    return json(null, 202, cors);
  }

  // Request metadata headers must be present and agree with the body.
  const headerVersion = request.headers.get('MCP-Protocol-Version');
  const headerMethod = request.headers.get('Mcp-Method');
  if (headerVersion === null) return json(rpcError(id, JSONRPC.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version is required'), 400, cors);
  if (headerMethod === null) return json(rpcError(id, JSONRPC.HEADER_MISMATCH, 'Header mismatch: Mcp-Method is required'), 400, cors);
  if (!HEADER_SAFE.test(headerVersion) || !HEADER_SAFE.test(headerMethod)) return json(rpcError(id, JSONRPC.HEADER_MISMATCH, 'Header mismatch: a header value has invalid characters'), 400, cors);
  if (headerMethod !== message.method) return json(rpcError(id, JSONRPC.HEADER_MISMATCH, `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body value '${String(message.method)}'`), 400, cors);
  const nameField = NAME_METHODS[message.method];
  if (nameField) {
    const raw = request.headers.get('Mcp-Name');
    if (raw === null) return json(rpcError(id, JSONRPC.HEADER_MISMATCH, 'Header mismatch: Mcp-Name is required for this method'), 400, cors);
    const decoded = decodeHeaderValue(raw);
    if (decoded === undefined) return json(rpcError(id, JSONRPC.HEADER_MISMATCH, 'Header mismatch: Mcp-Name has invalid characters or encoding'), 400, cors);
    const bodyValue = message.params?.[nameField];
    if (decoded !== bodyValue) return json(rpcError(id, JSONRPC.HEADER_MISMATCH, `Header mismatch: Mcp-Name header value does not match body ${nameField}`), 400, cors);
  }
  const bodyVersion = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if (typeof bodyVersion === 'string' && bodyVersion !== headerVersion) {
    return json(rpcError(id, JSONRPC.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${bodyVersion}'`), 400, cors);
  }
  if (message.method !== 'initialize') {
    try {
      checkRequestMeta(message.params);
    } catch (err) {
      if (err instanceof McpError) return json(rpcError(id, err.code, err.message, err.data), 400, cors);
      throw err;
    }
  }

  const response = dispatchMessage(message);
  if (!response) return json(null, 202, cors);
  const code = response.error?.code;
  const status = code === JSONRPC.METHOD_NOT_FOUND ? 404 : code === JSONRPC.INVALID_REQUEST || code === JSONRPC.PARSE_ERROR ? 400 : 200;
  return json(response, status, cors);
}
