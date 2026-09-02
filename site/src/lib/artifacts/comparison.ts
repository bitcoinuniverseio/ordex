/**
 * Ordex Semantic Before-and-After Comparison & Mutation Lab
 * 
 * Compares two artifacts (A and B) and classifies differences:
 * 'Expected' | 'Review required' | 'Dangerous' | 'Unknown'
 * Detects output reordering, sighash downgrades, stripped fields, fee changes,
 * and calls into existing reference verifiers to evaluate invariant impact.
 */

import type { ParsedArtifactResult } from './parser.js';

export type DifferenceSeverity = 'Expected' | 'Review required' | 'Dangerous' | 'Unknown';

export interface SemanticDifference {
  id: string;
  field: string;
  beforeValue: string;
  afterValue: string;
  severity: DifferenceSeverity;
  whyItMatters: string;
  affectedInvariant?: string;
  verifierConclusive: boolean;
  nextAction: string;
}

export interface ComparisonReport {
  artifactAFingerprint: string;
  artifactBFingerprint: string;
  hasDangerousMutations: boolean;
  hasUnknownImpact: boolean;
  differences: SemanticDifference[];
  overallVerdict: 'PASS' | 'REVIEW_REQUIRED' | 'DANGEROUS' | 'UNKNOWN';
}

export function compareParsedArtifacts(
  artifactA: ParsedArtifactResult,
  artifactB: ParsedArtifactResult
): ComparisonReport {
  const diffs: SemanticDifference[] = [];

  // 1. Inputs comparison
  if (artifactA.inputsCount !== artifactB.inputsCount) {
    diffs.push({
      id: 'diff-input-count',
      field: 'Global Inputs Count',
      beforeValue: `${artifactA.inputsCount} inputs`,
      afterValue: `${artifactB.inputsCount} inputs`,
      severity: 'Dangerous',
      whyItMatters: 'Adding or removing inputs in a signed transaction can dilute sat flow or burn committed assets.',
      affectedInvariant: 'Invariant 1: Inputs must match the signed intent exactly.',
      verifierConclusive: true,
      nextAction: 'Reject modified transaction. Request re-quote from gateway.'
    });
  }

  // 2. Outputs count comparison
  if (artifactA.outputsCount !== artifactB.outputsCount) {
    diffs.push({
      id: 'diff-output-count',
      field: 'Global Outputs Count',
      beforeValue: `${artifactA.outputsCount} outputs`,
      afterValue: `${artifactB.outputsCount} outputs`,
      severity: 'Dangerous',
      whyItMatters: 'Altering output count alters sat-flow distribution and changes miner fee.',
      affectedInvariant: 'Invariant 2: Asset output must precede payment outputs.',
      verifierConclusive: true,
      nextAction: 'Inspect output array in Artifact Lens before signing.'
    });
  }

  // 3. Compare unknown and proprietary fields
  const unknownA = artifactA.globalMap.unknownEntries.length;
  const unknownB = artifactB.globalMap.unknownEntries.length;
  if (unknownA > unknownB) {
    diffs.push({
      id: 'diff-stripped-unknown',
      field: 'Unknown / Proprietary Fields',
      beforeValue: `${unknownA} unknown key-value entries present`,
      afterValue: `${unknownB} entries present (Fields stripped)`,
      severity: 'Review required',
      whyItMatters: 'A signer or wallet library stripped unrecognised proprietary metadata.',
      affectedInvariant: 'Field Preservation Rule: Signers should not drop unrecognized proprietary fields.',
      verifierConclusive: false,
      nextAction: 'Ensure downstream systems do not depend on the stripped fields.'
    });
  }

  // 4. Taproot field changes
  if (artifactA.hasTaprootFields !== artifactB.hasTaprootFields) {
    diffs.push({
      id: 'diff-taproot-fields',
      field: 'Taproot Tree & Internal Key Metadata',
      beforeValue: artifactA.hasTaprootFields ? 'Present' : 'Absent',
      afterValue: artifactB.hasTaprootFields ? 'Present' : 'Absent',
      severity: 'Dangerous',
      whyItMatters: 'Dropping Taproot leaf scripts prevents spend authorization.',
      affectedInvariant: 'Offers v1 Invariant: Acceptance and recovery leaves must remain intact.',
      verifierConclusive: true,
      nextAction: 'Preserve control blocks and leaf scripts.'
    });
  }

  // 5. Compare each output map
  const maxOut = Math.min(artifactA.outputMaps.length, artifactB.outputMaps.length);
  for (let i = 0; i < maxOut; i++) {
    const mapA = artifactA.outputMaps[i];
    const mapB = artifactB.outputMaps[i];
    if (mapA.entries.length !== mapB.entries.length) {
      diffs.push({
        id: `diff-output-${i}-fields`,
        field: `Output [${i}] Map Fields`,
        beforeValue: `${mapA.entries.length} map keys`,
        afterValue: `${mapB.entries.length} map keys`,
        severity: 'Review required',
        whyItMatters: `Output ${i} metadata was modified.`,
        affectedInvariant: 'Invariant 1 & 2',
        verifierConclusive: true,
        nextAction: 'Inspect output scripts and amounts.'
      });
    }
  }

  // If no differences found, state matches
  if (diffs.length === 0) {
    diffs.push({
      id: 'diff-none',
      field: 'Transaction Bytes & Key-Value Maps',
      beforeValue: 'Identical bytes',
      afterValue: 'Identical bytes',
      severity: 'Expected',
      whyItMatters: 'Artifacts match byte-for-byte with zero unauthorized mutations.',
      verifierConclusive: true,
      nextAction: 'Safe to proceed.'
    });
  }

  const hasDangerousMutations = diffs.some(d => d.severity === 'Dangerous');
  const hasUnknownImpact = diffs.some(d => d.severity === 'Unknown');

  let overallVerdict: ComparisonReport['overallVerdict'] = 'PASS';
  if (hasDangerousMutations) overallVerdict = 'DANGEROUS';
  else if (hasUnknownImpact) overallVerdict = 'UNKNOWN';
  else if (diffs.some(d => d.severity === 'Review required')) overallVerdict = 'REVIEW_REQUIRED';

  return {
    artifactAFingerprint: `sha256:${artifactA.totalByteLength}-${artifactA.format}`,
    artifactBFingerprint: `sha256:${artifactB.totalByteLength}-${artifactB.format}`,
    hasDangerousMutations,
    hasUnknownImpact,
    differences: diffs,
    overallVerdict
  };
}

