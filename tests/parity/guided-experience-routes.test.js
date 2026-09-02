import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('guided experience routes exist with accessible landmarks and headings', async () => {
  const newRoutes = [
    'index.html',
    'workspace/index.html',
    'sandbox/index.html',
    'inspect/index.html',
    'diagnose/index.html',
    'agents/index.html',
    'tour/index.html'
  ];

  for (const r of newRoutes) {
    const html = await readFile(resolve(root, 'dist', 'client', r), 'utf8');
    assert.ok(html.includes('<html lang="en">'), `${r} missing lang="en"`);
    assert.ok(html.includes('class="skip-link"'), `${r} missing skip-link`);
    assert.ok(html.includes('<main id="main-content"'), `${r} missing main landmark`);
    assert.ok(html.includes('<h1'), `${r} missing top-level h1 heading`);
  }
});

test('all routes strictly use /ordex/ base path and have zero dead links', async () => {
  const { execSync } = await import('node:child_process');
  assert.doesNotThrow(() => {
    execSync('node scripts/check-links.mjs', { cwd: root, stdio: 'pipe' });
  }, 'check-links.mjs must pass with zero errors');
});
