// OX-S12: writes dist/client/sw.js from scripts/docs/sw-template.js with this build's file list
// (relative to the site base) and a version derived from the files' contents, so every change
// to the site produces a new worker and a new cache. Run after the site, search index and
// generated text files are in dist/client, before they are copied to docs/.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const client = join(root, 'dist', 'client');
const SKIP = new Set(['sw.js']);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function buildServiceWorker() {
  const files = walk(client)
    .map((p) => relative(client, p).split(sep).join('/'))
    .filter((f) => !SKIP.has(f))
    .sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(readFileSync(join(client, f)));
  const revision = (() => {
    try {
      return process.env.ORDEX_BUILD_REVISION || process.env.GITHUB_SHA || execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
    } catch {
      return 'unknown';
    }
  })();
  const manifest = { version: hash.digest('hex').slice(0, 16), revision, files };
  const template = readFileSync(join(root, 'scripts', 'docs', 'sw-template.js'), 'utf8').replace(/\r\n/g, '\n');
  const source = template.replace('self.__ORDEX_SW_MANIFEST__', JSON.stringify(manifest));
  writeFileSync(join(client, 'sw.js'), source);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = buildServiceWorker();
  console.log(`Service worker ${m.version}: ${m.files.length} files precached`);
}
