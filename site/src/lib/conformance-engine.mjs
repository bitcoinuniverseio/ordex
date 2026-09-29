// Conformance Engine
// Shared deterministic conformance vector executor for the CLI, Conformance Studio,
// Protocol Lab, the Sandbox and the MCP dispatcher.
//
// OX-S07: this module is browser-safe. It imports no Node built-ins and reads no files;
// vector files are loaded by scripts/docs/vector-loader.mjs in Node and by generated JSON
// in the browser, and both hand complete source cases to the same functions below. The
// verifiers' node:crypto import resolves to a pinned pure implementation in browser
// bundles (site/src/lib/browser/node-crypto.mjs), tested byte for byte against Node.

import * as purchaseVerifier from '../../../verifier/purchase.js';
import * as offersVerifier from '../../../verifier/offers.js';
import * as runesVerifier from '../../../verifier/runes.js';
import * as safeopsVerifier from '../../../verifier/safeops.js';
import * as swapsVerifier from '../../../verifier/swaps.js';
import * as eventsVerifier from '../../../verifier/events.js';
import * as collectionManifestVerifier from '../../../verifier/collection-manifest.js';
import * as counterpartyAssetVerifier from '../../../verifier/counterparty-asset.js';
import * as offlineSigningVerifier from '../../../verifier/offline-signing.js';
import { FAMILY_REGISTRY, FAMILIES, isKnownFamily, variantOf, variantArguments } from './conformance-registry.mjs';

export { FAMILY_REGISTRY, FAMILIES, isKnownFamily, variantOf, variantArguments };

/** File and verifier names per family, kept for existing callers. */
export const FAMILY_CONFIG = Object.freeze(
  Object.fromEntries(FAMILIES.map((f) => [f, { file: FAMILY_REGISTRY[f].file, verifier: FAMILY_REGISTRY[f].verifier }]))
);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class ConformanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConformanceError';
    this.code = code;
  }
}

/** A generated entry nests the untouched source case under `case`; a raw source case is used as is. */
export function sourceCaseOf(vectorCase) {
  if (vectorCase && typeof vectorCase === 'object' && vectorCase.case && typeof vectorCase.case === 'object') {
    return vectorCase.case;
  }
  return vectorCase;
}

function webhookHeader(c) {
  const verifying = c.verifying || {};
  if (typeof verifying.headerOverride === 'string') return verifying.headerOverride;
  return eventsVerifier.signWebhookDelivery(c.signing);
}

/**
 * Call the reference verifier for one case, with the exact arguments of its variant.
 * Returns the verifier's own result object, unmodified.
 */
