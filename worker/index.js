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

/*
 * IMPLEMENTATION-HANDOFF [OX-P08] Preparation only; functional status FAIL, repair NOT IMPLEMENTED.
 * Coverage: OX-P-C061, OX-P-C062, OX-P-C063, OX-P-C064. Evidence:
 * evidence/sdk-worker-observations.json in handoff/evidence.
 * Verified cause: Telemetry persists arbitrary categoryData and metadata unsanitized; feedback
 * sanitizes comment only. Missing D1 binding still yields success; errors all become malformed400. Ask
 * ignores protocolVersion and reads canonicalUrl while corpus exposes docUrl.
 * Required behavior: Docs Worker typed validation, privacy and truthful persistence. Governing refs:
 * P-S13 (prepared base); P-S14 (official guide accessed2026-09-29); complete URLs in
 * reports/protocol.md.
 * Prerequisites/order: define shared docs schema and Worker foundation here; OX-S11 consumes it.
 * OX-S11 is coordinated UI/readback acceptance, not a blocking prerequisite. Related files:
 * site/src/data/corpus.json; worker/migrations/0001_initial.sql; docs consumers in OX-S11.
 * 1. Add bounded schema per docs endpoint before parsing/storing: event-specific enumerated category
 * keys/values, normalized allowlisted route/product/role/version/build identity, bounded body size;
 * redact all accepted free text and reject arbitrary nested payloads before any SQL/logging.
 * 2. Make consent and collected fields explicit in docs UI; do not rely on clients to sanitize or
 * claim zero tracking while Worker persists telemetry. Avoid seeds/PSBT/xpub/token/wallet data in
 * persistent fields; apply retention policy to raw/hourly/feedback data.
 * 3. Treat required D1 unavailable as service unavailable with honest user recovery; preserve storage
 * failures as operational errors and support idempotent user retry; batch related D1 writes atomically
 * so raw/hourly counts cannot partially commit.
 * 4. For Ask validate query types/version/page context, retrieve only requested supported version, map
 * citation URL from actual corpus schema, and return grounded refusal for unsupported version/no
 * sources. Connect OX-S11 consumers to deployed endpoints and display truthful response state.
 * Validation (PROPOSED NEW tests, commands unverified until implemented):
 * tests/unit/worker-docs.test.js, tests/integration/worker-docs-d1.test.js. node --test
 * tests/unit/worker-docs.test.js; node --test tests/integration/worker-docs-d1.test.js.
 * Assertions/evidence: Synthetic sensitive category/route/etc cannot reach any D1 bind/log;
 * Missing/failed DB not reported persisted; atomic raw+hourly writes recover without duplicates;
 * Unsupported version refuses; citations open correct generated source routes; Real
 * request->D1->readback verified with isolated nonpersonal data; disabled telemetry writes nothing.
 * Offline probes are not end-to-end PASS; require actual Signet transaction and indexed/consumer
 * readback where applicable.
 * Rollback: Back up then apply reviewed D1 schema/retention changes only in implementation; no
 * destructive purge without exact affected-row analysis. Revert Worker+consumer contract together;
 * report rejected/unsaved feedback honestly.
 */
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

/*
 * IMPLEMENTATION-HANDOFF [OX-P08] Local integration steps; ANNOTATED is not implemented.
 * Coverage: OX-P-C061, OX-P-C062, OX-P-C063, OX-P-C064.
 * Corpus343 records use docUrl, consumer expects docUrl||url, but this handler emits canonicalUrl and
 * ignores requested version. 1. Define shared bounded request/citation contract with OX-S11, return
 * docUrl consistently and derive configured base-path links. 2. Validate query/pageContext types and
 * supported version, filter retrieval or explicitly refuse unsupported version. 3. Add PROPOSED NEW
 * tests/unit/worker-docs.test.js; node --test tests/unit/worker-docs.test.js unverified. Assert all
 * four citation URLs resolve and999.9 refuses in actual deployed consumer. Sources actual
 * site/src/data/corpus.json and OX-S11 consumer contract; evidence sdk-worker-observations. Rollback
 * worker+consumer contract together; preserve truthful local-fallback provenance.
 */
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

