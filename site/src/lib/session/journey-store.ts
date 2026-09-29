/**
 * Ordex Durable Journey Store
 *
 * OX-S03: IndexedDB persistence for journey sessions, settings, evidence, transferred
 * artifacts and run history. A write is acknowledged only after its transaction commits;
 * an abort (quota, a stale revision, a closed database) rejects with a typed error. Session
 * writes are compare-and-update on a revision so a stale tab cannot overwrite newer
 * evidence. One database open is shared, the connection closes when another tab upgrades,
 * and storage state (ready, blocked, quota exceeded, ephemeral) is observable. Other tabs
 * learn about committed changes through BroadcastChannel or, where that is missing, a
 * storage event; notifications carry ids only, never session contents.
 */

import { detectSecrets, safeJsonParse, sanitizeForExport } from '../security/sanitizer.js';
import { MemoryIDBFactory } from './memory-idb.js';
import { sha256Bytes } from '../browser/node-crypto.mjs';
import {
  DEFAULT_SETTINGS,
  JOURNEY_SCHEMA_VERSION,
  LIMITS,
  STAGE_IDS,
  newId,
  validateEvidence,
  validateSession,
  validateSettings,
  type EvidenceRecord,
  type JourneyArtifactReference,
  type JourneyContext,
  type JourneyStageId,
  type OrdexJourneySession,
  type UserSettings
} from './journey-schema.js';

export { DEFAULT_SETTINGS };
export type { EvidenceRecord, JourneyArtifactReference, JourneyContext, OrdexJourneySession, UserSettings };

export interface ActivityRunRecord {
  id: string;
  product: 'launchpad' | 'sandbox' | 'artifact-lens' | 'failure-navigator' | 'protocol-lab' | 'conformance' | 'kits' | 'doctor' | 'playground';
  operation: string;
  isDeterministic: boolean;
  protocolVersion: string;
  timestamp: string;
  outcome: 'PASS' | 'REFUSAL' | 'ERROR' | 'INFO';
  evidenceClass: 'Chain proof' | 'Protocol verification' | 'Gateway observation' | 'Publisher claim' | 'Deterministic example';
  summary: string;
  reopenRoute: string;
}

export type StorageState = 'opening' | 'ready' | 'blocked' | 'quota-exceeded' | 'ephemeral' | 'closed' | 'failed';

export class JourneyStoreError extends Error {
  constructor(public code: 'REVISION_CONFLICT' | 'QUOTA_EXCEEDED' | 'TRANSACTION_ABORTED' | 'STORAGE_UNAVAILABLE' | 'INVALID_DATA' | 'SECRET_DETECTED' | 'NOT_FOUND' | 'DUPLICATE_ID', message: string) {
    super(message);
    this.name = 'JourneyStoreError';
  }
}

export type StoreEvent =
  | { type: 'session'; id: string; revision: number }
  | { type: 'settings' }
  | { type: 'evidence'; id: string }
  | { type: 'status'; state: StorageState };

export const DB_NAME = 'ordex_experience_db';
const DB_VERSION = 2;
const CHANNEL = 'ordex_session_sync';
const STORAGE_KEY = 'ordex_session_sync_event';
const STORES = ['sessions', 'settings', 'runs', 'evidence', 'artifacts'] as const;

interface StoreOptions {
  idbFactory?: IDBFactory | MemoryIDBFactory | null;
  broadcastChannel?: typeof BroadcastChannel | null;
  storage?: Pick<Storage, 'setItem'> | null;
  eventTarget?: Pick<Window, 'addEventListener'> | null;
  dbName?: string;
}

function assertNoSecrets(value: unknown) {
  const check = detectSecrets(JSON.stringify(value));
  if (check.hasHighConfidenceSecrets) {
    throw new JourneyStoreError('SECRET_DETECTED', `Refusing to store data containing ${check.detectedSecrets.map((s) => s.type).join(', ')}`);
  }
}

function abortError(error: DOMException | null): JourneyStoreError {
  if (error?.name === 'QuotaExceededError') return new JourneyStoreError('QUOTA_EXCEEDED', 'The browser storage quota is exhausted; nothing was saved.');
  return new JourneyStoreError('TRANSACTION_ABORTED', `The storage transaction did not commit: ${error?.message || 'aborted'}`);
}

