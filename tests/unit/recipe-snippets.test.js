import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { RECIPES, resolveValues, sdkProgram, fetchProgram, curlCommands } from '../../site/src/lib/docs/recipes.mjs';
import { buildRequestPlan } from '../../site/src/lib/api/request-plan.mjs';

// OX-S11 (PROPOSED NEW): recipe arguments are valid for the contract, the SDK and fetch
// programs type-check against the real SDK declarations, and the read recipe runs end to end
// against a loopback gateway that checks every request against the contract.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const doc = JSON.parse(readFileSync(join(root, 'spec', 'openapi.json'), 'utf8'));
const operations = JSON.parse(readFileSync(join(root, 'site', 'src', 'data', 'operations.json'), 'utf8'));
const kitAssets = JSON.parse(readFileSync(join(root, 'site', 'src', 'data', 'kitAssets.json'), 'utf8'));
const SAMPLE = { 'catalog[0].id': 'ordinals', 'page.orders[0].id': 'ord_1', 'published.id': 'ord_2', sellerSignedPsbt: 'cHNidP8BAAoCAAAAAAAAAAAAAAAA', buyerSignedPsbt: 'cHNidP8BAAoCAAAAAAAAAAAAAAAA' };

test('every recipe step is a contract operation with arguments the contract accepts', () => {
  for (const recipe of RECIPES) {
    for (const step of recipe.steps) {
      const op = operations.find((o) => o.operationId === step.operationId);
      assert.ok(op, step.operationId);
      const args = resolveValues(step.args || {}, (from) => {
        assert.ok(from in SAMPLE, `${from} is a known carried value`);
        return SAMPLE[from];
      });
      const values = { path: args.path || {}, query: args.query || {} };
      const plan = buildRequestPlan({ doc, operation: op, origin: 'http://127.0.0.1:8080', values, bodyText: args.body ? JSON.stringify(args.body) : '' });
      assert.deepEqual(plan.errors, [], `${recipe.id} ${step.operationId}`);
      assert.match(step.sdk, new RegExp(`^client\\.${step.operationId}\\(`), 'the SDK call names the same operation');
    }
  }
});

test('the SDK and fetch programs type-check against the SDK declarations', () => {
  const dir = mkdtempSync(join(root, 'dist', 'recipe-check-'));
  try {
    const sdk = join(dir, 'node_modules', '@bitcoinuniverse', 'ordex-sdk');
    for (const [path, text] of Object.entries(kitAssets.sdk.files)) {
      mkdirSync(dirname(join(sdk, path)), { recursive: true });
      writeFileSync(join(sdk, path), text);
    }
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@bitcoinuniverse/ordex-sdk', type: 'module', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }));
    mkdirSync(join(dir, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(root, 'node_modules', '@types', 'node'), join(dir, 'node_modules', '@types', 'node'), 'junction');
    symlinkSync(join(root, 'node_modules', 'undici-types'), join(dir, 'node_modules', 'undici-types'), 'junction');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: ['node'], lib: ['ES2022', 'DOM'] }, include: ['*.ts'] }));
    for (const recipe of RECIPES) {
      writeFileSync(join(dir, `${recipe.id}-sdk.ts`), `${sdkProgram(recipe)}\nexport {};\n`);
      writeFileSync(join(dir, `${recipe.id}-fetch.ts`), `${fetchProgram(recipe, operations)}\nexport {};\n`);
    }
    try {
      execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
    } catch (err) {
      assert.fail(err.stdout || err.message);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the read recipe runs against a gateway and sends exactly the contract requests', async () => {
  const seen = [];
  const bodies = {
    '/api/ordex/health': { ok: true, status: 'active', network: 'signet' },
    '/api/ordex/protocol': { network: 'signet', protocolVersion: '1.2' },
    '/api/ordex/orders': { orders: [{ id: 'ord_1' }], total: 1, limit: 20, nextCursor: '', hasMore: false },
    '/api/ordex/orders/ord_1': { id: 'ord_1', state: 'OPEN' }
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    const body = bodies[url.pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? { statusCode: 404, error: 'Not Found', message: 'no' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(root, 'dist', 'recipe-run-'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const saved = process.env.ORDEX_GATEWAY_ORIGIN;
  process.env.ORDEX_GATEWAY_ORIGIN = origin;
  const log = console.log;
  console.log = () => {};
  try {
    const js = ts.transpileModule(fetchProgram(RECIPES[0], operations), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const file = join(dir, 'read.mjs');
    writeFileSync(file, `${js}\nexport {};\n`);
    await import(pathToFileURL(file).href);
  } finally {
    console.log = log;
    process.env.ORDEX_GATEWAY_ORIGIN = saved;
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(seen, ['GET /api/ordex/health', 'GET /api/ordex/protocol', 'GET /api/ordex/orders?limit=20&sort=newest', 'GET /api/ordex/orders/ord_1']);
});

test('the cURL view carries values with jq and never embeds secrets', () => {
  const text = curlCommands(RECIPES[1], operations);
  assert.match(text, /CATALOG_0_ID=\$\(jq -r '\.\[0\]\.id' catalog\.json\)/);
  assert.match(text, /\/api\/ordex\/orders\/\$PUBLISHED_ID\/preflight/);
  assert.match(text, /: "\$\{SELLER_SIGNED_PSBT:\?set it first\}"/);
  assert.doesNotMatch(text, /password|xprv|Authorization/i);
});