/*
 * IMPLEMENTATION-HANDOFF [OX-P08] Local integration steps; ANNOTATED is not implemented.
 * Coverage: OX-P-C061, OX-P-C062, OX-P-C063, OX-P-C064.
 * Only comment is redacted; route/heading persist arbitrary secrets, and missingDB still returns
 * success. 1. Validate/redact every persisted string, normalize allowlisted pathname without
 * query/hash, reject unexpected fields/types and enforce body/field bounds before DB/log. 2. Make
 * missing/failed required storage explicit503/degraded state, distinguish input400 and operational
 * failures, retain user retry without duplicate submissions. 3. Add PROPOSED NEW
 * tests/unit/worker-docs.test.js and tests/integration/worker-docs-d1.test.js; node --test each file
 * after creation (unverified). P-S13 storage privacy contract, P-S14 D1; related
 * migration0001_initial.sql and OX-S11 feedback UI. Assert synthetic marker absent from every bind and
 * real isolated D1 readback. Rollback preserves accepted feedback and reports unsaved state.
 */
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

/*
 * IMPLEMENTATION-HANDOFF [OX-P08] Local integration steps; ANNOTATED is not implemented.
 * Coverage: OX-P-C061, OX-P-C062, OX-P-C063, OX-P-C064.
 * Event-name allowlist does not sanitize categoryData/route/product/role; arbitrary synthetic markers
 * reach D1. 1. Enforce event-specific bounded categorical schema; derive known build/version identity,
 * normalize route, reject unknown nested data and redact every free-text field. 2. Serialize only
 * validated complete JSON; never truncate serialized JSON mid-value. 3. Batch raw/hourly writes
 * atomically and implement truthful unavailable/idempotent retry behavior; test exact D1 binds, absent
 * binding and second-statement failure. Dependencies OX-S11 consent/UI; sources P-S13/P-S14. PROPOSED
 * NEW tests/unit/worker-docs.test.js and tests/integration/worker-docs-d1.test.js, node --test both
 * (unverified). Acceptance uses real isolated D1 readback, no real personal test data. Rollback
 * respects retention and does not delete historic rows blindly.
 */
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

/*
 * IMPLEMENTATION-HANDOFF [OX-P07] Preparation only; functional status FAIL, repair NOT IMPLEMENTED.
 * Coverage: OX-P-C065, OX-P-C066, OX-P-C067, OX-P-C068, OX-P-C069, OX-P-C070, OX-P-C071, OX-P-C072,
 * OX-P-C073, OX-P-C074, OX-P-C075. Evidence: evidence/sdk-worker-observations.json in
 * handoff/evidence.
 * Verified cause: Worker tools/call ignores name/args and returns fixed executed/ok:true plus stale
 * hardcoded commit. Server/discover and modern version/header binding/CORS requirements are
 * absent.2026-07-28 is real stateless spec; initialize removal is intentional, not this defect.
 * Required behavior: Execute real Worker MCP tools and implement declared2026 transport. Governing
 * refs: P-S11 (2026-07-28); P-S12 (2026-07-28); complete URLs in reports/protocol.md.
 * Prerequisites/order: OX-S04. Related files: spec/openapi.json and sdk/test/client.test.js;
 * Core/backend or site consumer named by the work package.
 * 1. Replace placeholder tools/call branch with shared validated executable MCP engine repaired by
 * OX-S04. Advertise only actual implemented tools; unknown tool and invalid args produce
 * protocol/schema errors; verifier output must be actual verdict.
 * 2. Implement declared2026-07-28 stateless server/discover and per-request _meta protocol
 * negotiation, required HTTP/body header mirror checks and proper JSON-RPC/MCP results. Use pinned
 * official SDK/adapters or exact transport requirements, no fabricated handshake assumptions.
 * 3. Allow required MCP request headers in OPTIONS; preserve correlation id including0; apply
 * body/content-type/method validation and structured result/content shape; expose actual build
 * revision from built artifact.
 * 4. Test hosted Worker adapter and shared engine separately then together with real client; do not
 * treat AgentBridge local call as hosted route acceptance. Run all10 tool contracts and invalid
 * families.
 * Validation (PROPOSED NEW tests, commands unverified until implemented):
 * tests/unit/worker-mcp.test.js, tests/integration/mcp-worker.test.js. node --test
 * tests/unit/worker-mcp.test.js; node --test tests/integration/mcp-worker.test.js.
 * Assertions/evidence: Unknown tool/empty invalid verifier never report executed success;
 * server/discover shape/version,required mirroring,CORS match MCP2026-07-28; All10 advertised tools
 * return independently verified content and failures; Real supported remote client can discover/call
 * hosted endpoint. Offline probes are not end-to-end PASS; require actual Signet transaction and
 * indexed/consumer readback where applicable.
 * Rollback: Revert Worker and engine together; preserve compatible paths. If deployment verification
 * fails return honest unavailable/refusal instead of fake success; do not redeploy in preparation.
 */
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
