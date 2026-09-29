// OX-S02: Gateway Doctor. Every check is a bounded read-only request to the chosen gateway
// with exact assertions from spec/openapi.json and spec/api.md: readiness and freshness from
// /health, the network and protocol the gateway speaks, catalog and orderbook schemas,
// decimal-string amounts, keyset paging, a malformed cursor answered with 400 and a missing
// order answered with a 404 error envelope. An unreachable or wrong gateway fails; checks
// whose prerequisite failed are blocked, never passed. The report digest is a real SHA-256
// over the sanitized report.

import { executePlan, buildRequestPlan } from '../api/request-plan.mjs';
import { validateSchema } from '../api/schema.mjs';
import { stableJson, sha256Hex } from '../lab-report.mjs';
import { maskSensitiveIdentifiers } from '../security/sanitizer';

export const REPORT_SCHEMA = 'ordex.gateway-doctor-report/v1';
const SATS = /^(0|[1-9][0-9]*)$/;

export const CHECKS = [
  { id: 'reach', name: 'Health endpoint answers (GET /api/ordex/health)', depends: [] },
  { id: 'health-schema', name: 'Health report matches the HealthReport schema', depends: ['reach'] },
  { id: 'health-ready', name: 'Listings can be verified now: storage, Core, ord and freshness', depends: ['health-schema'] },
  { id: 'protocol', name: 'Protocol contract (GET /api/ordex/protocol) matches its schema and the pinned version', depends: ['reach'] },
  { id: 'network', name: 'Gateway network matches the selected network', depends: ['health-schema', 'protocol'] },
  { id: 'catalog', name: 'Catalog (GET /api/ordex/catalog) matches its schema', depends: ['reach'] },
  { id: 'orders', name: 'Orderbook page matches OrderPage and every amount is a decimal string', depends: ['reach'] },
  { id: 'paging', name: 'Keyset paging: hasMore agrees with nextCursor and pages do not overlap', depends: ['orders'] },
  { id: 'malformed-cursor', name: 'A malformed cursor is refused with 400 and an error envelope', depends: ['reach'] },
  { id: 'error-envelope', name: 'A missing order is a 404 with an error envelope', depends: ['reach'] },
  { id: 'cors', name: 'This page can read the gateway responses (CORS)', depends: ['reach'] }
];

function findOperation(operations, id) {
  const op = operations.find((o) => o.operationId === id);
  if (!op) throw new Error(`Operation ${id} is missing from the generated contract data`);
  return op;
}

