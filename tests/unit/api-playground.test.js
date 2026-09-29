import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  buildRequestPlan,
  authorizePlan,
  planFingerprint,
  validateResponse,
  executePlan,
  curlFor,
  shellQuote,
  effectOf,
  contractOperation,
  operationParameters,
  parseExactJson
} from '../../site/src/lib/api/request-plan.mjs';
import { exampleForSchema } from '../../site/src/lib/api/schema.mjs';

// OX-S05 (PROPOSED NEW): every contract operation builds a validated request plan, effects
// are enforced by mode and network, and responses are checked against the schema for their
// status independently of HTTP success.

const doc = JSON.parse(await readFile(new URL('../../spec/openapi.json', import.meta.url), 'utf8'));
const operations = JSON.parse(await readFile(new URL('../../site/src/data/operations.json', import.meta.url), 'utf8'));
const ORIGIN = 'https://gw.example';
const READ = { network: 'signet', gatewayOrigin: ORIGIN, mode: 'read-only' };
const WRITE = { network: 'signet', gatewayOrigin: ORIGIN, mode: 'write' };

function valuesFor(op) {
  const values = { path: {}, query: {}, header: {} };
  for (const p of operationParameters(doc, op)) {
    if (!(p.required || p.in === 'path')) continue;
    const ex = exampleForSchema(p.schema || { type: 'string' }, doc);
    values[p.in][p.name] = String(ex.ok ? ex.value : 'x');
  }
  return values;
}

test('every operation builds a complete plan with no unresolved path segments', () => {
  assert.equal(operations.length, 85);
  let withBody = 0;
  for (const op of operations) {
    const bodyText = op.requestExample ? JSON.stringify(op.requestExample) : '';
    const plan = buildRequestPlan({ doc, operation: op, origin: ORIGIN, values: valuesFor(op), bodyText });
    const bodyRequired = !!contractOperation(doc, op).requestBody?.required;
    if (bodyRequired && !op.requestExample) {
      assert.ok(plan.errors.some((e) => /body is required/.test(e)), op.operationId);
      continue;
    }
    assert.equal(plan.ok, true, `${op.operationId}: ${plan.errors.join('; ')}`);
    assert.doesNotMatch(plan.url, /[{}]/, op.operationId);
    assert.ok(plan.url.startsWith(`${ORIGIN}/`), op.operationId);
    if (plan.body) withBody++;
  }
  assert.ok(withBody > 10);
});

test('missing and invalid parameters are refused before sending', () => {
  const getOrder = operations.find((o) => o.operationId === 'getOrder');
  const missing = buildRequestPlan({ doc, operation: getOrder, origin: ORIGIN });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /path parameter .* is required/.test(e)));
  const withSlash = buildRequestPlan({ doc, operation: getOrder, origin: ORIGIN, values: { path: { [operationParameters(doc, getOrder)[0].name]: 'a/b?c' } } });
  assert.doesNotMatch(withSlash.url, /a\/b\?c/, 'path values are encoded');
  const intParam = operations.flatMap((o) => operationParameters(doc, o).map((p) => [o, p])).find(([, p]) => p.schema?.type === 'integer');
  if (intParam) {
    const [op, p] = intParam;
    const v = valuesFor(op);
    v[p.in][p.name] = '1.5';
    assert.equal(buildRequestPlan({ doc, operation: op, origin: ORIGIN, values: v, bodyText: op.requestExample ? JSON.stringify(op.requestExample) : '' }).ok, false);
  }
  assert.ok(buildRequestPlan({ doc, operation: getOrder, origin: '', values: valuesFor(getOrder) }).errors.includes('No gateway origin is configured'));
});

test('bodies are validated against the schema and unsafe integers are refused', () => {
  const op = operations.find((o) => o.requestExample && contractOperation(doc, o).requestBody);
  assert.equal(buildRequestPlan({ doc, operation: op, origin: ORIGIN, values: valuesFor(op), bodyText: '{not json' }).ok, false);
  assert.equal(buildRequestPlan({ doc, operation: op, origin: ORIGIN, values: valuesFor(op), bodyText: '{}' }).ok, false);
  assert.throws(() => parseExactJson('{"amount": 21000000000000001}'), /cannot be represented exactly/);
  assert.deepEqual(parseExactJson('{"amount": "21000000000000001", "note": "12345678901234567890"}'), { amount: '21000000000000001', note: '12345678901234567890' });
  const get = operations.find((o) => o.method === 'GET' && !o.path.includes('{'));
  assert.ok(buildRequestPlan({ doc, operation: get, origin: ORIGIN, bodyText: '{}' }).errors.includes('This operation takes no request body'));
});

test('effects are classified from the contract', () => {
  const byEffect = (e) => operations.filter((o) => effectOf(o, contractOperation(doc, o)) === e).map((o) => o.operationId);
  assert.deepEqual(byEffect('broadcast').sort(), ['broadcastSafeOpsTransaction', 'broadcastSwapSession']);
  assert.ok(byEffect('operator').includes('adminWithdrawOrder'));
  assert.ok(byEffect('read').includes('getHealth'));
  assert.ok(byEffect('write').includes('publishAsk'));
});

