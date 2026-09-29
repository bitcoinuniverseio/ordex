// OX-P08 / OX-S11: the docs API request contract, shared by the service (worker/index.js)
// and the site consumers (Ask, feedback, telemetry, insights). Every field is bounded and
// typed; free text is redacted before storage; routes are normalized to the site's own
// pages; telemetry carries only enumerated categorical data and only with consent.

import { FAMILIES } from '../conformance-registry.mjs';

export const DOCS_API_VERSION = 'ordex.docs-api/v1';
export const CONSENT_VERSION = 'analytics-v1';
export const PROTOCOL_VERSIONS = ['1.0', '1.1', '1.2'];

/** Every page the site publishes, without the /ordex base. */
export const SITE_ROUTES = [
  '/', '/workspace/', '/sandbox/', '/inspect/', '/diagnose/', '/agents/', '/tour/', '/start/', '/learn/', '/build/',
  '/build/wizards/', '/build/recipes/', '/build/playground/', '/verify/', '/lab/', '/atlas/', '/kits/', '/ask/',
  '/operate/', '/releases/', '/compatibility/', '/insights/', '/reference/', '/reference/api/', '/reference/refusal-codes/',
  '/reference/specifications/'
];

export const FEEDBACK_CATEGORIES = ['helpful', 'not_helpful', 'unclear', 'outdated', 'missing_example', 'broken_workflow', 'other'];
export const PRODUCTS = ['launchpad', 'workspace', 'sandbox', 'artifact-lens', 'failure-navigator', 'agent-bridge', 'tour', 'lab', 'conformance', 'doctor', 'playground', 'wizards', 'recipes', 'kits', 'ask', 'atlas', 'reference', 'insights', 'other'];

const bucket = ['0', '1-5', '6-20', '21+'];
/** Allowed categoryData keys and values per telemetry event. Anything else is refused. */
export const EVENT_SCHEMAS = {
  page_viewed: {},
  search_submitted: { resultCount: bucket },
  search_no_result: {},
  search_result_selected: { position: ['1', '2', '3', '4', '5', '6+'] },
  wizard_started: { wizardId: 'wizardId' },
  wizard_step_completed: { wizardId: 'wizardId', step: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'] },
  wizard_completed: { wizardId: 'wizardId' },
  recipe_opened: { recipeId: 'slug' },
  playground_mode_selected: { mode: ['example', 'gateway'] },
  mock_request_completed: {},
  playground_validation_failed: { location: ['path', 'query', 'header', 'body', 'response'] },
  lab_verifier_completed: { family: [...FAMILIES], verdict: ['accepted', 'refused', 'unknown'] },
  conformance_run_completed: { family: ['all', ...FAMILIES], outcome: ['passed', 'failed'] },
  kit_generated: { runtime: ['node', 'browser', 'worker'], capabilityCount: ['1', '2', '3', '4', '5+'] },
  assistant_answered: { citationCount: ['0', '1', '2', '3', '4'] },
  assistant_refused: { reason: ['unsupported_version', 'secret_in_query', 'safety', 'no_sources'] },
  feedback_submitted: { category: FEEDBACK_CATEGORIES }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUILD = /^([0-9a-f]{7,40}|unknown)$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Patterns redacted from every stored free-text field.
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED KEY]'],
  [/\b(?:bc1|tb1|bcrt1)[a-z0-9]{8,87}\b/gi, '[REDACTED ADDRESS]'],
  [/\b[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}\b/g, '[REDACTED ADDRESS]'],
  [/\b[xytuvz](?:pub|prv)[1-9A-HJ-NP-Za-km-z]{100,112}\b/g, '[REDACTED KEY]'],
  [/\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,52}\b/g, '[REDACTED KEY]'],
  [/\b(?:ghp_|gho_|github_pat_|sk-|whsec_)[A-Za-z0-9_-]{8,255}\b/g, '[REDACTED TOKEN]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED TOKEN]'],
  [/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED TOKEN]'],
  [/\bcHNidP[A-Za-z0-9+/=]{10,}/g, '[REDACTED PSBT]'],
  [/\b70736274ff[0-9a-f]{10,}\b/gi, '[REDACTED PSBT]'],
  [/\b[0-9a-f]{64}\b/gi, '[REDACTED HEX]'],
  [/\b[0-9a-f]{66,}\b/gi, '[REDACTED HEX]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '[REDACTED EMAIL]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED IP]']
];

