import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { OrdexClient, SDK_EXCLUDED_OPERATIONS } from '../dist/index.js';

// OX-P06: every operation in spec/openapi.json is either a client method of the
// same name, checked here against the contract's method, path template, query
// and header parameters, request media and success status, or a documented
// exclusion.

const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../../spec/openapi.json', import.meta.url)), 'utf8'));
const resolve = (node) => (node && node.$ref ? node.$ref.slice(2).split('/').reduce((at, key) => at[key], contract) : node);

const operations = [];
for (const [path, item] of Object.entries(contract.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = item[method];
    if (!op) continue;
    const parameters = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolve);
    const success = Object.keys(op.responses).find((status) => /^2/.test(status));
    const media = Object.keys(resolve(op.responses[success]).content ?? {});
    operations.push({
      id: op.operationId,
      method: method.toUpperCase(),
      path,
      parameters,
      body: op.requestBody ? resolve(op.requestBody) : null,
      success: Number(success),
      media,
      developer: (op.security ?? []).some((s) => 'developerBearer' in s),
    });
  }
}

const SAMPLE = 'id/ä 1';
const sampleValue = (schema) => {
  const s = resolve(schema) ?? {};
  if (s.enum) return s.enum[0];
  if (s.type === 'integer' || s.type === 'number') return 5;
  if (s.type === 'boolean') return true;
  return 'q-value';
};

