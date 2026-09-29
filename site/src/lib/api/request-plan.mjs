// OX-S05: the API Playground's request contract. A request plan is built from the OpenAPI
// 3.1 operation and the user's values, validated before anything is sent, and authorized
// against the shared settings: read-only mode never sends an effect, broadcasts and all
// writes on mainnet are refused, operator routes are refused, and write approval is bound
// to the exact request so any change invalidates it. Responses are checked against the
// documented schema for their status, separately from HTTP success.

import { validateSchema, resolveRef } from './schema.mjs';

export const REQUEST_TIMEOUT_MS = 15000;

const deref = (value, doc) => (value && value.$ref ? resolveRef(value.$ref, doc) : value);

/** Effect class of an operation: read, write, broadcast, or operator. */
export function effectOf(operation, raw = {}) {
  if (Array.isArray(raw.security) && raw.security.some((s) => Object.keys(s).includes('operatorBasic'))) return 'operator';
  if (/broadcast/i.test(operation.operationId) || /\/broadcast$/.test(operation.path)) return 'broadcast';
  return ['GET', 'HEAD'].includes(operation.method) ? 'read' : 'write';
}

/** The credential a route documents: 'developer' for a developer API key (bearer), else null. */
export function credentialOf(raw = {}) {
  return Array.isArray(raw.security) && raw.security.some((s) => Object.keys(s).includes('developerBearer')) ? 'developer' : null;
}

/** The raw contract operation for a generated operation entry. */
export function contractOperation(doc, operation) {
  return doc.paths?.[operation.path]?.[operation.method.toLowerCase()] || null;
}

/** Parameters of an operation with $refs resolved. */
export function operationParameters(doc, operation) {
  const raw = contractOperation(doc, operation);
  const pathLevel = doc.paths?.[operation.path]?.parameters || [];
  return [...pathLevel, ...(raw?.parameters || [])].map((p) => deref(p, doc));
}

function coerce(value, schema, doc) {
  const s = deref(schema, doc) || {};
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.includes('integer') && !types.includes('string')) {
    if (!/^-?\d+$/.test(value)) return { ok: false, error: 'must be a whole number' };
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return { ok: false, error: 'is outside the safe integer range; this parameter is not a decimal string' };
    return { ok: true, value: n };
  }
  if (types.includes('number') && !types.includes('string')) {
    const n = Number(value);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'must be a number' };
  }
  if (types.includes('boolean')) {
    if (value !== 'true' && value !== 'false') return { ok: false, error: 'must be true or false' };
    return { ok: true, value: value === 'true' };
  }
  return { ok: true, value };
}

/** JSON.parse that refuses integers JavaScript cannot hold exactly, so amounts stay exact. */
export function parseExactJson(text) {
  const value = JSON.parse(text);
  // Look at number tokens outside string literals only.
  const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const token of withoutStrings.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || []) {
    const n = Number(token);
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(n)) {
      throw new Error(`The number ${token} cannot be represented exactly. Send amounts as decimal strings.`);
    }
  }
  return value;
}

/**
 * Build and validate a request. values = { path: {}, query: {}, header: {} } of strings.
 * Returns { ok, errors, method, url, headers, body, effect, operationId }.
 */
