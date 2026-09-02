/**
 * Ordex Deterministic Diagnostic Input Detector
 * 
 * Inspects raw paste or structured input and deterministically classifies:
 * - Exact refusal code
 * - Verifier result envelope
 * - OpenAPI / Gateway REST error response
 * - HTTP status code
 * - Gateway Doctor test verdict
 * - CORS / Transport network error
 * - Async event or webhook delivery error
 * - Artifact Lens finding
 * - Unknown input
 */

import diagnosticsData from '../../data/diagnostics.json';

export interface DiagnosticCause {
  cause: string;
  probability: 'High' | 'Medium' | 'Low';
}

export interface DiagnosticEvidenceRequirement {
  evidenceType: string;
  required: boolean;
}

export interface DiagnosticResolutionStep {
  step: number;
  action: string;
}

export interface DiagnosticRule {
  id: string;
  exactCodes: string[];
  family: string;
  lifecyclePhases: string[];
  supportedProtocolVersions: string[];
  summary: string;
  invariant: string;
  likelyCauses: DiagnosticCause[];
  evidenceRequirements: DiagnosticEvidenceRequirement[];
  resolutionSteps: DiagnosticResolutionStep[];
  reproducerFactoryId: string | null;
  destinationProduct: string;
  sourceRefs: Array<{
    title: string;
    path: string;
    type: string;
  }>;
}

export interface DetectionResult {
  inputType: 'EXACT_REFUSAL_CODE' | 'VERIFIER_RESULT' | 'API_ERROR' | 'HTTP_STATUS' | 'GATEWAY_DOCTOR' | 'CORS_NETWORK' | 'UNKNOWN';
  confidence: 'Conclusive' | 'Inferred' | 'Unknown';
  detectedCode?: string;
  matchedRule?: DiagnosticRule;
  evidenceUsed: string;
  missingFieldsForConclusiveVerdict?: string[];
}

const DIAGNOSTICS: DiagnosticRule[] = diagnosticsData as unknown as DiagnosticRule[];

export function detectFailureInput(rawInput: string): DetectionResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      inputType: 'UNKNOWN',
      confidence: 'Unknown',
      evidenceUsed: 'Input is empty',
      missingFieldsForConclusiveVerdict: ['Refusal code or error response JSON']
    };
  }

  // 1. Direct Refusal Code Match (e.g. PAYMENT_OUTPUT_MISMATCH or MALFORMED_TRANSACTION)
  const singleCodeMatch = trimmed.match(/^[A-Z0-9_-]{3,64}$/);
  if (singleCodeMatch) {
    const code = singleCodeMatch[0];
    const rule = DIAGNOSTICS.find(d => d.exactCodes.includes(code));
    if (rule) {
      return {
        inputType: 'EXACT_REFUSAL_CODE',
        confidence: 'Conclusive',
        detectedCode: code,
        matchedRule: rule,
        evidenceUsed: `Exact match for authoritative refusal code: ${code}`
      };
    }
  }

  // 2. JSON Structure Detection
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);

      // Verifier result shape: { ok: false, code: "..." }
      if (parsed.ok === false && typeof parsed.code === 'string') {
        const rule = DIAGNOSTICS.find(d => d.exactCodes.includes(parsed.code));
        return {
          inputType: 'VERIFIER_RESULT',
          confidence: 'Conclusive',
          detectedCode: parsed.code,
          matchedRule: rule,
          evidenceUsed: `Parsed verifier failure envelope with code: ${parsed.code}`
        };
      }

      // API Error shape: { error: { code: "..." } } or { statusCode: 400, code: "..." }
      const errCode = parsed.error?.code || parsed.code || (parsed.error && typeof parsed.error === 'string' ? parsed.error : undefined);
      if (errCode && typeof errCode === 'string') {
        const rule = DIAGNOSTICS.find(d => d.exactCodes.includes(errCode));
        return {
          inputType: 'API_ERROR',
          confidence: rule ? 'Conclusive' : 'Inferred',
          detectedCode: errCode,
          matchedRule: rule,
          evidenceUsed: `Parsed API error payload with code: ${errCode}`
        };
      }

      // Gateway Doctor result shape: { doctorSuite: ..., passed: false }
      if (parsed.doctorSuite || (parsed.suite && parsed.checks)) {
        return {
          inputType: 'GATEWAY_DOCTOR',
          confidence: 'Conclusive',
          evidenceUsed: 'Parsed Gateway Doctor diagnostic report',
          missingFieldsForConclusiveVerdict: ['Check individual failed test assertion']
        };
      }
    } catch {
      // Not valid JSON, proceed to text patterns
    }
  }

  // 3. CORS or Network Transport Error Detection
  if (/cors|failed to fetch|network error|access-control-allow-origin/i.test(trimmed)) {
    return {
      inputType: 'CORS_NETWORK',
      confidence: 'Inferred',
      evidenceUsed: 'CORS / Transport header keywords detected in error text',
      missingFieldsForConclusiveVerdict: ['Gateway origin response headers', 'Preflight OPTIONS status']
    };
  }

  // 4. HTTP Status Detection (e.g. "400 Bad Request", "404", "502 Bad Gateway")
  const httpMatch = trimmed.match(/\b(4[0-9]{2}|5[0-9]{2})\b/);
  if (httpMatch) {
    const status = httpMatch[1];
    return {
      inputType: 'HTTP_STATUS',
      confidence: 'Inferred',
      evidenceUsed: `HTTP status code ${status} detected`,
      missingFieldsForConclusiveVerdict: ['Ordex response body JSON', 'Refusal code header']
    };
  }

  // 5. Scan text for any contained refusal code
  for (const rule of DIAGNOSTICS) {
    for (const code of rule.exactCodes) {
      if (trimmed.includes(code)) {
        return {
          inputType: 'EXACT_REFUSAL_CODE',
          confidence: 'Inferred',
          detectedCode: code,
          matchedRule: rule,
          evidenceUsed: `Found refusal code substring '${code}' in error text`
        };
      }
    }
  }

  return {
    inputType: 'UNKNOWN',
    confidence: 'Unknown',
    evidenceUsed: 'Input does not match known refusal codes, verifier shapes, or network patterns',
    missingFieldsForConclusiveVerdict: ['Exact refusal code (e.g. PAYMENT_OUTPUT_MISMATCH)', 'Verifier JSON result']
  };
}

export function getAllDiagnosticRules(): DiagnosticRule[] {
  return DIAGNOSTICS;
}