// How each wrapped operation is called: path params in template order, then
// the query object, the header values and the body the contract declares.
const CALLS = {
  getHealth: (c) => c.getHealth(),
  getProtocol: (c) => c.getProtocol(),
  getCatalog: (c) => c.getCatalog(),
  getOperation: (c, a) => c.getOperation(a.path[0]),
  listOrders: (c, a) => c.listOrders(a.query),
  listActivity: (c, a) => c.listActivity(a.query),
  getOrder: (c, a) => c.getOrder(a.path[0]),
  getOrderArtifact: (c, a) => c.getOrderArtifact(a.path[0]),
  importOrder: (c, a) => c.importOrder(a.body),
  importOpenOrdexEvent: (c, a) => c.importOpenOrdexEvent(a.body),
  buildAsk: (c, a) => c.buildAsk(a.body),
  publishAsk: (c, a) => c.publishAsk(a.body, { idempotencyKey: a.headers['idempotency-key'] }),
  getOwnershipChallenge: (c, a) => c.getOwnershipChallenge(a.path[0]),
  withdrawOrder: (c, a) => c.withdrawOrder(a.path[0], a.body, { idempotencyKey: a.headers['idempotency-key'] }),
  replaceOrder: (c, a) => c.replaceOrder(a.path[0], a.body, { idempotencyKey: a.headers['idempotency-key'] }),
  adminWithdrawOrder: (c, a) => c.adminWithdrawOrder(a.path[0], a.body, { username: 'op', password: 'pw' }),
  getNostrEnvelope: (c, a) => c.getNostrEnvelope(a.path[0]),
  revalidateOrder: (c, a) => c.revalidateOrder(a.path[0]),
  quoteOrder: (c, a) => c.quoteOrder(a.path[0], a.body),
  preflightOrder: (c, a) => c.preflightOrder(a.path[0], a.body),
  composeBatchPurchase: (c, a) => c.composeBatchPurchase(a.body),
  preflightBatchPurchase: (c, a) => c.preflightBatchPurchase(a.body),
  createSafeOpsPlan: (c, a) => c.createSafeOpsPlan(a.body),
  getSafeOpsPlan: (c, a) => c.getSafeOpsPlan(a.path[0]),
  refreshExecutionShield: (c, a) => c.refreshExecutionShield(a.path[0], a.body),
  getSafeOpsOperation: (c, a) => c.getSafeOpsOperation(a.path[0]),
  planSafeOpsRbf: (c, a) => c.planSafeOpsRbf(a.body),
  planSafeOpsCpfp: (c, a) => c.planSafeOpsCpfp(a.body),
  publishSwapIntent: (c, a) => c.publishSwapIntent(a.body),
  listSwapIntents: (c, a) => c.listSwapIntents(a.query),
  getSwapIntent: (c, a) => c.getSwapIntent(a.path[0]),
  withdrawSwapIntent: (c, a) => c.withdrawSwapIntent(a.path[0], a.body),
  buildSwapAcceptancePlan: (c, a) => c.buildSwapAcceptancePlan(a.path[0], a.body),
  getSwapSession: (c, a) => c.getSwapSession(a.path[0]),
  submitSwapSignature: (c, a) => c.submitSwapSignature(a.path[0], a.body),
  preflightSwapSession: (c, a) => c.preflightSwapSession(a.path[0]),
  storePrivateSwap: (c, a) => c.storePrivateSwap(a.body),
  listPrivateSwaps: (c) => c.listPrivateSwaps(),
  getPrivateSwap: (c, a) => c.getPrivateSwap(a.path[0]),
  destroyPrivateSwap: (c, a) => c.destroyPrivateSwap(a.path[0], a.body),
  listOrdexEvents: (c, a) => c.listOrdexEvents(a.query),
  streamOrdexEvents: (c, a) => c.streamOrdexEvents(a.query, { lastEventId: a.headers['last-event-id'] }),
  getEventStreamCheckpoint: (c, a) => c.getEventStreamCheckpoint(a.query),
  createWebhookSubscription: (c, a) => c.createWebhookSubscription(a.body),
  listWebhookSubscriptions: (c) => c.listWebhookSubscriptions(),
  getWebhookSubscription: (c, a) => c.getWebhookSubscription(a.path[0]),
  updateWebhookSubscription: (c, a) => c.updateWebhookSubscription(a.path[0], a.body),
  deleteWebhookSubscription: (c, a) => c.deleteWebhookSubscription(a.path[0]),
  rotateWebhookSecret: (c, a) => c.rotateWebhookSecret(a.path[0]),
  verifyWebhookEndpoint: (c, a) => c.verifyWebhookEndpoint(a.path[0], a.body),
  testWebhookSubscription: (c, a) => c.testWebhookSubscription(a.path[0]),
  listWebhookDeliveries: (c, a) => c.listWebhookDeliveries(a.query),
  replayWebhookDelivery: (c, a) => c.replayWebhookDelivery(a.path[0]),
  publishCollectionManifest: (c, a) => c.publishCollectionManifest(a.body),
  listCollectionManifests: (c, a) => c.listCollectionManifests(a.query),
  getCollectionManifest: (c, a) => c.getCollectionManifest(a.path[0]),
  getCollectionMembershipProof: (c, a) => c.getCollectionMembershipProof(a.path[0], a.path[1]),
  reviseCollectionManifest: (c, a) => c.reviseCollectionManifest(a.path[0], a.body),
  getCollectionProvenance: (c, a) => c.getCollectionProvenance(a.path[0], a.query),
  getHeritageReadiness: (c) => c.getHeritageReadiness(),
  getHeritageAsset: (c, a) => c.getHeritageAsset(a.path[0], a.query),
  listHeritageAssetUtxos: (c, a) => c.listHeritageAssetUtxos(a.path[0], a.query),
  listHeritageAddressAssets: (c, a) => c.listHeritageAddressAssets(a.path[0]),
  buildHeritageAttach: (c, a) => c.buildHeritageAttach(a.body),
  buildHeritageDetach: (c, a) => c.buildHeritageDetach(a.body),
  openSigningSession: (c, a) => c.openSigningSession(a.body),
  listSigningSessions: (c, a) => c.listSigningSessions(a.headers['x-ordex-signing-capability'].split(','), a.query),
  getSigningSession: (c, a) => c.getSigningSession(a.path[0], a.headers['x-ordex-signing-capability']),
  submitSignedResult: (c, a) => c.submitSignedResult(a.path[0], a.headers['x-ordex-signing-capability'], a.body),
  verifySigningArtifacts: (c, a) => c.verifySigningArtifacts(a.body),
};

const HEADER_SAMPLES = {
  'idempotency-key': 'op-7',
  'x-ordex-signing-capability': 'sgr_a,sgi_b',
  'last-event-id': 'evt-9',
};

function argumentsFor(op) {
  const pathNames = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const query = {};
  for (const p of op.parameters.filter((p) => p.in === 'query')) query[p.name] = sampleValue(p.schema);
  const headers = {};
  for (const p of op.parameters.filter((p) => p.in === 'header')) headers[p.name] = HEADER_SAMPLES[p.name];
  return {
    path: pathNames.map((name, i) => `${SAMPLE}${i}`),
    pathNames,
    query,
    headers,
    body: op.body ? { operation: op.id, amountSats: '1000' } : undefined,
  };
}