export function buildRequestPlan({ doc, operation, origin, values = {}, bodyText = '' }) {
  const errors = [];
  const raw = contractOperation(doc, operation);
  if (!raw) return { ok: false, errors: [`Operation ${operation.operationId} is not in the contract`] };
  const effect = effectOf(operation, raw);
  const params = operationParameters(doc, operation);
  let path = operation.path;
  const query = new URLSearchParams();
  const headers = { accept: 'application/json' };
  for (const p of params) {
    const supplied = values[p.in]?.[p.name];
    const text = typeof supplied === 'string' ? supplied : '';
    if (text === '') {
      if (p.required || p.in === 'path') errors.push(`${p.in} parameter ${p.name} is required`);
      continue;
    }
    const c = coerce(text, p.schema, doc);
    if (!c.ok) {
      errors.push(`${p.in} parameter ${p.name} ${c.error}`);
      continue;
    }
    const schemaErrors = validateSchema(c.value, p.schema || {}, doc);
    if (schemaErrors.length) errors.push(`${p.in} parameter ${p.name}: ${schemaErrors[0].message}`);
    if (p.in === 'path') path = path.split(`{${p.name}}`).join(encodeURIComponent(text));
    else if (p.in === 'query') query.append(p.name, text);
    else if (p.in === 'header') {
      if (/^(authorization|cookie|host|origin|content-length)$/i.test(p.name)) errors.push(`header ${p.name} cannot be set here`);
      else headers[p.name.toLowerCase()] = text;
    }
  }
  if (/\{[^}]+\}/.test(path)) errors.push(`The path still has unresolved segments: ${path.match(/\{[^}]+\}/g).join(', ')}`);

  let body = null;
  const bodySpec = deref(raw.requestBody, doc);
  const jsonSchema = bodySpec?.content?.['application/json']?.schema;
  if (bodySpec) {
    if (bodyText.trim() === '') {
      if (bodySpec.required) errors.push('A JSON request body is required');
    } else {
      try {
        const parsed = parseExactJson(bodyText);
        const bodyErrors = jsonSchema ? validateSchema(parsed, jsonSchema, doc) : [];
        for (const e of bodyErrors.slice(0, 8)) errors.push(`body ${e.path}: ${e.message}`);
        body = bodyText;
        headers['content-type'] = 'application/json';
      } catch (err) {
        errors.push(`The request body is not valid JSON: ${err.message}`);
      }
    }
  } else if (bodyText.trim() !== '') {
    errors.push('This operation takes no request body');
  }

  let url = null;
  if (!origin) errors.push('No gateway origin is configured');
  else {
    const qs = query.toString();
    url = `${origin}${path}${qs ? `?${qs}` : ''}`;
  }
  return { ok: errors.length === 0, errors, method: operation.method, url, headers, body, effect, credential: credentialOf(raw), operationId: operation.operationId };
}

/** A stable fingerprint of the exact request, used to bind a write approval to it. */
export function planFingerprint(plan, settings) {
  return JSON.stringify([plan.method, plan.url, plan.body, plan.headers, settings.network, settings.gatewayOrigin]);
}

/**
 * Decide whether a plan may be sent under the settings. `approval` is the fingerprint the
 * user confirmed; any change to the request or context makes it stale.
 */
export function authorizePlan(plan, settings, approval, { developerKey = '' } = {}) {
  // The route and the mode decide first: they refuse whatever the form holds.
  if (plan.effect === 'operator') {
    return { allowed: false, reason: 'Operator routes need operator credentials. Use your operator tooling; the documentation site never handles them.' };
  }
  if (plan.effect !== 'read' && settings.mode !== 'write') {
    return { allowed: false, reason: `Read-only mode never sends a ${plan.effect === 'broadcast' ? 'broadcast' : 'request with an effect'}. Switch to write mode in settings to continue on a test network.` };
  }
  if (!plan.ok) return { allowed: false, reason: plan.errors[0] };
  if (plan.credential === 'developer' && !developerKey.trim()) {
    return { allowed: false, reason: 'This route needs a developer API key with the webhooks:write scope. Enter it above; it stays in this page only and is never saved.' };
  }
  if (plan.effect === 'read') return { allowed: true, reason: null };
  if (settings.network === 'mainnet') {
    return { allowed: false, reason: 'The playground sends effects only to Signet, Testnet4 or Regtest gateways. Use your wallet or the SDK for mainnet actions.' };
  }
  if (approval !== planFingerprint(plan, settings)) {
    return { allowed: false, needsApproval: true, reason: 'Review and confirm this exact request before it is sent.' };
  }
  return { allowed: true, reason: null };
}

function statusSpec(raw, doc, status) {
  const responses = raw?.responses || {};
  const exact = responses[String(status)];
  const range = responses[`${String(status)[0]}XX`];
  return deref(exact || range || responses.default, doc) || null;
}

/**
 * Check an actual response against the contract. HTTP success and schema conformance are
 * reported separately; a 200 with a body the schema rejects is not a pass.
 */
