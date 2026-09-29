import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { missingAnswers, wizardOutcome } from '../../site/src/lib/docs/wizard-outcome.mjs';
import { callDocsApi } from '../../site/src/lib/docs/docs-client.mjs';
import { rankCorpus, validateAskResponse, SITE_ROUTES } from '../../site/src/lib/docs/docs-contract.mjs';
import { validateKitOptions } from '../../site/src/lib/kits/generator.ts';
import { getRecipe } from '../../site/src/lib/docs/recipes.mjs';

// OX-S11: the pieces the Ask, Feedback, Insights, Wizards and Recipes pages share.

const wizards = JSON.parse(readFileSync(new URL('../../site/src/data/wizards.json', import.meta.url), 'utf8'));
const operations = JSON.parse(readFileSync(new URL('../../site/src/data/operations.json', import.meta.url), 'utf8'));
const corpus = JSON.parse(readFileSync(new URL('../../site/src/data/corpus.json', import.meta.url), 'utf8'));

function* answerSets(wizard) {
  // Every option of every step, one step varied at a time; multi-choice steps also take all options.
  const first = Object.fromEntries(wizard.steps.map((s) => [s.id, s.isMulti ? [s.options[0].value] : s.options[0].value]));
  yield first;
  for (const s of wizard.steps) {
    for (const o of s.options) yield { ...first, [s.id]: s.isMulti ? [o.value] : o.value };
    if (s.isMulti) yield { ...first, [s.id]: s.options.map((o) => o.value) };
  }
}

test('all 12 wizards: every answer path leads only to real routes, operations, recipes and valid kits', () => {
  assert.equal(wizards.length, 12);
  for (const w of wizards) {
    assert.deepEqual(missingAnswers(w, {}), w.steps.map((s) => s.id));
    for (const answers of answerSets(w)) {
      assert.deepEqual(missingAnswers(w, answers), []);
      const { links, kit } = wizardOutcome(w, answers, operations);
      assert.ok(links.length > 0, w.id);
      for (const l of links) {
        const url = new URL(l.href, 'https://x.invalid');
        assert.ok(SITE_ROUTES.includes(url.pathname), `${w.id}: ${l.href}`);
        if (url.searchParams.get('operation')) assert.ok(operations.some((o) => o.operationId === url.searchParams.get('operation')), l.href);
        if (url.searchParams.get('recipe')) assert.ok(getRecipe(url.searchParams.get('recipe')), l.href);
      }
      if (kit) {
        const problems = validateKitOptions({ ...kit, network: 'signet', gatewayOrigin: kit.mode === 'gateway' ? 'https://gateway.example' : '', revision: 'abcdef1' });
        assert.deepEqual(problems, [], `${w.id} ${JSON.stringify(kit)}`);
      }
    }
  }
  const path = wizards.find((w) => w.id === 'integration-path');
  const kit = wizardOutcome(path, { role: 'wallet', runtime: 'worker', features: ['swaps', 'events'] }, operations).kit;
  assert.deepEqual(kit, { runtime: 'worker', capabilities: ['swaps', 'events'], mode: 'gateway' }, 'the chosen runtime and features reach the kit');
});

test('Ask retrieval is shared, version-filtered, and responses are validated', () => {
  const hits = rankCorpus(corpus, { query: 'keyset cursor paging', protocolVersion: '1.2' });
  assert.ok(hits.length > 0 && hits.length <= 4);
  assert.deepEqual(rankCorpus(corpus, { query: 'keyset cursor paging', protocolVersion: '1.0' }), []);
  assert.deepEqual(rankCorpus(corpus, { query: 'a b', protocolVersion: '1.2' }), []);
  const good = { ok: true, refused: false, noSources: false, extracts: [{ citationId: 'x', text: 't' }], citations: [{ id: 'x', title: 'T', docUrl: '/ordex/reference/' }] };
  assert.equal(validateAskResponse(good), null);
  assert.ok(validateAskResponse({ ...good, citations: [{ id: 'x', title: 'T', docUrl: 'https://evil.example/' }] }));
  assert.ok(validateAskResponse({ ...good, citations: [{ id: 'x', title: 'T', docUrl: '//evil.example/' }] }));
  assert.ok(validateAskResponse({ ...good, extracts: [] }));
  assert.ok(validateAskResponse({ error: 'x' }));
});

test('docs API calls report what happened, never success on failure', async () => {
  const json = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  assert.equal((await callDocsApi('/api/docs/health', { fetchImpl: json(200, { ok: true }) })).kind, 'ok');
  const http = await callDocsApi('/api/docs/feedback', { method: 'POST', body: {}, fetchImpl: json(503, { ok: false, code: 'STORAGE_UNAVAILABLE' }) });
  assert.equal(http.kind, 'http');
  assert.equal(http.status, 503);
  assert.equal((await callDocsApi('/x', { fetchImpl: async () => new Response('<html>', { status: 404 }) })).kind, 'invalid');
  assert.equal((await callDocsApi('/x', { fetchImpl: async () => { throw new TypeError('fetch failed'); } })).kind, 'unavailable');
  const slow = (_url, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal((await callDocsApi('/x', { fetchImpl: slow, timeoutMs: 50 })).kind, 'timeout');
  const ctrl = new AbortController();
  const pending = callDocsApi('/x', { fetchImpl: slow, signal: ctrl.signal });
  ctrl.abort();
  assert.equal((await pending).kind, 'cancelled');
  let seenUrl = '';
  await callDocsApi('/api/docs/ask', { base: 'https://docs.example/', fetchImpl: async (u) => ((seenUrl = u), new Response('{}')) });
  assert.equal(seenUrl, 'https://docs.example/api/docs/ask');
});