/** Every value under a key ending in Sats, or each item of a list under one, must be a decimal string. */
export function nonDecimalAmounts(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => nonDecimalAmounts(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}.${k}`;
      const decimal = (x) => typeof x === 'string' && SATS.test(x);
      if (/Sats$/.test(k) && v !== null) {
        if (Array.isArray(v)) v.forEach((x, i) => !decimal(x) && out.push(`${p}[${i}]`));
        else if (!decimal(v)) out.push(p);
      }
      nonDecimalAmounts(v, p, out);
    }
  }
  return out;
}

function evidenceOf(plan, res) {
  const request = { method: plan.method, url: plan.url };
  if (!res) return { request, response: null };
  if (!res.ok) return { request, response: { error: res.code, message: res.message } };
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  return {
    request,
    response: {
      status: res.status,
      contentType: res.headers['content-type'] || null,
      bodySha256: sha256Hex(text ?? ''),
      // The report keeps a masked excerpt; the digest covers the full body via bodySha256.
      excerpt: maskSensitiveIdentifiers((text ?? '').slice(0, 400))
    }
  };
}

/**
 * Run the doctor. options: { doc, operations, origin, network, protocolVersion, sourceBuild,
 * fetchImpl, signal, now, inBrowser, onProgress }.
 */
export async function runGatewayDoctor(options) {
  const { doc, operations, origin, network, protocolVersion, sourceBuild = 'unknown', fetchImpl = fetch, signal, now = () => Date.now(), inBrowser = typeof window !== 'undefined', onProgress = () => {} } = options;
  const startedAt = new Date(now()).toISOString();
  const results = new Map();
  const cache = {};
  const set = (id, status, details, evidence = null) => {
    results.set(id, { id, name: CHECKS.find((c) => c.id === id).name, status, details, evidence });
    onProgress([...results.values()]);
  };
  const call = async (operationId, values = {}) => {
    const op = findOperation(operations, operationId);
    const plan = buildRequestPlan({ doc, operation: op, origin, values });
    if (!plan.ok) return { plan, res: { ok: false, code: 'PLAN_INVALID', message: plan.errors.join('; ') } };
    const res = await executePlan({ doc, operation: op, plan, fetchImpl, signal, timeoutMs: 10000 });
    return { plan, res };
  };

  for (const check of CHECKS) {
    if (signal?.aborted) {
      set(check.id, 'cancelled', 'The run was cancelled before this check.');
      continue;
    }
    const blockedBy = check.depends.filter((d) => results.get(d)?.status !== 'passed');
    if (blockedBy.length) {
      set(check.id, 'blocked', `Not run: ${blockedBy.map((d) => CHECKS.find((c) => c.id === d).name).join('; ')} did not pass.`);
      continue;
    }
    set(check.id, 'running', '');
    try {
      switch (check.id) {
        case 'reach': {
          cache.health = await call('getHealth');
          const { plan, res } = cache.health;
          if (!res.ok) set('reach', res.code === 'CANCELLED' ? 'cancelled' : 'failed', `${res.code}: ${res.message}`, evidenceOf(plan, res));
          else if (!res.http.ok) set('reach', 'failed', `HTTP ${res.status} from the health endpoint`, evidenceOf(plan, res));
          else set('reach', 'passed', `HTTP ${res.status} in ${res.durationMs} ms`, evidenceOf(plan, res));
          break;
        }
        case 'health-schema': {
          const { plan, res } = cache.health;
          if (res.schema.state === 'valid') set(check.id, 'passed', 'Every required field is present with the documented type.', evidenceOf(plan, res));
          else set(check.id, 'failed', res.schema.errors.slice(0, 3).map((e) => (typeof e === 'string' ? e : `${e.path} ${e.message}`)).join('; '), evidenceOf(plan, res));
          break;
        }
        case 'health-ready': {
          const h = cache.health.res.body;
          const problems = [];
          if (h.ok !== true) problems.push('ok is false');
          if (h.status !== 'active') problems.push(`status is ${h.status}`);
          if (!h.storageWritable) problems.push('storage is not writable');
          if (!h.configurationComplete) problems.push('configuration is incomplete');
          const r = h.listingReadiness || {};
          if (!r.ready) problems.push(`listing readiness is false (${r.reason || 'no reason'})`);
          if (typeof r.lagBlocks === 'number' && r.lagBlocks > r.maxLagBlocks) problems.push(`ord lags Core by ${r.lagBlocks} blocks (limit ${r.maxLagBlocks})`);
          const checkedAt = Date.parse(r.checkedAt);
          const age = (now() - checkedAt) / 1000;
          if (!Number.isFinite(age)) problems.push('readiness has no observation time');
          else if (age > h.maxVerificationAgeSeconds) problems.push(`the readiness observation is ${Math.round(age)} s old (limit ${h.maxVerificationAgeSeconds} s)`);
          set(check.id, problems.length ? 'failed' : 'passed', problems.length ? problems.join('; ') : `Ready at Core height ${r.coreHeight}, ord height ${r.ordHeight}, observed ${Math.round(age)} s ago.`, evidenceOf(cache.health.plan, cache.health.res));
          break;
        }
        case 'protocol': {
          cache.protocol = await call('getProtocol');
          const { plan, res } = cache.protocol;
          if (!res.ok || !res.http.ok) set(check.id, 'failed', res.ok ? `HTTP ${res.status}` : `${res.code}: ${res.message}`, evidenceOf(plan, res));
          else if (res.schema.state !== 'valid') set(check.id, 'failed', `Schema: ${res.schema.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`, evidenceOf(plan, res));
          else {
            const p = res.body;
            const pinned = String(protocolVersion);
            const problems = [];
            if (p.version !== p.protocolVersion) problems.push(`version ${p.version} differs from protocolVersion ${p.protocolVersion}`);
            if (!(p.protocolVersion === pinned || p.protocolVersion.startsWith(`${pinned}.`))) problems.push(`the gateway speaks protocol ${p.protocolVersion}, not the selected ${pinned}`);
            const missing = Object.entries(p.capabilities || {}).filter(([, v]) => v === false).map(([k]) => k);
            set(check.id, problems.length ? 'failed' : 'passed', problems.length ? problems.join('; ') : `Protocol ${p.protocolVersion} by ${p.implementation?.name || 'unknown'}${missing.length ? `; capabilities off: ${missing.join(', ')}` : ''}.`, evidenceOf(plan, res));
          }
          break;
        }
        case 'network': {
          const hn = cache.health.res.body.network;
          const pn = cache.protocol.res.body.network;
          const ok = hn === network && pn === network;
          set(check.id, ok ? 'passed' : 'failed', ok ? `Health and protocol both report ${network}.` : `Selected ${network}, but health reports ${hn} and protocol reports ${pn}.`);
          break;
        }
        case 'catalog': {
          const { plan, res } = await call('getCatalog');
          const ok = res.ok && res.http.ok && res.schema.state === 'valid';
          set(check.id, ok ? 'passed' : 'failed', ok ? `${Array.isArray(res.body) ? res.body.length : 0} markets described.` : res.ok ? `HTTP ${res.status}; ${res.schema.errors.slice(0, 2).map((e) => (typeof e === 'string' ? e : `${e.path} ${e.message}`)).join('; ')}` : `${res.code}: ${res.message}`, evidenceOf(plan, res));
          break;
        }
        case 'orders': {
          cache.orders = await call('listOrders', { query: { limit: '2' } });
          const { plan, res } = cache.orders;
          if (!res.ok || !res.http.ok) set(check.id, 'failed', res.ok ? `HTTP ${res.status}` : `${res.code}: ${res.message}`, evidenceOf(plan, res));
          else if (res.schema.state !== 'valid') set(check.id, 'failed', `Schema: ${res.schema.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`, evidenceOf(plan, res));
          else {
            const bad = nonDecimalAmounts(res.body);
            set(check.id, bad.length ? 'failed' : 'passed', bad.length ? `Amounts not sent as decimal strings: ${bad.slice(0, 5).join(', ')}` : `${res.body.orders.length} orders on the page; all amounts are decimal strings.`, evidenceOf(plan, res));
          }
          break;
        }
        case 'paging': {
          const page = cache.orders.res.body;
          const hasCursor = typeof page.nextCursor === 'string' && page.nextCursor !== '';
          if (page.hasMore !== hasCursor) {
            set(check.id, 'failed', `hasMore is ${page.hasMore} while nextCursor is ${hasCursor ? 'set' : 'empty'}.`);
            break;
          }
          if (!hasCursor) {
            set(check.id, 'passed', 'Single page: hasMore is false and nextCursor is empty.');
            break;
          }
          const next = await call('listOrders', { query: { limit: '2', cursor: page.nextCursor } });
          if (!next.res.ok || !next.res.http.ok || next.res.schema.state !== 'valid') {
            set(check.id, 'failed', 'The next page could not be read or does not match OrderPage.', evidenceOf(next.plan, next.res));
            break;
          }
          const first = new Set(page.orders.map((o) => o.id));
          const overlap = next.res.body.orders.filter((o) => first.has(o.id)).map((o) => o.id);
          set(check.id, overlap.length ? 'failed' : 'passed', overlap.length ? `The next page repeats ${overlap.join(', ')}.` : 'The next page continues without repeating a row.', evidenceOf(next.plan, next.res));
          break;
        }
        case 'malformed-cursor': {
          const { plan, res } = await call('listOrders', { query: { cursor: 'ordex-doctor:not-a-cursor' } });
          if (!res.ok) set(check.id, 'failed', `${res.code}: ${res.message}`, evidenceOf(plan, res));
          else if (res.status !== 400) set(check.id, 'failed', `Answered HTTP ${res.status}; a malformed cursor must be a 400, never a page.`, evidenceOf(plan, res));
          else set(check.id, res.schema.state === 'valid' ? 'passed' : 'failed', res.schema.state === 'valid' ? '400 with a valid error envelope.' : `400, but the envelope does not match: ${res.schema.errors.slice(0, 2).map((e) => (typeof e === 'string' ? e : `${e.path} ${e.message}`)).join('; ')}`, evidenceOf(plan, res));
          break;
        }
        case 'error-envelope': {
          const { plan, res } = await call('getOrder', { path: { id: `ordex-doctor-missing-${now()}` } });
          if (!res.ok) set(check.id, 'failed', `${res.code}: ${res.message}`, evidenceOf(plan, res));
          else if (res.status !== 404) set(check.id, 'failed', `Answered HTTP ${res.status} for an order that does not exist.`, evidenceOf(plan, res));
          else set(check.id, res.schema.state === 'valid' ? 'passed' : 'failed', res.schema.state === 'valid' ? '404 with a valid error envelope.' : `404, but the envelope does not match: ${res.schema.errors.slice(0, 2).map((e) => (typeof e === 'string' ? e : `${e.path} ${e.message}`)).join('; ')}`, evidenceOf(plan, res));
          break;
        }
        case 'cors': {
          if (!inBrowser) set(check.id, 'not-run', 'CORS is enforced by browsers only; run the Doctor in a browser for this check.');
          else set(check.id, 'passed', 'The browser allowed this page to read every response, so the gateway allows this origin. Header values are not readable from the page.');
          break;
        }
        default:
          set(check.id, 'not-run', 'Unknown check');
      }
    } catch (err) {
      set(check.id, signal?.aborted ? 'cancelled' : 'failed', String(err?.message || err));
    }
  }

  const checks = CHECKS.map((c) => results.get(c.id));
  const count = (s) => checks.filter((c) => c.status === s).length;
  const report = {
    schema: REPORT_SCHEMA,
    origin,
    network,
    protocolVersion: String(protocolVersion),
    sourceBuild,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    checks,
    passed: count('passed'),
    failed: count('failed'),
    blocked: count('blocked'),
    cancelled: count('cancelled'),
    notRun: count('not-run'),
    success: checks.every((c) => c.status === 'passed' || (c.id === 'cors' && c.status === 'not-run')) && count('passed') > 0
  };
  return { ...report, digest: reportDigest(report) };
}

/** SHA-256 over the canonical JSON of the report without its digest. */
export function reportDigest(report) {
  const { digest, ...rest } = report;
  return sha256Hex(stableJson(rest));
}
