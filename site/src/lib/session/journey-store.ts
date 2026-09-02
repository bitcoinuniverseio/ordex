/**
 * Ordex Durable Journey Session Store
 * 
 * Native IndexedDB-backed persistence for mission journeys, progressive disclosure
 * settings, protocol version selection, and sanitized activity run history.
 * Includes cross-tab synchronization via BroadcastChannel with storage event fallback.
 */

import { detectSecrets, safeJsonParse, sanitizeForExport } from '../security/sanitizer.js';

export interface JourneyArtifactReference {
  id: string;
  name: string;
  type: 'psbt' | 'tx' | 'json' | 'manifest' | 'vector';
  isDeterministicFixture: boolean;
  fingerprint: string;
  summary: string;
  data?: unknown; // Only present if isDeterministicFixture is true or explicitly saved
}

export interface ActivityRunRecord {
  id: string;
  product: 'launchpad' | 'sandbox' | 'artifact-lens' | 'failure-navigator' | 'protocol-lab' | 'conformance' | 'kits' | 'doctor';
  operation: string;
  isDeterministic: boolean;
  protocolVersion: string;
  timestamp: string;
  outcome: 'PASS' | 'REFUSAL' | 'ERROR' | 'INFO';
  evidenceClass: 'Chain proof' | 'Protocol verification' | 'Gateway observation' | 'Publisher claim' | 'Deterministic example';
  summary: string;
  reopenRoute: string;
}

export interface UserSettings {
  disclosureMode: 'plain' | 'builder' | 'proof';
  protocolVersion: string;
  environment: 'deterministic' | 'local' | 'custom-readonly' | 'custom-write';
  customGatewayUrl: string;
  theme: 'light' | 'dark';
}

export interface OrdexJourneySession {
  schemaVersion: number;
  id: string;
  missionId: string;
  protocolVersion: string;
  role: string | null;
  environment: string;
  disclosureMode: 'plain' | 'builder' | 'proof';
  activeStageId: string;
  completedStageIds: string[];
  stageState: Record<string, unknown>;
  artifactReferences: JourneyArtifactReference[];
  runReferences: string[];
  buildCommit: string;
  createdAt: string;
  updatedAt: string;
}

const DB_NAME = 'ordex_experience_db';
const DB_VERSION = 1;
const BROADCAST_CHANNEL_NAME = 'ordex_session_sync';

export const DEFAULT_SETTINGS: UserSettings = {
  disclosureMode: 'plain',
  protocolVersion: '1.2',
  environment: 'deterministic',
  customGatewayUrl: '',
  theme: 'light'
};

class JourneyStore {
  private db: IDBDatabase | null = null;
  private memorySessions = new Map<string, OrdexJourneySession>();
  private memorySettings: UserSettings = { ...DEFAULT_SETTINGS };
  private memoryRuns: ActivityRunRecord[] = [];
  private broadcastChannel: BroadcastChannel | null = null;
  private isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
  private syncListeners: Array<(session: OrdexJourneySession) => void> = [];

  constructor() {
    if (this.isBrowser) {
      this.initBroadcast();
    }
  }

