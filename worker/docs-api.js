// OX-P08: docs service endpoints with typed validation, privacy and truthful persistence.
// Requests are validated against site/src/lib/docs/docs-contract.mjs before anything is
// stored or logged. Storage is a D1 binding (env.DB): when it is missing or failing the
// answer is 503, never a success. Feedback is idempotent on its submission id and returns
// the stored receipt read back from the database. Telemetry needs consent, carries only
// enumerated data, and its raw row and hourly count commit atomically in one batch.

import corpusData from '../site/src/data/corpus.json' with { type: 'json' };
import wizardsData from '../site/src/data/wizards.json' with { type: 'json' };
import { validateAsk, validateFeedback, validateEvent, rankCorpus, PROTOCOL_VERSIONS, DOCS_API_VERSION } from '../site/src/lib/docs/docs-contract.mjs';
import { detectSecrets } from '../site/src/lib/security/sanitizer.ts';
import { json, readBody } from './http.js';

const WIZARD_IDS = wizardsData.map((w) => w.id);
const INDEXED_VERSIONS = [...new Set(corpusData.map((c) => c.protocolVersion))];
const RETENTION = { rawEventsDays: 30, feedbackDays: 365, hourlyDays: 400 };
const clean = (s) => String(s).replace(/\r/g, '');

async function parseJson(request, origin) {
  const text = await readBody(request, 8 * 1024);
  if (text === null) return { error: json({ ok: false, code: 'BODY_TOO_LARGE', error: 'The request body exceeds 8 KiB.' }, 413, origin) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: json({ ok: false, code: 'MALFORMED_JSON', error: 'The request body is not valid JSON.' }, 400, origin) };
  }
}

const invalid = (errors, origin) => json({ ok: false, code: 'INVALID_REQUEST', errors }, 400, origin);
const unavailable = (origin, detail) =>
  json({ ok: false, code: 'STORAGE_UNAVAILABLE', error: 'Documentation storage is unavailable, so nothing was saved. Try again later.', ...(detail ? { detail } : {}) }, 503, origin);

/** Citations point at the site page for each corpus section, under the configured base. */
function citation(chunk, basePath) {
  return {
    id: chunk.id,
    title: clean(chunk.title),
    sourcePath: chunk.sourcePath,
    pointer: clean(chunk.pointer),
    protocolVersion: chunk.protocolVersion,
    docUrl: `${basePath}${chunk.docUrl}`
  };
}

export async function handleAsk(request, env, origin) {
  const { body, error } = await parseJson(request, origin);
  if (error) return error;
  const v = validateAsk(body);
  if (!v.ok) return invalid(v.errors, origin);
  const { query, protocolVersion, pageContext } = v.value;
  const basePath = env?.ORDEX_SITE_BASE ?? '/ordex';
  const refusal = (code, answer, citations = []) => json({ ok: true, api: DOCS_API_VERSION, mode: 'extractive', refused: true, code, answer, citations, protocolVersion }, 200, origin);

  if (detectSecrets(query).hasHighConfidenceSecrets) {
    return refusal('SECRET_IN_QUERY', 'The question contains what looks like private key material. It was not processed or stored. Never paste keys or seed phrases into any tool.');
  }
  if (!INDEXED_VERSIONS.includes(protocolVersion)) {
    return refusal('UNSUPPORTED_VERSION', `Documentation for protocol ${protocolVersion} is not indexed. Indexed versions: ${INDEXED_VERSIONS.join(', ')}.`);
  }
  const lowered = query.toLowerCase();
  if (/(private key|seed phrase|mnemonic|sign (and|&) broadcast|send (my )?btc|move (my )?funds)/.test(lowered)) {
    const trust = corpusData.find((c) => c.sourcePath === 'spec/lifecycle.md') || corpusData[0];
    return refusal('SAFETY', 'Ordex documentation tools never handle private keys or seed phrases and never sign or broadcast. Signing happens in your own wallet.', [citation(trust, basePath)]);
  }
  const scored = rankCorpus(corpusData, { query, protocolVersion, pageContext }).map((chunk) => ({ chunk }));
  if (scored.length === 0) {
    return json({ ok: true, api: DOCS_API_VERSION, mode: 'extractive', refused: false, noSources: true, answer: null, citations: [], protocolVersion }, 200, origin);
  }
  return json(
    {
      ok: true,
      api: DOCS_API_VERSION,
      mode: 'extractive',
      refused: false,
      noSources: false,
      protocolVersion,
      // Extracts quoted from the matched sections, each tied to its citation. Not generated text.
      extracts: scored.map(({ chunk }) => ({ citationId: chunk.id, text: clean(chunk.content).slice(0, 700) })),
      citations: scored.map(({ chunk }) => citation(chunk, basePath))
    },
    200,
    origin
  );
}

async function purgeExpired(db) {
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.batch([
      db.prepare('DELETE FROM docs_events_raw WHERE created_at < ?').bind(now - RETENTION.rawEventsDays * 86400),
      db.prepare('DELETE FROM docs_feedback WHERE created_at < ?').bind(now - RETENTION.feedbackDays * 86400),
      db.prepare('DELETE FROM docs_events_hourly WHERE hour_bucket < ?').bind(new Date((now - RETENTION.hourlyDays * 86400) * 1000).toISOString().slice(0, 13))
    ]);
  } catch {
    // retention is best effort; the request's own write already committed
  }
}

