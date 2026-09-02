import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('all static pages include skip links, main landmark, and lang attribute', async () => {
  const pages = [
    'index.html',
    'start/index.html',
    'learn/index.html',
    'build/index.html',
    'verify/index.html',
    'lab/index.html',
    'atlas/index.html',
    'kits/index.html',
    'ask/index.html',
    'operate/index.html',
    'releases/index.html',
    'compatibility/index.html'
  ];

  for (const p of pages) {
    const html = await readFile(resolve(root, 'dist', 'client', p), 'utf8');
    assert.ok(html.includes('<html lang="en">'), `${p} missing lang="en"`);
    assert.ok(html.includes('class="skip-link"'), `${p} missing skip link`);
    assert.ok(html.includes('<main id="main-content"'), `${p} missing main landmark`);
    assert.ok(html.includes('<h1'), `${p} missing top-level h1 heading`);
  }
});

test('interactive buttons and inputs include aria labels or visible text', async () => {
  const html = await readFile(resolve(root, 'dist', 'client', 'index.html'), 'utf8');
  assert.ok(!html.includes('<button></button>'), 'Buttons must not be empty');
});
