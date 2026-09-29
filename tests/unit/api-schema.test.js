import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateSchema, exampleForSchema, resolveRef } from '../../site/src/lib/api/schema.mjs';

const openapi = JSON.parse(await readFile(new URL('../../spec/openapi.json', import.meta.url), 'utf8'));
const operations = JSON.parse(await readFile(new URL('../../site/src/data/operations.json', import.meta.url), 'utf8'));

const successSchema = (op) => {
  const raw = openapi.paths[op.path][op.method.toLowerCase()];
  const code = Object.keys(raw.responses).find((c) => /^2\d\d$/.test(c));
  if (!code) return null;
  const response = raw.responses[code].$ref ? resolveRef(raw.responses[code].$ref, openapi) : raw.responses[code];
  return response?.content?.['application/json']?.schema || null;
};

test('validator enforces type, const, enum, pattern, required, oneOf, allOf and nullable', () => {
  const doc = { components: { schemas: { Sats: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } } };
  const schema = {
    type: 'object',
    required: ['v', 'amount'],
    additionalProperties: false,
    properties: {
      v: { const: '1' },
      kind: { enum: ['a', 'b'] },
      amount: { allOf: [{ $ref: '#/components/schemas/Sats' }] },
      either: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      maybe: { type: 'string', nullable: true }
    }
  };
  assert.deepEqual(validateSchema({ v: '1', amount: '10', either: 3, maybe: null }, schema, doc), []);
  const bad = validateSchema({ v: '2', kind: 'c', amount: 10, either: true, extra: 1 }, schema, doc).map((e) => e.path);
  assert.deepEqual(bad.sort(), ['$.amount', '$.either', '$.extra', '$.kind', '$.v'].sort());
  assert.ok(validateSchema({}, schema, doc).some((e) => e.path === '$.amount'));
  assert.ok(validateSchema(1, { type: 'string', madeUp: true }, doc).some((e) => /madeUp is not supported/.test(e.message)));
});

test('every published request and response example validates against its contract schema', () => {
  let checked = 0;
  for (const op of operations) {
    if (op.requestExample !== null) {
      assert.deepEqual(validateSchema(op.requestExample, op.requestBodySchema, openapi), [], `${op.operationId} request`);
      checked++;
    }
    const schema = successSchema(op);
    if (op.responseExample !== null) {
      assert.ok(schema, `${op.operationId} has an example without a schema`);
      assert.deepEqual(validateSchema(op.responseExample, schema, openapi), [], `${op.operationId} response`);
      checked++;
    }
  }
  assert.ok(checked >= 80, `only ${checked} examples checked`);
});

test('a missing example states why instead of claiming a generic success body', () => {
  for (const op of operations) {
    if (op.requestBodySchema && op.requestExample === null) assert.ok(op.requestExampleIssue, op.operationId);
    if (op.responseExample === null) assert.ok(op.responseExampleIssue, op.operationId);
    assert.notDeepEqual(op.responseExample, { status: 200, ok: true }, op.operationId);
  }
});

test('an example is refused when the contract requires a property it never defines', () => {
  const r = exampleForSchema({ type: 'object', required: ['ghost'], properties: {} }, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /ghost has no schema/);
});