test('read-only mode, mainnet and operator routes never send an effect; approval binds to the exact request', () => {
  const publish = operations.find((o) => o.operationId === 'importOrder' || o.operationId === 'publishAsk');
  const body = publish.requestExample ? JSON.stringify(publish.requestExample) : '{}';
  const plan = { ...buildRequestPlan({ doc, operation: publish, origin: ORIGIN, values: valuesFor(publish), bodyText: body }), ok: true, errors: [] };
  assert.equal(authorizePlan(plan, READ, null).allowed, false);
  assert.match(authorizePlan(plan, READ, null).reason, /Read-only mode/);
  assert.match(authorizePlan(plan, { ...WRITE, network: 'mainnet' }, null).reason, /Signet, Testnet4 or Regtest/);
  const needs = authorizePlan(plan, WRITE, null);
  assert.equal(needs.allowed, false);
  assert.equal(needs.needsApproval, true);
  const approval = planFingerprint(plan, WRITE);
  assert.equal(authorizePlan(plan, WRITE, approval).allowed, true);
  const changed = { ...plan, body: `${plan.body} ` };
  assert.equal(authorizePlan(changed, WRITE, approval).allowed, false, 'a changed body invalidates the approval');
  assert.equal(authorizePlan(plan, { ...WRITE, network: 'testnet4' }, approval).allowed, false, 'a changed network invalidates the approval');
  const admin = operations.find((o) => o.operationId === 'adminWithdrawOrder');
  const adminPlan = { ...buildRequestPlan({ doc, operation: admin, origin: ORIGIN, values: valuesFor(admin), bodyText: admin.requestExample ? JSON.stringify(admin.requestExample) : '' }), ok: true };
  assert.match(authorizePlan(adminPlan, WRITE, planFingerprint(adminPlan, WRITE)).reason, /Operator routes/);
  const health = operations.find((o) => o.operationId === 'getHealth');
  assert.equal(authorizePlan(buildRequestPlan({ doc, operation: health, origin: ORIGIN }), READ, null).allowed, true);
});

test('a 200 with a body the schema rejects is not a pass, and HTTP and contract results are separate', () => {
  const health = operations.find((o) => o.operationId === 'getHealth');
  const good = validateResponse({ doc, operation: health, status: 200, contentType: 'application/json', bodyText: JSON.stringify(health.responseExample) });
  assert.equal(good.http.ok, true);
  assert.equal(good.schema.state, 'valid');
  const bad = validateResponse({ doc, operation: health, status: 200, contentType: 'application/json', bodyText: '{"status":"fine"}' });
  assert.equal(bad.http.ok, true);
  assert.equal(bad.schema.state, 'invalid');
  assert.equal(validateResponse({ doc, operation: health, status: 200, contentType: 'text/html', bodyText: '<html>' }).schema.state, 'invalid');
  assert.equal(validateResponse({ doc, operation: health, status: 200, contentType: 'application/json', bodyText: 'nope' }).schema.state, 'invalid');
  const stream = operations.find((o) => o.operationId === 'streamOrdexEvents');
  assert.equal(validateResponse({ doc, operation: stream, status: 200, contentType: 'text/event-stream', bodyText: '' }).schema.state, 'not-validated');
  const getOrder = operations.find((o) => o.operationId === 'getOrder');
  const errEnvelope = exampleForSchema(doc.components.schemas.ErrorResponse, doc);
  if (errEnvelope.ok) {
    const r = validateResponse({ doc, operation: getOrder, status: 404, contentType: 'application/json', bodyText: JSON.stringify(errEnvelope.value) });
    assert.equal(r.http.ok, false);
    assert.equal(r.schema.state, 'valid');
  }
});

test('requests time out, cancel and report network failures with typed codes', async () => {
  const health = operations.find((o) => o.operationId === 'getHealth');
  const plan = buildRequestPlan({ doc, operation: health, origin: ORIGIN });
  const ok = await executePlan({ doc, operation: health, plan, fetchImpl: async () => new Response(JSON.stringify(health.responseExample), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.schema.state, 'valid');
  const down = await executePlan({ doc, operation: health, plan, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(down.code, 'NETWORK_ERROR');
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  assert.equal((await executePlan({ doc, operation: health, plan, fetchImpl: hang, timeoutMs: 20 })).code, 'TIMEOUT');
  const c = new AbortController();
  const pending = executePlan({ doc, operation: health, plan, fetchImpl: hang, signal: c.signal });
  c.abort();
  assert.equal((await pending).code, 'CANCELLED');
});

test('cURL reproduces the exact body through a POSIX shell, including apostrophes and newlines', () => {
  const tricky = `{"note":"it's\n  two lines","x":"$HOME \`id\`"}`;
  const probe = spawnSync('sh', ['-c', `printf %s ${shellQuote(tricky)}`], { encoding: 'utf8' });
  if (probe.error) return; // no POSIX shell on this host; CI runs Linux
  assert.equal(probe.stdout, tricky);
  const health = operations.find((o) => o.operationId === 'getHealth');
  const curl = curlFor(buildRequestPlan({ doc, operation: health, origin: ORIGIN }));
  assert.match(curl, /^curl -X GET 'https:\/\/gw\.example\/api\/ordex\/health'/);
  assert.doesNotMatch(curl, /authorization/i);
});
