import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../../worker/index.js';
import { createD1Database, applyMigrations } from '../../worker/node-host.mjs';
import { normalizeRoute, redactText, SITE_ROUTES, validateEvent } from '../../site/src/lib/docs/docs-contract.mjs';

// OX-P08 (PROPOSED NEW): typed validation, privacy and truthful persistence of the docs
// service, against a real SQLite database behind the D1-compatible binding.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = 'ZZMARKERZZ';

/** A D1 binding that records every bound value, to prove what reaches the database. */
function recordingEnv() {
  const DB = createD1Database(':memory:');
  applyMigrations(DB, resolve(root, 'worker', 'migrations'));
  const binds = [];
  const wrapStmt = (stmt) => ({
    bind: (...v) => {
      binds.push(...v);
      return wrapStmt(stmt.bind(...v));
    },
    run: () => stmt.run(),
    all: () => stmt.all(),
    first: (c) => stmt.first(c),
    runSync: () => stmt.runSync()
  });
  return { env: { DB: { prepare: (sql) => wrapStmt(DB.prepare(sql)), batch: (s) => DB.batch(s), raw: DB.raw } }, binds, db: DB };
}
const post = (path, body) => new Request(`http://svc${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const uuid = (n) => `6f1c2c1e-3b1a-4c2d-9e8f-${String(n).padStart(12, '0')}`;
const feedback = (over = {}) => ({ submissionId: uuid(1), category: 'unclear', route: '/ordex/verify/', comment: 'The count is wrong', protocolVersion: '1.2', buildRevision: 'abcdef1', ...over });
const event = (over = {}) => ({ eventId: uuid(100), event: 'lab_verifier_completed', consent: 'analytics-v1', route: '/lab/', product: 'lab', protocolVersion: '1.2', buildRevision: 'abcdef1', categoryData: { family: 'purchase', verdict: 'accepted' }, ...over });

test('unexpected fields, nested payloads and sensitive markers never reach a database bind', async () => {
  const { env, binds } = recordingEnv();
  const attempts = [
    ['/api/docs/feedback', feedback({ route: `/lab/?${MARKER}`, extra: MARKER })],
    ['/api/docs/feedback', feedback({ category: MARKER })],
    ['/api/docs/events', event({ categoryData: { family: 'purchase', verdict: 'accepted', note: MARKER } })],
    ['/api/docs/events', event({ categoryData: { family: MARKER, verdict: 'accepted' } })],
    ['/api/docs/events', event({ route: `/${MARKER}/` })],
    ['/api/docs/events', event({ product: MARKER })],
    ['/api/docs/events', event({ consent: 'yes' })]
  ];
  for (const [path, body] of attempts) {
    const res = await worker.fetch(post(path, body), env);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
  }
  assert.equal(binds.length, 0, 'nothing was bound for any rejected request');
  const ok = await worker.fetch(post('/api/docs/feedback', feedback({ submissionId: uuid(2), comment: `key xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8 and bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq and ${'ab'.repeat(32)} and user@example.com`, heading: `h ${'cd'.repeat(32)}` })), env);
  assert.equal(ok.status, 201);
  const stored = binds.join(' ');
  for (const secret of ['xpub661', 'bc1qar0', 'ab'.repeat(32), 'user@example.com', 'cd'.repeat(32)]) assert.ok(!stored.includes(secret), `${secret} reached a bind`);
});

test('private key material is refused, not stored', async () => {
  const { env, binds } = recordingEnv();
  const res = await worker.fetch(post('/api/docs/feedback', feedback({ submissionId: uuid(3), comment: 'my key L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ' })), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'SECRET_DETECTED');
  assert.equal(binds.length, 0);
});

test('without storage nothing is reported saved', async () => {
  for (const [path, body] of [['/api/docs/feedback', feedback()], ['/api/docs/events', event()]]) {
    const res = await worker.fetch(post(path, body), {});
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, 'STORAGE_UNAVAILABLE');
  }
  const failing = { DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('disk I/O error'); }, first: async () => null }) }), batch: async () => { throw new Error('disk I/O error'); } } };
  assert.equal((await worker.fetch(post('/api/docs/feedback', feedback()), failing)).status, 503);
  assert.equal((await worker.fetch(post('/api/docs/events', event()), failing)).status, 503);
});

test('feedback is idempotent on its submission id and returns the stored receipt', async () => {
  const { env, db } = recordingEnv();
  const first = await worker.fetch(post('/api/docs/feedback', feedback({ submissionId: uuid(4) })), env);
  assert.equal(first.status, 201);
  const r1 = (await first.json()).receipt;
  assert.equal(r1.id, uuid(4));
  assert.equal(r1.route, '/verify/');
  const retry = await worker.fetch(post('/api/docs/feedback', feedback({ submissionId: uuid(4) })), env);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).receipt.replayed, true);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM docs_feedback').get().n, 1);
  const reuse = await worker.fetch(post('/api/docs/feedback', feedback({ submissionId: uuid(4), category: 'outdated' })), env);
  assert.equal(reuse.status, 409);
});

test('event raw rows and hourly counts commit together, duplicates count once', async () => {
  const { env, db } = recordingEnv();
  assert.equal((await worker.fetch(post('/api/docs/events', event()), env)).status, 202);
  const dup = await (await worker.fetch(post('/api/docs/events', event()), env)).json();
  assert.equal(dup.duplicate, true);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM docs_events_raw').get().n, 1);
  assert.equal(db.raw.prepare('SELECT SUM(count) AS n FROM docs_events_hourly').get().n, 1);
  // A failure of the second statement rolls back the first.
  const broken = { DB: { prepare: (sql) => (sql.includes('docs_events_hourly') ? db.prepare('INSERT INTO no_such_table VALUES (1)') : db.prepare(sql)), batch: (s) => db.batch(s) } };
  const res = await worker.fetch(post('/api/docs/events', event({ eventId: uuid(101) })), broken);
  assert.equal(res.status, 503);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM docs_events_raw WHERE id = ?').get(uuid(101)).n, 0);
});

test('insights return aggregates only, and 503 without storage', async () => {
  const { env } = recordingEnv();
  await worker.fetch(post('/api/docs/events', event({ eventId: uuid(200) })), env);
  const res = await worker.fetch(new Request('http://svc/api/docs/insights?range=7d'), env);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.deepEqual(data.events, [{ event: 'lab_verifier_completed', product: 'lab', count: 1 }]);
  assert.equal((await worker.fetch(new Request('http://svc/api/docs/insights?range=1y'), env)).status, 400);
  const day = await (await worker.fetch(new Request('http://svc/api/docs/insights?range=24h'), env)).json();
  assert.equal(day.range, '24h');
  assert.equal((await worker.fetch(new Request('http://svc/api/docs/insights'), {})).status, 503);
});

test('ask retrieves the requested version, cites real site pages, and refuses unsupported versions', async () => {
  const res = await (await worker.fetch(post('/api/docs/ask', { query: 'keyset cursor paging', protocolVersion: '1.2', pageContext: '/ordex/reference/api/' }), {})).json();
  assert.equal(res.refused, false);
  assert.equal(res.mode, 'extractive');
  assert.ok(res.citations.length > 0);
  for (const c of res.citations) {
    assert.ok(c.docUrl.startsWith('/ordex/'), c.docUrl);
    assert.ok(SITE_ROUTES.includes(normalizeRoute(c.docUrl.split('#')[0])), c.docUrl);
    assert.doesNotMatch(c.title, /\r/);
  }
  assert.equal(res.extracts.length, res.citations.length);
  const old = await (await worker.fetch(post('/api/docs/ask', { query: 'offers', protocolVersion: '999.9' }), {})).json();
  assert.equal(old.refused, true);
  assert.equal(old.code, 'UNSUPPORTED_VERSION');
  const none = await (await worker.fetch(post('/api/docs/ask', { query: 'qqqqzzzzxxxx' }), {})).json();
  assert.equal(none.noSources, true);
  assert.equal(none.answer, null);
  assert.equal((await worker.fetch(post('/api/docs/ask', { query: 'x', extra: 1 }), {})).status, 400);
  assert.equal((await worker.fetch(post('/api/docs/ask', '{bad'), {})).status, 400);
  const key = await (await worker.fetch(post('/api/docs/ask', { query: 'is xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi valid' }), {})).json();
  assert.equal(key.code, 'SECRET_IN_QUERY');
});

test('contract helpers: routes normalize to site pages, text is redacted and bounded, categoryData is serialized from allowed keys only', () => {
  assert.equal(normalizeRoute('https://bitcoinuniverseio.github.io/ordex/lab?x=1#y'), '/lab/');
  assert.equal(normalizeRoute('/ordex'), '/');
  assert.equal(normalizeRoute('/admin/'), null);
  assert.equal(redactText('x'.repeat(2000)).length, 1000);
  assert.equal(redactText('a\u0000b'), 'ab');
  const v = validateEvent(event({ categoryData: { verdict: 'refused', family: 'runes' } }));
  assert.equal(v.value.categoryData, '{"family":"runes","verdict":"refused"}');
});