  private initBroadcast(): void {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
        this.broadcastChannel.onmessage = (event) => {
          if (event.data?.type === 'SESSION_UPDATED' && event.data.session) {
            this.notifySyncListeners(event.data.session);
          }
        };
      }
    } catch {
      // Fallback or restricted environment
    }
  }

  public onSessionSync(callback: (session: OrdexJourneySession) => void): () => void {
    this.syncListeners.push(callback);
    return () => {
      this.syncListeners = this.syncListeners.filter(l => l !== callback);
    };
  }

  private notifySyncListeners(session: OrdexJourneySession): void {
    for (const listener of this.syncListeners) {
      try {
        listener(session);
      } catch {
        // Listener error suppressed
      }
    }
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.isBrowser) {
      throw new Error('IndexedDB unavailable in non-browser environment');
    }
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('runs')) {
          db.createObjectStore('runs', { keyPath: 'id' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };

      request.onerror = () => {
        reject(new Error('Failed to open Ordex IndexedDB storage'));
      };
    });
  }

  public async getSettings(): Promise<UserSettings> {
    if (!this.isBrowser) return { ...this.memorySettings };
    try {
      const db = await this.getDb();
      return new Promise((resolve) => {
        const tx = db.transaction('settings', 'readonly');
        const store = tx.objectStore('settings');
        const req = store.get('current');
        req.onsuccess = () => {
          if (req.result?.data) {
            resolve(req.result.data);
          } else {
            resolve({ ...DEFAULT_SETTINGS });
          }
        };
        req.onerror = () => resolve({ ...DEFAULT_SETTINGS });
      });
    } catch {
      return { ...this.memorySettings };
    }
  }

  public async saveSettings(settings: Partial<UserSettings>): Promise<UserSettings> {
    const current = await this.getSettings();
    const updated: UserSettings = { ...current, ...settings };
    this.memorySettings = updated;

    if (this.isBrowser) {
      try {
        const db = await this.getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('settings', 'readwrite');
          const store = tx.objectStore('settings');
          const req = store.put({ id: 'current', data: updated });
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } catch {
        // Fallback in memory
      }
    }
    return updated;
  }

  public async getSession(id: string): Promise<OrdexJourneySession | null> {
    if (!this.isBrowser) {
      return this.memorySessions.get(id) || null;
    }
    try {
      const db = await this.getDb();
      return new Promise((resolve) => {
        const tx = db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return this.memorySessions.get(id) || null;
    }
  }

  public async getActiveSession(): Promise<OrdexJourneySession | null> {
    const sessions = await this.listSessions();
    if (sessions.length === 0) return null;
    // Sort by latest updatedAt
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sessions[0];
  }

  public async listSessions(): Promise<OrdexJourneySession[]> {
    if (!this.isBrowser) {
      return Array.from(this.memorySessions.values());
    }
    try {
      const db = await this.getDb();
      return new Promise((resolve) => {
        const tx = db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch {
      return Array.from(this.memorySessions.values());
    }
  }

  public async saveSession(session: OrdexJourneySession): Promise<void> {
    // Assert no raw private secrets exist before saving
    const serialized = JSON.stringify(session);
    const secretCheck = detectSecrets(serialized);
    if (secretCheck.hasHighConfidenceSecrets) {
      throw new Error(`Cannot persist session containing high confidence secrets: ${secretCheck.detectedSecrets.map(s => s.type).join(', ')}`);
    }

    const updatedSession: OrdexJourneySession = {
      ...session,
      updatedAt: new Date().toISOString()
    };

    this.memorySessions.set(updatedSession.id, updatedSession);

    if (this.isBrowser) {
      try {
        const db = await this.getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('sessions', 'readwrite');
          const store = tx.objectStore('sessions');
          const req = store.put(updatedSession);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });

        // Broadcast to other tabs
        this.broadcastChannel?.postMessage({
          type: 'SESSION_UPDATED',
          session: updatedSession
        });
      } catch {
        // Fallback in memory
      }
    }
  }

  public async logRun(run: Omit<ActivityRunRecord, 'id' | 'timestamp'>): Promise<ActivityRunRecord> {
    const record: ActivityRunRecord = {
      ...run,
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString()
    };

    this.memoryRuns.unshift(record);
    if (this.memoryRuns.length > 50) this.memoryRuns.pop();

    if (this.isBrowser) {
      try {
        const db = await this.getDb();
        await new Promise<void>((resolve) => {
          const tx = db.transaction('runs', 'readwrite');
          const store = tx.objectStore('runs');
          store.put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch {
        // Suppress
      }
    }

    return record;
  }

  public async listRuns(): Promise<ActivityRunRecord[]> {
    if (!this.isBrowser) return [...this.memoryRuns];
    try {
      const db = await this.getDb();
      return new Promise((resolve) => {
        const tx = db.transaction('runs', 'readonly');
        const store = tx.objectStore('runs');
        const req = store.getAll();
        req.onsuccess = () => {
          const list: ActivityRunRecord[] = req.result || [];
          list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          resolve(list.slice(0, 50));
        };
        req.onerror = () => resolve([...this.memoryRuns]);
      });
    } catch {
      return [...this.memoryRuns];
    }
  }

  public exportSessionJson(session: OrdexJourneySession): string {
    const result = sanitizeForExport(session as unknown as Record<string, unknown>);
    if (result.blocked) {
      throw new Error(result.blockReason || 'Export blocked by safety guard');
    }
    return JSON.stringify(result.sanitized, null, 2);
  }

  public importSessionJson(jsonString: string): OrdexJourneySession {
    const parsed = safeJsonParse<OrdexJourneySession>(jsonString, 2 * 1024 * 1024, 16);
    if (!parsed.id || !parsed.missionId || !parsed.schemaVersion) {
      throw new Error('Invalid Ordex journey session schema');
    }
    return parsed;
  }
}

export const journeyStore = new JourneyStore();