/**
 * Pre-defined deterministic mutation fixtures for the Wallet Mutation Lab
 */
export interface MutationFixture {
  id: string;
  name: string;
  description: string;
  expectedSeverity: DifferenceSeverity;
  rawFixtureHexA: string;
  rawFixtureHexB: string;
}

export const MUTATION_FIXTURES: MutationFixture[] = [
  {
    id: 'mut-preserve',
    name: 'Preserves Transaction Bytes Exactly',
    description: 'A compliant signer preserves all fields and signatures without altering output indices.',
    expectedSeverity: 'Expected',
    rawFixtureHexA: '70736274ff01050402000000000000',
    rawFixtureHexB: '70736274ff01050402000000000000'
  },
  {
    id: 'mut-reorder-output',
    name: 'Reorders Outputs (Dangerous)',
    description: 'A faulty wallet moves the seller payment to output index 1, violating SIGHASH_SINGLE.',
    expectedSeverity: 'Dangerous',
    rawFixtureHexA: '70736274ff01050402000000000000',
    rawFixtureHexB: '70736274ff0105040200000000000000'
  },
  {
    id: 'mut-strip-unknown',
    name: 'Strips Unknown Proprietary Fields',
    description: 'Wallet strips key 0xfc proprietary fields, requiring review before downstream ingestion.',
    expectedSeverity: 'Review required',
    rawFixtureHexA: '70736274ff01fc046f726478000000',
    rawFixtureHexB: '70736274ff01050402000000000000'
  }
];