export function validateResponse({ doc, operation, status, contentType, bodyText }) {
  const raw = contractOperation(doc, operation);
  const spec = statusSpec(raw, doc, status);
  const http = { status, ok: status >= 200 && status < 300 };
  if (!spec) return { http, schema: { state: 'undocumented', errors: [`The contract documents no ${status} response for this operation`] }, body: bodyText };
  const media = (contentType || '').split(';')[0].trim().toLowerCase();
  const content = spec.content || {};
  if (Object.keys(content).length === 0) {
    return { http, schema: bodyText ? { state: 'invalid', errors: ['The contract documents no body for this status'] } : { state: 'valid', errors: [] }, body: bodyText };
  }
  if (!content[media]) return { http, schema: { state: 'invalid', errors: [`Media type ${media || 'none'} is not documented; expected ${Object.keys(content).join(', ')}`] }, body: bodyText };
  if (media !== 'application/json') return { http, schema: { state: 'not-validated', errors: [`${media} bodies are shown as received`] }, body: bodyText };
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    return { http, schema: { state: 'invalid', errors: [`The body is not valid JSON: ${err.message}`] }, body: bodyText };
  }
  const errors = validateSchema(parsed, content[media].schema || {}, doc);
  return { http, schema: { state: errors.length ? 'invalid' : 'valid', errors: errors.slice(0, 20) }, body: parsed };
}

/** POSIX shell single-quote escaping: close, escaped quote, reopen. Newlines are kept exactly. */
export function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** A cURL command reproducing the plan byte for byte. Credentials are never included. */
export function curlFor(plan) {
  const parts = [`curl -X ${plan.method} ${shellQuote(plan.url || '')}`];
  for (const [k, v] of Object.entries(plan.headers || {})) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (plan.body !== null && plan.body !== undefined) parts.push(`--data-binary ${shellQuote(plan.body)}`);
  if (plan.effect === 'operator') parts.push('-u "$ORDEX_OPERATOR_USER:$ORDEX_OPERATOR_PASSWORD"');
  if (plan.credential === 'developer') parts.push('-H "authorization: Bearer $ORDEX_DEVELOPER_KEY"');
  return parts.join(' \\\n  ');
}

export const STREAM_SAMPLE_MS = 3000;
export const STREAM_SAMPLE_BYTES = 16384;

/**
 * An event stream never ends on its own, so a request shows what arrived in the first
 * STREAM_SAMPLE_MS (at most STREAM_SAMPLE_BYTES) and then closes the connection. The Event
 * Playground is the tool that consumes a stream.
 */
async function streamSample(body) {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + STREAM_SAMPLE_MS;
  let text = '';
  try {
    while (text.length < STREAM_SAMPLE_BYTES) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const next = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), left))]);
      if (next.timeout || next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text.slice(0, STREAM_SAMPLE_BYTES);
}

/**
 * Send a plan with a timeout and caller cancellation. Resolves with the validated response
 * or a typed failure; the caller suppresses results of superseded requests.
 */
export async function executePlan({ doc, operation, plan, fetchImpl = fetch, signal, timeoutMs = REQUEST_TIMEOUT_MS, developerKey = '' }) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const started = Date.now();
  let response;
  try {
    // The key joins the request only here, so plans, fingerprints and cURL never carry it.
    const headers = plan.credential === 'developer' ? { ...plan.headers, authorization: `Bearer ${developerKey.trim()}` } : plan.headers;
    response = await fetchImpl(plan.url, { method: plan.method, headers, body: plan.body ?? undefined, signal: AbortSignal.any(signals), credentials: 'omit', redirect: 'error' });
  } catch (err) {
    const name = err?.name;
    const code = signal?.aborted ? 'CANCELLED' : name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
    return {
      ok: false,
      code,
      message: code === 'NETWORK_ERROR' ? `The gateway could not be reached, or it does not allow this site's origin (CORS): ${err?.message || err}` : code === 'TIMEOUT' ? `No response within ${timeoutMs} ms` : 'Cancelled',
      durationMs: Date.now() - started
    };
  }
  const bodyText = /^text\/event-stream\b/i.test(response.headers.get('content-type') || '') ? await streamSample(response.body) : await response.text();
  const headers = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const result = validateResponse({ doc, operation, status: response.status, contentType: response.headers.get('content-type'), bodyText });
  return { ok: true, status: response.status, statusText: response.statusText, headers, durationMs: Date.now() - started, ...result };
}
