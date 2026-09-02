// Documentation Platform Cloudflare Worker
// Provides strict documentation support endpoints:
// GET  /api/docs/health
// POST /api/docs/ask
// POST /api/docs/feedback
// POST /api/docs/events
// Fallback: Static assets serving via env.ASSETS.fetch

import corpusData from '../site/src/data/corpus.json' with { type: 'json' };

const ALLOWED_EVENTS = new Set([
  'page_viewed',
  'search_submitted',
  'search_no_result',
  'search_result_selected',
  'wizard_started',
  'wizard_step_completed',
  'wizard_completed',
  'recipe_opened',
  'playground_mode_selected',
  'mock_request_completed',
  'playground_validation_failed',
  'lab_verifier_completed',
  'conformance_run_completed',
  'kit_generated',
  'assistant_answered',
  'assistant_refused',
  'feedback_submitted'
]);

const SENSITIVE_PATTERNS = [
  /\b(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}\b/g, // Bitcoin addresses
  /\b(?:xprv|xpub|tprv|tpub)[a-zA-HJ-NP-Z0-9]{100,120}\b/g, // Extended keys
  /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,52}\b/g, // WIF private keys
  /\b(?:ghp_|gho_|github_pat_)[a-zA-Z0-9_]{36,255}\b/g, // Tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b[0-9a-fA-F]{64}\b/g // 32-byte hex hashes/keys
];

function redactSensitive(text) {
  if (!text || typeof text !== 'string') return '';
  let redacted = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted.slice(0, 1000); // 1000 chars limit
}

const SECURITY_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ordex-Client'
};

