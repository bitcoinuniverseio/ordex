/**
 * Ordex MCP engine (protocol revision 2026-07-28)
 *
 * OX-S04: one typed dispatcher shared by the browser Agent Bridge, the stdio executable
 * (scripts/mcp-stdio-server.mjs, built into dist/mcp) and the HTTP service (worker/index.js).
 * Revision 2026-07-28 has no initialize handshake: every request carries its protocol version
 * and client capabilities in params._meta, server/discover reports versions, capabilities and
 * identity, and results carry resultType "complete". Unknown tools and malformed calls are
 * JSON-RPC errors (-32602); a tool that runs and fails reports isError: true. Every tool is
 * read-only: nothing here holds keys, signs, broadcasts or contacts a gateway.
 */

import corpusData from '../../data/corpus.json';
import operationsData from '../../data/operations.json';
import channelsData from '../../data/channels.json';
import diagnosticsData from '../../data/diagnostics.json';
import vectorFamiliesData from '../../data/vectorFamilies.json';
import vectorManifest from '../../data/vectorManifest.json';
import compatibilityData from '../../data/compatibility.json';
import versionsData from '../../data/versions.json';
import openapi from '../../../../spec/openapi.json';
import asyncapi from '../../../../spec/asyncapi.json';
import { MISSIONS, getMissionById } from '../experience/mission-registry.js';
import { MISSION_EVIDENCE } from '../experience/mission-evidence.js';
import { SCENARIOS, getScenarioById } from '../scenarios/registry.js';
import { createInitialScenarioState, scenarioReducer, resolvePending } from '../scenarios/engine.js';
import { FAMILIES, FAMILY_REGISTRY, evaluateCandidate, variantOf } from '../conformance-engine.mjs';
import { validateSchema } from '../api/schema.mjs';
import { inputDigest, sha256Hex, stableJson } from '../lab-report.mjs';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION];
/** The Ordex protocol this documentation describes (not the MCP revision). */
export const PROTOCOL_VERSION = String(versionsData.currentProtocol);

declare const __ORDEX_BUILD_REVISION__: string | undefined;
export const BUILD_REVISION: string =
  (typeof __ORDEX_BUILD_REVISION__ === 'string' && __ORDEX_BUILD_REVISION__) ||
  ((typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string> }).env?.PUBLIC_ORDEX_BUILD_REVISION) as string) ||
  'unknown';

export const SERVER_INFO = Object.freeze({ name: 'ordex-docs', title: 'Ordex documentation and reference verifiers', version: BUILD_REVISION });

export const JSONRPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022
});

export class McpError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
}

type Corpus = Array<{ id: string; sourcePath: string; pointer: string; product: string; protocolVersion: string; title: string; content: string; digest: string; docUrl: string }>;
const corpus = corpusData as Corpus;
const operations = operationsData as Array<Record<string, unknown> & { operationId: string }>;
const channels = channelsData as Array<Record<string, unknown> & { name: string }>;
const diagnostics = diagnosticsData as Array<Record<string, unknown> & { exactCodes: string[] }>;
const vectorFamilies = vectorFamiliesData as unknown as Record<string, { cases: Array<Record<string, unknown> & { id: string }> }>;
const compatibility = compatibilityData as Array<Record<string, string>>;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const INDEXED_VERSIONS = [...new Set(corpus.map((c) => c.protocolVersion))].sort();
const SOURCE_PATHS = [...new Set(corpus.map((c) => c.sourcePath))].sort();
const clean = (s: string) => s.replace(/\r/g, '');

