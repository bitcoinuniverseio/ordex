import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateOrdexEvent } from '../verifier/events.js';

const documentPath = fileURLToPath(new URL('./asyncapi.json', import.meta.url));
const document = JSON.parse(await readFile(documentPath, 'utf8'));

test('the streaming contract is AsyncAPI 3.x with a version and a description', () => {
  assert.ok(document.asyncapi.startsWith('3.'));
  assert.ok(document.info.version.length > 0);
  assert.ok(document.info.description.length > 0);
});

test('every channel message payload example is a valid ordex-event/v1 envelope', () => {
  const examples = document.components.messages.ordexEvent.examples;
  assert.ok(examples.length >= 2);
  for (const example of examples) {
    const verdict = validateOrdexEvent(example.payload);
    assert.equal(verdict.ok, true, verdict.reason || '');
  }
});

test('the reorg example names the event it reverses', () => {
  const examples = document.components.messages.ordexEvent.examples;
  const reorged = examples.find((example) => example.payload.status === 'reverted');
  assert.ok(reorged, 'a reversal example must exist');
  assert.equal(reorged.payload.revertedEventId, examples[0].payload.id);
});

test('sse, websocket, and webhook channels all carry the same envelope', () => {
  const channels = Object.values(document.channels);
  assert.equal(channels.length, 3);
  for (const channel of channels) {
    const names = Object.keys(channel.messages);
    assert.ok(names.includes('ordexEvent'), JSON.stringify(names));
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
  for (const { ref, where } of refs) {
    assert.ok(ref.startsWith('#/'), `${where}: external reference ${ref}`);
    let node = document;
    for (const segment of ref.slice(2).split('/')) {
      node = node?.[segment];
    }
    assert.ok(node !== undefined, `${where}: unresolved reference ${ref}`);
  }
});