function stubFetch(answer) {
  const calls = [];
  const stub = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return answer();
  };
  return { calls, stub };
}

test('every contract operation is a client method or a documented exclusion, never both', () => {
  const methods = new Set(Object.getOwnPropertyNames(OrdexClient.prototype));
  const wrapped = operations.filter((op) => methods.has(op.id));
  const excluded = operations.filter((op) => op.id in SDK_EXCLUDED_OPERATIONS);
  for (const op of operations) {
    const isMethod = methods.has(op.id);
    const isExcluded = op.id in SDK_EXCLUDED_OPERATIONS;
    assert.ok(isMethod !== isExcluded, `${op.id} must be exactly one of wrapped or excluded`);
  }
  for (const [id, reason] of Object.entries(SDK_EXCLUDED_OPERATIONS)) {
    assert.ok(operations.some((op) => op.id === id), `excluded ${id} is not a contract operation`);
    assert.ok(typeof reason === 'string' && reason.length > 20, `${id} needs a reason`);
  }
  assert.equal(operations.length, 79);
  assert.equal(wrapped.length, 70);
  assert.equal(excluded.length, 9);
  assert.deepEqual(Object.keys(CALLS).sort(), wrapped.map((op) => op.id).sort());
});

test('the client never broadcasts: every relay route is excluded', () => {
  for (const op of operations.filter((o) => /broadcast/i.test(o.id) || /broadcast/i.test(o.path))) {
    assert.ok(op.id in SDK_EXCLUDED_OPERATIONS, `${op.id} relays to the network and must not be wrapped`);
  }
});

for (const op of operations.filter((o) => o.id in CALLS)) {
  test(`${op.id}: ${op.method} ${op.path} as the contract states`, async () => {
    const args = argumentsFor(op);
    const stream = op.media.includes('text/event-stream');
    const payload = { answeredBy: op.id };
    const { calls, stub } = stubFetch(() =>
      stream
        ? new Response(`id: 1\nevent: ordex-event\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : new Response(JSON.stringify(payload), { status: op.success, headers: { 'content-type': 'application/json' } }),
    );
    const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, developerKey: 'dev-key' });
    let answer = CALLS[op.id](client, args);
    if (stream) {
      const messages = [];
      for await (const message of answer) messages.push(message);
      answer = messages;
      assert.deepEqual(messages, [{ id: '1', event: 'ordex-event', data: payload }]);
    } else {
      assert.deepEqual(await answer, payload);
      assert.deepEqual(op.media, ['application/json']);
    }
    assert.equal(calls.length, 1);
    const [{ url, init }] = calls;
    assert.equal(init.method, op.method);
    const expectedPath = args.pathNames.reduce((p, name, i) => p.replace(`{${name}}`, encodeURIComponent(args.path[i])), op.path);
    assert.equal(url.pathname, expectedPath);
    assert.deepEqual(Object.fromEntries(url.searchParams), Object.fromEntries(Object.entries(args.query).map(([k, v]) => [k, String(v)])));
    for (const [name, value] of Object.entries(args.headers)) assert.equal(init.headers[name], value, `header ${name}`);
    assert.equal(init.headers.accept, stream ? 'text/event-stream' : 'application/json');
    if (args.body === undefined) assert.equal(init.body ?? null, null);
    else {
      assert.equal(init.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), args.body);
    }
    if (op.developer) assert.equal(init.headers.authorization, 'Bearer dev-key');
    else if (op.id !== 'adminWithdrawOrder') assert.equal(init.headers.authorization, undefined, 'the developer key goes to webhook routes only');
  });
}

test('no write is retried, whatever the retry budget', async () => {
  for (const op of operations.filter((o) => o.id in CALLS && o.method !== 'GET')) {
    const { calls, stub } = stubFetch(() => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, retries: 5, retryDelayMs: 0 });
    await assert.rejects(Promise.resolve(CALLS[op.id](client, argumentsFor(op))), (error) => error.status === 503, op.id);
    assert.equal(calls.length, 1, `${op.id} was sent ${calls.length} times`);
  }
});