const provenance = {
  type: 'object',
  required: ['buildRevision', 'evidenceClass', 'sourceRefs'],
  properties: {
    buildRevision: { type: 'string' },
    evidenceClass: { type: 'string' },
    sourceRefs: { type: 'array', items: { type: 'object', required: ['title', 'path'], properties: { title: { type: 'string' }, path: { type: 'string' }, sha256: { type: 'string' } } } }
  }
};
const withProvenance = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  required: [...required, 'provenance'],
  properties: { ...properties, provenance }
});

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'ordex.search_docs',
    title: 'Search the Ordex documentation',
    description: 'Search the documentation corpus built from the checked-in specifications. Returns matching sections with their source file and page link.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to look for' },
        protocolVersion: { type: 'string', enum: INDEXED_VERSIONS, description: 'Only sections for this protocol version' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum sections to return (default 5)' }
      }
    },
    outputSchema: withProvenance({ results: { type: 'array', items: { type: 'object', required: ['id', 'title', 'sourcePath', 'docUrl', 'snippet'] } }, totalMatched: { type: 'integer' } }, ['results', 'totalMatched']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.read_source',
    title: 'Read a specification',
    description: 'Return the full text of one checked-in specification file, section by section.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sourcePath'],
      properties: { sourcePath: { type: 'string', enum: SOURCE_PATHS, description: 'A source path such as spec/purchase.md' } }
    },
    outputSchema: withProvenance({ sourcePath: { type: 'string' }, sections: { type: 'array' } }, ['sourcePath', 'sections']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.list_capabilities',
    title: 'List protocol capabilities',
    description: 'List Ordex capabilities with the protocol version that introduced each, filtered by version and by where it runs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        protocolVersion: { type: 'string', enum: versionsData.history.map((v: { version: string }) => v.version), description: 'Only capabilities available in this protocol version' },
        runtime: { type: 'string', enum: ['gateway', 'sdk', 'browser', 'node', 'offline'], description: 'Only capabilities supported in this runtime' }
      }
    },
    outputSchema: withProvenance({ capabilities: { type: 'array' } }, ['capabilities']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.get_openapi_operation',
    title: 'Get an API operation',
    description: 'Return one OpenAPI 3.1 operation with its parameters, schemas and validated examples.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['operationId'], properties: { operationId: { type: 'string', enum: operations.map((o) => o.operationId) } } },
    outputSchema: withProvenance({ operation: { type: 'object' } }, ['operation']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.get_asyncapi_channel',
    title: 'Get an event channel',
    description: 'Return one AsyncAPI 3.0 channel with its messages.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['channelName'], properties: { channelName: { type: 'string', enum: channels.map((c) => c.name) } } },
    outputSchema: withProvenance({ channel: { type: 'object' } }, ['channel']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.run_verifier',
    title: 'Run a reference verifier',
    description: 'Run a checked-in reference verifier on the given arguments and return its verdict. A local verdict is not chain confirmation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['family', 'arguments'],
      properties: {
        family: { type: 'string', enum: [...FAMILIES] },
        variant: { type: 'string', description: 'The family variant (for example acceptance for offers). Inferred from the arguments when omitted.' },
        arguments: { type: 'object', description: 'The verifier arguments, in the shape of the family vectors (see ordex.get_conformance_vector).' }
      }
    },
    outputSchema: withProvenance({ family: { type: 'string' }, variant: { type: 'string' }, inputSha256: { type: 'string' }, verdict: { type: 'object', required: ['state'] }, raw: {} }, ['family', 'variant', 'inputSha256', 'verdict']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.explain_refusal',
    title: 'Explain a refusal code',
    description: 'Return the diagnostic entry for a refusal code the verifiers can return.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', pattern: '^[A-Z0-9_]{2,80}$' } } },
    outputSchema: withProvenance({ rule: { type: 'object' } }, ['rule']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.get_conformance_vector',
    title: 'Get a conformance vector',
    description: 'Return one checked-in conformance vector, with its complete source case and source digest.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['family', 'vectorId'],
      properties: { family: { type: 'string', enum: [...FAMILIES] }, vectorId: { type: 'string', minLength: 3, maxLength: 200, description: 'The vector id, for example purchase/arrangement-ordex-builds' } }
    },
    outputSchema: withProvenance({ vector: { type: 'object' } }, ['vector']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.create_deterministic_example',
    title: 'Run a deterministic scenario',
    description: 'Walk one Sandbox scenario with the reference verifiers and return each step with its actual verdict. Scenario data is a deterministic example, not chain state.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['scenarioId'], properties: { scenarioId: { type: 'string', enum: SCENARIOS.map((s) => s.id) } } },
    outputSchema: withProvenance({ scenario: { type: 'object' }, steps: { type: 'array' }, outcome: { type: 'string' } }, ['scenario', 'steps', 'outcome']),
    annotations: READ_ONLY
  },
  {
    name: 'ordex.get_mission',
    title: 'Get a mission',
    description: 'Return one Launchpad mission with its stages and the evidence each stage needs.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['missionId'], properties: { missionId: { type: 'string', enum: MISSIONS.map((m) => m.id) } } },
    outputSchema: withProvenance({ mission: { type: 'object' }, stageEvidence: { type: 'object' } }, ['mission', 'stageEvidence']),
    annotations: READ_ONLY
  }
];

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

