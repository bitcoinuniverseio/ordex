// Conformance Engine
// Shared deterministic conformance vector runner for both CLI and Browser / Conformance Studio.
// Loads authoritative repository-owned vectors and executes corresponding reference verifiers.

import * as purchaseVerifier from '../../../verifier/purchase.js';
import * as offersVerifier from '../../../verifier/offers.js';
import * as runesVerifier from '../../../verifier/runes.js';
import * as safeopsVerifier from '../../../verifier/safeops.js';
import * as swapsVerifier from '../../../verifier/swaps.js';
import * as eventsVerifier from '../../../verifier/events.js';
import * as collectionManifestVerifier from '../../../verifier/collection-manifest.js';
import * as counterpartyAssetVerifier from '../../../verifier/counterparty-asset.js';
import * as offlineSigningVerifier from '../../../verifier/offline-signing.js';

export const FAMILY_CONFIG = {
  purchase: { file: 'purchase-vectors.json', verifier: 'purchase.js' },
  offers: { file: 'offer-vectors.json', verifier: 'offers.js' },
  runes: { file: 'rune-burn-vectors.json', verifier: 'runes.js' },
  safeops: { file: 'safeops-vectors.json', verifier: 'safeops.js' },
  swaps: { file: 'swap-vectors.json', verifier: 'swaps.js' },
  events: { file: 'event-vectors.json', verifier: 'events.js' },
  'collection-manifest': { file: 'collection-manifest-vectors.json', verifier: 'collection-manifest.js' },
  'counterparty-asset': { file: 'counterparty-asset-vectors.json', verifier: 'counterparty-asset.js' },
  'offline-signing': { file: 'offline-signing-vectors.json', verifier: 'offline-signing.js' }
};

export const FAMILIES = Object.keys(FAMILY_CONFIG);

/**
 * Execute a single vector case.
 * Returns: { ok: boolean, passed: boolean, expected: object, actual: object, reason?: string, durationMs: number }
 */
