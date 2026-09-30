// OX-S04 / OX-P07: build the self-hosted service artifacts with esbuild (installed as an Astro
// dependency). Outputs, all self-contained ES modules:
//   dist/mcp/ordex-mcp-engine.mjs     shared MCP engine (imported by scripts/mcp-stdio-server.mjs)
//   dist/mcp/ordex-mcp-stdio.mjs      stdio server runnable from any directory
//   dist/server/index.js              the docs and MCP HTTP handler (worker/index.js, bundled)
//   dist/server/node-host.mjs         the Node runtime host for that handler
//   dist/server/build-info.json       exact source identity of this build
// node:crypto resolves to the pinned browser-safe implementation so the handler runs the
// same in Node and in a Workers-compatible runtime.

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const revision = (() => {
  if (process.env.ORDEX_BUILD_REVISION) return process.env.ORDEX_BUILD_REVISION;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
})();

const cryptoShim = join(root, 'site', 'src', 'lib', 'browser', 'node-crypto.mjs');
const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
  legalComments: 'none',
  define: {
    __ORDEX_BUILD_REVISION__: JSON.stringify(revision),
    'import.meta.env.PUBLIC_ORDEX_BUILD_REVISION': JSON.stringify(revision)
  },
  alias: { 'node:crypto': cryptoShim, crypto: cryptoShim }
};

mkdirSync(join(root, 'dist', 'mcp'), { recursive: true });
mkdirSync(join(root, 'dist', 'server'), { recursive: true });

await build({ ...common, platform: 'node', entryPoints: [join(root, 'site/src/lib/mcp/server.ts')], outfile: join(root, 'dist/mcp/ordex-mcp-engine.mjs') });
await build({
  ...common,
  platform: 'node',
  entryPoints: [join(root, 'scripts/mcp/stdio-entry.mjs')],
  outfile: join(root, 'dist/mcp/ordex-mcp-stdio.mjs'),
  banner: { js: '#!/usr/bin/env node' }
});
await build({ ...common, platform: 'neutral', mainFields: ['module', 'main'], entryPoints: [join(root, 'worker/index.js')], outfile: join(root, 'dist/server/index.js') });
writeFileSync(join(root, 'dist/server/package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));
copyFileSync(join(root, 'worker/node-host.mjs'), join(root, 'dist/server/node-host.mjs'));
cpSync(join(root, 'worker/migrations'), join(root, 'dist/server/migrations'), { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'site/src/data/vectorManifest.json'), 'utf8'));
writeFileSync(
  join(root, 'dist/server/build-info.json'),
  JSON.stringify({ revision, builtAt: new Date().toISOString(), vectorDigest: manifest.vectorDigest, specDigest: manifest.specDigest, verifierDigest: manifest.verifierDigest }, null, 2)
);
console.log(`Built MCP engine, stdio server and docs service for revision ${revision}`);
