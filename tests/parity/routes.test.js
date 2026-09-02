import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('all required documentation product routes exist in dist/client and docs', async () => {
  const routes = [
    'index.html',
    'start/index.html',
    'learn/index.html',
    'build/index.html',
    'build/wizards/index.html',
    'build/recipes/index.html',
    'build/playground/index.html',
    'verify/index.html',
    'lab/index.html',
    'atlas/index.html',
    'kits/index.html',
    'ask/index.html',
    'operate/index.html',
    'releases/index.html',
    'compatibility/index.html',
    'insights/index.html',
    'reference/index.html',
    'reference/api/index.html',
    'reference/refusal-codes/index.html',
    'reference/specifications/index.html'
  ];

  for (const route of routes) {
    await access(resolve(root, 'dist', 'client', route));
    await access(resolve(root, 'docs', route));
  }
});

test('legacy html documentation routes continue to resolve in docs', async () => {
  const legacyRoutes = [
    'index.html',
    'quickstart.html',
    'architecture.html',
    'protocol-guide.html',
    'safeops.html',
    'swaps.html',
    'developers.html',
    'provenance.html',
    'heritage.html',
    'cold-signing.html',
    'troubleshooting.html',
    'api-reference.html'
  ];

  for (const file of legacyRoutes) {
    await access(resolve(root, 'docs', file));
  }
});

test('api reference renders all 78 OpenAPI operations and schemas', async () => {
  const content = await readFile(resolve(root, 'dist', 'client', 'reference', 'api', 'index.html'), 'utf8');
  assert.ok(content.includes('78 Operations'));
  assert.ok(content.includes('buildAsk'));
  assert.ok(content.includes('publishAsk'));
});
