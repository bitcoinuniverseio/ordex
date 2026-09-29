import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { MISSIONS } from '../../site/src/lib/experience/mission-registry.js';
import { evaluateStage, requirementFor } from '../../site/src/lib/experience/mission-evidence.js';
import { STAGE_IDS } from '../../site/src/lib/session/journey-schema.js';
import { SCENARIOS } from '../../site/src/lib/scenarios/registry.js';
import { FAMILIES } from '../../site/src/lib/conformance-registry.mjs';

// OX-S03 final phase: every stage of every mission can be completed by evidence a tool really
// records. Each emitter below is checked against its component source (the exact operation
// template it records), then every stage requirement must be satisfied by some emitted run.
// Browser proof with real IndexedDB is tests/e2e/missions.test.js in CI.

const src = (p) => readFileSync(new URL(`../../site/src/${p}`, import.meta.url), 'utf8');
const EMITTERS = [
  { file: 'components/launchpad/MissionWorkspace.tsx', template: "tool: 'learn', operation: `read:${mission.id}`", runs: MISSIONS.map((m) => ['learn', `read:${m.id}`, 'read']) },
  { file: 'components/artifact-lens/ArtifactLens.tsx', template: 'operation: `decode:${res.format}`', runs: [['artifact-lens', 'decode:psbt', 'accepted']] },
  { file: 'components/artifact-lens/ArtifactLens.tsx', template: 'operation: `compare:${report.overallVerdict}`', runs: [['artifact-lens', 'compare:DANGEROUS', 'refused'], ['artifact-lens', 'compare:IDENTICAL', 'accepted']] },
  { file: 'components/sandbox/TransactionSandbox.tsx', template: 'key = `scenario:${selectedScenario.id}`', runs: SCENARIOS.map((s) => ['sandbox', `scenario:${s.id}`, 'passed']) },
  { file: 'components/sandbox/TransactionSandbox.tsx', template: 'key = `injection:${selectedScenario.id}:${injection}`', runs: [['sandbox', 'injection:ask.publish-and-settle.success:inject-reorder-output', 'refused']] },
  { file: 'components/lab/ProtocolLab.jsx', template: 'operation: `${family}/${variant}`', runs: FAMILIES.flatMap((f) => [['lab', `${f}/x`, 'accepted'], ['lab', `${f}/x`, 'refused']]) },
  { file: 'components/verify/ConformanceStudio.jsx', template: 'operation: `suite:${selectedFamily}`', runs: [...FAMILIES, 'all'].map((f) => ['conformance', `suite:${f}`, 'passed']) },
  { file: 'components/playground/ApiPlayground.jsx', template: 'operation: `api:${op.operationId}`', runs: [['playground', 'api:getHealth', 'passed'], ['playground', 'api:getProtocol', 'passed'], ['playground', 'api:listOrders', 'refused']], gateway: true },
  { file: 'components/playground/EventPlayground.jsx', template: 'operation: `events:stream:${tab}`', runs: [['events', 'events:stream:sse', 'passed']], gateway: true },
  { file: 'components/playground/EventPlayground.jsx', template: "operation: 'events:webhook'", runs: [['events', 'events:webhook', 'accepted']] },
  { file: 'components/verify/GatewayDoctor.jsx', template: 'operation: `doctor:${o.origin}`', runs: [['doctor', 'doctor:https://gateway.example', 'passed']], gateway: true },
  { file: 'components/kits/KitGenerator.jsx', template: "tool: 'kits', operation: `kit:${cap.family}`", runs: ['purchase', 'offers', 'safeops', 'swaps', 'events', 'collection-manifest'].map((f) => ['kits', `kit:${f}`, 'passed']) },
  { file: 'components/wizards/WizardEngine.jsx', template: "tool: 'wizards', operation: `wizard:${wizard.id}`", runs: [['wizards', 'wizard:offers-v1', 'passed']] },
  { file: 'components/failure-navigator/FailureNavigator.tsx', template: "tool: 'failure-navigator', operation: `reproduce:${code}`", runs: [['failure-navigator', 'reproduce:SELLER_VALUE_MISMATCH', 'passed']] },
  { file: 'components/atlas/VisualProtocolAtlas.jsx', template: "tool: 'atlas', operation: `read:${diagram.id}`", runs: [['atlas', 'read:system-architecture', 'read']] }
];

const context = { network: 'signet', gatewayOrigin: 'https://gateway.example', protocolVersion: '1.2', sourceBuild: 'abcdef1' };
const record = ([tool, operation, state], i) => ({ schema: 'ordex.evidence/v1', id: `ev_${i}`, tool, operation, missionId: null, stageId: null, context, inputDigest: null, artifactDigests: [], result: { state, code: null, reason: null }, evidenceClass: 'Deterministic example', recordedAt: '2026-09-29T00:00:00Z' });

test('each emitter records exactly the operation template the requirements expect', () => {
  for (const e of EMITTERS) assert.ok(src(e.file).includes(e.template), `${e.file} records ${e.template}`);
});

test('every stage of every mission is satisfiable by a real emitted run, and only by a matching one', () => {
  const all = EMITTERS.flatMap((e) => e.runs).map(record);
  assert.equal(MISSIONS.length, 9);
  for (const m of MISSIONS) {
    for (const stage of STAGE_IDS.filter((s) => s !== 'finish')) {
      const req = requirementFor(m.id, stage);
      assert.ok(req, `${m.id}/${stage} has a requirement`);
      const ev = evaluateStage(m.id, stage, all, context);
      assert.equal(ev.satisfied, true, `${m.id}/${stage}: ${ev.reason}`);
      // The same runs from another network do not count.
      assert.equal(evaluateStage(m.id, stage, all.map((r) => ({ ...r, context: { ...context, network: 'mainnet' } })), context).satisfied, false, `${m.id}/${stage} ignores another network`);
    }
  }
});

test('the tool a stage opens is the tool its requirement needs', () => {
  const ROUTE_OF = { learn: '/learn', playground: '/build/playground', events: '/build/playground', sandbox: '/sandbox', 'artifact-lens': '/inspect', lab: '/lab', kits: '/kits', conformance: '/verify', doctor: '/verify', wizards: '/build/wizards', 'failure-navigator': '/diagnose', atlas: '/atlas' };
  for (const m of MISSIONS) {
    for (const st of m.stages.filter((s) => s.id !== 'finish')) {
      const req = requirementFor(m.id, st.id);
      assert.equal(st.toolRoute, ROUTE_OF[req.tool], `${m.id}/${st.id} opens ${st.toolRoute} but needs ${req.tool}`);
    }
  }
});
