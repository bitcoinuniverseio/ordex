import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ORDEX_EVENT_SCHEMA,
  eventSortKey,
  signWebhookDelivery,
  validateOrdexEvent,
  verifyWebhookSignature,
} from './events.js';

const vectorsPath = fileURLToPath(new URL('../conformance/event-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    if (vector.kind === 'webhook') {
      const header = vector.verifying.headerOverride || signWebhookDelivery(vector.signing);
      const { headerOverride, ...rest } = vector.verifying;
      const verdict = verifyWebhookSignature({ header, ...rest });
      assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
      if (!vector.expected.ok) assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
      return;
    }
    const verdict = validateOrdexEvent(vector.event);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (!vector.expected.ok) assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
  });
}

test('the schema name is stable', () => {
  assert.equal(ORDEX_EVENT_SCHEMA, 'ordex-event/v1');
});

test('a malformed event is refused, never thrown on', () => {
  assert.equal(validateOrdexEvent(null).ok, false);
  assert.equal(validateOrdexEvent('event').ok, false);
  assert.equal(validateOrdexEvent({}).code, 'SCHEMA_UNSUPPORTED');
});

test('the replay sort key orders by network, then sequence, then id', () => {
  const base = { network: 'mainnet' };
  const a = eventSortKey({ ...base, sequence: 1, id: 'aaaaaaaa-0000-4000-8000-000000000001' });
  const b = eventSortKey({ ...base, sequence: 2, id: 'aaaaaaaa-0000-4000-8000-000000000000' });
  const c = eventSortKey({ ...base, sequence: 2, id: 'bbbbbbbb-0000-4000-8000-000000000000' });
  assert.ok(a < b, 'sequence one sorts before sequence two');
  assert.ok(b < c, 'equal sequences break ties by id');
  const regtest = eventSortKey({ network: 'regtest', sequence: 99, id: 'cccccccc-0000-4000-8000-000000000000' });
  assert.ok(regtest.startsWith('regtest:'), 'the key names its network so replays never cross networks');
});

test('the signer and the verifier agree about an unchanged body', () => {
  const header = signWebhookDelivery({ secret: 's', timestamp: 10, deliveryId: 'd', body: 'b' });
  assert.match(header, /^t=10,d=d,v1=[0-9a-f]{64}$/);
  assert.equal(verifyWebhookSignature({ header, secret: 's', body: 'b', nowSeconds: 20, toleranceSeconds: 300 }).ok, true);
});