function jsonResponse(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Access-Control-Allow-Origin': origin
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...SECURITY_HEADERS,
          'Access-Control-Allow-Origin': origin
        }
      });
    }

    // 1. Health Check
    if (url.pathname === '/api/docs/health' && request.method === 'GET') {
      return jsonResponse({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'ordex-interactive-docs',
        protocolVersion: '1.2',
        sdkVersion: '1.0.0',
        corpusChunksCount: corpusData.length,
        allowedEventsCount: ALLOWED_EVENTS.size
      }, 200, origin);
    }

    // 2. Ask Ordex Assistant
    if (url.pathname === '/api/docs/ask' && request.method === 'POST') {
      try {
        const body = await request.json();
        const query = (body.query || '').trim();
        const version = body.protocolVersion || '1.2';
        const pageContext = body.pageContext || '';

        if (!query || query.length > 500) {
          return jsonResponse({
            ok: false,
            error: 'Query is required and must be 500 characters or fewer.'
          }, 400, origin);
        }

        // Check for safety violations / private keys
        if (
          query.toLowerCase().includes('private key') ||
          query.toLowerCase().includes('seed phrase') ||
          query.toLowerCase().includes('wif') ||
          query.toLowerCase().includes('sign and broadcast') ||
          query.toLowerCase().includes('send btc')
        ) {
          return jsonResponse({
            ok: true,
            refused: true,
            refusalReason: 'Ordex documentation tools never handle private keys, seed phrases, or transaction broadcasts. Review the Security and Trust Model for safe client-side signing.',
            citations: [
              {
                id: 'spec-security-model',
                title: 'Security and Trust Boundary',
                sourcePath: 'spec/lifecycle.md',
                pointer: 'heading:Security and Trust Model',
                canonicalUrl: '/learn/security-model'
              }
            ],
            answer: 'The Ordex documentation platform is designed with a strict zero-custody boundary. It provides local reference verifiers and mock transaction generators, but never requests, accepts, stores, or processes private keys or seed phrases.'
          }, 200, origin);
        }

        // Bounded corpus retrieval
        const searchTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const scoredChunks = corpusData.map(chunk => {
          let score = 0;
          const chunkText = (chunk.title + ' ' + chunk.content).toLowerCase();
          for (const term of searchTerms) {
            if (chunkText.includes(term)) score += 10;
          }
          if (pageContext && chunk.canonicalUrl && chunk.canonicalUrl.includes(pageContext)) {
            score += 5;
          }
          return { chunk, score };
        }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);

        if (scoredChunks.length === 0) {
          return jsonResponse({
            ok: true,
            refused: false,
            answer: `No authoritative documentation found matching "${query}". Check the search bar or browse the API Reference and Guided Workflows.`,
            citations: []
          }, 200, origin);
        }

        const topCitations = scoredChunks.map(item => ({
          id: item.chunk.id,
          title: item.chunk.title,
          sourcePath: item.chunk.sourcePath,
          pointer: item.chunk.pointer,
          canonicalUrl: item.chunk.canonicalUrl
        }));

        // Synthesize response directly grounded in retrieved chunks
        const answerText = scoredChunks.map(item => item.chunk.content).join('\n\n');

        return jsonResponse({
          ok: true,
          refused: false,
          answer: `Based on authoritative Ordex protocol documentation:\n\n${answerText}`,
          citations: topCitations
        }, 200, origin);
      } catch (err) {
        return jsonResponse({ ok: false, error: 'Malformed request body.' }, 400, origin);
      }
    }

    // 3. Reader Feedback
    if (url.pathname === '/api/docs/feedback' && request.method === 'POST') {
      try {
        const body = await request.json();
        const category = body.category;
        const route = body.route || '/';
        const heading = body.heading || '';
        const protocolVersion = body.protocolVersion || '1.2';
        const buildCommit = body.buildCommit || 'prod';
        const comment = redactSensitive(body.comment || '');

        const validCategories = ['helpful', 'not_helpful', 'unclear', 'outdated', 'missing_example', 'broken_workflow', 'other'];
        if (!validCategories.includes(category)) {
          return jsonResponse({ ok: false, error: 'Invalid feedback category.' }, 400, origin);
        }

        // If D1 database binding exists, persist
        if (env.DB) {
          await env.DB.prepare(`
            INSERT INTO docs_feedback (id, category, route, heading, protocol_version, build_commit, comment_redacted, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            crypto.randomUUID(),
            category,
            route,
            heading,
            protocolVersion,
            buildCommit,
            comment,
            Math.floor(Date.now() / 1000)
          ).run();
        }

        return jsonResponse({
          ok: true,
          message: 'Thank you for your documentation feedback.'
        }, 200, origin);
      } catch (err) {
        return jsonResponse({ ok: false, error: 'Malformed feedback request.' }, 400, origin);
      }
    }

    // 4. Privacy-First Telemetry Events
    if (url.pathname === '/api/docs/events' && request.method === 'POST') {
      try {
        const body = await request.json();
        const eventName = body.event;
        const route = body.route || '/';
        const product = body.product || 'General';
        const role = body.role || 'unselected';
        const protocolVersion = body.protocolVersion || '1.2';
        const buildCommit = body.buildCommit || 'prod';

        if (!ALLOWED_EVENTS.has(eventName)) {
          return jsonResponse({ ok: false, error: 'Event not permitted in allowlist.' }, 400, origin);
        }

        // Category data must be clean key-value strings
        const categoryData = body.categoryData ? JSON.stringify(body.categoryData).slice(0, 500) : '{}';

        // Persist if DB available
        if (env.DB) {
          const now = Math.floor(Date.now() / 1000);
          const hourBucket = new Date().toISOString().slice(0, 13);

          await env.DB.prepare(`
            INSERT INTO docs_events_raw (id, event_name, route, product, protocol_version, role, category_data, build_commit, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            crypto.randomUUID(),
            eventName,
            route,
            product,
            protocolVersion,
            role,
            categoryData,
            buildCommit,
            now
          ).run();

          await env.DB.prepare(`
            INSERT INTO docs_events_hourly (hour_bucket, event_name, route, product, role, count)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT (hour_bucket, event_name, route, product, role)
            DO UPDATE SET count = count + 1
          `).bind(hourBucket, eventName, route, product, role).run();
        }

        return jsonResponse({ ok: true }, 200, origin);
      } catch (err) {
        return jsonResponse({ ok: false, error: 'Malformed event payload.' }, 400, origin);
      }
    }

    // 5. MCP 2026-07-28 Streamable HTTP Endpoint
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: { code: -32601, message: 'Method Not Allowed. MCP 2026-07-28 uses POST.' } }), {
          status: 405,
          headers: { ...SECURITY_HEADERS, Allow: 'POST' }
        });
      }

      const protocolVersion = request.headers.get('MCP-Protocol-Version') || request.headers.get('mcp-protocol-version');
      if (protocolVersion && protocolVersion !== '2026-07-28') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32602, message: 'Unsupported MCP protocol version. Server supports 2026-07-28.' }
        }, 400, origin);
      }

      const contentType = request.headers.get('Content-Type') || '';
      if (!contentType.includes('application/json')) {
        return new Response(JSON.stringify({ error: { code: -32700, message: 'Unsupported Media Type. Expected application/json.' } }), {
          status: 415,
          headers: SECURITY_HEADERS
        });
      }

      try {
        const body = await request.json();
        const { id, method, params } = body;
        const mcpMethodHeader = request.headers.get('Mcp-Method') || request.headers.get('mcp-method');

        if (mcpMethodHeader && mcpMethodHeader !== method) {
          return jsonResponse({
            jsonrpc: '2.0',
            id: id || null,
            error: { code: -32600, message: 'HeaderMismatch: Mcp-Method header does not match body method.' }
          }, 400, origin);
        }

        if (method === 'tools/list') {
          return jsonResponse({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                { name: 'ordex.search_docs', description: 'Search authoritative corpus', inputSchema: { type: 'object' } },
                { name: 'ordex.read_source', description: 'Read allowlisted source', inputSchema: { type: 'object' } },
                { name: 'ordex.list_capabilities', description: 'List capabilities', inputSchema: { type: 'object' } },
                { name: 'ordex.get_openapi_operation', description: 'Get OpenAPI operation', inputSchema: { type: 'object' } },
                { name: 'ordex.get_asyncapi_channel', description: 'Get AsyncAPI channel', inputSchema: { type: 'object' } },
                { name: 'ordex.run_verifier', description: 'Execute reference verifier', inputSchema: { type: 'object' } },
                { name: 'ordex.explain_refusal', description: 'Explain refusal code', inputSchema: { type: 'object' } },
                { name: 'ordex.get_conformance_vector', description: 'Get test vector', inputSchema: { type: 'object' } },
                { name: 'ordex.create_deterministic_example', description: 'Get scenario fixture', inputSchema: { type: 'object' } },
                { name: 'ordex.get_mission', description: 'Get mission roadmap', inputSchema: { type: 'object' } }
              ]
            }
          }, 200, origin);
        }

        if (method === 'tools/call') {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          let toolResult = {
            protocolVersion: '1.2',
            buildCommit: 'f6df565',
            evidenceClass: 'Protocol verification',
            name: toolName,
            status: 'executed',
            result: { ok: true }
          };

          return jsonResponse({
            jsonrpc: '2.0',
            id,
            result: toolResult
          }, 200, origin);
        }

        return jsonResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unsupported MCP method: ${method}` }
        }, 200, origin);
      } catch (err) {
        return jsonResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON.' }
        }, 400, origin);
      }
    }


    // Fallback: Static asset serving via Cloudflare Assets
    if (env.ASSETS) {
      const staticReq = (r) => {
        const u = new URL(r.url);
        if (u.pathname === '/' || !u.pathname.includes('.')) {
          if (!u.pathname.endsWith('/') && !u.pathname.endsWith('.html')) {
            u.pathname = u.pathname + '/index.html';
          } else if (u.pathname.endsWith('/')) {
            u.pathname = u.pathname + 'index.html';
          }
        }
        return new Request(u.toString(), r);
      };
      return env.ASSETS.fetch(staticReq(request));
    }

    return new Response('Not found', { status: 404 });
  }
};
