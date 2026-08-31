import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderApiReference } from './api-reference.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

// GitHub Pages serves docs/ directly, so the generated reference is written
// into docs/ and committed. CI regenerates it and fails on any difference,
// exactly as it does for the SDK's generated types.
const contract = JSON.parse(await readFile(resolve(root, 'spec', 'openapi.json'), 'utf8'));
await writeFile(resolve(root, 'docs', 'api-reference.html'), renderApiReference(contract));

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'server'), { recursive: true });
await cp(resolve(root, 'docs'), resolve(dist, 'client'), { recursive: true });
await cp(resolve(root, 'worker', 'index.js'), resolve(dist, 'server', 'index.js'));
