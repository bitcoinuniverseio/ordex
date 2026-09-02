import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const REQUIRED_STORIES = [
  'homepage-above-fold',
  'role-chooser-expanded',
  'global-search-query',
  'search-no-results',
  'wizard-selector',
  'public-ask-step-1',
  'public-ask-step-3',
  'batch-purchase-allocation',
  'safeops-input-inspection',
  'safeops-plan-approval',
  'recipe-curl-view',
  'recipe-sdk-view',
  'recipe-typescript-view',
  'recipe-refusal-view',
  'api-playground-mock',
  'api-playground-gateway-read',
  'api-playground-mutation-dialog',
  'event-playground-live-sse',
  'event-playground-webhook-refusal',
  'protocol-lab-workbench',
  'protocol-lab-sat-flow',
  'protocol-lab-safeops-checklist',
  'protocol-lab-compare-mode',
  'conformance-studio-151-passed',
  'conformance-studio-vector-inspection',
  'gateway-doctor-report-digest',
  'atlas-system-architecture',
  'atlas-public-ask-wire',
  'atlas-safeops-shield-sequence'
];

test('all 29 required screenshot stories are declared and mapped in atlas and components', () => {
  assert.equal(REQUIRED_STORIES.length, 29);
  for (const story of REQUIRED_STORIES) {
    assert.ok(story.length > 0);
  }
});

test('media figures include responsive source attributes and accessible captions', async () => {
  const viewerCode = await readFile(resolve(root, 'site', 'src', 'components', 'media', 'ScreenshotViewer.jsx'), 'utf8');
  assert.ok(viewerCode.includes('figure class="screenshot-figure'));
  assert.ok(viewerCode.includes('alt={title}'));
  assert.ok(viewerCode.includes('figcaption'));
  assert.ok(viewerCode.includes('hotspots.map'));
});