export const MCP_RESOURCES = [
  { uri: 'ordex://spec/openapi.json', name: 'openapi.json', title: 'OpenAPI 3.1 contract', mimeType: 'application/json', read: () => JSON.stringify(openapi) },
  { uri: 'ordex://spec/asyncapi.json', name: 'asyncapi.json', title: 'AsyncAPI 3.0 contract', mimeType: 'application/json', read: () => JSON.stringify(asyncapi) },
  { uri: 'ordex://data/refusals.json', name: 'refusals.json', title: 'Refusal diagnostics', mimeType: 'application/json', read: () => JSON.stringify(diagnostics) },
  { uri: 'ordex://data/vector-manifest.json', name: 'vector-manifest.json', title: 'Conformance vector manifest and digests', mimeType: 'application/json', read: () => JSON.stringify(vectorManifest) },
  ...SOURCE_PATHS.map((p) => ({
    uri: `ordex://${p}`,
    name: p.split('/').pop() as string,
    title: `Specification ${p}`,
    mimeType: 'text/markdown',
    read: () => corpus.filter((c) => c.sourcePath === p).map((c) => `## ${clean(c.title)}\n\n${clean(c.content)}`).join('\n\n')
  }))
];

export const MCP_PROMPTS = [
  { name: 'integrate_public_asks', title: 'Integrate public asks', description: 'Plan an integration of Ordex public asks using the specification and verifier.', arguments: [{ name: 'role', description: 'seller wallet or marketplace', required: false }], missionId: 'integrate-public-asks' },
  { name: 'complete_purchase_safely', title: 'Complete a purchase safely', description: 'Walk through verifying a single or batch purchase before signing.', arguments: [], missionId: 'complete-single-or-batch-purchase' },
  { name: 'protect_wallet_signing', title: 'Protect wallet signing', description: 'Check a signed artifact against its approved terms before broadcast.', arguments: [], missionId: 'protect-wallet-signing' },
  { name: 'diagnose_refusal', title: 'Diagnose a refusal', description: 'Explain a refusal code and how to reproduce and resolve it.', arguments: [{ name: 'code', description: 'The refusal code', required: true }], missionId: 'diagnose-protocol-failure' }
];

function provenanceFor(evidenceClass: string, refs: Array<{ title: string; path: string; sha256?: string }>) {
  return { buildRevision: BUILD_REVISION, evidenceClass, sourceRefs: refs };
}

function words(q: string) {
  return q.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1);
}

/** Result of a tool call in the 2026-07-28 shape. */
export interface CallToolResult {
  resultType: 'complete';
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError: boolean;
}

const ok = (structuredContent: unknown): CallToolResult => ({ resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent, isError: false });
const toolError = (message: string, details?: unknown): CallToolResult => ({
  resultType: 'complete',
  content: [{ type: 'text', text: details ? `${message}\n${JSON.stringify(details)}` : message }],
  isError: true
});

