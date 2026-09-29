import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_DIR, loadBuilt, startBuiltHost, tempDir } from './service-host.mjs';

// OX-P08 (PROPOSED NEW): the built docs service behind the built Node host, over real HTTP on
// an ephemeral loopback port, with a real SQLite file. Requests are read back from the file
// through a separate connection, so a success answer is checked against what was stored.

const MARKER = 'ZZPRIVACYMARKERZZ';
const XPUB = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
const ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const EMAIL = 'reader@example.com';
const uuid = (n) => `7a2b3c4d-5e6f-4a1b-8c2d-${String(n).padStart(12, '0')}`;
const feedback = (over = {}) => ({ submissionId: uuid(1), category: 'unclear', route: '/ordex/lab/', comment: 'The verdict panel is hard to read', protocolVersion: '1.2', buildRevision: 'abcdef1', ...over });
const event = (over = {}) => ({ eventId: uuid(500), event: 'lab_verifier_completed', consent: 'analytics-v1', route: '/lab/', product: 'lab', protocolVersion: '1.2', buildRevision: 'abcdef1', categoryData: { family: 'purchase', verdict: 'accepted' }, ...over });

let tmp;
let dbPath;
let host;
const post = (path, body, headers = {}) => fetch(`${host.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
/** Read the database file through its own connection, as an operator would. */
function readDb(fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const count = (table) => readDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

before(async () => {
  tmp = tempDir('ordex-docs-');
  dbPath = join(tmp.dir, 'data', 'ordex-docs.sqlite');
  host = await startBuiltHost({ dbPath });
});
after(async () => {
  await host?.close();
  tmp?.cleanup();
});

test('startup applied the migrations through the ledger and health reports the exact build', async () => {
  assert.ok(existsSync(dbPath), 'the database file was created under the configured path');
  const ledger = readDb((db) => db.prepare('SELECT name, sha256 FROM _ordex_migrations ORDER BY name').all());
  assert.deepEqual(ledger.map((r) => r.name), readdirSync(join(SERVER_DIR, 'migrations')).filter((f) => f.endsWith('.sql')).sort());
  for (const r of ledger) assert.match(r.sha256, /^[0-9a-f]{64}$/);
  const health = await (await fetch(`${host.url}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.storage, 'available');
  assert.equal(health.revision, host.built.buildInfo.revision);
  const api = await (await fetch(`${host.url}/api/docs/health`)).json();
  assert.equal(api.revision, host.built.buildInfo.revision);
  assert.equal(api.storage, 'available');
});

test('feedback: the receipt matches the stored row, sensitive text never reaches the file', async () => {
  const res = await post('/api/docs/feedback', feedback({ comment: `see ${XPUB} paid from ${ADDRESS} mail ${EMAIL}`, heading: `Heading ${'ef'.repeat(32)}` }));
  assert.equal(res.status, 201);
  const { receipt } = await res.json();
  const row = readDb((db) => db.prepare('SELECT * FROM docs_feedback WHERE id = ?').get(uuid(1)));
  assert.equal(row.id, receipt.id);
  assert.equal(row.category, receipt.category);
  assert.equal(row.route, '/lab/');
  assert.equal(new Date(row.created_at * 1000).toISOString(), receipt.storedAt);
  for (const secret of [XPUB, ADDRESS, EMAIL, 'ef'.repeat(32)]) assert.ok(!JSON.stringify(row).includes(secret), `${secret.slice(0, 12)} was stored`);
  // A retry with the same submission id is a replay of the same receipt, not a second row.
  const retry = await post('/api/docs/feedback', feedback({ comment: `see ${XPUB} paid from ${ADDRESS} mail ${EMAIL}`, heading: `Heading ${'ef'.repeat(32)}` }));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).receipt.replayed, true);
  assert.equal(readDb((db) => db.prepare('SELECT COUNT(*) AS n FROM docs_feedback WHERE id = ?').get(uuid(1)).n), 1);
});

