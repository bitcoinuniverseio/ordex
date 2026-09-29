import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JourneyStore, JourneyStoreError } from '../../site/src/lib/session/journey-store.js';
import { MemoryIDBFactory } from '../../site/src/lib/session/memory-idb.js';
import {
  validateSession,
  validateSettings,
  validateEvidence,
  normalizeGatewayOrigin,
  contextFromSettings,
  DEFAULT_SETTINGS,
  EVIDENCE_SCHEMA,
  newId
} from '../../site/src/lib/session/journey-schema.js';
import { evaluateStage, MISSION_EVIDENCE, requirementFor } from '../../site/src/lib/experience/mission-evidence.js';
import { MISSIONS } from '../../site/src/lib/experience/mission-registry.js';
import { readJourneyHandoff, journeyQuery } from '../../site/src/lib/session/evidence.js';

// OX-S03 (PROPOSED NEW): the store logic runs against an in-memory IndexedDB with the same
// commit, abort and fault semantics. This is component evidence; the CI browser gate
// (tests/e2e/missions.test.js) repeats the flows on real IndexedDB.

const CTX = { network: 'mainnet', gatewayOrigin: null, protocolVersion: '1.2', sourceBuild: 'abcdef1234567' };
const makeStore = (factory = new MemoryIDBFactory(), extra = {}) =>
  new JourneyStore({ idbFactory: factory, broadcastChannel: null, storage: null, eventTarget: null, ...extra });

function evidence(overrides = {}) {
  return {
    schema: EVIDENCE_SCHEMA,
    id: newId('ev'),
    tool: 'lab',
    operation: 'purchase/completion',
    missionId: 'integrate-public-asks',
    stageId: 'verify',
    context: { ...CTX },
    inputDigest: 'a'.repeat(64),
    artifactDigests: [],
    result: { state: 'accepted', code: null, reason: null },
    evidenceClass: 'Protocol verification',
    recordedAt: new Date().toISOString(),
    ...overrides
  };
}

test('a write is readable by a fresh connection only after it commits', async () => {
  const factory = new MemoryIDBFactory();
  const a = makeStore(factory);
  const saved = await a.saveSettings({ network: 'signet', gatewayOrigin: 'https://gateway.example' });
  assert.equal(saved.network, 'signet');
  const b = makeStore(factory);
  assert.equal((await b.getSettings()).gatewayOrigin, 'https://gateway.example');
});

test('a quota failure rejects, reports its state, and keeps the previous data', async () => {
  const factory = new MemoryIDBFactory();
  const store = makeStore(factory);
  await store.saveSettings({ protocolVersion: '1.1' });
  factory.injectWriteFault(new DOMException('full', 'QuotaExceededError'));
  await assert.rejects(store.saveSettings({ protocolVersion: '1.0' }), (err) => err instanceof JourneyStoreError && err.code === 'QUOTA_EXCEEDED');
  assert.equal(store.storageState, 'quota-exceeded');
  assert.equal((await store.getSettings()).protocolVersion, '1.1');
});

test('sessions are per mission and resume never crosses missions', async () => {
  const store = makeStore();
  const a = await store.createSession('integrate-public-asks', CTX);
  const b = await store.createSession('integrate-atomic-swaps', CTX);
  assert.equal((await store.getSessionForMission('integrate-public-asks')).id, a.id);
  assert.equal((await store.getSessionForMission('integrate-atomic-swaps')).id, b.id);
  assert.equal(await store.getSessionForMission('perform-security-review'), null);
});

test('compare-and-update refuses a stale revision so another tab cannot overwrite progress', async () => {
  const store = makeStore();
  const s = await store.createSession('integrate-public-asks', CTX);
  const first = await store.updateSession(s.id, s.revision, (x) => ({ ...x, activeStageId: 'prepare' }));
  assert.equal(first.revision, s.revision + 1);
  await assert.rejects(store.updateSession(s.id, s.revision, (x) => ({ ...x, activeStageId: 'finish' })), (err) => err.code === 'REVISION_CONFLICT');
  assert.equal((await store.getSession(s.id)).activeStageId, 'prepare');
  await assert.rejects(store.saveSession(s), (err) => err.code === 'REVISION_CONFLICT');
});

