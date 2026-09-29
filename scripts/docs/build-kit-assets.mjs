// OX-S06: everything a generated starter kit vendors, gathered into one data file the Kits
// page loads on demand (site/src/data/kitAssets.json):
//   - the SDK in sdk/ compiled with the repository's pinned TypeScript (JS and .d.ts), since
//     @bitcoinuniverse/ordex-sdk is not published to a registry
//   - the checked-in conformance vector files for each kit capability, exact text and digest
//   - the browser implementation of node:crypto used by the site (site/src/lib/browser)
//   - lockfile entries for the kit's pinned dev tools, copied from package-lock.json
// Output is deterministic so the committed file only changes when a source changes.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lf = (text) => text.replace(/\r\n/g, '\n');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const readText = (...p) => lf(readFileSync(join(root, ...p), 'utf8'));

export const KIT_FIXTURES = {
  asks: 'purchase-vectors.json',
  offers: 'offer-vectors.json',
  safeops: 'safeops-vectors.json',
  swaps: 'swap-vectors.json',
  events: 'event-vectors.json',
  provenance: 'collection-manifest-vectors.json'
};
export const KIT_TOOL_PINS = { typescript: '5.9.3', '@types/node': '24.10.1', esbuild: '0.28.2' };

function compileSdk() {
  const out = mkdtempSync(join(tmpdir(), 'ordex-kit-sdk-'));
  try {
    execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'sdk', 'tsconfig.json'), '--outDir', out], { cwd: root, stdio: 'inherit' });
    const files = {};
    for (const name of readdirSync(out).sort()) files[`dist/${name}`] = lf(readFileSync(join(out, name), 'utf8'));
    return files;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function sdkSourceDigest() {
  const names = readdirSync(join(root, 'sdk', 'src')).filter((f) => f.endsWith('.ts')).sort();
  return sha256(names.map((n) => `${n}\n${readText('sdk', 'src', n)}`).join('\n'));
}

function lockEntries() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const wanted = (key) => /^node_modules\/(typescript|@types\/node|undici-types|esbuild|@esbuild\/[^/]+)$/.test(key);
  const entries = {};
  for (const key of Object.keys(lock.packages).filter(wanted).sort()) {
    const { dev, devOptional, peer, ...entry } = lock.packages[key];
    entries[key] = entry;
  }
  for (const [name, version] of Object.entries(KIT_TOOL_PINS)) {
    const got = entries[`node_modules/${name}`]?.version;
    if (got !== version) throw new Error(`package-lock.json has ${name} ${got}, the kits pin ${version}`);
  }
  return entries;
}

export function buildKitAssets() {
  const sdkPackage = JSON.parse(readFileSync(join(root, 'sdk', 'package.json'), 'utf8'));
  const fixtures = {};
  for (const [capability, file] of Object.entries(KIT_FIXTURES)) {
    const text = readText('conformance', file);
    fixtures[capability] = { file, sha256: sha256(text), text };
  }
  const shim = readText('site', 'src', 'lib', 'browser', 'node-crypto.mjs');
  return {
    schema: 'ordex.kit-assets/v1',
    sdk: { name: sdkPackage.name, version: sdkPackage.version, license: sdkPackage.license, sourceSha256: sdkSourceDigest(), files: compileSdk() },
    fixtures,
    cryptoShim: { path: 'site/src/lib/browser/node-crypto.mjs', sha256: sha256(shim), text: shim },
    tools: KIT_TOOL_PINS,
    node: readText('.nvmrc').trim(),
    lockPackages: lockEntries()
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = buildKitAssets();
  writeFileSync(join(root, 'site', 'src', 'data', 'kitAssets.json'), `${JSON.stringify(assets, null, 2)}\n`);
  console.log(`Kit assets: SDK ${assets.sdk.version} (${Object.keys(assets.sdk.files).length} files), ${Object.keys(assets.fixtures).length} fixture families, ${Object.keys(assets.lockPackages).length} lock entries`);
}