/** Redact sensitive material and control characters; bound the length. */
export function redactText(text, max = 1000) {
  let out = String(text).normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out.slice(0, max);
}

/** A site route from a path or URL: pathname only, base removed, known pages only. */
export function normalizeRoute(input) {
  if (typeof input !== 'string' || input.length > 300) return null;
  let path;
  try {
    path = new URL(input, 'https://docs.invalid').pathname;
  } catch {
    return null;
  }
  path = path.replace(/^\/ordex(?=\/|$)/, '') || '/';
  if (!path.endsWith('/')) path += '/';
  path = path.replace(/\/{2,}/g, '/');
  return SITE_ROUTES.includes(path) ? path : null;
}

function strictObject(body, allowed, errors) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    errors.push('The body must be a JSON object');
    return false;
  }
  for (const k of Object.keys(body)) if (!allowed.includes(k)) errors.push(`Unexpected field ${k}`);
  return true;
}

export function validateAsk(body) {
  const errors = [];
  if (!strictObject(body, ['query', 'protocolVersion', 'pageContext'], errors)) return { ok: false, errors };
  if (typeof body.query !== 'string' || body.query.trim().length === 0 || body.query.length > 500) errors.push('query must be 1 to 500 characters');
  if (body.protocolVersion !== undefined && (typeof body.protocolVersion !== 'string' || body.protocolVersion.length > 10)) errors.push('protocolVersion must be a short string');
  const route = body.pageContext === undefined ? null : normalizeRoute(body.pageContext);
  if (body.pageContext !== undefined && route === null) errors.push('pageContext must be a page of this site');
  return errors.length ? { ok: false, errors } : { ok: true, value: { query: body.query.trim(), protocolVersion: body.protocolVersion || '1.2', pageContext: route } };
}

export function validateFeedback(body) {
  const errors = [];
  if (!strictObject(body, ['submissionId', 'category', 'route', 'heading', 'comment', 'protocolVersion', 'buildRevision'], errors)) return { ok: false, errors };
  if (typeof body.submissionId !== 'string' || !UUID.test(body.submissionId)) errors.push('submissionId must be a version 4 UUID');
  if (!FEEDBACK_CATEGORIES.includes(body.category)) errors.push('category is not a feedback category');
  const route = normalizeRoute(body.route);
  if (!route) errors.push('route must be a page of this site');
  if (body.heading !== undefined && (typeof body.heading !== 'string' || body.heading.length > 200)) errors.push('heading must be up to 200 characters');
  if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 1000)) errors.push('comment must be up to 1000 characters');
  if (!PROTOCOL_VERSIONS.includes(body.protocolVersion)) errors.push('protocolVersion is not a released version');
  if (typeof body.buildRevision !== 'string' || !BUILD.test(body.buildRevision)) errors.push('buildRevision must be a commit id or unknown');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: body.submissionId,
      category: body.category,
      route,
      heading: body.heading ? redactText(body.heading, 200) : null,
      comment: body.comment ? redactText(body.comment, 1000) : null,
      protocolVersion: body.protocolVersion,
      buildRevision: body.buildRevision
    }
  };
}

