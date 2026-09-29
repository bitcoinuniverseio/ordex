// OX-S04: one working argument set per MCP tool, used as the Agent Bridge defaults. Each is
// checked by tests/unit/mcp-server.test.js to return a real result, so the page never opens
// on an example that fails. The run_verifier example is a checked-in conformance case.

import { callTool } from './server.js';
import { argsFromCase } from '../lab-report.mjs';

export function toolExamples(): Record<string, Record<string, unknown>> {
  const vector = callTool('ordex.get_conformance_vector', { family: 'runes', vectorId: 'runes/single-edict' }).structuredContent as { vector?: { case?: unknown } } | undefined;
  return {
    'ordex.search_docs': { query: 'public ask seller payment', limit: 5 },
    'ordex.read_source': { sourcePath: 'spec/purchase.md' },
    'ordex.list_capabilities': { protocolVersion: '1.2' },
    'ordex.get_openapi_operation': { operationId: 'buildAsk' },
    'ordex.get_asyncapi_channel': { channelName: 'eventsStream' },
    'ordex.run_verifier': { family: 'runes', variant: 'burn-safety', arguments: vector?.vector?.case ? argsFromCase('runes', 'burn-safety', vector.vector.case) : {} },
    'ordex.explain_refusal': { code: 'SELLER_VALUE_MISMATCH' },
    'ordex.get_conformance_vector': { family: 'offers', vectorId: 'offers/a-valid-item-acceptance-settles-through-both-policy-signers' },
    'ordex.create_deterministic_example': { scenarioId: 'purchase.batch.success' },
    'ordex.get_mission': { missionId: 'integrate-public-asks' }
  };
}