export function invokeVerifier(family, source, variant = variantOf(family, source)) {
  if (!isKnownFamily(family)) throw new ConformanceError('UNKNOWN_FAMILY', `Unsupported verifier family: ${family}`);
  if (!variant || !FAMILY_REGISTRY[family].variants[variant]) {
    throw new ConformanceError('UNKNOWN_VARIANT', `No ${family} variant matches this case.`);
  }
  const c = source;
  switch (`${family}:${variant}`) {
    case 'purchase:completion':
      return purchaseVerifier.verifyPublicAskCompletion(c.transaction, c.order);
    case 'offers:terms':
      return offersVerifier.verifyOfferTerms(c.terms);
    case 'offers:acceptance':
      return offersVerifier.verifyOfferAcceptance(c.acceptance, c.offer);
    case 'offers:recovery':
      return offersVerifier.verifyOfferRecovery(c.recovery, c.offer);
    case 'runes:burn-safety':
      return runesVerifier.verifyRuneBurnSafety(c.outputScriptsHex, c.inputs, c.outputCount);
    case 'safeops:signed':
      return safeopsVerifier.verifySafeOpsSignedResult(c.signed, c.plan);
    case 'safeops:plan':
      return safeopsVerifier.verifySafeOpsPlan(c.plan);
    case 'swaps:acceptance':
      return swapsVerifier.verifySwapAcceptance(c.acceptance, c.intent);
    case 'swaps:intent':
      return swapsVerifier.verifySwapIntent(c.intent);
    case 'events:webhook': {
      const { headerOverride, ...rest } = c.verifying || {};
      return eventsVerifier.verifyWebhookSignature({ header: webhookHeader(c), ...rest });
    }
    case 'events:event':
      return eventsVerifier.validateOrdexEvent(c.event);
    case 'collection-manifest:membership':
      return collectionManifestVerifier.verifyMembershipProof({
        manifest: c.manifest,
        memberIdentity: c.membership?.memberIdentity,
        proof: c.membership?.proof
      });
    case 'collection-manifest:revocation':
      return collectionManifestVerifier.verifyManifestRevocation(c.revocation, c.manifest);
    case 'collection-manifest:manifest':
      return collectionManifestVerifier.verifyCollectionManifest(c.manifest);
    case 'counterparty-asset:attachment':
      return counterpartyAssetVerifier.verifyAttachmentFollows(c.record, c.spendTx, c.expectedOutputIndex);
    case 'counterparty-asset:record':
      return counterpartyAssetVerifier.verifyCounterpartyUtxoAsset(c.record);
    case 'offline-signing:signed':
      return offlineSigningVerifier.compareSignedResultToManifest(c.signed, c.manifest);
    case 'offline-signing:manifest':
      return offlineSigningVerifier.verifyExpectedTransactionManifest(c.manifest);
    default:
      throw new ConformanceError('UNKNOWN_VARIANT', `No executor for ${family}:${variant}.`);
  }
}

/**
 * Normalize a verifier result into an explicit candidate verdict. Rune results report
 * `safe`, every other family reports `ok`; anything else is unknown, never accepted.
 */
export function normalizeVerdict(family, raw) {
  const kind = FAMILY_REGISTRY[family]?.result;
  const flag = raw && typeof raw === 'object' ? raw[kind] : undefined;
  if (flag === true) return { state: 'accepted', code: null, reason: null };
  if (flag === false) {
    return { state: 'refused', code: raw.code ?? null, reason: raw.reason ?? null };
  }
  return { state: 'unknown', code: raw?.code ?? null, reason: 'The verifier returned no verdict.' };
}

/**
 * Compare every expected field of a vector with the verifier result. An expected field the
 * engine does not know how to compare is a mismatch, so no expectation is silently skipped.
 */
export function compareExpected(family, expected, raw) {
  const spec = FAMILY_REGISTRY[family];
  const mismatches = [];
  if (!expected || typeof expected !== 'object') {
    return { passed: false, mismatches: [{ field: 'expected', expected: 'object', actual: typeof expected }] };
  }
  if (!Object.prototype.hasOwnProperty.call(expected, spec.result)) {
    mismatches.push({ field: spec.result, expected: 'present', actual: 'missing from vector' });
  }
  for (const [field, want] of Object.entries(expected)) {
    if (!spec.expectedFields.includes(field)) {
      mismatches.push({ field, expected: want, actual: 'field not supported by this family' });
      continue;
    }
    if (field === 'flaw') {
      const flaws = Array.isArray(raw?.flaws) ? raw.flaws : [];
      if (!flaws.includes(want)) mismatches.push({ field, expected: want, actual: flaws });
      continue;
    }
    const got = raw?.[field];
    if (got !== want) mismatches.push({ field, expected: want, actual: got === undefined ? null : got });
  }
  // An accepting expectation with no code must not come back carrying a refusal code.
  if (expected[spec.result] === true && expected.code === undefined && raw?.code !== undefined && raw?.code !== null) {
    mismatches.push({ field: 'code', expected: null, actual: raw.code });
  }
  return { passed: mismatches.length === 0, mismatches };
}

function caseName(vectorCase, source) {
  return vectorCase?.name || vectorCase?.title || source?.name || source?.title || 'unnamed';
}

/**
 * Execute one conformance vector (a raw source case or a generated entry).
 * `passed` means the verifier reached exactly the expected verdict, which for a refusal
 * vector is a matched refusal, not an accepted transaction and never chain acceptance.
 */