export async function handleFeedback(request, env, origin) {
  const { body, error } = await parseJson(request, origin);
  if (error) return error;
  const v = validateFeedback(body);
  if (!v.ok) return invalid(v.errors, origin);
  const f = v.value;
  if (detectSecrets(`${body.comment || ''} ${body.heading || ''}`).hasHighConfidenceSecrets) {
    return json({ ok: false, code: 'SECRET_DETECTED', error: 'The feedback contains what looks like private key material and was not saved. Remove it and send again.' }, 400, origin);
  }
  const db = env?.DB;
  if (!db) return unavailable(origin);
  try {
    const now = Math.floor(Date.now() / 1000);
    const insert = await db
      .prepare('INSERT INTO docs_feedback (id, category, route, heading, protocol_version, build_commit, comment_redacted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .bind(f.id, f.category, f.route, f.heading, f.protocolVersion, f.buildRevision, f.comment, now)
      .run();
    const row = await db.prepare('SELECT id, category, route, created_at FROM docs_feedback WHERE id = ?').bind(f.id).first();
    if (!row) return unavailable(origin, 'The write could not be read back.');
    if (row.category !== f.category || row.route !== f.route) {
      return json({ ok: false, code: 'SUBMISSION_ID_REUSED', error: 'This submission id was already used for different feedback.' }, 409, origin);
    }
    await purgeExpired(db);
    const replay = (insert?.meta?.changes ?? 1) === 0;
    return json({ ok: true, api: DOCS_API_VERSION, receipt: { id: row.id, storedAt: new Date(row.created_at * 1000).toISOString(), category: row.category, route: row.route, replayed: replay } }, replay ? 200 : 201, origin);
  } catch (err) {
    return unavailable(origin, 'The database refused the write.');
  }
}

export async function handleEvent(request, env, origin) {
  const { body, error } = await parseJson(request, origin);
  if (error) return error;
  const v = validateEvent(body, WIZARD_IDS);
  if (!v.ok) return invalid(v.errors, origin);
  const e = v.value;
  const db = env?.DB;
  if (!db) return unavailable(origin);
  const now = Math.floor(Date.now() / 1000);
  const hour = new Date(now * 1000).toISOString().slice(0, 13);
  try {
    // One atomic batch: the hourly count moves only when the raw row was new.
    const results = await db.batch([
      db
        .prepare('INSERT INTO docs_events_raw (id, event_name, route, product, protocol_version, role, category_data, build_commit, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .bind(e.id, e.event, e.route, e.product, e.protocolVersion, e.categoryData, e.buildRevision, now),
      db
        .prepare("INSERT INTO docs_events_hourly (hour_bucket, event_name, route, product, role, count) SELECT ?, ?, ?, ?, '', 1 WHERE changes() = 1 ON CONFLICT (hour_bucket, event_name, route, product, role) DO UPDATE SET count = count + 1")
        .bind(hour, e.event, e.route, e.product)
    ]);
    await purgeExpired(db);
    const duplicate = (results?.[0]?.meta?.changes ?? 1) === 0;
    return json({ ok: true, api: DOCS_API_VERSION, stored: true, duplicate }, 202, origin);
  } catch {
    return unavailable(origin, 'The database refused the write.');
  }
}

const RANGES = { '7d': 7, '30d': 30, '90d': 90 };

/** Aggregates only: hourly counts per event and product over a range. */
export async function handleInsights(request, env, origin) {
  const range = new URL(request.url).searchParams.get('range') || '30d';
  if (!RANGES[range]) return invalid(['range must be 7d, 30d or 90d'], origin);
  const db = env?.DB;
  if (!db) return unavailable(origin);
  try {
    const since = new Date(Date.now() - RANGES[range] * 86400 * 1000).toISOString().slice(0, 13);
    const { results } = await db
      .prepare('SELECT event_name AS event, product, SUM(count) AS count FROM docs_events_hourly WHERE hour_bucket >= ? GROUP BY event_name, product ORDER BY count DESC')
      .bind(since)
      .all();
    const feedback = await db.prepare('SELECT category, COUNT(*) AS count FROM docs_feedback WHERE created_at >= ? GROUP BY category').bind(Math.floor(Date.now() / 1000) - RANGES[range] * 86400).all();
    return json({ ok: true, api: DOCS_API_VERSION, range, since: `${since}:00:00Z`, events: results || [], feedback: feedback.results || [], generatedAt: new Date().toISOString() }, 200, origin);
  } catch {
    return unavailable(origin, 'The database refused the read.');
  }
}

export async function handleHealth(env, origin, revision) {
  let storage = 'unavailable';
  if (env?.DB) {
    try {
      await env.DB.prepare('SELECT 1 AS ok').first();
      storage = 'available';
    } catch {
      storage = 'failing';
    }
  }
  return json(
    {
      status: storage === 'available' ? 'ok' : 'degraded',
      service: 'ordex-docs',
      api: DOCS_API_VERSION,
      revision,
      protocolVersions: PROTOCOL_VERSIONS,
      indexedVersions: INDEXED_VERSIONS,
      corpusSections: corpusData.length,
      storage,
      time: new Date().toISOString()
    },
    200,
    origin
  );
}