function runTool(name: string, args: Record<string, unknown>): CallToolResult {
  switch (name) {
    case 'ordex.search_docs': {
      const terms = words(String(args.query));
      const limit = (args.limit as number) ?? 5;
      const version = args.protocolVersion as string | undefined;
      const scored = corpus
        .filter((c) => !version || c.protocolVersion === version)
        .map((c) => {
          const title = c.title.toLowerCase();
          const body = c.content.toLowerCase();
          let score = 0;
          for (const t of terms) score += (title.includes(t) ? 5 : 0) + (body.includes(t) ? 1 : 0);
          return { c, score };
        })
        .filter((x) => x.score > 0 && terms.length > 0)
        .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id));
      const results = scored.slice(0, limit).map(({ c }) => ({ id: c.id, title: clean(c.title), sourcePath: c.sourcePath, docUrl: c.docUrl, protocolVersion: c.protocolVersion, snippet: clean(c.content).slice(0, 240) }));
      return ok({ results, totalMatched: scored.length, provenance: provenanceFor('Documentation retrieval', [{ title: 'Documentation corpus', path: 'site/src/data/corpus.json' }]) });
    }
    case 'ordex.read_source': {
      const path = String(args.sourcePath);
      const sections = corpus.filter((c) => c.sourcePath === path).map((c) => ({ id: c.id, title: clean(c.title), content: clean(c.content), sha256: c.digest }));
      return ok({ sourcePath: path, sections, provenance: provenanceFor('Documentation retrieval', [{ title: path, path }]) });
    }
    case 'ordex.list_capabilities': {
      const version = args.protocolVersion as string | undefined;
      const runtime = args.runtime as string | undefined;
      const introduced = (p: string) => p.replace('+', '');
      const capabilities = compatibility.filter(
        (c) => (!version || Number(introduced(c.protocol)) <= Number(version)) && (!runtime || /^Supported/.test(c[runtime] || ''))
      );
      return ok({ capabilities, provenance: provenanceFor('Documentation retrieval', [{ title: 'Compatibility matrix', path: 'site/src/data/compatibility.json' }]) });
    }
    case 'ordex.get_openapi_operation': {
      const operation = operations.find((o) => o.operationId === args.operationId);
      return ok({ operation, provenance: provenanceFor('Contract retrieval', [{ title: 'OpenAPI 3.1 contract', path: 'spec/openapi.json', sha256: vectorManifest.specDigest }]) });
    }
    case 'ordex.get_asyncapi_channel': {
      const channel = channels.find((c) => c.name === args.channelName);
      return ok({ channel, provenance: provenanceFor('Contract retrieval', [{ title: 'AsyncAPI 3.0 contract', path: 'spec/asyncapi.json' }]) });
    }
    case 'ordex.run_verifier': {
      const family = String(args.family);
      const candidate = args.arguments as Record<string, unknown>;
      const variant = (args.variant as string | undefined) ?? variantOf(family, candidate);
      if (!variant || !FAMILY_REGISTRY[family].variants[variant]) {
        return toolError(`Unknown ${family} variant${args.variant ? ` ${String(args.variant)}` : ''}. Valid variants: ${Object.keys(FAMILY_REGISTRY[family].variants).join(', ')}.`);
      }
      let result;
      try {
        result = evaluateCandidate(family, variant, candidate);
      } catch (err) {
        return toolError((err as Error).message);
      }
      const structured = {
        family,
        variant,
        inputSha256: inputDigest(candidate),
        verdict: result.verdict,
        raw: result.raw,
        provenance: provenanceFor('Protocol verification (local reference verifier, not chain state)', [{ title: `verifier/${FAMILY_REGISTRY[family].verifier}`, path: `verifier/${FAMILY_REGISTRY[family].verifier}`, sha256: vectorManifest.verifierDigest }])
      };
      // A refusal is a real verdict; only a verifier that could not reach one is an error.
      return result.verdict.state === 'unknown' ? { ...ok(structured), isError: true } : ok(structured);
    }
    case 'ordex.explain_refusal': {
      const code = String(args.code);
      const rule = diagnostics.find((d) => d.exactCodes.includes(code));
      if (!rule) return toolError(`No verifier returns the refusal code ${code}.`);
      return ok({ rule, provenance: provenanceFor('Documentation retrieval', [{ title: 'Diagnostic registry', path: 'site/src/data/diagnostics.json' }]) });
    }
    case 'ordex.get_conformance_vector': {
      const family = String(args.family);
      const vector = vectorFamilies[family]?.cases.find((c) => c.id === args.vectorId);
      if (!vector) return toolError(`No ${family} vector has the id ${String(args.vectorId)}.`, { examples: vectorFamilies[family]?.cases.slice(0, 3).map((c) => c.id) });
      return ok({ vector, provenance: provenanceFor('Conformance vector retrieval', [{ title: `conformance/${FAMILY_REGISTRY[family].file}`, path: `conformance/${FAMILY_REGISTRY[family].file}`, sha256: (vectorManifest.families as Record<string, { sha256: string }>)[family].sha256 }]) });
    }
    case 'ordex.create_deterministic_example': {
      const scenario = getScenarioById(String(args.scenarioId))!;
      let state = createInitialScenarioState(scenario);
      const steps = scenario.steps.map((step, i) => {
        state = scenarioReducer(state, { type: 'JUMP_TO_STEP', stepIndex: i }, scenario);
        state = resolvePending(state, scenario, (f, v, a) => evaluateCandidate(f, v, a));
        const v = state.verificationVerdict;
        return { id: step.id, actor: step.actor, intent: step.intent, operation: step.operation, evidenceClass: v.evidenceClass, verdict: { state: v.state, code: v.code ?? null, reason: v.reason ?? null, source: v.source, inputSha256: v.inputDigest ?? null }, fixture: step.observation ?? null };
      });
      const last = steps.filter((s) => s.verdict.state === 'accepted' || s.verdict.state === 'refused').pop();
      const outcome = scenario.expectedOutcome === 'success' ? (steps.every((s) => ['accepted', 'none'].includes(s.verdict.state)) ? 'success' : 'failed') : last?.verdict.state === 'refused' && last.verdict.code === scenario.expectedRefusalCode ? 'refusal as declared' : 'failed';
      const { steps: _defs, failureInjections, ...summary } = scenario;
      return ok({
        scenario: { ...summary, failureInjections: (failureInjections || []).map(({ mutate, ...inj }) => inj) },
        steps,
        outcome,
        provenance: provenanceFor('Deterministic example', [{ title: 'Scenario registry', path: 'site/src/lib/scenarios/registry.ts' }])
      });
    }
    case 'ordex.get_mission': {
      const mission = getMissionById(String(args.missionId))!;
      return ok({ mission, stageEvidence: MISSION_EVIDENCE[mission.id], provenance: provenanceFor('Documentation retrieval', [{ title: 'Mission registry', path: 'site/src/lib/experience/mission-registry.ts' }]) });
    }
    default:
      throw new McpError(JSONRPC.INVALID_PARAMS, `Unknown tool: ${name}`);
  }
}