test('rejected requests write nothing: extra fields, nested data, unknown values, key material, no consent', async () => {
  const before = { feedback: count('docs_feedback'), raw: count('docs_events_raw'), hourly: count('docs_events_hourly') };
  const attempts = [
    ['/api/docs/feedback', feedback({ submissionId: uuid(10), extra: MARKER })],
    ['/api/docs/feedback', feedback({ submissionId: uuid(11), route: `/${MARKER}/` })],
    ['/api/docs/feedback', feedback({ submissionId: uuid(12), comment: 'key L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ' })],
    ['/api/docs/events', event({ eventId: uuid(13), categoryData: { family: 'purchase', verdict: 'accepted', note: MARKER } })],
    ['/api/docs/events', event({ eventId: uuid(14), categoryData: { family: MARKER, verdict: 'accepted' } })],
    ['/api/docs/events', event({ eventId: uuid(15), product: MARKER })],
    ['/api/docs/events', event({ eventId: uuid(16), consent: undefined })],
    ['/api/docs/events', event({ eventId: uuid(17), consent: 'granted' })],
    ['/api/docs/events', '{"eventId":']
  ];
  for (const [path, body] of attempts) {
    const res = await post(path, body);
    assert.equal(res.status, 400, `${path} ${JSON.stringify(body).slice(0, 100)}`);
    assert.equal((await res.json()).ok, false);
  }
  assert.deepEqual({ feedback: count('docs_feedback'), raw: count('docs_events_raw'), hourly: count('docs_events_hourly') }, before);
});

test('events: consented events store only enumerated fields, duplicates count once, insights read back aggregates', async () => {
  for (const n of [600, 601, 601, 602]) {
    const res = await post('/api/docs/events', event({ eventId: uuid(n) }));
    assert.equal(res.status, 202);
  }
  const raw = readDb((db) => db.prepare("SELECT * FROM docs_events_raw WHERE id IN (?, ?, ?)").all(uuid(600), uuid(601), uuid(602)));
  assert.equal(raw.length, 3);
  for (const r of raw) {
    assert.equal(r.category_data, '{"family":"purchase","verdict":"accepted"}');
    assert.equal(r.route, '/lab/');
  }
  const hourly = readDb((db) => db.prepare("SELECT SUM(count) AS n FROM docs_events_hourly WHERE event_name = 'lab_verifier_completed'").get().n);
  assert.equal(hourly, 3, 'the duplicate did not move the hourly count');
  const insights = await (await fetch(`${host.url}/api/docs/insights?range=7d`)).json();
  assert.equal(insights.ok, true);
  const lab = insights.events.find((e) => e.event === 'lab_verifier_completed' && e.product === 'lab');
  assert.equal(lab.count, 3);
  assert.ok(insights.feedback.some((f) => f.category === 'unclear' && f.count >= 1));
  assert.ok(!JSON.stringify(insights).includes(uuid(600)), 'insights never return raw rows or ids');
});

test('retention: expired rows are purged on the next write', async () => {
  const old = Math.floor(Date.now() / 1000) - 400 * 86400;
  const writer = new DatabaseSync(dbPath);
  writer.prepare("INSERT INTO docs_events_raw (id, event_name, route, product, protocol_version, role, category_data, build_commit, created_at) VALUES ('expired-raw', 'page_view', '/', 'other', '1.2', NULL, NULL, 'x', ?)").run(old);
  writer.prepare("INSERT INTO docs_feedback (id, category, route, heading, protocol_version, build_commit, comment_redacted, created_at) VALUES ('expired-fb', 'other', '/', NULL, '1.2', 'x', NULL, ?)").run(old);
  writer.close();
  assert.equal((await post('/api/docs/events', event({ eventId: uuid(700) }))).status, 202);
  assert.equal(readDb((db) => db.prepare("SELECT COUNT(*) AS n FROM docs_events_raw WHERE id = 'expired-raw'").get().n), 0);
  assert.equal(readDb((db) => db.prepare("SELECT COUNT(*) AS n FROM docs_feedback WHERE id = 'expired-fb'").get().n), 0);
});

