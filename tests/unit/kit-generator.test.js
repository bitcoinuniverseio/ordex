import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { KIT_CAPABILITIES, KIT_RUNTIMES, createKitZip, generateKit, validateKitOptions, verifyKitZip } from '../../site/src/lib/kits/generator.ts';
import { buildKitAssets } from '../../scripts/docs/build-kit-assets.mjs';
import { ALL_CAPABILITIES, loadKitAssets, startFakeGateway, verifyKit } from '../../scripts/docs/verify-kits.mjs';

// OX-S06: assertions against the real generator output, and every runtime extracted, built,
// tested and started with its pinned tools (npm ci from the kit lockfile runs in CI through
// scripts/docs/verify-kits.mjs --install).

const assets = loadKitAssets();
const base = { runtime: 'node', capabilities: ['asks', 'events'], mode: 'offline', network: 'mainnet', gatewayOrigin: '', revision: 'abcdef1' };
const fileMap = (o) => Object.fromEntries(generateKit(o, assets).files.map((f) => [f.path, f.content]));

test('the committed kit assets match their sources (SDK build, vectors, crypto shim, lock entries)', () => {
  assert.deepEqual(buildKitAssets(), assets);
  for (const cap of KIT_CAPABILITIES) {
    const text = readFileSync(new URL(`../../conformance/${assets.fixtures[cap.id].file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(assets.fixtures[cap.id].text, text, cap.id);
  }
});

test('options are validated: capabilities, mode, network, origin without credentials, revision', () => {
  assert.deepEqual(validateKitOptions(base), []);
  assert.ok(validateKitOptions({ ...base, capabilities: [] }).length);
  assert.ok(validateKitOptions({ ...base, capabilities: ['nope'] }).length);
  assert.ok(validateKitOptions({ ...base, runtime: 'deno' }).length);
  assert.ok(validateKitOptions({ ...base, network: 'moonnet' }).length);
  assert.ok(validateKitOptions({ ...base, mode: 'gateway' }).length, 'gateway mode needs an origin');
  assert.ok(validateKitOptions({ ...base, mode: 'gateway', gatewayOrigin: 'https://user:pw@gw.example' }).length);
  assert.ok(validateKitOptions({ ...base, mode: 'gateway', gatewayOrigin: 'http://gw.example' }).length, 'plain http only on loopback');
  assert.deepEqual(validateKitOptions({ ...base, mode: 'gateway', gatewayOrigin: 'http://127.0.0.1:8080' }), []);
  assert.ok(validateKitOptions({ ...base, revision: 'main' }).length);
  assert.throws(() => generateKit({ ...base, capabilities: [] }, assets), /at least one capability/);
});

test('generation is deterministic, and the ZIP bytes are reproducible and read back exactly', async () => {
  const a = generateKit(base, assets);
  const b = generateKit(base, assets);
  assert.deepEqual(a, b);
  const zipA = await createKitZip(a.name, a.files, JSZip);
  const zipB = await createKitZip(b.name, b.files, JSZip);
  assert.deepEqual(Buffer.from(zipA), Buffer.from(zipB));
  assert.deepEqual(await verifyKitZip(a.name, a.files, zipA, JSZip), []);
  const tampered = a.files.map((f) => (f.path === 'src/config.ts' ? { ...f, content: `${f.content}// x\n` } : f));
  assert.deepEqual(await verifyKitZip(a.name, tampered, zipA, JSZip), [`changed ${a.name}/src/config.ts`]);
});

test('each runtime gets its own entry, build and start; tools are pinned in package.json and the lockfile', () => {
  for (const { id } of KIT_RUNTIMES) {
    const files = fileMap({ ...base, runtime: id });
    const pkg = JSON.parse(files['package.json']);
    const lock = JSON.parse(files['package-lock.json']);
    assert.equal(pkg.name, `ordex-${id}-kit`);
    assert.equal(pkg.engines.node, assets.node);
    assert.equal(pkg.dependencies['@bitcoinuniverse/ordex-sdk'], 'file:vendor/ordex-sdk');
    assert.equal(pkg.devDependencies.typescript, '5.9.3');
    assert.equal(pkg.devDependencies['@types/node'], '24.10.1');
    assert.match(pkg.scripts.start, /^npm run build && /, 'start builds first');
    assert.match(pkg.scripts.test, /^npm run build && node --test/);
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      const entry = lock.packages[`node_modules/${name}`];
      assert.equal(entry.version, version, name);
      assert.match(entry.integrity, /^sha512-/, name);
    }
    assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
    assert.equal(lock.packages['node_modules/@bitcoinuniverse/ordex-sdk'].link, true);
    if (id === 'node') {
      assert.ok(files['src/index.ts']);
      assert.equal(pkg.devDependencies.esbuild, undefined);
      assert.ok(!Object.keys(lock.packages).some((k) => k.includes('esbuild')));
    } else {
      assert.equal(pkg.devDependencies.esbuild, '0.28.2');
      assert.match(files['scripts/bundle.mjs'], id === 'browser' ? /platform: 'browser'/ : /platform: 'neutral'/);
      assert.equal(files['src/shims/node-crypto.js'], assets.cryptoShim.text);
      assert.doesNotMatch(files[id === 'browser' ? 'src/main.ts' : 'src/worker.ts'], /process\.env|from 'node:/);
    }
    if (id === 'browser') assert.match(files['public/index.html'], /<script type="module" src=".\/app.js">/);
    if (id === 'worker') assert.match(files['src/worker.ts'], /export default \{\n {2}async fetch\(request: Request, env: Env = \{\}\)/);
  }
});

test('capabilities decide the SDK calls, fixtures and gateway reads; the SDK is vendored as built', () => {
  const files = fileMap({ ...base, capabilities: ['swaps'] });
  assert.match(files['src/capabilities.ts'], /import \{ verifySwapAcceptance, verifySwapIntent \} from '@bitcoinuniverse\/ordex-sdk';/);
  assert.doesNotMatch(files['src/capabilities.ts'], /verifyPublicAskCompletion/);
  assert.deepEqual(Object.keys(files).filter((p) => p.startsWith('fixtures/')), ['fixtures/swap-vectors.json']);
  assert.equal(files['fixtures/swap-vectors.json'], assets.fixtures.swaps.text);
  for (const [path, text] of Object.entries(assets.sdk.files)) assert.equal(files[`vendor/ordex-sdk/${path}`], text);
  const all = fileMap({ ...base, capabilities: ALL_CAPABILITIES });
  assert.equal(Object.keys(all).filter((p) => p.startsWith('fixtures/')).length, 6);
});

test('mode and network are labeled; no credentials; CI runs on self-hosted runners with pinned actions', () => {
  const offline = fileMap(base);
  assert.match(offline['src/config.ts'], /MODE: 'offline' \| 'gateway' = 'offline'/);
  assert.match(offline['src/config.ts'], /GATEWAY_ORIGIN = ''/);
  const gw = fileMap({ ...base, mode: 'gateway', network: 'signet', gatewayOrigin: 'https://gateway.example/' });
  assert.match(gw['src/config.ts'], /GATEWAY_ORIGIN = 'https:\/\/gateway.example'/);
  assert.match(gw['src/config.ts'], /NETWORK = 'signet'/);
  assert.match(gw['README.md'], /serves \*\*signet\*\*/);
  assert.match(gw['README.md'], /never holds keys, signs or broadcasts/);
  for (const files of [offline, gw]) {
    const ci = files['.github/workflows/ci.yml'];
    assert.doesNotMatch(ci, /ubuntu-latest|windows-latest|macos-latest/);
    assert.match(ci, /runs-on: \[self-hosted/);
    for (const uses of ci.match(/uses: \S+/g)) assert.match(uses, /@[0-9a-f]{40}$/, uses);
    assert.match(ci, /npm ci/);
    for (const [path, text] of Object.entries(files)) {
      if (path.startsWith('vendor/') || path.startsWith('fixtures/')) continue;
      assert.doesNotMatch(text, /password|api[_-]?key|BEGIN [A-Z ]*PRIVATE KEY|xprv/i, path);
    }
  }
});

test('every runtime builds, passes its own tests and starts, offline and against a gateway', { timeout: 600000 }, async () => {
  const signet = await startFakeGateway('signet');
  const mainnet = await startFakeGateway('mainnet');
  try {
    for (const runtime of ['node', 'browser', 'worker']) {
      for (const mode of ['offline', 'gateway']) {
        const r = await verifyKit({ runtime, capabilities: ALL_CAPABILITIES, mode, network: 'signet', gatewayOrigin: mode === 'gateway' ? signet.origin : '', revision: 'abcdef1' });
        assert.match(r.testOutput, /fail 0/, `${runtime} ${mode}`);
        if (runtime === 'node') assert.match(r.startOutput, /104\/104 conformance cases give the recorded verdict/);
        if (runtime === 'node' && mode === 'gateway') assert.match(r.startOutput, /ok {5}network: signet/);
      }
    }
    // The same kit pointed at a mainnet gateway refuses it at start.
    await assert.rejects(verifyKit({ runtime: 'node', capabilities: ['asks'], mode: 'gateway', network: 'signet', gatewayOrigin: mainnet.origin, revision: 'abcdef1' }), /The gateway serves mainnet; this kit is configured for signet/);
  } finally {
    await signet.close();
    await mainnet.close();
  }
});