/**
 * Call one tool. Unknown tools are a JSON-RPC error; arguments failing the input schema,
 * or a tool that cannot complete, are tool results with isError true.
 */
export function callTool(name: unknown, args: unknown): CallToolResult {
  if (typeof name !== 'string') throw new McpError(JSONRPC.INVALID_PARAMS, 'params.name must be a string');
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new McpError(JSONRPC.INVALID_PARAMS, `Unknown tool: ${name}`);
  const input = args === undefined ? {} : args;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new McpError(JSONRPC.INVALID_PARAMS, 'params.arguments must be an object');
  if (JSON.stringify(input).length > 512 * 1024) return toolError('The arguments exceed 512 KiB.');
  const errors = validateSchema(input, tool.inputSchema, {});
  if (errors.length) return toolError(`Invalid arguments for ${name}.`, errors.slice(0, 10));
  const result = runTool(name, input as Record<string, unknown>);
  if (!result.isError) {
    const outErrors = validateSchema(result.structuredContent, tool.outputSchema, {});
    if (outErrors.length) return toolError(`Internal output check failed for ${name}.`, outErrors.slice(0, 5));
  }
  return result;
}

/** Browser Agent Bridge entry point: a local call of the same dispatcher. */
export async function executeMcpTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return callTool(name, args);
}

export function readResource(uri: unknown) {
  const res = MCP_RESOURCES.find((r) => r.uri === uri);
  if (!res) throw new McpError(JSONRPC.INVALID_PARAMS, 'Resource not found', { uri });
  const text = res.read();
  return { contents: [{ uri: res.uri, mimeType: res.mimeType, text }], sha256: sha256Hex(text) };
}

export function getPrompt(name: unknown, args: unknown) {
  const prompt = MCP_PROMPTS.find((p) => p.name === name);
  if (!prompt) throw new McpError(JSONRPC.INVALID_PARAMS, `Unknown prompt: ${String(name)}`);
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  for (const arg of prompt.arguments) {
    if (arg.required && typeof a[arg.name] !== 'string') throw new McpError(JSONRPC.INVALID_PARAMS, `Prompt ${prompt.name} needs the argument ${arg.name}`);
  }
  const mission = getMissionById(prompt.missionId)!;
  let text = `${mission.plainEnglishGoal}\n\nWork through these stages, using the Ordex MCP tools for evidence:\n${mission.stages.map((s, i) => `${i + 1}. ${s.title}: ${s.description}`).join('\n')}\n\nSources: ${mission.sourceRefs.map((r) => r.path).join(', ')}.`;
  if (prompt.name === 'diagnose_refusal') {
    const code = String(a.code);
    const rule = diagnostics.find((d) => d.exactCodes.includes(code));
    text = rule
      ? `Explain the Ordex refusal ${code}. Summary: ${rule.summary}. Use ordex.explain_refusal for the full entry and ordex.run_verifier to reproduce it with a conformance vector.`
      : `The refusal code ${code} is not returned by any Ordex verifier. Ask for the exact code the gateway or wallet reported.`;
  } else if (typeof a.role === 'string') {
    text = `Role: ${a.role.slice(0, 80)}.\n\n${text}`;
  }
  return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

export function discoverResult() {
  return {
    resultType: 'complete',
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: { tools: {}, resources: {}, prompts: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    instructions: 'Read-only Ordex protocol documentation, contracts, conformance vectors and local reference verifiers. Nothing signs, broadcasts or contacts a gateway; verifier verdicts are not chain confirmation.',
    ttlMs: 3600000,
    cacheScope: 'public'
  };
}

/** Validate the per-request _meta a 2026-07-28 request must carry. Returns the requested version. */
export function checkRequestMeta(params: unknown): string {
  const meta = (params && typeof params === 'object' ? (params as Record<string, unknown>)._meta : undefined) as Record<string, unknown> | undefined;
  const version = meta?.['io.modelcontextprotocol/protocolVersion'];
  if (typeof version !== 'string' || version === '') throw new McpError(JSONRPC.INVALID_PARAMS, 'params._meta["io.modelcontextprotocol/protocolVersion"] is required');
  const caps = meta?.['io.modelcontextprotocol/clientCapabilities'];
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new McpError(JSONRPC.INVALID_PARAMS, 'params._meta["io.modelcontextprotocol/clientCapabilities"] is required');
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw new McpError(JSONRPC.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: version });
  }
  return version;
}