test('ask cites pages that exist in the built site and refuses unsupported versions', async () => {
  const res = await (await post('/api/docs/ask', { query: 'seller payment output value', protocolVersion: '1.2' })).json();
  assert.equal(res.refused, false);
  assert.ok(res.citations.length > 0);
  for (const c of res.citations) {
    const route = c.docUrl.split('#')[0].replace(/^\/ordex/, '');
    assert.ok(existsSync(join(SERVER_DIR, '..', 'client', ...route.split('/').filter(Boolean), 'index.html')), `${c.docUrl} is a built page`);
  }
  const old = await (await post('/api/docs/ask', { query: 'offers', protocolVersion: '0.9' })).json();
  assert.equal(old.code, 'UNSUPPORTED_VERSION');
});

test('nothing sensitive or rejected is anywhere in the database file after shutdown, and data survives a restart', async () => {
  await host.close();
  const bytes = readFileSync(dbPath).toString('latin1');
  for (const s of [MARKER, XPUB, ADDRESS, EMAIL, 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ']) assert.ok(!bytes.includes(s), `${s.slice(0, 12)} is in the file`);
  host = await startBuiltHost({ dbPath });
  assert.ok(!host.logs.some((l) => l.startsWith('applied migrations')), 'a restart does not reapply migrations');
  const insights = await (await fetch(`${host.url}/api/docs/insights?range=7d`)).json();
  assert.ok(insights.events.find((e) => e.event === 'lab_verifier_completed').count >= 3);
  const replay = await post('/api/docs/feedback', feedback({ comment: 'x' }));
  assert.equal((await replay.json()).receipt.replayed, true, 'the receipt from before the restart is still the stored one');
});

test('a migration changed after it was applied stops startup', async () => {
  const other = tempDir('ordex-mig-');
  try {
    const migrations = join(other.dir, 'migrations');
    cpSync(join(SERVER_DIR, 'migrations'), migrations, { recursive: true });
    const db = join(other.dir, 'db.sqlite');
    const first = await startBuiltHost({ dbPath: db, migrationsDir: migrations });
    await first.close();
    const file = join(migrations, readdirSync(migrations).find((f) => f.endsWith('.sql')));
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- edited after release\n`);
    await assert.rejects(startBuiltHost({ dbPath: db, migrationsDir: migrations }), /changed after it was applied/);
  } finally {
    other.cleanup();
  }
});

test('the host process reads its contract from the environment and serves only allowed origins', async () => {
  const { buildInfo } = await loadBuilt();
  const run = tempDir('ordex-proc-');
  const child = spawn(process.execPath, [join(SERVER_DIR, 'node-host.mjs')], {
    env: { ...process.env, ORDEX_DOCS_HOST: '127.0.0.1', ORDEX_DOCS_PORT: '0', ORDEX_DOCS_DB: join(run.dir, 'svc.sqlite'), ORDEX_ALLOWED_ORIGINS: 'https://docs.example', ORDEX_BUILD_REVISION: '', ORDEX_SITE_BASE: '/docs' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  try {
    const url = await new Promise((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`host did not start: ${stderr}`)), 15000);
      child.stderr.on('data', (d) => {
        stderr += d;
        const m = stderr.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolveUrl(m[1]);
        }
      });
      child.on('exit', (code) => reject(new Error(`host exited ${code}: ${stderr}`)));
    });
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.revision, buildInfo.revision, 'the revision comes from build-info.json next to the bundle');
    const allowed = await fetch(`${url}/api/docs/ask`, { method: 'POST', headers: { origin: 'https://docs.example', 'content-type': 'application/json' }, body: JSON.stringify({ query: 'cursor paging' }) });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://docs.example');
    const body = await allowed.json();
    assert.ok(body.citations.every((c) => c.docUrl.startsWith('/docs/')), 'citations use ORDEX_SITE_BASE');
    const foreign = await fetch(`${url}/api/docs/ask`, { method: 'POST', headers: { origin: 'https://bitcoinuniverseio.github.io', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(foreign.status, 403, 'the configured list replaces the default list');
    assert.ok(existsSync(join(run.dir, 'svc.sqlite')));
    if (process.platform !== 'win32') {
      const exited = new Promise((r) => child.once('exit', (code) => r(code)));
      child.kill('SIGTERM');
      assert.equal(await exited, 0, 'SIGTERM closes the server and the database, then exits 0');
      assert.match(stderr, /SIGTERM: closing/);
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    run.cleanup();
  }
});
