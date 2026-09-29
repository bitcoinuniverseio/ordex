/**
 * Ordex failure input detector (OX-S09).
 *
 * Classifies what was pasted and finds the diagnostic rule for it. A diagnosis is
 * Conclusive only when an exact registered refusal code sits where a verifier, the gateway
 * or a report puts it; text that merely contains a code, network errors and bare HTTP
 * statuses are Inferred; anything else is Unknown. Structured inputs that need a verifier
 * run (an event envelope) are classified here and verified by the page in the bounded
 * Worker, never guessed.
 */

import diagnosticsData from '../../data/diagnostics.json';

export interface DiagnosticCause {
  family: string;
  predicate: string;
  source: { path: string; line: number; symbol: string | null };
  reachable: boolean;
}

export interface DiagnosticEvidenceRequirement {
  evidenceType: string;
  required: boolean;
}

export interface DiagnosticResolutionStep {
  step: number;
  action: string;
}

export interface PatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

export interface DiagnosticReproducer {
  family: string;
  /** The helper module branch this reproducer reaches through its family, when it is not the family's own. */
  covers?: string;
  variant: string;
  base: string;
  baseName: string;
  patch: PatchOp[];
  derivation: 'vector' | 'mutation' | 'authored';
  note?: string;
  verifiedReason: string;
  lifecycle: string;
  inputs: string[];
  recovery: string;
}

export interface DiagnosticRule {
  id: string;
  exactCodes: string[];
  family: string;
  families: string[];
  variant: string;
  category: string;
  lifecyclePhases: string[];
  supportedProtocolVersions: string[];
  summary: string;
  invariant: string | null;
  causes: DiagnosticCause[];
  evidenceRequirements: DiagnosticEvidenceRequirement[];
  resolutionSteps: DiagnosticResolutionStep[];
  reproducers: DiagnosticReproducer[];
  unreachable: Array<{ family: string; reason: string }>;
  nextTools: Array<{ tool: string; label: string; href: string }>;
  sourceRefs: Array<{ title: string; path: string; line: number | null; type: string }>;
}

export type InputType =
  | 'EXACT_REFUSAL_CODE'
  | 'VERIFIER_RESULT'
  | 'API_ERROR'
  | 'HTTP_STATUS'
  | 'GATEWAY_DOCTOR'
  | 'EVENT_ENVELOPE'
  | 'ARTIFACT_FINDING'
  | 'CORS_NETWORK'
  | 'UNKNOWN';

export interface DetectionResult {
  inputType: InputType;
  confidence: 'Conclusive' | 'Inferred' | 'Unknown';
  detectedCode?: string;
  matchedRule?: DiagnosticRule;
  evidenceUsed: string;
  missingFieldsForConclusiveVerdict?: string[];
  /** Failed Gateway Doctor checks, or dangerous Artifact Lens differences. */
  findings?: Array<{ id: string; detail: string }>;
  /** An event envelope to verify in the Worker before any conclusion. */
  pendingVerification?: { family: 'events'; variant: 'event'; args: { event: unknown } };
  nextTool?: { tool: string; href: string; label: string };
}

const DIAGNOSTICS: DiagnosticRule[] = diagnosticsData as unknown as DiagnosticRule[];
const BY_CODE = new Map<string, DiagnosticRule>(DIAGNOSTICS.flatMap((d) => d.exactCodes.map((c) => [c, d] as [string, DiagnosticRule])));
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,79}$/;
const MAX_INPUT = 256 * 1024;

export function ruleFor(code: string | null | undefined): DiagnosticRule | undefined {
  return typeof code === 'string' ? BY_CODE.get(code) : undefined;
}