export function validateEvent(body, wizardIds = []) {
  const errors = [];
  if (!strictObject(body, ['eventId', 'event', 'consent', 'route', 'product', 'protocolVersion', 'buildRevision', 'categoryData'], errors)) return { ok: false, errors };
  if (body.consent !== CONSENT_VERSION) errors.push(`consent must be ${CONSENT_VERSION}; telemetry is sent only after the reader agrees`);
  if (typeof body.eventId !== 'string' || !UUID.test(body.eventId)) errors.push('eventId must be a version 4 UUID');
  const schema = EVENT_SCHEMAS[body.event];
  if (!schema) errors.push('event is not an allowed event');
  const route = normalizeRoute(body.route);
  if (!route) errors.push('route must be a page of this site');
  if (!PRODUCTS.includes(body.product)) errors.push('product is not a known product');
  if (!PROTOCOL_VERSIONS.includes(body.protocolVersion)) errors.push('protocolVersion is not a released version');
  if (typeof body.buildRevision !== 'string' || !BUILD.test(body.buildRevision)) errors.push('buildRevision must be a commit id or unknown');
  const data = body.categoryData === undefined ? {} : body.categoryData;
  if (!data || typeof data !== 'object' || Array.isArray(data)) errors.push('categoryData must be an object');
  else if (schema) {
    for (const [k, v] of Object.entries(data)) {
      const rule = schema[k];
      if (!rule) errors.push(`categoryData.${k} is not allowed for ${body.event}`);
      else if (rule === 'wizardId' ? !wizardIds.includes(v) : rule === 'slug' ? !(typeof v === 'string' && SLUG.test(v)) : !rule.includes(v)) errors.push(`categoryData.${k} has a value outside its allowed set`);
    }
  }
  if (errors.length) return { ok: false, errors };
  // Serialize only the validated keys in a fixed order: never a truncated or free-form payload.
  const categoryData = JSON.stringify(Object.fromEntries(Object.keys(schema).filter((k) => k in data).map((k) => [k, data[k]])));
  return { ok: true, value: { id: body.eventId, event: body.event, route, product: body.product, protocolVersion: body.protocolVersion, buildRevision: body.buildRevision, categoryData } };
}

/** Join the configured docs API base (empty for same origin) and a path. */
export function docsApiUrl(base, path) {
  const b = typeof base === 'string' ? base.replace(/\/+$/, '') : '';
  return `${b}${path}`;
}

/**
 * OX-S11: the extractive retrieval the docs service and the page's local fallback share. Only
 * sections of the requested protocol version are scored; a section in the current page gets a
 * small boost. Returns at most `limit` corpus sections, best first.
 */
export function rankCorpus(corpus, { query, protocolVersion, pageContext }, limit = 4) {
  const lowered = String(query).toLowerCase();
  const terms = lowered.split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
  if (terms.length === 0) return [];
  return corpus
    .filter((c) => c.protocolVersion === protocolVersion)
    .map((chunk) => {
      const title = chunk.title.toLowerCase();
      const text = chunk.content.toLowerCase();
      let score = 0;
      for (const t of terms) score += (title.includes(t) ? 5 : 0) + (text.includes(t) ? 1 : 0);
      if (score > 0 && pageContext && chunk.docUrl.startsWith(pageContext.replace(/\/$/, ''))) score += 2;
      return { chunk, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, limit)
    .map((x) => x.chunk);
}

/** Checks an ask response from the docs service before the page shows it. */
export function validateAskResponse(data) {
  if (!data || typeof data !== 'object' || data.ok !== true || typeof data.refused !== 'boolean' || !Array.isArray(data.citations)) return 'The response is not a docs service answer.';
  for (const c of data.citations) {
    if (!c || typeof c.title !== 'string' || typeof c.docUrl !== 'string' || !c.docUrl.startsWith('/') || c.docUrl.startsWith('//')) return 'A citation has no usable page link.';
  }
  if (!data.refused && !data.noSources && (!Array.isArray(data.extracts) || data.extracts.length !== data.citations.length)) return 'The answer extracts do not match its citations.';
  return null;
}