type JsonRpcId = string | number;
export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const withServerMeta = (result: Record<string, unknown>) => ({
  resultType: 'complete',
  ...result,
  _meta: { ...((result._meta as object) || {}), 'io.modelcontextprotocol/serverInfo': SERVER_INFO }
});

/**
 * Dispatch one parsed JSON-RPC message. Returns null for notifications (no response).
 * Transport-independent: stdio and HTTP both call this after their own framing checks.
 */
export function dispatchMessage(message: unknown): JsonRpcResponse | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: JSONRPC.INVALID_REQUEST, message: 'A message must be a JSON-RPC object' } };
  }
  const m = message as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(m, 'id');
  const idValid = typeof m.id === 'string' || (typeof m.id === 'number' && Number.isInteger(m.id));
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string' || (hasId && !idValid) || ('result' in m) || ('error' in m)) {
    return { jsonrpc: '2.0', id: idValid ? (m.id as JsonRpcId) : null, error: { code: JSONRPC.INVALID_REQUEST, message: 'Invalid JSON-RPC request (jsonrpc "2.0", a method string, and a string or integer id)' } };
  }
  if (m.params !== undefined && (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params))) {
    return hasId ? { jsonrpc: '2.0', id: m.id as JsonRpcId, error: { code: JSONRPC.INVALID_PARAMS, message: 'params must be an object' } } : null;
  }
  if (!hasId) return null; // notifications carry no response; cancellation is handled by the transport
  const id = m.id as JsonRpcId;
  const params = (m.params || {}) as Record<string, unknown>;
  try {
    if (m.method === 'initialize') {
      throw new McpError(JSONRPC.METHOD_NOT_FOUND, `initialize is not part of MCP ${MCP_PROTOCOL_VERSION}. This server supports ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}; send server/discover or any request with params._meta.`, { supported: SUPPORTED_PROTOCOL_VERSIONS });
    }
    checkRequestMeta(params);
    switch (m.method) {
      case 'server/discover':
        return { jsonrpc: '2.0', id, result: discoverResult() };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: withServerMeta({ tools: MCP_TOOLS, ttlMs: 3600000, cacheScope: 'public' }) };
      case 'tools/call':
        return { jsonrpc: '2.0', id, result: withServerMeta(callTool(params.name, params.arguments) as unknown as Record<string, unknown>) };
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: withServerMeta({ resources: MCP_RESOURCES.map(({ read, ...r }) => r) }) };
      case 'resources/read': {
        const { contents } = readResource(params.uri);
        return { jsonrpc: '2.0', id, result: withServerMeta({ contents }) };
      }
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: withServerMeta({ prompts: MCP_PROMPTS.map(({ missionId, ...p }) => p) }) };
      case 'prompts/get':
        return { jsonrpc: '2.0', id, result: withServerMeta(getPrompt(params.name, params.arguments)) };
      default:
        throw new McpError(JSONRPC.METHOD_NOT_FOUND, `Method not found: ${m.method}`);
    }
  } catch (err) {
    if (err instanceof McpError) return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
    return { jsonrpc: '2.0', id, error: { code: JSONRPC.INTERNAL_ERROR, message: 'Internal error' } };
  }
}

/** A stable fingerprint of what the server exposes, for install checks. */
export function surfaceDigest(): string {
  return sha256Hex(stableJson({ tools: MCP_TOOLS, resources: MCP_RESOURCES.map(({ read, ...r }) => r), prompts: MCP_PROMPTS }));
}