test('a completed stage must cite evidence the session holds', async () => {
  const store = makeStore();
  const s = await store.createSession('integrate-public-asks', CTX);
  await assert.rejects(
    store.updateSession(s.id, s.revision, (x) => ({ ...x, completedStages: [{ stageId: 'verify', evidenceIds: ['ev_missing'], completedAt: new Date().toISOString() }] })),
    (err) => err.code === 'INVALID_DATA'
  );
  await assert.rejects(store.updateSession(s.id, s.revision, (x) => ({ ...x, completedStages: [{ stageId: 'verify', evidenceIds: [], completedAt: new Date().toISOString() }] })), (err) => err.code === 'INVALID_DATA');
});

test('imports reject malicious or unknown shapes and migrate version 1 without trusting its PASS', async () => {
  const store = makeStore();
  assert.throws(() => store.importSessionJson('{"schemaVersion":3,"id":"x","missionId":"y"}'), /Unsupported session schema/);
  assert.throws(() => store.importSessionJson('{"__proto__":{"polluted":true},"schemaVersion":2}'), (err) => err.code === 'INVALID_DATA');
  assert.equal({}.polluted, undefined);
  const s = await store.createSession('integrate-public-asks', CTX);
  const tampered = { ...s, isAdmin: true };
  assert.throws(() => store.importSessionJson(JSON.stringify(tampered)), /isAdmin is not part of the schema/);
  const huge = { ...s, evidenceIds: Array.from({ length: 500 }, (_, i) => `ev_${i}`) };
  assert.throws(() => store.importSessionJson(JSON.stringify(huge)), /evidenceIds/);
  const v1 = { schemaVersion: 1, id: 'session-1', missionId: 'integrate-public-asks', completedStageIds: ['understand', 'verify', 'finish'], activeStageId: 'finish', protocolVersion: '1.2' };
  const migrated = store.importSessionJson(JSON.stringify(v1));
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.completedStages, []);
  assert.deepEqual(migrated.legacyProgress.completedStageIds, ['understand', 'verify', 'finish']);
});

test('an imported session gets a fresh id and never overwrites an existing one', async () => {
  const store = makeStore();
  const s = await store.createSession('integrate-public-asks', CTX);
  const imported = await store.importSession(store.exportSessionJson(s));
  assert.notEqual(imported.id, s.id);
  assert.equal((await store.listSessions()).length, 2);
});

test('secrets are refused before anything is stored', async () => {
  const store = makeStore();
  const s = await store.createSession('integrate-public-asks', CTX);
  const wif = 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ';
  await assert.rejects(store.updateSession(s.id, s.revision, (x) => ({ ...x, role: wif })), (err) => err.code === 'SECRET_DETECTED');
  await assert.rejects(store.putArtifact({ name: 'k', type: 'json', payload: `{"k":"${wif}"}`, isDeterministicFixture: false, summary: '' }), (err) => err.code === 'SECRET_DETECTED');
});