export function executeVector(family, vectorCase) {
  const start = performance.now();
  let actual = null;
  let passed = false;

  try {
    switch (family) {
      case 'purchase': {
        const res = purchaseVerifier.verifyPublicAskCompletion(vectorCase.transaction, vectorCase.order);
        actual = { ok: res.ok, code: res.code, sharedIndex: res.sharedIndex, reason: res.reason };
        passed = (res.ok === vectorCase.expected.ok) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code) &&
                 (vectorCase.expected.sharedIndex === undefined || res.sharedIndex === vectorCase.expected.sharedIndex);
        break;
      }
      case 'offers': {
        let res;
        if (vectorCase.kind === 'terms') {
          res = offersVerifier.verifyOfferTerms(vectorCase.terms);
        } else if (vectorCase.kind === 'acceptance') {
          res = offersVerifier.verifyOfferAcceptance(vectorCase.acceptance, vectorCase.offer);
        } else if (vectorCase.kind === 'recovery') {
          res = offersVerifier.verifyOfferRecovery(vectorCase.recovery, vectorCase.offer);
        } else {
          res = { ok: false, code: 'UNKNOWN_OFFER_CASE' };
        }
        actual = { ok: res.ok, code: res.code, sharedIndex: res.sharedIndex, offerTermsHash: res.offerTermsHash, reason: res.reason };
        passed = (res.ok === vectorCase.expected.ok) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code) &&
                 (vectorCase.expected.sharedIndex === undefined || res.sharedIndex === vectorCase.expected.sharedIndex) &&
                 (vectorCase.expected.offerTermsHash === undefined || res.offerTermsHash === vectorCase.expected.offerTermsHash);
        break;
      }
      case 'runes': {
        const res = runesVerifier.verifyRuneBurnSafety(vectorCase.outputScriptsHex, vectorCase.inputs, vectorCase.outputCount);
        actual = { safe: res.safe, code: res.code, runestone: res.runestone, reason: res.reason };
        passed = (res.safe === vectorCase.expected.safe) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code) &&
                 (vectorCase.expected.runestone === undefined || res.runestone === vectorCase.expected.runestone);
        break;
      }
      case 'safeops': {
        let res;
        if (vectorCase.signed) {
          res = safeopsVerifier.verifySafeOpsSignedResult(vectorCase.signed, vectorCase.plan);
        } else {
          res = safeopsVerifier.verifySafeOpsPlan(vectorCase.plan);
        }
        actual = { ok: res.ok, code: res.code, digest: res.digest, reason: res.reason };
        passed = (res.ok === vectorCase.expected.ok) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code);
        break;
      }
      case 'swaps': {
        let res;
        if (vectorCase.acceptance) {
          res = swapsVerifier.verifySwapAcceptance(vectorCase.acceptance, vectorCase.intent);
        } else {
          res = swapsVerifier.verifySwapIntent(vectorCase.intent);
        }
        actual = { ok: res.ok, code: res.code, reason: res.reason };
        passed = (res.ok === vectorCase.expected.ok) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code);
        break;
      }
      case 'events': {
        let res;
        if (vectorCase.kind === 'webhook') {
          const header = vectorCase.verifying.headerOverride || eventsVerifier.signWebhookDelivery(vectorCase.signing);
          const { headerOverride, ...rest } = vectorCase.verifying;
          res = eventsVerifier.verifyWebhookSignature({ header, ...rest });
        } else {
          res = eventsVerifier.validateOrdexEvent(vectorCase.event);
        }
        actual = { ok: res.ok, code: res.code, reason: res.reason };
        passed = (res.ok === vectorCase.expected.ok) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code);
        break;
      }
      case 'collection-manifest': {
        let res;
        if (vectorCase.membership) {
          res = collectionManifestVerifier.verifyMembershipProof({
            manifest: vectorCase.manifest,
            memberIdentity: vectorCase.membership.memberIdentity,
            proof: vectorCase.membership.proof
          });
        } else if (vectorCase.revocation) {
          res = collectionManifestVerifier.verifyManifestRevocation(vectorCase.revocation, vectorCase.manifest);
        } else {
          res = collectionManifestVerifier.verifyCollectionManifest(vectorCase.manifest);
        }
        actual = { ok: res.ok, code: res.code, reason: res.reason };
        passed = (res.ok === vectorCase.expected.ok) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code);
        break;
      }
      case 'counterparty-asset': {
        let res;
        if (vectorCase.spendTx) {
          res = counterpartyAssetVerifier.verifyAttachmentFollows(vectorCase.record, vectorCase.spendTx, vectorCase.expectedOutputIndex);
        } else {
          res = counterpartyAssetVerifier.verifyCounterpartyUtxoAsset(vectorCase.record);
        }
        actual = { ok: res.ok, code: res.code, carriedToIndex: res.carriedToIndex, reason: res.reason };
        passed = (res.ok === vectorCase.expected.ok) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code) &&
                 (vectorCase.expected.carriedToIndex === undefined || res.carriedToIndex === vectorCase.expected.carriedToIndex);
        break;
      }
      case 'offline-signing': {
        let res;
        if (vectorCase.signed) {
          res = offlineSigningVerifier.compareSignedResultToManifest(vectorCase.signed, vectorCase.manifest);
        } else {
          res = offlineSigningVerifier.verifyExpectedTransactionManifest(vectorCase.manifest);
        }
        actual = { ok: res.ok, code: res.code, digest: res.digest, reason: res.reason };
        passed = (res.ok === vectorCase.expected.ok) &&
                 (!vectorCase.expected.code || res.code === vectorCase.expected.code);
        break;
      }
      default:
        throw new Error(`Unsupported verifier family: ${family}`);
    }
  } catch (err) {
    actual = { ok: false, error: err.message, stack: err.stack };
    passed = false;
  }

  const durationMs = performance.now() - start;
  return {
    name: vectorCase.name || vectorCase.title || 'unnamed',
    family,
    passed,
    expected: vectorCase.expected,
    actual,
    durationMs
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __conformanceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../conformance');

export function loadVectorFamily(family) {
  const cfg = FAMILY_CONFIG[family];
  if (!cfg) return [];
  const p = path.resolve(__conformanceDir, cfg.file);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cases = data.cases || data.vectors || [];
  return cases.map(c => ({ ...c, family, title: c.name || c.title || c.description }));
}

export { runConformanceSuite as runAllVectors };
export function runConformanceSuite(familiesData = null, selectedFamilies = null) {
  const start = performance.now();
  const results = [];
  const familiesToRun = selectedFamilies || (familiesData ? Object.keys(familiesData) : FAMILIES);

  for (const family of familiesToRun) {
    const cases = familiesData
      ? (familiesData[family]?.cases || familiesData[family]?.vectors || [])
      : loadVectorFamily(family);
    for (const vectorCase of cases) {
      const res = executeVector(family, vectorCase);
      results.push(res);
    }
  }

  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;
  const totalDurationMs = performance.now() - start;

  return {
    total,
    passed,
    failed,
    success: failed === 0,
    durationMs: totalDurationMs,
    summary: {
      total,
      passed,
      failed,
      success: failed === 0,
      durationMs: totalDurationMs,
      timestamp: new Date().toISOString()
    },
    results
  };
}
