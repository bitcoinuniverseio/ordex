// Ordex documentation service: a standard fetch handler (Workers-compatible) served on
// Universe infrastructure by worker/node-host.mjs.
//   GET  /api/docs/health     service, storage and build identity
//   POST /api/docs/ask        extractive answers with citations (OX-P08)
//   POST /api/docs/feedback   idempotent feedback with a stored receipt (OX-P08)
//   POST /api/docs/events     consented, enumerated telemetry (OX-P08)
//   GET  /api/docs/insights   aggregate counts only (OX-P08)
//   POST /mcp                 MCP 2026-07-28 Streamable HTTP (OX-P07)
// env: DB (D1-compatible binding), ORDEX_ALLOWED_ORIGINS, ORDEX_BUILD_REVISION, ORDEX_SITE_BASE.

import { BUILD_REVISION } from '../site/src/lib/mcp/server.ts';
import { handleMcpHttp } from './mcp-http.js';
import { handleAsk, handleFeedback, handleEvent, handleInsights, handleHealth } from './docs-api.js';
import { checkOrigin, json, preflight } from './http.js';

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const revision = env.ORDEX_BUILD_REVISION || BUILD_REVISION;

    if (url.pathname === '/mcp') return request.method === 'OPTIONS' ? preflight(request, env) : handleMcpHttp(request, env);

    if (url.pathname.startsWith('/api/docs/')) {
      if (request.method === 'OPTIONS') return preflight(request, env);
      const { ok, origin } = checkOrigin(request, env);
      if (!ok) return json({ ok: false, code: 'ORIGIN_NOT_ALLOWED', error: 'This origin may not call the docs service.' }, 403, null);
      const route = `${request.method} ${url.pathname}`;
      if (request.method === 'POST' && (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'Send application/json.' }, 415, origin);
      }
      if (route === 'GET /api/docs/health') return handleHealth(env, origin, revision);
      if (route === 'POST /api/docs/ask') return handleAsk(request, env, origin);
      if (route === 'POST /api/docs/feedback') return handleFeedback(request, env, origin);
      if (route === 'POST /api/docs/events') return handleEvent(request, env, origin);
      if (route === 'GET /api/docs/insights') return handleInsights(request, env, origin);
      return json({ ok: false, code: 'NOT_FOUND', error: `No docs route ${route}.` }, 404, origin);
    }

    // Static assets when the runtime provides them (a Workers deployment); the Node host
    // serves only the API, since the site itself is published separately.
    if (env.ASSETS) {
      const u = new URL(request.url);
      if (!u.pathname.includes('.')) u.pathname = u.pathname.endsWith('/') ? `${u.pathname}index.html` : `${u.pathname}/index.html`;
      return env.ASSETS.fetch(new Request(u.toString(), request));
    }
    return new Response('Not found', { status: 404 });
  }
};
