/**
 * OX-S03: typed stage adapters. For every mission and stage this names the tool that must
 * run, the operation it must record and the result that counts. A stage completes only when
 * matching evidence exists for the session's mission, recorded in the same network, gateway
 * origin and protocol context by the current build. Reading is progress, never completion,
 * except for the understand stage, which is reading by nature. Stages that need a gateway
 * cannot be satisfied by local deterministic runs.
 */

import type { EvidenceRecord, JourneyContext, JourneyStageId, ToolId } from '../session/journey-schema.js';
import { sameContext } from '../session/journey-schema.js';

export interface EvidenceRequirement {
  label: string;
  tool: ToolId;
  /** Operations that count; a string ending in ':' or '/' matches as a prefix. */
  operations: string[];
  states: EvidenceRecord['result']['state'][];
  /** True when only a run against a configured gateway counts. */
  needsGateway: boolean;
}

type StageMap = Record<Exclude<JourneyStageId, 'finish'>, EvidenceRequirement>;

const read = (missionId: string): EvidenceRequirement => ({
  label: 'Read the guide for this mission and acknowledge it',
  tool: 'learn',
  operations: [`read:${missionId}`],
  states: ['read'],
  needsGateway: false
});
const lens: EvidenceRequirement = {
  label: 'Decode or compare an artifact in Artifact Lens',
  tool: 'artifact-lens',
  operations: ['decode:', 'compare:'],
  states: ['accepted', 'refused'],
  needsGateway: false
};
const scenario = (...ids: string[]): EvidenceRequirement => ({
  label: `Complete ${ids.length > 1 ? 'one of the scenarios' : 'the scenario'} ${ids.join(' or ')} in the Sandbox`,
  tool: 'sandbox',
  operations: ids.map((id) => `scenario:${id}`),
  states: ['passed'],
  needsGateway: false
});
const lab = (families: string[], states: EvidenceRecord['result']['state'][] = ['accepted']): EvidenceRequirement => ({
  label: `Run the ${families.join(' or ')} reference verifier in Protocol Lab${states.includes('refused') && !states.includes('accepted') ? ' and reproduce a refusal' : ''}`,
  tool: 'lab',
  operations: families.map((f) => `${f}/`),
  states,
  needsGateway: false
});
const suite = (families: string[]): EvidenceRequirement => ({
  label: `Run the ${families.join(', ')} conformance vectors with every vector matching`,
  tool: 'conformance',
  operations: families.map((f) => `suite:${f}`),
  states: ['passed'],
  needsGateway: false
});
const kit = (capability: string): EvidenceRequirement => ({
  label: `Generate and verify a starter kit with the ${capability} capability`,
  tool: 'kits',
  operations: [`kit:${capability}`],
  states: ['passed'],
  needsGateway: false
});
const api = (label: string, operations: string[] = ['api:']): EvidenceRequirement => ({
  label,
  tool: 'playground',
  operations,
  states: ['passed'],
  needsGateway: true
});
const wizard: EvidenceRequirement = {
  label: 'Finish the matching guided wizard',
  tool: 'wizards',
  operations: ['wizard:'],
  states: ['passed'],
  needsGateway: false
};

