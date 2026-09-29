// Shared HTTP helpers for the docs service: a strict Origin allowlist and JSON responses.
// OX-P08 / OX-P07: an Origin that is present and not allowed is refused with 403 (the MCP
// 2026-07-28 transport requires it against DNS rebinding); requests without an Origin
// (servers, command line MCP clients) are served without CORS headers.

export const DEFAULT_ALLOWED_ORIGINS = ['https://bitcoinuniverseio.github.io', 'http://localhost:4321', 'http://127.0.0.1:4321'];
export const MAX_BODY_BYTES = 64 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

export function allowedOrigins(env) {
  const raw = env?.ORDEX_ALLOWED_ORIGINS;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_ALLOWED_ORIGINS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** { ok, origin }: ok is false only when an Origin header is present and not allowed. */
export function checkOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (origin === null) return { ok: true, origin: null };
  return { ok: allowedOrigins(env).includes(origin), origin };
}

export function corsHeaders(origin) {
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

export function json(body, status, origin, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...corsHeaders(origin), ...extra }
  });
}

export function preflight(request, env) {
  const { ok, origin } = checkOrigin(request, env);
  if (!ok || !origin) return new Response(null, { status: 403, headers: SECURITY_HEADERS });
  return new Response(null, {
    status: 204,
    headers: {
      ...SECURITY_HEADERS,
      ...corsHeaders(origin),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
      'Access-Control-Max-Age': '600'
    }
  });
}

/** Read a bounded body as text; null when it is larger than the bound. */
export async function readBody(request, max = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > max ? null : text;
}