test('evidence is validated and bounded', async () => {
  const store = makeStore();
  await assert.rejects(store.recordEvidence({ ...evidence(), tool: 'wallet' }), (err) => err.code === 'INVALID_DATA');
  await assert.rejects(store.recordEvidence({ ...evidence(), context: { ...CTX, network: 'bitcoin' } }), (err) => err.code === 'INVALID_DATA');
  await assert.rejects(store.recordEvidence({ ...evidence(), result: { state: 'accepted', code: 'lower', reason: null } }), (err) => err.code === 'INVALID_DATA');
  for (let i = 0; i < 205; i++) await store.recordEvidence(evidence({ recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
  assert.equal((await store.listEvidence()).length, 200);
});

test('artifacts travel by opaque id and are checked against their digest', async () => {
  const factory = new MemoryIDBFactory();
  const store = makeStore(factory);
  const ref = await store.putArtifact({ name: 'psbt', type: 'psbt', payload: '70736274ff', isDeterministicFixture: true, summary: 'example' });
  assert.match(ref.id, /^art_[0-9a-f]+$/);
  assert.match(ref.sha256, /^[0-9a-f]{64}$/);
  assert.equal((await store.getArtifact(ref.id)).payload, '70736274ff');
  assert.equal(await store.getArtifact('not-an-id'), null);
  assert.equal(journeyQuery('ses_0123456789ab', 'inspect', ref.id), `?journey=ses_0123456789ab&stage=inspect&artifact=${ref.id}`);
  assert.deepEqual(readJourneyHandoff(`?journey=ses_0123456789ab&stage=inspect&artifact=${ref.id}`), { sessionId: 'ses_0123456789ab', stageId: 'inspect', artifactId: ref.id });
  assert.equal(readJourneyHandoff('?journey=../x&stage=inspect'), null);
  assert.equal(readJourneyHandoff('?journey=ses_0123456789ab&stage=hack'), null);
});

test('other tabs are told about commits by id only, with a storage event fallback', async () => {
  // A BroadcastChannel stand-in shared by two stores.
  const channels = new Set();
  class Channel {
    constructor() {
      channels.add(this);
      this.onmessage = null;
    }
    postMessage(data) {
      for (const c of channels) if (c !== this) setTimeout(() => c.onmessage?.({ data: structuredClone(data) }), 0);
    }
    close() {
      channels.delete(this);
    }
  }
  const factory = new MemoryIDBFactory();
  const a = makeStore(factory, { broadcastChannel: Channel });
  const b = makeStore(factory, { broadcastChannel: Channel });
  const seen = [];
  b.subscribe((e) => seen.push(e));
  const s = await a.createSession('integrate-public-asks', CTX);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [{ type: 'session', id: s.id, revision: 1 }]);
  assert.ok(!JSON.stringify(seen).includes('missionId'), 'notices carry ids only');

  // Without BroadcastChannel the notice goes through localStorage and a storage event.
  const listeners = [];
  const target = { addEventListener: (type, fn) => listeners.push(fn) };
  const writes = [];
  const storage = { setItem: (key, value) => writes.push({ key, value }) };
  const c = makeStore(factory, { storage, eventTarget: null });
  const d = makeStore(factory, { eventTarget: target, storage: null });
  const got = [];
  d.subscribe((e) => got.push(e));
  await c.saveSettings({ theme: 'dark' });
  assert.equal(writes.length, 1);
  for (const fn of listeners) fn({ key: writes[0].key, newValue: writes[0].value });
  assert.deepEqual(got, [{ type: 'settings' }]);
});

test('a blocked open and a version change are reported, and the store recovers', async () => {
  const factory = new MemoryIDBFactory();
  const store = makeStore(factory);
  factory.blockNextOpen = true;
  const states = [];
  store.subscribe((e) => e.type === 'status' && states.push(e.state));
  await assert.rejects(store.listSessions(), (err) => err.code === 'STORAGE_UNAVAILABLE');
  assert.equal(store.storageState, 'blocked');
  await store.listSessions();
  assert.equal(store.storageState, 'ready');
  factory.fireVersionChange('ordex_experience_db');
  assert.equal(store.storageState, 'closed');
  await store.listSessions();
  assert.equal(store.storageState, 'ready');
  assert.deepEqual(states, ['blocked', 'ready', 'closed', 'ready']);
});

test('settings migrate from version 1 keeping mainnet, and invalid origins are refused', () => {
  const v1 = { disclosureMode: 'proof', protocolVersion: '1.1', environment: 'custom-write', customGatewayUrl: 'https://gw.example/', theme: 'dark' };
  const m = validateSettings(v1);
  assert.equal(m.ok, true);
  assert.equal(m.value.network, 'mainnet');
  assert.equal(m.value.gatewayOrigin, 'https://gw.example');
  assert.equal(m.value.mode, 'write');
  assert.equal(normalizeGatewayOrigin('http://gw.example').ok, false);
  assert.equal(normalizeGatewayOrigin('http://127.0.0.1:1').ok, true);
  assert.equal(normalizeGatewayOrigin('https://user:pw@gw.example').ok, false);
  assert.equal(normalizeGatewayOrigin('https://gw.example/api').ok, false);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, network: 'mainnet', gatewayOrigin: 'https://gw.example/x' }).ok, false);
  assert.deepEqual(contextFromSettings({ ...DEFAULT_SETTINGS, gatewayOrigin: '' }, 'not-a-sha').gatewayOrigin, null);
});

