import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// OX-S12: the service worker template run in a simulated worker scope: precache under the
// scope, scoped cleanup, no caching of API, MCP, credentialed or unlisted requests, and
// route-aware offline navigation.

const template = readFileSync(new URL('../../scripts/docs/sw-template.js', import.meta.url), 'utf8');

function scope({ files = ['index.html', 'lab/index.html', 'assets/app.js'], version = 'v2', fail = null, existing = [] } = {}) {
  const stores = new Map(existing.map((k) => [k, new Map()]));
  const listeners = {};
  const network = [];
  const caches = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        addAll: async (reqs) => {
          for (const r of reqs) {
            if (fail && r.url.endsWith(fail)) throw new TypeError(`failed ${r.url}`);
            m.set(new URL(r.url).pathname, new Response(`cached ${new URL(r.url).pathname}`));
          }
        },
        keys: async () => [...m.keys()]
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (path, { cacheName }) => stores.get(cacheName)?.get(path)?.clone()
  };
  const self = {
    registration: { scope: 'https://site.example/ordex/' },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    __ORDEX_SW_MANIFEST__: { version, revision: 'abcdef1', files }
  };
  const context = vm.createContext({
    self,
    caches,
    URL,
    Request,
    Response,
    Set,
    fetch: async (req) => {
      network.push(typeof req === 'string' ? req : req.url);
      throw new TypeError('offline');
    }
  });
  vm.runInContext(template.replace('self.__ORDEX_SW_MANIFEST__', 'self.__ORDEX_SW_MANIFEST__'), context);
  const run = async (type, event) => {
    let waited;
    let responded;
    listeners[type]({ ...event, waitUntil: (p) => (waited = p), respondWith: (p) => (responded = p) });
    if (waited) await waited;
    return responded ? await responded : undefined;
  };
  return { stores, run, network };
}

const fetchEvent = (url, init = {}) => ({ request: new Request(url, init) });
const navigate = (url) => ({ request: { url, method: 'GET', mode: 'navigate', headers: new Headers() } });

test('install precaches the build under the scope; a failed file fails the install and keeps nothing', async () => {
  const s = scope();
  await s.run('install', {});
  assert.deepEqual([...s.stores.get('ordex-static:/ordex/:v2').keys()], ['/ordex/index.html', '/ordex/lab/index.html', '/ordex/assets/app.js']);
  const bad = scope({ fail: 'assets/app.js' });
  await assert.rejects(bad.run('install', {}));
  assert.equal(bad.stores.has('ordex-static:/ordex/:v2'), false);
});

test('activate deletes only older Ordex caches of this scope', async () => {
  const s = scope({ existing: ['ordex-static:/ordex/:v1', 'ordex-static:/other/:v1', 'another-app-cache'] });
  await s.run('install', {});
  await s.run('activate', {});
  assert.deepEqual([...s.stores.keys()].sort(), ['another-app-cache', 'ordex-static:/ordex/:v2', 'ordex-static:/other/:v1']);
});

test('listed files come from the cache; API, MCP, credentialed, unlisted and non-GET requests are not handled', async () => {
  const s = scope();
  await s.run('install', {});
  const hit = await s.run('fetch', fetchEvent('https://site.example/ordex/assets/app.js'));
  assert.equal(await hit.text(), 'cached /ordex/assets/app.js');
  for (const e of [
    fetchEvent('https://site.example/ordex/api/docs/ask'),
    fetchEvent('https://site.example/ordex/mcp'),
    fetchEvent('https://site.example/ordex/assets/app.js', { headers: { authorization: 'Bearer x' } }),
    fetchEvent('https://site.example/ordex/assets/other.js'),
    fetchEvent('https://site.example/ordex/assets/app.js', { method: 'POST', body: 'x' }),
    fetchEvent('https://gateway.example/api/ordex/orders')
  ]) {
    assert.equal(await s.run('fetch', e), undefined, e.request.url);
  }
});

test('offline navigation serves the saved page for that route, or an honest 503', async () => {
  const s = scope();
  await s.run('install', {});
  const lab = await s.run('fetch', navigate('https://site.example/ordex/lab/?family=runes'));
  assert.equal(await lab.text(), 'cached /ordex/lab/index.html');
  const missing = await s.run('fetch', navigate('https://site.example/ordex/nope/'));
  assert.equal(missing.status, 503);
  assert.match(await missing.text(), /not saved for offline use/);
});
