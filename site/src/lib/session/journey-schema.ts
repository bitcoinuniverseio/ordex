/**
 * OX-S03: the versioned shared journey context and evidence schema.
 *
 * Every tool records what it actually ran as an EvidenceRecord bound to the context it ran
 * in (network, gateway origin, protocol version, source build). Missions complete only from
 * matching evidence, never from a click. Imported or persisted data is validated field by
 * field; an unknown schema is rejected, and version 1 sessions are migrated with their old
 * progress kept for review but not trusted as evidence.
 */

export const JOURNEY_SCHEMA_VERSION = 2;
export const EVIDENCE_SCHEMA = 'ordex.evidence/v1';
export const SETTINGS_SCHEMA_VERSION = 2;

export const NETWORKS = ['mainnet', 'signet', 'testnet4', 'regtest'] as const;
export type Network = (typeof NETWORKS)[number];

export const STAGE_IDS = ['understand', 'prepare', 'simulate', 'inspect', 'verify', 'integrate', 'validate', 'finish'] as const;
export type JourneyStageId = (typeof STAGE_IDS)[number];

export const TOOLS = ['lab', 'sandbox', 'artifact-lens', 'conformance', 'doctor', 'playground', 'events', 'kits', 'failure-navigator', 'learn', 'wizards', 'atlas'] as const;
export type ToolId = (typeof TOOLS)[number];

export const RESULT_STATES = ['accepted', 'refused', 'unknown', 'passed', 'failed', 'blocked', 'read'] as const;
export type ResultState = (typeof RESULT_STATES)[number];

export const EVIDENCE_CLASSES = ['Chain proof', 'Protocol verification', 'Gateway observation', 'Publisher claim', 'Deterministic example'] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const LIMITS = Object.freeze({
  evidencePerSession: 200,
  artifactRefsPerSession: 100,
  runsKept: 200,
  idLength: 128,
  textLength: 2000,
  artifactPayloadBytes: 2 * 1024 * 1024
});

/** Where a run happened. Evidence from one context never satisfies a mission in another. */
export interface JourneyContext {
  network: Network;
  /** The gateway origin the run talked to, or null for local deterministic execution. */
  gatewayOrigin: string | null;
  protocolVersion: string;
  sourceBuild: string;
}

export interface EvidenceRecord {
  schema: typeof EVIDENCE_SCHEMA;
  id: string;
  tool: ToolId;
  operation: string;
  missionId: string | null;
  stageId: JourneyStageId | null;
  context: JourneyContext;
  /** SHA-256 of the exact input the tool ran on, when it ran on an input. */
  inputDigest: string | null;
  artifactDigests: string[];
  result: { state: ResultState; code: string | null; reason: string | null };
  evidenceClass: EvidenceClass;
  recordedAt: string;
}

export interface JourneyArtifactReference {
  /** Opaque id; the bytes live in the artifact store, never in a URL. */
  id: string;
  name: string;
  type: 'psbt' | 'tx' | 'json' | 'manifest' | 'vector' | 'report';
  isDeterministicFixture: boolean;
  sha256: string;
  summary: string;
}

export interface OrdexJourneySession {
  schemaVersion: typeof JOURNEY_SCHEMA_VERSION;
  id: string;
  missionId: string;
  /** Incremented by every committed write; a write with a stale revision is refused. */
  revision: number;
  context: JourneyContext;
  role: string | null;
  disclosureMode: 'plain' | 'builder' | 'proof';
  activeStageId: JourneyStageId;
  /** Stages whose completion predicate was satisfied by the evidence ids listed for them. */
  completedStages: Array<{ stageId: JourneyStageId; evidenceIds: string[]; completedAt: string }>;
  /** Stages the reader acknowledged; progress only, never completion. */
  acknowledgedStageIds: JourneyStageId[];
  evidenceIds: string[];
  artifactReferences: JourneyArtifactReference[];
  /** Progress carried over from a version 1 session: shown for review, never trusted. */
  legacyProgress: { migratedFrom: number; completedStageIds: string[] } | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  disclosureMode: 'plain' | 'builder' | 'proof';
  protocolVersion: string;
  network: Network;
  /** Configured gateway origin; empty means local deterministic execution only. */
  gatewayOrigin: string;
  /** Read-only never sends a request with an effect. Write requires explicit confirmation. */
  mode: 'read-only' | 'write';
  theme: 'light' | 'dark';
}

