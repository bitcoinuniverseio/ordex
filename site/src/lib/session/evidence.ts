/**
 * OX-S03: how tools record what they actually ran. A tool calls recordToolEvidence after a
 * completed run; the record carries the current settings context and build, and when the
 * page was opened from a mission (?journey=<session>&stage=<stage>) it is attached to that
 * session. Only opaque ids travel in the URL.
 */

import { journeyStore, JourneyStoreError } from './journey-store.js';
import {
  EVIDENCE_SCHEMA,
  LIMITS,
  STAGE_IDS,
  contextFromSettings,
  newId,
  type EvidenceClass,
  type EvidenceRecord,
  type JourneyStageId,
  type ResultState,
  type ToolId
} from './journey-schema.js';

export const SOURCE_BUILD: string =
  (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string> }).env?.PUBLIC_ORDEX_BUILD_REVISION) || 'unknown';

export interface JourneyHandoff {
  sessionId: string;
  stageId: JourneyStageId;
  artifactId: string | null;
}

/** Read and validate the journey handoff parameters of the current page. */
export function readJourneyHandoff(search: string = typeof window !== 'undefined' ? window.location.search : ''): JourneyHandoff | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get('journey');
  const stageId = params.get('stage');
  const artifactId = params.get('artifact');
  if (!sessionId || !/^ses_[0-9a-f]{8,64}$/.test(sessionId)) return null;
  if (!stageId || !STAGE_IDS.includes(stageId as JourneyStageId)) return null;
  return { sessionId, stageId: stageId as JourneyStageId, artifactId: artifactId && /^art_[a-z0-9]{8,64}$/.test(artifactId) ? artifactId : null };
}

/** The query string that hands a mission stage (and optionally an artifact) to a tool. */
export function journeyQuery(sessionId: string, stageId: JourneyStageId, artifactId?: string | null): string {
  const p = new URLSearchParams({ journey: sessionId, stage: stageId });
  if (artifactId) p.set('artifact', artifactId);
  return `?${p.toString()}`;
}

export interface ToolRun {
  tool: ToolId;
  operation: string;
  state: ResultState;
  code?: string | null;
  reason?: string | null;
  evidenceClass: EvidenceClass;
  inputDigest?: string | null;
  artifactDigests?: string[];
  /** Use this gateway origin instead of the configured one (for example Gateway Doctor's target). */
  gatewayOrigin?: string | null;
}

/**
 * Record a completed run. Resolves with the committed evidence, or null when storage is
 * unavailable (the tool's own result stands; nothing is claimed as saved).
 */
export async function recordToolEvidence(run: ToolRun, handoff: JourneyHandoff | null = readJourneyHandoff()): Promise<EvidenceRecord | null> {
  try {
    const settings = await journeyStore.getSettings();
    const context = contextFromSettings(settings, SOURCE_BUILD);
    if (run.gatewayOrigin !== undefined) context.gatewayOrigin = run.gatewayOrigin;
    const session = handoff ? await journeyStore.getSession(handoff.sessionId) : null;
    const evidence: EvidenceRecord = {
      schema: EVIDENCE_SCHEMA,
      id: newId('ev'),
      tool: run.tool,
      operation: run.operation.slice(0, 200),
      missionId: session?.missionId ?? null,
      stageId: session ? handoff!.stageId : null,
      context,
      inputDigest: run.inputDigest ?? null,
      artifactDigests: (run.artifactDigests || []).slice(0, 50),
      result: { state: run.state, code: run.code ?? null, reason: run.reason ? run.reason.slice(0, 2000) : null },
      evidenceClass: run.evidenceClass,
      recordedAt: new Date().toISOString()
    };
    const saved = await journeyStore.recordEvidence(evidence);
    if (session) await attachEvidence(session.id, saved.id);
    return saved;
  } catch {
    return null;
  }
}

/** Attach evidence to a session, retrying once when another tab committed first. */
export async function attachEvidence(sessionId: string, evidenceId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await journeyStore.getSession(sessionId);
    if (!session) return;
    if (session.evidenceIds.includes(evidenceId)) return;
    try {
      await journeyStore.updateSession(session.id, session.revision, (s) => {
        const cited = new Set(s.completedStages.flatMap((c) => c.evidenceIds));
        let ids = [...s.evidenceIds, evidenceId];
        // Stay within the bound by dropping the oldest evidence no completed stage cites.
        while (ids.length > LIMITS.evidencePerSession) {
          const drop = ids.findIndex((id) => !cited.has(id));
          if (drop < 0) break;
          ids.splice(drop, 1);
        }
        return { ...s, evidenceIds: ids };
      });
      return;
    } catch (err) {
      if (!(err instanceof JourneyStoreError && err.code === 'REVISION_CONFLICT')) throw err;
    }
  }
}