test('evidence records validate strictly', () => {
  assert.equal(validateEvidence(evidence()).ok, true);
  assert.equal(validateEvidence({ ...evidence(), extra: 1 }).ok, false);
  assert.equal(validateEvidence({ ...evidence(), recordedAt: 'yesterday' }).ok, false);
  assert.equal(validateEvidence({ ...evidence(), inputDigest: 'xyz' }).ok, false);
  assert.equal(validateSession(null).ok, false);
});

test('every mission stage except finish has an evidence requirement', () => {
  for (const m of MISSIONS) {
    assert.ok(MISSION_EVIDENCE[m.id], m.id);
    for (const s of m.stages) {
      if (s.id === 'finish') assert.equal(requirementFor(m.id, s.id), null);
      else assert.ok(requirementFor(m.id, s.id), `${m.id}/${s.id}`);
    }
  }
});

test('stage evaluation rejects premature completion, other contexts and local runs for gateway stages', () => {
  const m = 'integrate-public-asks';
  assert.equal(evaluateStage(m, 'verify', [], CTX).satisfied, false);
  const ok = evidence();
  assert.deepEqual(evaluateStage(m, 'verify', [ok], CTX), { satisfied: true, evidenceIds: [ok.id], stale: [], reason: 'Satisfied by lab run purchase/completion.' });
  const refused = evidence({ result: { state: 'refused', code: 'SAT_FLOW_SHORTFALL', reason: null } });
  assert.equal(evaluateStage(m, 'verify', [refused], CTX).satisfied, false);
  const otherNet = evidence({ context: { ...CTX, network: 'signet' } });
  const r = evaluateStage(m, 'verify', [otherNet], CTX);
  assert.equal(r.satisfied, false);
  assert.equal(r.stale.length, 1);
  const oldBuild = evidence({ context: { ...CTX, sourceBuild: '1111111' } });
  assert.equal(evaluateStage(m, 'verify', [oldBuild], CTX).satisfied, false);
  const otherMission = evidence({ missionId: 'integrate-atomic-swaps' });
  assert.equal(evaluateStage(m, 'verify', [otherMission], CTX).satisfied, false);
  const wrongFamily = evidence({ operation: 'swaps/intent' });
  assert.equal(evaluateStage(m, 'verify', [wrongFamily], CTX).satisfied, false);
  // A playground stage needs a gateway: a local run never satisfies it.
  const api = evidence({ tool: 'playground', operation: 'api:getCatalog', result: { state: 'passed', code: null, reason: null } });
  assert.equal(evaluateStage(m, 'prepare', [api], CTX).satisfied, false);
  const gwCtx = { ...CTX, gatewayOrigin: 'https://gw.example' };
  assert.equal(evaluateStage(m, 'prepare', [{ ...api, context: gwCtx }], gwCtx).satisfied, true);
  // A whole-suite run covers a family suite.
  const all = evidence({ tool: 'conformance', operation: 'suite:all', result: { state: 'passed', code: null, reason: null } });
  assert.equal(evaluateStage('protect-wallet-signing', 'validate', [{ ...all, missionId: null }], CTX).satisfied, true);
  const failedSuite = { ...all, result: { state: 'failed', code: null, reason: null } };
  assert.equal(evaluateStage(m, 'validate', [failedSuite], CTX).satisfied, false);
});
