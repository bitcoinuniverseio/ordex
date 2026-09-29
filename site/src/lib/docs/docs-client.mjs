// OX-S11: how pages call the self-hosted docs service (worker/node-host.mjs). The origin is the
// build setting PUBLIC_ORDEX_DOCS_API_BASE (empty means the site's own origin). Every call is
// bounded in time, cancellable, and reports exactly what happened: a stored receipt, a refusal,
// an unavailable service or an invalid response. Nothing here turns a failure into success.

import { docsApiUrl } from './docs-contract.mjs';

export const DOCS_API_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_ORDEX_DOCS_API_BASE) || '';

/**
 * { kind: 'ok' | 'http' | 'unavailable' | 'timeout' | 'cancelled' | 'invalid', status, data, message }
 */
export async function callDocsApi(path, { method = 'GET', body, base = DOCS_API_BASE, timeoutMs = 10000, signal, fetchImpl = fetch } = {}) {
  const url = docsApiUrl(base, path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
  const onAbort = () => ctrl.abort('cancelled');
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetchImpl(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    let data = null;
    try {
      data = await res.json();
    } catch {
      return { kind: 'invalid', status: res.status, data: null, message: `The docs service answered HTTP ${res.status} without JSON.` };
    }
    if (!res.ok) return { kind: 'http', status: res.status, data, message: data?.error || data?.code || `HTTP ${res.status}` };
    return { kind: 'ok', status: res.status, data, message: null };
  } catch (err) {
    if (signal?.aborted) return { kind: 'cancelled', status: null, data: null, message: 'Cancelled.' };
    if (ctrl.signal.aborted) return { kind: 'timeout', status: null, data: null, message: `The docs service did not answer within ${timeoutMs / 1000} s.` };
    return { kind: 'unavailable', status: null, data: null, message: `The docs service could not be reached (${err?.message || err}).` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