export const DEFAULT_SETTINGS: UserSettings = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  disclosureMode: 'plain',
  protocolVersion: '1.2',
  network: 'mainnet',
  gatewayOrigin: '',
  mode: 'read-only',
  theme: 'light'
}) as UserSettings;

type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+(\.\d+)?$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
const isText = (v: unknown, max = LIMITS.textLength) => typeof v === 'string' && v.length <= max;

function onlyKeys(obj: Record<string, unknown>, allowed: string[], path: string, errors: string[]) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${path}.${k} is not part of the schema`);
}

/**
 * A gateway origin must be an https origin, or http on a loopback host for local testing.
 * Paths, credentials, queries and fragments are refused.
 */
export function normalizeGatewayOrigin(input: string): { ok: true; origin: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, origin: '' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Enter a full origin such as https://gateway.example' };
  }
  if (url.username || url.password) return { ok: false, error: 'The origin must not carry credentials.' };
  if (url.search || url.hash || (url.pathname && url.pathname !== '/')) return { ok: false, error: 'Enter only the origin, without a path, query or fragment.' };
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return { ok: false, error: 'Use https, or http only for a loopback host.' };
  return { ok: true, origin: url.origin };
}

export function validateContext(value: unknown, path = 'context'): Result<JourneyContext> {
  const errors: string[] = [];
  if (!isObj(value)) return { ok: false, errors: [`${path} must be an object`] };
  onlyKeys(value, ['network', 'gatewayOrigin', 'protocolVersion', 'sourceBuild'], path, errors);
  if (!NETWORKS.includes(value.network as Network)) errors.push(`${path}.network must be one of ${NETWORKS.join(', ')}`);
  if (value.gatewayOrigin !== null) {
    const o = typeof value.gatewayOrigin === 'string' ? normalizeGatewayOrigin(value.gatewayOrigin) : null;
    if (!o || !o.ok || o.origin !== value.gatewayOrigin || value.gatewayOrigin === '') errors.push(`${path}.gatewayOrigin must be null or a normalized origin`);
  }
  if (typeof value.protocolVersion !== 'string' || !VERSION.test(value.protocolVersion)) errors.push(`${path}.protocolVersion is invalid`);
  if (typeof value.sourceBuild !== 'string' || !/^([0-9a-f]{7,64}|unknown)$/.test(value.sourceBuild)) errors.push(`${path}.sourceBuild must be a commit id or unknown`);
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as JourneyContext };
}

export function validateEvidence(value: unknown): Result<EvidenceRecord> {
  const errors: string[] = [];
  if (!isObj(value)) return { ok: false, errors: ['evidence must be an object'] };
  onlyKeys(value, ['schema', 'id', 'tool', 'operation', 'missionId', 'stageId', 'context', 'inputDigest', 'artifactDigests', 'result', 'evidenceClass', 'recordedAt'], 'evidence', errors);
  if (value.schema !== EVIDENCE_SCHEMA) errors.push(`evidence.schema must be ${EVIDENCE_SCHEMA}`);
  if (typeof value.id !== 'string' || !ID.test(value.id)) errors.push('evidence.id is invalid');
  if (!TOOLS.includes(value.tool as ToolId)) errors.push('evidence.tool is not a known tool');
  if (!isText(value.operation, 200) || value.operation === '') errors.push('evidence.operation is invalid');
  if (value.missionId !== null && (typeof value.missionId !== 'string' || !ID.test(value.missionId))) errors.push('evidence.missionId is invalid');
  if (value.stageId !== null && !STAGE_IDS.includes(value.stageId as JourneyStageId)) errors.push('evidence.stageId is invalid');
  const ctx = validateContext(value.context, 'evidence.context');
  if (!ctx.ok) errors.push(...ctx.errors);
  if (value.inputDigest !== null && (typeof value.inputDigest !== 'string' || !HEX64.test(value.inputDigest))) errors.push('evidence.inputDigest must be null or 64 hex');
  if (!Array.isArray(value.artifactDigests) || value.artifactDigests.length > 50 || !value.artifactDigests.every((d) => typeof d === 'string' && HEX64.test(d))) errors.push('evidence.artifactDigests must be up to 50 hex digests');
  if (!isObj(value.result)) errors.push('evidence.result must be an object');
  else {
    onlyKeys(value.result, ['state', 'code', 'reason'], 'evidence.result', errors);
    if (!RESULT_STATES.includes(value.result.state as ResultState)) errors.push('evidence.result.state is invalid');
    if (value.result.code !== null && (typeof value.result.code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(value.result.code))) errors.push('evidence.result.code is invalid');
    if (value.result.reason !== null && !isText(value.result.reason)) errors.push('evidence.result.reason is invalid');
  }
  if (!EVIDENCE_CLASSES.includes(value.evidenceClass as EvidenceClass)) errors.push('evidence.evidenceClass is invalid');
  if (!isIso(value.recordedAt)) errors.push('evidence.recordedAt must be an ISO timestamp');
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as EvidenceRecord };
}

function validateArtifactRef(value: unknown, i: number, errors: string[]) {
  const p = `artifactReferences[${i}]`;
  if (!isObj(value)) {
    errors.push(`${p} must be an object`);
    return;
  }
  onlyKeys(value, ['id', 'name', 'type', 'isDeterministicFixture', 'sha256', 'summary'], p, errors);
  if (typeof value.id !== 'string' || !/^art_[a-z0-9]{8,64}$/.test(value.id)) errors.push(`${p}.id must be an opaque art_ id`);
  if (!isText(value.name, 200)) errors.push(`${p}.name is invalid`);
  if (!['psbt', 'tx', 'json', 'manifest', 'vector', 'report'].includes(value.type as string)) errors.push(`${p}.type is invalid`);
  if (typeof value.isDeterministicFixture !== 'boolean') errors.push(`${p}.isDeterministicFixture must be boolean`);
  if (typeof value.sha256 !== 'string' || !HEX64.test(value.sha256)) errors.push(`${p}.sha256 must be 64 hex`);
  if (!isText(value.summary, 500)) errors.push(`${p}.summary is invalid`);
}

/** Validate a stored or imported session. Version 1 is migrated; anything else unknown is refused. */
export function validateSession(value: unknown): Result<OrdexJourneySession> {
  if (isObj(value) && value.schemaVersion === 1) return migrateV1Session(value);
  const errors: string[] = [];
  if (!isObj(value)) return { ok: false, errors: ['session must be an object'] };
  if (value.schemaVersion !== JOURNEY_SCHEMA_VERSION) return { ok: false, errors: [`Unsupported session schema version ${String(value.schemaVersion)}`] };
  onlyKeys(value, ['schemaVersion', 'id', 'missionId', 'revision', 'context', 'role', 'disclosureMode', 'activeStageId', 'completedStages', 'acknowledgedStageIds', 'evidenceIds', 'artifactReferences', 'legacyProgress', 'createdAt', 'updatedAt'], 'session', errors);
  if (typeof value.id !== 'string' || !ID.test(value.id)) errors.push('session.id is invalid');
  if (typeof value.missionId !== 'string' || !ID.test(value.missionId)) errors.push('session.missionId is invalid');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) errors.push('session.revision must be a non-negative integer');
  const ctx = validateContext(value.context, 'session.context');
  if (!ctx.ok) errors.push(...ctx.errors);
  if (value.role !== null && !isText(value.role, 64)) errors.push('session.role is invalid');
  if (!['plain', 'builder', 'proof'].includes(value.disclosureMode as string)) errors.push('session.disclosureMode is invalid');
  if (!STAGE_IDS.includes(value.activeStageId as JourneyStageId)) errors.push('session.activeStageId is invalid');
  const evidenceIds = Array.isArray(value.evidenceIds) ? value.evidenceIds : null;
  if (!evidenceIds || evidenceIds.length > LIMITS.evidencePerSession || !evidenceIds.every((id) => typeof id === 'string' && ID.test(id))) errors.push(`session.evidenceIds must hold up to ${LIMITS.evidencePerSession} ids`);
  else if (new Set(evidenceIds).size !== evidenceIds.length) errors.push('session.evidenceIds holds duplicates');
  if (!Array.isArray(value.completedStages) || value.completedStages.length > STAGE_IDS.length) errors.push('session.completedStages is invalid');
  else {
    const seen = new Set<string>();
    value.completedStages.forEach((c, i) => {
      if (!isObj(c) || !STAGE_IDS.includes(c.stageId as JourneyStageId) || !isIso(c.completedAt) || !Array.isArray(c.evidenceIds) || c.evidenceIds.length === 0) {
        errors.push(`session.completedStages[${i}] is invalid`);
        return;
      }
      if (seen.has(c.stageId as string)) errors.push(`session.completedStages lists ${c.stageId} twice`);
      seen.add(c.stageId as string);
      for (const id of c.evidenceIds as unknown[]) if (!evidenceIds?.includes(id as string)) errors.push(`session.completedStages[${i}] cites evidence ${String(id)} the session does not hold`);
    });
  }
  if (!Array.isArray(value.acknowledgedStageIds) || !value.acknowledgedStageIds.every((s) => STAGE_IDS.includes(s as JourneyStageId)) || new Set(value.acknowledgedStageIds).size !== value.acknowledgedStageIds.length) errors.push('session.acknowledgedStageIds is invalid');
  if (!Array.isArray(value.artifactReferences) || value.artifactReferences.length > LIMITS.artifactRefsPerSession) errors.push('session.artifactReferences is invalid');
  else value.artifactReferences.forEach((a, i) => validateArtifactRef(a, i, errors));
  if (value.legacyProgress !== null && !(isObj(value.legacyProgress) && value.legacyProgress.migratedFrom === 1 && Array.isArray(value.legacyProgress.completedStageIds))) errors.push('session.legacyProgress is invalid');
  if (!isIso(value.createdAt) || !isIso(value.updatedAt)) errors.push('session timestamps must be ISO timestamps');
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as OrdexJourneySession };
}

/**
 * Version 1 sessions recorded completion from a click. Keep their identity and position,
 * move their claimed completions to legacyProgress, and require fresh evidence.
 */
function migrateV1Session(v1: Record<string, unknown>): Result<OrdexJourneySession> {
  const id = typeof v1.id === 'string' && ID.test(v1.id) ? v1.id : null;
  const missionId = typeof v1.missionId === 'string' && ID.test(v1.missionId) ? v1.missionId : null;
  if (!id || !missionId) return { ok: false, errors: ['The version 1 session has no valid id or mission id'] };
  const now = new Date().toISOString();
  const session: OrdexJourneySession = {
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    id,
    missionId,
    revision: 0,
    context: { network: 'mainnet', gatewayOrigin: null, protocolVersion: typeof v1.protocolVersion === 'string' && VERSION.test(v1.protocolVersion) ? v1.protocolVersion : '1.2', sourceBuild: 'unknown' },
    role: typeof v1.role === 'string' ? v1.role.slice(0, 64) : null,
    disclosureMode: ['plain', 'builder', 'proof'].includes(v1.disclosureMode as string) ? (v1.disclosureMode as OrdexJourneySession['disclosureMode']) : 'plain',
    activeStageId: STAGE_IDS.includes(v1.activeStageId as JourneyStageId) ? (v1.activeStageId as JourneyStageId) : 'understand',
    completedStages: [],
    acknowledgedStageIds: [],
    evidenceIds: [],
    artifactReferences: [],
    legacyProgress: {
      migratedFrom: 1,
      completedStageIds: Array.isArray(v1.completedStageIds) ? (v1.completedStageIds as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, STAGE_IDS.length) : []
    },
    createdAt: isIso(v1.createdAt) ? (v1.createdAt as string) : now,
    updatedAt: now
  };
  return validateSession(session);
}

/** Validate settings; version 1 settings are migrated, keeping the mainnet default. */
export function validateSettings(value: unknown): Result<UserSettings> {
  if (!isObj(value)) return { ok: false, errors: ['settings must be an object'] };
  if (value.schemaVersion === undefined) {
    // Version 1 had environment and customGatewayUrl.
    const env = value.environment;
    const origin = typeof value.customGatewayUrl === 'string' ? normalizeGatewayOrigin(value.customGatewayUrl) : { ok: true as const, origin: '' };
    const migrated: UserSettings = {
      ...DEFAULT_SETTINGS,
      disclosureMode: ['plain', 'builder', 'proof'].includes(value.disclosureMode as string) ? (value.disclosureMode as UserSettings['disclosureMode']) : 'plain',
      protocolVersion: typeof value.protocolVersion === 'string' && VERSION.test(value.protocolVersion) ? value.protocolVersion : '1.2',
      gatewayOrigin: (env === 'custom-readonly' || env === 'custom-write') && origin.ok ? origin.origin : '',
      mode: env === 'custom-write' ? 'write' : 'read-only',
      theme: value.theme === 'dark' ? 'dark' : 'light'
    };
    return validateSettings(migrated);
  }
  const errors: string[] = [];
  if (value.schemaVersion !== SETTINGS_SCHEMA_VERSION) return { ok: false, errors: [`Unsupported settings schema ${String(value.schemaVersion)}`] };
  onlyKeys(value, Object.keys(DEFAULT_SETTINGS), 'settings', errors);
  if (!['plain', 'builder', 'proof'].includes(value.disclosureMode as string)) errors.push('settings.disclosureMode is invalid');
  if (typeof value.protocolVersion !== 'string' || !VERSION.test(value.protocolVersion)) errors.push('settings.protocolVersion is invalid');
  if (!NETWORKS.includes(value.network as Network)) errors.push('settings.network is invalid');
  const o = typeof value.gatewayOrigin === 'string' ? normalizeGatewayOrigin(value.gatewayOrigin) : null;
  if (!o || !o.ok || o.origin !== value.gatewayOrigin) errors.push('settings.gatewayOrigin must be empty or a normalized origin');
  if (!['read-only', 'write'].includes(value.mode as string)) errors.push('settings.mode is invalid');
  if (!['light', 'dark'].includes(value.theme as string)) errors.push('settings.theme is invalid');
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as UserSettings };
}

/** The context a run made now under these settings would carry. */
export function contextFromSettings(settings: UserSettings, sourceBuild: string): JourneyContext {
  return {
    network: settings.network,
    gatewayOrigin: settings.gatewayOrigin || null,
    protocolVersion: settings.protocolVersion,
    sourceBuild: /^([0-9a-f]{7,64})$/.test(sourceBuild) ? sourceBuild : 'unknown'
  };
}

/** Two contexts agree when network, origin and protocol match; a build change keeps evidence readable but stale. */
export function sameContext(a: JourneyContext, b: JourneyContext): boolean {
  return a.network === b.network && a.gatewayOrigin === b.gatewayOrigin && a.protocolVersion === b.protocolVersion;
}

export function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
