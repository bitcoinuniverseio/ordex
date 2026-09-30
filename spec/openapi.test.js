import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const documentPath = fileURLToPath(new URL('./openapi.json', import.meta.url));
const document = JSON.parse(await readFile(documentPath, 'utf8'));

test('the contract is OpenAPI 3.1 with a version and a description', () => {
  assert.ok(document.openapi.startsWith('3.1'));
  assert.ok(document.info.version.length > 0);
  assert.ok(document.info.description.length > 0);
});

test('every path is served under /api/ordex', () => {
  for (const path of Object.keys(document.paths)) {
    assert.ok(path.startsWith('/api/ordex'), path);
  }
});

const operations = [];
for (const [path, item] of Object.entries(document.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    if (item[method]) operations.push({ path, method, operation: item[method] });
  }
}

test('every operation names an operationId, a summary, a tag, and responses', () => {
  for (const { path, method, operation } of operations) {
    const where = `${method.toUpperCase()} ${path}`;
    assert.ok(operation.operationId, where);
    assert.ok(operation.summary, where);
    assert.ok(Array.isArray(operation.tags) && operation.tags.length > 0, where);
    assert.ok(operation.responses && Object.keys(operation.responses).length > 0, where);
  }
});

test('operation ids are unique', () => {
  const ids = operations.map(({ operation }) => operation.operationId);
  assert.equal(new Set(ids).size, ids.length);
});

test('every read declares 200 and every write declares 201', () => {
  for (const { path, method, operation } of operations) {
    const where = `${method.toUpperCase()} ${path}`;
    if (method === 'get') assert.ok(operation.responses['200'], where);
    // A write answers 201, unless it declares x-ordex-success-status 200 because
    // repeating it answers the stored state instead of creating anything.
    if (method === 'post') assert.ok(operation.responses[operation['x-ordex-success-status'] === 200 ? '200' : '201'], where);
  }
});

test('every operation declares a default error response', () => {
  for (const { path, method, operation } of operations) {
    assert.ok(operation.responses.default, `${method.toUpperCase()} ${path}`);
  }
});

test('every tag an operation uses is declared', () => {
  const declared = new Set((document.tags ?? []).map((tag) => tag.name));
  for (const { path, method, operation } of operations) {
    for (const tag of operation.tags) {
      assert.ok(declared.has(tag), `${method.toUpperCase()} ${path} uses undeclared tag ${tag}`);
    }
  }
});

test('every internal reference resolves', () => {
  const refs = [];
  const collect = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => collect(item, `${where}[${index}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref') refs.push({ ref: value, where });
        else collect(value, `${where}.${key}`);
      }
    }
  };
  collect(document, '$');
  assert.ok(refs.length > 0);
  for (const { ref, where } of refs) {
    assert.ok(ref.startsWith('#/'), `${where}: external reference ${ref}`);
    let node = document;
    for (const segment of ref.slice(2).split('/')) {
      node = node?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    assert.ok(node !== undefined, `${where}: unresolved reference ${ref}`);
  }
});

test('atomic amounts are strings, never numbers', () => {
  const sats = document.components.schemas.AtomicSats;
  assert.equal(sats.type, 'string');
  assert.ok(sats.pattern);
});

test('every purchase route documents a coded, retryable 503', () => {
  const at = (ref) => ref.slice(2).split('/').reduce((node, key) => node[key], document);
  const codes = document.components.schemas.PurchaseUnavailableCode.enum;
  for (const code of ['ORDER_CHECKING', 'INPUT_INVENTORY_UNAVAILABLE']) assert.ok(codes.includes(code), code);
  for (const path of ['/api/ordex/orders/{id}/quote', '/api/ordex/orders/{id}/preflight', '/api/ordex/orders/batch-preflight']) {
    const response = document.paths[path].post.responses['503'];
    assert.equal(response?.$ref, '#/components/responses/PurchaseUnavailable', path);
  }
  const single = at(document.components.responses.PurchaseUnavailable.content['application/json'].schema.$ref);
  assert.deepEqual(single.allOf[1].properties.code, { $ref: '#/components/schemas/PurchaseUnavailableCode' });
  assert.ok(single.allOf[1].required.includes('code'));
  const batch = at(document.paths['/api/ordex/orders/batch-purchase'].post.responses['503'].content['application/json'].schema.$ref);
  assert.ok(batch.required.includes('code'));
  assert.deepEqual(batch.properties.refusals.items.allOf[0], { $ref: '#/components/schemas/BatchRefusal' });
  assert.equal(document.paths['/api/ordex/orders/batch-purchase'].post.responses['409'].content['application/json'].schema.$ref, '#/components/schemas/BatchPurchaseRefused');
});

test('what the buyer approves discloses every view of the sold inscription', () => {
  const s = document.components.schemas;
  assert.ok(s.Quote.required.includes('assetViews'));
  assert.ok(s.BatchPurchaseResult.properties.placements.items.required.includes('assetViews'));
  assert.deepEqual(s.PreflightResult.properties.assetViews.items, { $ref: '#/components/schemas/AssetView' });
});