export function executeVector(family, vectorCase) {
  const start = now();
  const source = sourceCaseOf(vectorCase);
  const variant = variantOf(family, source);
  let raw = null;
  let error = null;
  try {
    raw = invokeVerifier(family, source, variant);
  } catch (err) {
    error = { code: err?.code || 'VERIFIER_THREW', message: String(err?.message || err) };
  }
  const expected = source?.expected;
  const verdict = error ? { state: 'unknown', code: error.code, reason: error.message } : normalizeVerdict(family, raw);
  const comparison = error
    ? { passed: false, mismatches: [{ field: 'execution', expected: 'verdict', actual: error.message }] }
    : compareExpected(family, expected, raw);
  const resultKind = FAMILY_REGISTRY[family]?.result || 'ok';
  const actual = error
    ? { [resultKind]: false, code: error.code, error: error.message }
    : { ...raw };
  return {
    id: vectorCase?.id || null,
    name: caseName(vectorCase, source),
    family,
    variant,
    passed: comparison.passed,
    outcome: comparison.passed
      ? verdict.state === 'accepted'
        ? 'EXPECTED_ACCEPTANCE_MATCHED'
        : 'EXPECTED_REFUSAL_MATCHED'
      : 'MISMATCH',
    expected,
    actual,
    verdict,
    mismatches: comparison.mismatches,
    durationMs: now() - start
  };
}

/**
 * Evaluate a candidate from Protocol Lab or the Sandbox. There is no expected verdict:
 * the result is the verifier's own accepted/refused/unknown state plus its raw output.
 */
export function evaluateCandidate(family, variant, args) {
  const start = now();
  if (!isKnownFamily(family)) throw new ConformanceError('UNKNOWN_FAMILY', `Unsupported verifier family: ${family}`);
  const need = variantArguments(family, variant);
  if (!need) throw new ConformanceError('UNKNOWN_VARIANT', `Unknown ${family} variant: ${variant}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ConformanceError('MALFORMED_INPUT', 'Candidate input must be a JSON object.');
  }
  const missing = need.required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length) {
    throw new ConformanceError('MISSING_ARGUMENTS', `The ${variant} variant needs: ${missing.join(', ')}.`);
  }
  // The chosen variant pins the dispatch, independent of predicate order.
  let raw;
  try {
    raw = invokeVerifier(family, args, variant);
  } catch (err) {
    return {
      family,
      variant,
      verdict: { state: 'unknown', code: err?.code || 'VERIFIER_THREW', reason: String(err?.message || err) },
      raw: null,
      durationMs: now() - start
    };
  }
  return { family, variant, verdict: normalizeVerdict(family, raw), raw, durationMs: now() - start };
}

/**
 * Run a suite over loaded vector data: { family: { cases: [...] } } for any selection of
 * families. An empty or unknown selection is an error, never a success.
 */
export function runConformanceSuite(familiesData, selectedFamilies = null) {
  if (!familiesData || typeof familiesData !== 'object') {
    throw new ConformanceError('NO_VECTOR_DATA', 'No vector data was supplied. Load it with scripts/docs/vector-loader.mjs or generated data.');
  }
  const start = now();
  const families = selectedFamilies || Object.keys(familiesData);
  for (const family of families) {
    if (!isKnownFamily(family)) throw new ConformanceError('UNKNOWN_FAMILY', `Unsupported verifier family: ${family}`);
  }
  const results = [];
  for (const family of families) {
    const cases = familiesData[family]?.cases || familiesData[family]?.vectors || [];
    for (const vectorCase of cases) results.push(executeVector(family, vectorCase));
  }
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const success = total > 0 && failed === 0;
  const durationMs = now() - start;
  const summary = {
    total,
    passed,
    failed,
    empty: total === 0,
    success,
    families: families.length,
    durationMs,
    timestamp: new Date().toISOString()
  };
  return { total, passed, failed, success, durationMs, summary, results };
}