export const MISSION_EVIDENCE: Record<string, StageMap> = {
  'integrate-public-asks': {
    understand: read('integrate-public-asks'),
    prepare: api('Read the catalog or an order from the configured gateway in the API Playground'),
    simulate: scenario('ask.publish-and-settle.success'),
    inspect: lens,
    verify: lab(['purchase']),
    integrate: kit('purchase'),
    validate: suite(['purchase'])
  },
  'complete-single-or-batch-purchase': {
    understand: read('complete-single-or-batch-purchase'),
    prepare: api('Request a quote or preflight from the configured gateway in the API Playground'),
    simulate: scenario('purchase.batch.success', 'ask.publish-and-settle.success'),
    inspect: lens,
    verify: lab(['purchase']),
    integrate: kit('purchase'),
    validate: suite(['purchase'])
  },
  'integrate-buyer-funded-offers': {
    understand: read('integrate-buyer-funded-offers'),
    prepare: wizard,
    simulate: scenario('offer.accept.success', 'offer.recover-after-expiry.success'),
    inspect: lens,
    verify: lab(['offers']),
    integrate: kit('offers'),
    validate: suite(['offers'])
  },
  'protect-wallet-signing': {
    understand: read('protect-wallet-signing'),
    prepare: wizard,
    simulate: scenario('ask.wallet-output-reorder.refusal', 'cold-sign.returned-bytes-mismatch.refusal'),
    inspect: { ...lens, label: 'Compare two artifacts in Artifact Lens', operations: ['compare:'] },
    verify: lab(['offline-signing', 'safeops']),
    integrate: kit('safeops'),
    validate: suite(['safeops', 'offline-signing'])
  },
  'integrate-atomic-swaps': {
    understand: read('integrate-atomic-swaps'),
    prepare: wizard,
    simulate: scenario('swap.atomic-settlement.success'),
    inspect: lens,
    verify: lab(['swaps']),
    integrate: kit('swaps'),
    validate: suite(['swaps'])
  },
  'operate-gateway-and-events': {
    understand: read('operate-gateway-and-events'),
    prepare: api('Read gateway health from the configured gateway in the API Playground', ['api:getHealth', 'api:getProtocol']),
    simulate: { label: 'Receive or replay events from the configured gateway in the Event Playground', tool: 'events', operations: ['events:'], states: ['passed'], needsGateway: true },
    inspect: { label: 'Validate an event envelope or webhook signature in the Event Playground', tool: 'events', operations: ['events:'], states: ['passed', 'accepted'], needsGateway: false },
    verify: lab(['events']),
    integrate: kit('events'),
    validate: { label: 'Run Gateway Doctor against the configured gateway with every check passing', tool: 'doctor', operations: ['doctor:'], states: ['passed'], needsGateway: true }
  },
  'verify-collection-and-attached-assets': {
    understand: read('verify-collection-and-attached-assets'),
    prepare: wizard,
    simulate: scenario('collection.membership.success', 'counterparty.attachment-mismatch.refusal'),
    inspect: lens,
    verify: lab(['collection-manifest', 'counterparty-asset']),
    integrate: kit('collection-manifest'),
    validate: suite(['collection-manifest', 'counterparty-asset'])
  },
  'diagnose-protocol-failure': {
    understand: read('diagnose-protocol-failure'),
    prepare: { label: 'Look up the refusal in the Failure Navigator and run its reproducer', tool: 'failure-navigator', operations: ['reproduce:'], states: ['passed'], needsGateway: false },
    simulate: { label: 'Reproduce the refusal in the Sandbox with a failure injection', tool: 'sandbox', operations: ['injection:'], states: ['refused'], needsGateway: false },
    inspect: lens,
    verify: lab(['purchase', 'offers', 'runes', 'safeops', 'swaps', 'events', 'collection-manifest', 'counterparty-asset', 'offline-signing'], ['refused']),
    integrate: kit('diagnostics'),
    validate: { ...api('Receive a refusal whose error envelope matches the contract from the configured gateway in the API Playground', ['api:']), states: ['refused'] }
  },
  'perform-security-review': {
    understand: read('perform-security-review'),
    prepare: { label: 'Review the system in the Visual Protocol Atlas', tool: 'atlas', operations: ['read:'], states: ['read'], needsGateway: false },
    simulate: { label: 'Run a failure injection in the Sandbox and see it refused', tool: 'sandbox', operations: ['injection:'], states: ['refused'], needsGateway: false },
    inspect: { ...lens, label: 'Compare two artifacts in Artifact Lens', operations: ['compare:'] },
    verify: lab(['offline-signing', 'safeops']),
    integrate: kit('safeops'),
    validate: suite(['all'])
  }
};

function operationMatches(patterns: string[], operation: string): boolean {
  // A run of the whole suite covers every family suite.
  if (operation === 'suite:all' && patterns.some((p) => p.startsWith('suite:'))) return true;
  return patterns.some((p) => (p.endsWith(':') || p.endsWith('/') ? operation.startsWith(p) : operation === p || operation.startsWith(`${p}:`)));
}

export function requirementFor(missionId: string, stageId: JourneyStageId): EvidenceRequirement | null {
  if (stageId === 'finish') return null;
  return MISSION_EVIDENCE[missionId]?.[stageId] || null;
}

export interface StageEvaluation {
  satisfied: boolean;
  evidenceIds: string[];
  /** Matching runs from a different context or build: kept for provenance, not counted. */
  stale: EvidenceRecord[];
  reason: string;
}

/**
 * Decide whether a stage is satisfied by the given evidence in the given context. Refused
 * and pending runs count only where the requirement asks for a refusal.
 */
export function evaluateStage(missionId: string, stageId: JourneyStageId, evidence: EvidenceRecord[], context: JourneyContext): StageEvaluation {
  const req = requirementFor(missionId, stageId);
  if (!req) return { satisfied: false, evidenceIds: [], stale: [], reason: 'No requirement is defined for this stage.' };
  const candidates = evidence.filter(
    (e) => e.tool === req.tool && operationMatches(req.operations, e.operation) && req.states.includes(e.result.state) && (e.missionId === null || e.missionId === missionId)
  );
  const current = candidates.filter((e) => sameContext(e.context, context) && e.context.sourceBuild === context.sourceBuild && (!req.needsGateway || !!e.context.gatewayOrigin));
  const stale = candidates.filter((e) => !current.includes(e));
  if (current.length > 0) return { satisfied: true, evidenceIds: [current[0].id], stale, reason: `Satisfied by ${req.tool} run ${current[0].operation}.` };
  if (req.needsGateway && !context.gatewayOrigin) return { satisfied: false, evidenceIds: [], stale, reason: `${req.label}. Configure a gateway origin first; local runs cannot satisfy this stage.` };
  if (stale.length) return { satisfied: false, evidenceIds: [], stale, reason: `${req.label}. Earlier runs were recorded in a different network, gateway, protocol or build and must be repeated.` };
  return { satisfied: false, evidenceIds: [], stale, reason: `${req.label}.` };
}