function byCode(code: string, inputType: InputType, where: string): DetectionResult {
  const rule = ruleFor(code);
  if (rule) return { inputType, confidence: 'Conclusive', detectedCode: code, matchedRule: rule, evidenceUsed: `${where} carries the registered refusal code ${code}.` };
  return {
    inputType,
    confidence: 'Unknown',
    detectedCode: code,
    evidenceUsed: `${where} carries the code ${code}, which no Ordex verifier returns.`,
    missingFieldsForConclusiveVerdict: ['A refusal code from an Ordex verifier, or the full response it came from']
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function classifyJson(parsed: unknown): DetectionResult | null {
  if (!isObj(parsed)) return null;
  // Gateway Doctor report (OX-S02).
  if (parsed.schema === 'ordex.gateway-doctor-report/v1' && Array.isArray(parsed.checks)) {
    const failed = (parsed.checks as Array<Record<string, unknown>>).filter((c) => c && (c.status === 'failed' || c.status === 'blocked'));
    return {
      inputType: 'GATEWAY_DOCTOR',
      confidence: 'Conclusive',
      evidenceUsed: failed.length ? `Gateway Doctor report with ${failed.length} failed or blocked checks.` : 'Gateway Doctor report with no failed checks.',
      findings: failed.map((c) => ({ id: String(c.id), detail: `${c.status}: ${String(c.details ?? '')}`.trim() })),
      nextTool: { tool: 'doctor', href: '/verify/', label: 'Run Gateway Doctor again' }
    };
  }
  // Artifact Lens comparison report (OX-S01).
  if (typeof parsed.overallVerdict === 'string' && Array.isArray(parsed.differences)) {
    const risky = (parsed.differences as Array<Record<string, unknown>>).filter((d) => d && (d.severity === 'Dangerous' || d.severity === 'Unknown'));
    return {
      inputType: 'ARTIFACT_FINDING',
      confidence: parsed.conclusive === true ? 'Conclusive' : 'Inferred',
      evidenceUsed: `Artifact Lens comparison: ${parsed.overallVerdict}${parsed.conclusive === true ? '' : ' (not conclusive: a side could not be fully decoded)'}.`,
      findings: risky.map((d) => ({ id: String(d.field), detail: `${d.severity}: ${String(d.whyItMatters ?? '')}` })),
      nextTool: { tool: 'artifact-lens', href: '/inspect/', label: 'Compare the artifacts in Artifact Lens' }
    };
  }
  // Protocol Lab report (OX-S07) and MCP run_verifier output (OX-S04): { verdict: { state, code } }.
  if (isObj(parsed.verdict) && typeof parsed.verdict.state === 'string') {
    const v = parsed.verdict;
    if (v.state === 'refused' && typeof v.code === 'string') return byCode(v.code, 'VERIFIER_RESULT', 'The verifier verdict');
    return { inputType: 'VERIFIER_RESULT', confidence: 'Conclusive', evidenceUsed: `The verifier verdict is ${String(v.state)}; there is no refusal to diagnose.` };
  }
  // Raw verifier result: { ok: false, code } or { safe: false, code } (runes).
  if ((parsed.ok === false || parsed.safe === false) && typeof parsed.code === 'string') return byCode(parsed.code, 'VERIFIER_RESULT', 'The verifier result');
  if (parsed.ok === true || parsed.safe === true) return { inputType: 'VERIFIER_RESULT', confidence: 'Conclusive', evidenceUsed: 'The verifier accepted this input; there is no refusal to diagnose.' };
  // Gateway error envelope (spec/openapi.json ErrorResponse): statusCode, error, message, code?.
  if (typeof parsed.statusCode === 'number' && typeof parsed.error === 'string') {
    const code = typeof parsed.code === 'string' ? parsed.code : null;
    if (code && ruleFor(code)) return byCode(code, 'API_ERROR', `The gateway error (HTTP ${parsed.statusCode})`);
    const message = Array.isArray(parsed.message) ? parsed.message.join(' ') : String(parsed.message ?? '');
    const inText = [...BY_CODE.keys()].find((c) => message.includes(c));
    if (inText) return { inputType: 'API_ERROR', confidence: 'Inferred', detectedCode: inText, matchedRule: ruleFor(inText), evidenceUsed: `The gateway error message mentions ${inText}.` };
    return {
      inputType: 'API_ERROR',
      confidence: 'Unknown',
      ...(code ? { detectedCode: code } : {}),
      evidenceUsed: `Gateway error HTTP ${parsed.statusCode} ${parsed.error}${code ? ` with code ${code}` : ''}: ${message.slice(0, 200)}`,
      missingFieldsForConclusiveVerdict: ['A verifier refusal code; this error comes from the gateway, not a protocol verifier'],
      nextTool: { tool: 'playground', href: '/build/playground/', label: 'Repeat the request in the API Playground' }
    };
  }
  // An Ordex event envelope: verified in the Worker by the page.
  if (typeof parsed.type === 'string' && parsed.type.startsWith('ordex.') && 'schemaVersion' in parsed) {
    return {
      inputType: 'EVENT_ENVELOPE',
      confidence: 'Unknown',
      evidenceUsed: `An Ordex event of type ${parsed.type}. It needs the events verifier before any conclusion.`,
      pendingVerification: { family: 'events', variant: 'event', args: { event: parsed } }
    };
  }
  return null;
}

export function detectFailureInput(rawInput: string): DetectionResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { inputType: 'UNKNOWN', confidence: 'Unknown', evidenceUsed: 'The input is empty.', missingFieldsForConclusiveVerdict: ['A refusal code, a verifier result or an error response'] };
  }
  if (trimmed.length > MAX_INPUT) {
    return { inputType: 'UNKNOWN', confidence: 'Unknown', evidenceUsed: `The input is larger than ${MAX_INPUT / 1024} KiB and was not examined.`, missingFieldsForConclusiveVerdict: ['A smaller excerpt: the code or the error response'] };
  }
  if (CODE_SHAPE.test(trimmed)) return byCode(trimmed, 'EXACT_REFUSAL_CODE', 'The input');

  if (trimmed.startsWith('{')) {
    try {
      const result = classifyJson(JSON.parse(trimmed));
      if (result) return result;
    } catch {
      // not JSON: fall through to text patterns
    }
  }

  if (/\bcors\b|failed to fetch|networkerror|network error|access-control-allow-origin/i.test(trimmed)) {
    return {
      inputType: 'CORS_NETWORK',
      confidence: 'Inferred',
      evidenceUsed: 'The text describes a browser network or CORS failure.',
      missingFieldsForConclusiveVerdict: ['The gateway response headers', 'The preflight (OPTIONS) status'],
      nextTool: { tool: 'doctor', href: '/verify/', label: 'Check the gateway with Gateway Doctor' }
    };
  }

  const inText = [...BY_CODE.keys()].find((c) => new RegExp(`\\b${c}\\b`).test(trimmed));
  if (inText) return { inputType: 'EXACT_REFUSAL_CODE', confidence: 'Inferred', detectedCode: inText, matchedRule: ruleFor(inText), evidenceUsed: `The text contains the refusal code ${inText}.` };

  const http = trimmed.match(/\b([45][0-9]{2})\b/);
  if (http) {
    return {
      inputType: 'HTTP_STATUS',
      confidence: 'Inferred',
      evidenceUsed: `HTTP status ${http[1]} appears in the text.`,
      missingFieldsForConclusiveVerdict: ['The response body, which carries the error code'],
      nextTool: { tool: 'playground', href: '/build/playground/', label: 'Repeat the request in the API Playground' }
    };
  }

  return {
    inputType: 'UNKNOWN',
    confidence: 'Unknown',
    evidenceUsed: 'The input matches no refusal code, verifier result, report or error response.',
    missingFieldsForConclusiveVerdict: ['A refusal code such as SELLER_VALUE_MISMATCH', 'A verifier result or error response as JSON']
  };
}

export function getAllDiagnosticRules(): DiagnosticRule[] {
  return DIAGNOSTICS;
}