export class JourneyStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private state: StorageState = 'opening';
  private listeners = new Set<(event: StoreEvent) => void>();
  private channel: BroadcastChannel | null = null;
  private factory: IDBFactory | MemoryIDBFactory;
  private storage: Pick<Storage, 'setItem'> | null;
  private dbName: string;

  constructor(options: StoreOptions = {}) {
    const g = globalThis as unknown as { indexedDB?: IDBFactory; BroadcastChannel?: typeof BroadcastChannel; localStorage?: Storage; window?: Window };
    const factory = options.idbFactory === undefined ? g.indexedDB : options.idbFactory;
    this.dbName = options.dbName || DB_NAME;
    if (factory) this.factory = factory;
    else {
      this.factory = new MemoryIDBFactory();
      this.state = 'ephemeral';
    }
    this.storage = options.storage === undefined ? (typeof g.localStorage !== 'undefined' ? g.localStorage : null) : options.storage;
    // Only a page gets a cross-tab channel by default; a server render or test must not hold one open.
    const Channel = options.broadcastChannel === undefined ? (typeof g.window !== 'undefined' ? g.BroadcastChannel : null) : options.broadcastChannel;
    try {
      if (Channel) {
        this.channel = new Channel(CHANNEL);
        this.channel.onmessage = (e: MessageEvent) => this.receive(e.data);
      }
    } catch {
      this.channel = null;
    }
    const target = options.eventTarget === undefined ? g.window : options.eventTarget;
    target?.addEventListener?.('storage', (e: Event) => {
      const se = e as StorageEvent;
      if (se.key !== STORAGE_KEY || !se.newValue) return;
      try {
        this.receive(JSON.parse(se.newValue));
      } catch {
        // not ours
      }
    });
  }

  get storageState(): StorageState {
    return this.state;
  }

  subscribe(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Backwards-compatible session subscription: called with the committed session. */
  onSessionSync(callback: (session: OrdexJourneySession) => void): () => void {
    return this.subscribe((event) => {
      if (event.type === 'session') this.getSession(event.id).then((s) => s && callback(s)).catch(() => {});
    });
  }

  private setState(state: StorageState) {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'status', state });
  }

  private emit(event: StoreEvent) {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a failing listener must not break the others
      }
    }
  }

  private receive(data: unknown) {
    const d = data as Record<string, unknown>;
    if (!d || typeof d !== 'object') return;
    // Rebuild the notice from known fields only; anything else from another tab is dropped.
    if (d.type === 'settings') this.emit({ type: 'settings' });
    else if (d.type === 'session' && typeof d.id === 'string' && Number.isInteger(d.revision)) this.emit({ type: 'session', id: d.id, revision: d.revision as number });
    else if (d.type === 'evidence' && typeof d.id === 'string') this.emit({ type: 'evidence', id: d.id });
  }

  /** Notify this tab and others, after commit, with ids only. */
  private announce(event: StoreEvent) {
    this.emit(event);
    try {
      if (this.channel) this.channel.postMessage(event);
      else this.storage?.setItem(STORAGE_KEY, JSON.stringify({ ...event, nonce: Math.random() }));
    } catch {
      // cross-tab notice is best effort; the data itself is committed
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = (this.factory as IDBFactory).open(this.dbName, DB_VERSION);
      } catch (err) {
        this.setState('failed');
        reject(new JourneyStoreError('STORAGE_UNAVAILABLE', String((err as Error).message)));
        return;
      }
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      };
      req.onblocked = () => {
        this.setState('blocked');
        this.dbPromise = null;
        reject(new JourneyStoreError('STORAGE_UNAVAILABLE', 'Another Ordex tab holds an older database version open. Close it and retry.'));
      };
      req.onsuccess = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
          this.setState('closed');
        };
        if (this.state !== 'ephemeral') this.setState('ready');
        resolve(db);
      };
      req.onerror = () => {
        this.dbPromise = null;
        this.setState('failed');
        reject(new JourneyStoreError('STORAGE_UNAVAILABLE', 'The browser refused to open Ordex storage.'));
      };
    });
    return this.dbPromise;
  }

  /**
   * Run `work` in one transaction and resolve with its value only after the transaction
   * commits. Any request error or explicit abort rejects.
   */
  private async tx<T>(stores: string[], mode: IDBTransactionMode, work: (t: IDBTransaction, done: (value: T) => void, fail: (err: Error) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let t: IDBTransaction;
      try {
        t = db.transaction(stores, mode);
      } catch (err) {
        reject(new JourneyStoreError('STORAGE_UNAVAILABLE', String((err as Error).message)));
        return;
      }
      let value: T;
      let failure: Error | null = null;
      t.oncomplete = () => (failure ? reject(failure) : resolve(value));
      t.onabort = () => {
        const err = failure || abortError(t.error);
        if (err instanceof JourneyStoreError && err.code === 'QUOTA_EXCEEDED') this.setState('quota-exceeded');
        reject(err);
      };
      try {
        work(
          t,
          (v) => {
            value = v;
          },
          (err) => {
            failure = err;
            t.abort();
          }
        );
      } catch (err) {
        failure = err as Error;
        t.abort();
      }
    });
  }

  private reqValue<T>(req: IDBRequest, onValue: (v: T) => void) {
    req.onsuccess = () => onValue(req.result as T);
  }

  // Settings ---------------------------------------------------------------

  async getSettings(): Promise<UserSettings> {
    try {
      const row = await this.tx<{ id: string; data: unknown } | undefined>(['settings'], 'readonly', (t, done) => {
        this.reqValue(t.objectStore('settings').get('current'), done);
      });
      if (!row) return { ...DEFAULT_SETTINGS };
      const valid = validateSettings(row.data);
      return valid.ok ? valid.value : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  // Saves run one after another: each reads the settings the previous save wrote, so two
  // quick changes (network, then gateway origin) never overwrite each other.
  private settingsQueue: Promise<unknown> = Promise.resolve();

  saveSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    const run = this.settingsQueue.then(() => this.writeSettings(patch));
    this.settingsQueue = run.catch(() => undefined);
    return run;
  }

  private async writeSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    const current = await this.getSettings();
    const next = { ...current, ...patch, schemaVersion: current.schemaVersion };
    const valid = validateSettings(next);
    if (!valid.ok) throw new JourneyStoreError('INVALID_DATA', valid.errors.join('; '));
    await this.tx<void>(['settings'], 'readwrite', (t, done) => {
      this.reqValue(t.objectStore('settings').put({ id: 'current', data: valid.value }), () => done(undefined));
    });
    this.announce({ type: 'settings' });
    return valid.value;
  }

  // Sessions ---------------------------------------------------------------

  async getSession(id: string): Promise<OrdexJourneySession | null> {
    const row = await this.tx<unknown>(['sessions'], 'readonly', (t, done) => this.reqValue(t.objectStore('sessions').get(id), done));
    if (!row) return null;
    const valid = validateSession(row);
    return valid.ok ? valid.value : null;
  }

  async listSessions(): Promise<OrdexJourneySession[]> {
    const rows = await this.tx<unknown[]>(['sessions'], 'readonly', (t, done) => this.reqValue(t.objectStore('sessions').getAll(), done));
    return (rows || []).map((r) => validateSession(r)).filter((r) => r.ok).map((r) => (r as { value: OrdexJourneySession }).value);
  }

  /** The most recently updated session for one mission; sessions of other missions are never returned. */
  async getSessionForMission(missionId: string): Promise<OrdexJourneySession | null> {
    const sessions = (await this.listSessions()).filter((s) => s.missionId === missionId);
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions[0] || null;
  }

  async getActiveSession(): Promise<OrdexJourneySession | null> {
    const sessions = await this.listSessions();
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions[0] || null;
  }

  async createSession(missionId: string, context: JourneyContext, extra: { role?: string | null; disclosureMode?: OrdexJourneySession['disclosureMode'] } = {}): Promise<OrdexJourneySession> {
    const now = new Date().toISOString();
    const session: OrdexJourneySession = {
      schemaVersion: JOURNEY_SCHEMA_VERSION,
      id: newId('ses'),
      missionId,
      revision: 1,
      context,
      role: extra.role ?? null,
      disclosureMode: extra.disclosureMode ?? 'plain',
      activeStageId: STAGE_IDS[0],
      completedStages: [],
      acknowledgedStageIds: [],
      evidenceIds: [],
      artifactReferences: [],
      legacyProgress: null,
      createdAt: now,
      updatedAt: now
    };
    const valid = validateSession(session);
    if (!valid.ok) throw new JourneyStoreError('INVALID_DATA', valid.errors.join('; '));
    await this.tx<void>(['sessions'], 'readwrite', (t, done, fail) => {
      const store = t.objectStore('sessions');
      this.reqValue(store.get(session.id), (existing) => {
        if (existing) return fail(new JourneyStoreError('DUPLICATE_ID', 'A session with this id already exists.'));
        this.reqValue(store.put(session), () => done(undefined));
      });
    });
    this.announce({ type: 'session', id: session.id, revision: session.revision });
    return session;
  }

  /**
   * Compare-and-update: apply `mutate` to the stored session only if its revision is still
   * `expectedRevision`. Resolves with the committed session.
   */
  async updateSession(id: string, expectedRevision: number, mutate: (s: OrdexJourneySession) => OrdexJourneySession): Promise<OrdexJourneySession> {
    let committed: OrdexJourneySession | null = null;
    await this.tx<void>(['sessions'], 'readwrite', (t, done, fail) => {
      const store = t.objectStore('sessions');
      this.reqValue(store.get(id), (row) => {
        if (!row) return fail(new JourneyStoreError('NOT_FOUND', `No session ${id}`));
        const current = validateSession(row);
        if (!current.ok) return fail(new JourneyStoreError('INVALID_DATA', current.errors.join('; ')));
        if (current.value.revision !== expectedRevision) {
          return fail(new JourneyStoreError('REVISION_CONFLICT', `The session changed elsewhere (revision ${current.value.revision}, expected ${expectedRevision}). Reload it before saving.`));
        }
        let next: OrdexJourneySession;
        try {
          next = mutate(structuredClone(current.value));
          next = { ...next, id, missionId: current.value.missionId, revision: current.value.revision + 1, updatedAt: new Date().toISOString() };
          assertNoSecrets(next);
        } catch (err) {
          return fail(err as Error);
        }
        const valid = validateSession(next);
        if (!valid.ok) return fail(new JourneyStoreError('INVALID_DATA', valid.errors.join('; ')));
        committed = valid.value;
        this.reqValue(store.put(valid.value), () => done(undefined));
      });
    });
    this.announce({ type: 'session', id, revision: committed!.revision });
    return committed!;
  }

  /** Save a whole session the caller read earlier; refused when it changed since. */
  async saveSession(session: OrdexJourneySession): Promise<OrdexJourneySession> {
    return this.updateSession(session.id, session.revision, () => session);
  }

  async deleteSession(id: string): Promise<void> {
    await this.tx<void>(['sessions'], 'readwrite', (t, done) => this.reqValue(t.objectStore('sessions').delete(id), () => done(undefined)));
    this.announce({ type: 'session', id, revision: -1 });
  }

  // Evidence ---------------------------------------------------------------

  /** Store a validated evidence record; the oldest records beyond the bound are pruned in the same transaction. */
  async recordEvidence(evidence: EvidenceRecord): Promise<EvidenceRecord> {
    const valid = validateEvidence(evidence);
    if (!valid.ok) throw new JourneyStoreError('INVALID_DATA', valid.errors.join('; '));
    assertNoSecrets(evidence);
    await this.tx<void>(['evidence'], 'readwrite', (t, done) => {
      const store = t.objectStore('evidence');
      this.reqValue(store.put(valid.value), () => {
        this.reqValue(store.getAll(), (all: EvidenceRecord[]) => {
          const excess = all.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(LIMITS.runsKept);
          if (excess.length === 0) return done(undefined);
          let left = excess.length;
          for (const e of excess) this.reqValue(store.delete(e.id), () => (--left === 0 ? done(undefined) : undefined));
        });
      });
    });
    this.announce({ type: 'evidence', id: evidence.id });
    return valid.value;
  }

  async listEvidence(filter: { missionId?: string; tool?: string } = {}): Promise<EvidenceRecord[]> {
    const rows = await this.tx<unknown[]>(['evidence'], 'readonly', (t, done) => this.reqValue(t.objectStore('evidence').getAll(), done));
    return (rows || [])
      .map((r) => validateEvidence(r))
      .filter((r) => r.ok)
      .map((r) => (r as { value: EvidenceRecord }).value)
      .filter((e) => (!filter.missionId || e.missionId === filter.missionId) && (!filter.tool || e.tool === filter.tool))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  async getEvidence(id: string): Promise<EvidenceRecord | null> {
    const row = await this.tx<unknown>(['evidence'], 'readonly', (t, done) => this.reqValue(t.objectStore('evidence').get(id), done));
    const valid = row ? validateEvidence(row) : null;
    return valid && valid.ok ? valid.value : null;
  }

  // Artifacts --------------------------------------------------------------

  /**
   * Keep an artifact for transfer between tools and return an opaque reference. The bytes
   * stay in local storage; only the id may travel in a URL.
   */
  async putArtifact(input: { name: string; type: JourneyArtifactReference['type']; payload: string; isDeterministicFixture: boolean; summary: string }): Promise<JourneyArtifactReference> {
    const bytes = new TextEncoder().encode(input.payload);
    if (bytes.length > LIMITS.artifactPayloadBytes) throw new JourneyStoreError('INVALID_DATA', `Artifacts are limited to ${LIMITS.artifactPayloadBytes} bytes.`);
    assertNoSecrets(input.payload);
    const ref: JourneyArtifactReference = {
      id: newId('art').toLowerCase(),
      name: input.name.slice(0, 200),
      type: input.type,
      isDeterministicFixture: input.isDeterministicFixture,
      sha256: Array.from(sha256Bytes(bytes), (b: number) => b.toString(16).padStart(2, '0')).join(''),
      summary: input.summary.slice(0, 500)
    };
    await this.tx<void>(['artifacts'], 'readwrite', (t, done) => {
      this.reqValue(t.objectStore('artifacts').put({ ...ref, payload: input.payload, storedAt: new Date().toISOString() }), () => done(undefined));
    });
    return ref;
  }

  async getArtifact(id: string): Promise<(JourneyArtifactReference & { payload: string }) | null> {
    if (!/^art_[a-z0-9]{8,64}$/.test(id)) return null;
    const row = await this.tx<(JourneyArtifactReference & { payload: string }) | undefined>(['artifacts'], 'readonly', (t, done) => this.reqValue(t.objectStore('artifacts').get(id), done));
    if (!row) return null;
    const actual = Array.from(sha256Bytes(new TextEncoder().encode(row.payload)), (b: number) => b.toString(16).padStart(2, '0')).join('');
    if (actual !== row.sha256) throw new JourneyStoreError('INVALID_DATA', 'The stored artifact no longer matches its digest.');
    return row;
  }

  // Runs -------------------------------------------------------------------

  async logRun(run: Omit<ActivityRunRecord, 'id' | 'timestamp'>): Promise<ActivityRunRecord> {
    const record: ActivityRunRecord = { ...run, summary: String(run.summary).slice(0, 500), id: newId('run'), timestamp: new Date().toISOString() };
    assertNoSecrets(record);
    await this.tx<void>(['runs'], 'readwrite', (t, done) => {
      const store = t.objectStore('runs');
      this.reqValue(store.put(record), () => {
        this.reqValue(store.getAll(), (all: ActivityRunRecord[]) => {
          const excess = all.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(LIMITS.runsKept);
          if (excess.length === 0) return done(undefined);
          let left = excess.length;
          for (const r of excess) this.reqValue(store.delete(r.id), () => (--left === 0 ? done(undefined) : undefined));
        });
      });
    });
    return record;
  }

  async listRuns(): Promise<ActivityRunRecord[]> {
    const rows = await this.tx<ActivityRunRecord[]>(['runs'], 'readonly', (t, done) => this.reqValue(t.objectStore('runs').getAll(), done));
    return (rows || []).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 50);
  }

  // Import and export ------------------------------------------------------

  exportSessionJson(session: OrdexJourneySession): string {
    const result = sanitizeForExport(session as unknown as Record<string, unknown>);
    if (result.blocked) throw new JourneyStoreError('SECRET_DETECTED', result.blockReason || 'Export blocked by safety guard');
    return JSON.stringify(result.sanitized, null, 2);
  }

  /** Validate an exported session. Completion claims survive only with the evidence ids they cite. */
  importSessionJson(jsonString: string): OrdexJourneySession {
    let parsed: unknown;
    try {
      parsed = safeJsonParse(jsonString, 2 * 1024 * 1024, 16);
    } catch (err) {
      throw new JourneyStoreError('INVALID_DATA', (err as Error).message);
    }
    const valid = validateSession(parsed);
    if (!valid.ok) throw new JourneyStoreError('INVALID_DATA', `Invalid Ordex journey session: ${valid.errors.slice(0, 5).join('; ')}`);
    assertNoSecrets(valid.value);
    return valid.value;
  }

  /** Store an imported session under a fresh id so it can never overwrite an existing one. */
  async importSession(jsonString: string): Promise<OrdexJourneySession> {
    const imported = this.importSessionJson(jsonString);
    const now = new Date().toISOString();
    const session: OrdexJourneySession = { ...imported, id: newId('ses'), revision: 1, createdAt: imported.createdAt, updatedAt: now };
    await this.tx<void>(['sessions'], 'readwrite', (t, done) => this.reqValue(t.objectStore('sessions').put(session), () => done(undefined)));
    this.announce({ type: 'session', id: session.id, revision: 1 });
    return session;
  }

  /** Release the connection (tests and page teardown). */
  async close(): Promise<void> {
    if (!this.dbPromise) return;
    try {
      (await this.dbPromise).close();
    } catch {
      // never opened
    }
    this.dbPromise = null;
    this.channel?.close?.();
  }
}

export const journeyStore = new JourneyStore();

/** The stage ids in order, for consumers that walk a mission. */
export const JOURNEY_STAGES: readonly JourneyStageId[] = STAGE_IDS;
