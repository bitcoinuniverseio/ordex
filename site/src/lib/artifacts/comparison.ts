/**
 * Ordex Semantic Before-and-After Comparison
 *
 * OX-S01: compares two decoded artifacts field by field: transaction version and locktime,
 * every input (outpoint, order, sequence, sighash), every output (position, script, exact
 * amount) and every PSBT map key and value. Byte identity is claimed only when the original
 * bytes and their real SHA-256 match. Signature and finalization additions are classified
 * as expected; anything undecodable is UNKNOWN, never identical. Fees are derived only
 * from prevout amounts the artifact actually carries.
 */

import type { ParsedArtifactResult, ParsedPsbtMap, KeyValueEntry } from './parser.js';

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
  artifactASha256: string;
  artifactBSha256: string;
  byteIdentical: boolean;
  hasDangerousMutations: boolean;
  hasUnknownImpact: boolean;
  differences: SemanticDifference[];
  overallVerdict: 'IDENTICAL' | 'EXPECTED_SIGNER_ADDITIONS' | 'REVIEW_REQUIRED' | 'DANGEROUS' | 'UNKNOWN';
  /** False when a side could not be decoded or a check needed context the artifacts lack. */
  conclusive: boolean;
  feeSats: { before: string | null; after: string | null; reason: string | null };
}

// Fields a signer or finalizer adds without changing what the transaction does.
const SIGNER_INPUT_KEYS = new Set([0x02, 0x07, 0x08, 0x13, 0x14, 0x1b, 0x1c]);
// Fields BIP174 tells a finalizer to remove once final scripts exist.
const FINALIZER_REMOVES = new Set([0x02, 0x03, 0x04, 0x05, 0x06, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18]);
// Fields whose change alters what is spent or signed.
const DANGEROUS_INPUT_KEYS = new Set([0x00, 0x01, 0x03, 0x0e, 0x0f, 0x10, 0x11, 0x12]);
const DANGEROUS_OUTPUT_KEYS = new Set([0x03, 0x04]);
const DANGEROUS_GLOBAL_KEYS = new Set([0x00, 0x02, 0x03, 0x04, 0x05, 0x06, 0xfb]);
// Values the transaction comparison already checks field by field (outpoints, sequences,
// sighash, amounts, scripts, version, locktime, counts); a changed value is reported there.
const COVERED = {
  global: new Set([0x00, 0x02, 0x03, 0x04, 0x05]),
  input: new Set([0x03, 0x0e, 0x0f, 0x10, 0x11, 0x12]),
  output: new Set([0x03, 0x04])
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const short = (s: string) => (s.length > 34 ? `${s.slice(0, 16)}...${s.slice(-16)}` : s);

/** Fee from prevout amounts carried by the artifact, or the reason it cannot be derived. */
export function deriveFee(a: ParsedArtifactResult): { fee: string | null; reason: string | null } {
  if (a.status !== 'decoded') return { fee: null, reason: 'The artifact did not decode.' };
  const missing = a.inputs.filter((i) => i.prevoutValueSats === null).map((i) => i.index);
  if (a.inputs.length === 0) return { fee: null, reason: 'The transaction has no inputs.' };
  if (missing.length) return { fee: null, reason: `Prevout amounts are missing for input ${missing.join(', ')}, so the fee cannot be derived.` };
  const inSum = a.inputs.reduce((s, i) => s + BigInt(i.prevoutValueSats as string), 0n);
  const outSum = a.outputs.reduce((s, o) => s + BigInt(o.valueSats ?? '0'), 0n);
  return { fee: (inSum - outSum).toString(), reason: null };
}

function mapDiff(prefix: string, mapA: ParsedPsbtMap | undefined, mapB: ParsedPsbtMap | undefined, kind: 'global' | 'input' | 'output', finalizedInB: boolean, diffs: SemanticDifference[]) {
  const a = new Map<string, KeyValueEntry>((mapA?.entries || []).map((e) => [e.keyHex, e]));
  const b = new Map<string, KeyValueEntry>((mapB?.entries || []).map((e) => [e.keyHex, e]));
  const dangerous = kind === 'input' ? DANGEROUS_INPUT_KEYS : kind === 'output' ? DANGEROUS_OUTPUT_KEYS : DANGEROUS_GLOBAL_KEYS;
  for (const [key, ea] of a) {
    const eb = b.get(key);
    if (!eb) {
      const finalizerCleanup = kind === 'input' && finalizedInB && FINALIZER_REMOVES.has(ea.keyType);
      diffs.push({
        id: `${prefix}-removed-${key}`,
        field: `${prefix}: ${ea.label}`,
        beforeValue: `present (${ea.valueData.length} bytes)`,
        afterValue: 'removed',
        severity: finalizerCleanup ? 'Expected' : dangerous.has(ea.keyType) ? 'Dangerous' : 'Review required',
        whyItMatters: finalizerCleanup
          ? 'A finalizer removes this field once the final scriptSig or witness is present (BIP174).'
          : ea.isUnknown
            ? 'A signer or wallet dropped a field it did not recognize. BIP174 asks signers to keep unknown fields.'
            : 'A field present before is gone.',
        verifierConclusive: true,
        nextAction: finalizerCleanup ? 'No action needed.' : 'Check whether anything downstream depends on the dropped field.'
      });
    } else if (hex(ea.valueData) !== hex(eb.valueData) && !COVERED[kind].has(ea.keyType)) {
      diffs.push({
        id: `${prefix}-changed-${key}`,
        field: `${prefix}: ${ea.label}`,
        beforeValue: short(hex(ea.valueData)),
        afterValue: short(hex(eb.valueData)),
        severity: dangerous.has(ea.keyType) ? 'Dangerous' : 'Review required',
        whyItMatters: dangerous.has(ea.keyType) ? 'This value decides what is spent or what the signature commits to.' : 'A field value changed between the two artifacts.',
        verifierConclusive: true,
        nextAction: dangerous.has(ea.keyType) ? 'Do not sign or broadcast artifact B.' : 'Review the changed value.'
      });
    }
  }
  for (const [key, eb] of b) {
    if (a.has(key)) continue;
    const signerAddition = kind === 'input' && SIGNER_INPUT_KEYS.has(eb.keyType);
    diffs.push({
      id: `${prefix}-added-${key}`,
      field: `${prefix}: ${eb.label}`,
      beforeValue: 'absent',
      afterValue: `added (${eb.valueData.length} bytes)`,
      severity: signerAddition ? 'Expected' : dangerous.has(eb.keyType) ? 'Dangerous' : 'Review required',
      whyItMatters: signerAddition ? 'A signer or finalizer added a signature or final script.' : 'A field was added that artifact A did not carry.',
      verifierConclusive: true,
      nextAction: signerAddition ? 'Expected during signing.' : 'Review the added field.'
    });
  }
}

export function compareParsedArtifacts(artifactA: ParsedArtifactResult, artifactB: ParsedArtifactResult): ComparisonReport {
  const diffs: SemanticDifference[] = [];
  const base = {
    artifactASha256: artifactA.sha256,
    artifactBSha256: artifactB.sha256,
    byteIdentical: artifactA.sha256 === artifactB.sha256 && artifactA.rawHex === artifactB.rawHex
  };
  const feeA = deriveFee(artifactA);
  const feeB = deriveFee(artifactB);

  if (artifactA.status !== 'decoded' || artifactB.status !== 'decoded') {
    diffs.push({
      id: 'diff-undecoded',
      field: 'Artifact decoding',
      beforeValue: artifactA.status,
      afterValue: artifactB.status,
      severity: 'Unknown',
      whyItMatters: 'At least one artifact could not be decoded, so no semantic comparison is possible.',
      verifierConclusive: false,
      nextAction: `Fix the input: ${[...artifactA.errors, ...artifactB.errors][0] || 'decode both artifacts first'}.`
    });
    return {
      ...base,
      byteIdentical: false,
      hasDangerousMutations: false,
      hasUnknownImpact: true,
      differences: diffs,
      overallVerdict: 'UNKNOWN',
      conclusive: false,
      feeSats: { before: feeA.fee, after: feeB.fee, reason: 'Undecoded artifact.' }
    };
  }

  if (base.byteIdentical) {
    diffs.push({
      id: 'diff-none',
      field: 'Original bytes',
      beforeValue: `SHA-256 ${artifactA.sha256}`,
      afterValue: `SHA-256 ${artifactB.sha256}`,
      severity: 'Expected',
      whyItMatters: 'The two artifacts are byte for byte identical.',
      verifierConclusive: true,
      nextAction: 'Nothing changed between A and B. This alone does not check the order terms.'
    });
    return {
      ...base,
      hasDangerousMutations: false,
      hasUnknownImpact: false,
      differences: diffs,
      overallVerdict: 'IDENTICAL',
      conclusive: true,
      feeSats: { before: feeA.fee, after: feeB.fee, reason: feeA.reason }
    };
  }

  const push = (d: SemanticDifference) => diffs.push(d);
  const danger = (id: string, field: string, before: unknown, after: unknown, why: string, invariant?: string) =>
    push({
      id,
      field,
      beforeValue: String(before),
      afterValue: String(after),
      severity: 'Dangerous',
      whyItMatters: why,
      affectedInvariant: invariant,
      verifierConclusive: true,
      nextAction: 'Do not sign or broadcast artifact B. Rebuild it from the approved terms.'
    });

  if (artifactA.version !== artifactB.version) danger('diff-version', 'Transaction version', artifactA.version, artifactB.version, 'Signatures commit to the transaction version.');
  if (artifactA.locktime !== artifactB.locktime) danger('diff-locktime', 'Transaction locktime', artifactA.locktime, artifactB.locktime, 'Signatures commit to the locktime; it also decides when the transaction can confirm.');

  // Inputs: outpoints in order, sequences, sighash types.
  const outpoint = (i: { txid: string | null; vout: number | null }) => `${i.txid}:${i.vout}`;
  const opsA = artifactA.inputs.map(outpoint);
  const opsB = artifactB.inputs.map(outpoint);
  if (opsA.join() !== opsB.join()) {
    const sameSet = opsA.length === opsB.length && [...opsA].sort().join() === [...opsB].sort().join();
    danger(
      sameSet ? 'diff-inputs-reordered' : 'diff-inputs-changed',
      sameSet ? 'Input order' : 'Spent outpoints',
      opsA.map(short).join(', ') || 'none',
      opsB.map(short).join(', ') || 'none',
      sameSet ? 'SIGHASH_SINGLE pairs each input with the output at the same index; reordering breaks that pairing.' : 'Artifact B spends different outputs than artifact A.',
      'Inputs must match the signed intent exactly.'
    );
  }
  const n = Math.min(artifactA.inputs.length, artifactB.inputs.length);
  for (let i = 0; i < n; i++) {
    const a = artifactA.inputs[i];
    const b = artifactB.inputs[i];
    if (outpoint(a) !== outpoint(b)) continue;
    if (a.sequence !== b.sequence) danger(`diff-input-${i}-sequence`, `Input ${i} sequence`, a.sequence, b.sequence, 'Signatures commit to the sequence; it also controls replaceability and relative locktime.');
    if (a.sighashType !== null && b.sighashType !== null && a.sighashType !== b.sighashType) {
      danger(`diff-input-${i}-sighash`, `Input ${i} sighash type`, `0x${a.sighashType.toString(16)}`, `0x${b.sighashType.toString(16)}`, 'The sighash type decides which parts of the transaction the signature protects.');
    }
    if (a.prevoutValueSats !== null && b.prevoutValueSats !== null && a.prevoutValueSats !== b.prevoutValueSats) {
      danger(`diff-input-${i}-prevout-value`, `Input ${i} prevout amount`, a.prevoutValueSats, b.prevoutValueSats, 'The amount being spent differs, which changes the fee and SegWit signature commitments.');
    }
  }

  // Outputs: position, script and exact amount.
  const outKey = (o: { scriptHex: string | null; valueSats: string | null }) => `${o.valueSats}:${o.scriptHex}`;
  const outsA = artifactA.outputs.map(outKey);
  const outsB = artifactB.outputs.map(outKey);
  if (outsA.length !== outsB.length) {
    danger('diff-output-count', 'Output count', outsA.length, outsB.length, 'Adding or removing outputs moves value and changes sat flow.', 'Outputs must match the approved terms.');
  } else if (outsA.join() !== outsB.join() && [...outsA].sort().join() === [...outsB].sort().join()) {
    danger('diff-outputs-reordered', 'Output order', 'original order', 'same outputs, different order', 'Output positions decide sat flow and SIGHASH_SINGLE pairing.', 'Seller payment must sit at the shared index.');
  } else {
    artifactA.outputs.forEach((oa, i) => {
      const ob = artifactB.outputs[i];
      if (oa.valueSats !== ob.valueSats) danger(`diff-output-${i}-amount`, `Output ${i} amount`, `${oa.valueSats} sats`, `${ob.valueSats} sats`, 'The amount paid by this output changed.', 'Payments must carry exactly the agreed amounts.');
      if (oa.scriptHex !== ob.scriptHex) danger(`diff-output-${i}-script`, `Output ${i} script`, short(oa.scriptHex || ''), short(ob.scriptHex || ''), 'This output now pays a different script.', 'Payments must go to the agreed scripts.');
    });
  }

  // PSBT maps, per map, when both sides are PSBTs.
  const bothPsbt = artifactA.format.startsWith('PSBT') && artifactB.format.startsWith('PSBT');
  if (bothPsbt) {
    mapDiff('Global', artifactA.globalMap, artifactB.globalMap, 'global', false, diffs);
    for (let i = 0; i < Math.max(artifactA.inputMaps.length, artifactB.inputMaps.length); i++) {
      if (outpoint(artifactA.inputs[i] || { txid: null, vout: null }) !== outpoint(artifactB.inputs[i] || { txid: null, vout: null })) continue;
      const finalized = !!artifactB.inputs[i] && (artifactB.inputs[i].hasFinalScriptSig || artifactB.inputs[i].hasFinalScriptWitness);
      mapDiff(`Input ${i}`, artifactA.inputMaps[i], artifactB.inputMaps[i], 'input', finalized, diffs);
    }
    for (let i = 0; i < Math.max(artifactA.outputMaps.length, artifactB.outputMaps.length); i++) {
      mapDiff(`Output ${i}`, artifactA.outputMaps[i], artifactB.outputMaps[i], 'output', false, diffs);
    }
  } else if (artifactA.format !== artifactB.format) {
    // A PSBT and its extracted transaction: the skeleton was compared above; signatures and
    // witnesses are what extraction adds.
    push({
      id: 'diff-format',
      field: 'Artifact format',
      beforeValue: artifactA.format,
      afterValue: artifactB.format,
      severity: 'Expected',
      whyItMatters: 'Comparing a PSBT with a transaction checks the spent outpoints, sequences, outputs, version and locktime; PSBT metadata is not part of a transaction.',
      verifierConclusive: true,
      nextAction: 'Confirm the extracted transaction carries the final signatures you expect.'
    });
  } else if (artifactA.transaction && artifactB.transaction) {
    artifactA.transaction.inputs.forEach((ia, i) => {
      const ib = artifactB.transaction!.inputs[i];
      if (!ib || `${ia.txid}:${ia.vout}` !== `${ib.txid}:${ib.vout}`) return;
      if (ia.scriptSigHex !== ib.scriptSigHex || ia.witness.join() !== ib.witness.join()) {
        push({
          id: `diff-input-${i}-signatures`,
          field: `Input ${i} scriptSig or witness`,
          beforeValue: `${ia.scriptSigHex.length / 2} byte scriptSig, ${ia.witness.length} witness items`,
          afterValue: `${ib.scriptSigHex.length / 2} byte scriptSig, ${ib.witness.length} witness items`,
          severity: 'Review required',
          whyItMatters: 'Signature data differs. It does not change what is spent or paid, but it decides whether the transaction is valid.',
          verifierConclusive: false,
          nextAction: 'Validate the signatures against the prevouts with a real node before broadcasting.'
        });
      }
    });
  }

  if (feeA.fee !== null && feeB.fee !== null && feeA.fee !== feeB.fee) {
    danger('diff-fee', 'Fee', `${feeA.fee} sats`, `${feeB.fee} sats`, 'The fee paid differs.');
  }

  if (diffs.length === 0) {
    // Different bytes but no semantic difference found: never claim identity.
    push({
      id: 'diff-unexplained-bytes',
      field: 'Original bytes',
      beforeValue: `SHA-256 ${artifactA.sha256}`,
      afterValue: `SHA-256 ${artifactB.sha256}`,
      severity: 'Unknown',
      whyItMatters: 'The bytes differ but no decoded field explains the difference.',
      verifierConclusive: false,
      nextAction: 'Inspect both artifacts byte by byte before relying on either.'
    });
  }

  const hasDangerousMutations = diffs.some((d) => d.severity === 'Dangerous');
  const hasUnknownImpact = diffs.some((d) => d.severity === 'Unknown');
  let overallVerdict: ComparisonReport['overallVerdict'] = 'EXPECTED_SIGNER_ADDITIONS';
  if (hasDangerousMutations) overallVerdict = 'DANGEROUS';
  else if (hasUnknownImpact) overallVerdict = 'UNKNOWN';
  else if (diffs.some((d) => d.severity === 'Review required')) overallVerdict = 'REVIEW_REQUIRED';

  return {
    ...base,
    hasDangerousMutations,
    hasUnknownImpact,
    differences: diffs,
    overallVerdict,
    conclusive: !hasUnknownImpact,
    feeSats: { before: feeA.fee, after: feeB.fee, reason: feeA.reason || feeB.reason }
  };
}

/**
 * The purchase verifier's view of a decoded artifact: outpoints with their prevout amounts
 * and outputs. Null when any prevout amount is missing, since sat flow cannot be evaluated.
 */
export function purchaseCandidateFrom(a: ParsedArtifactResult): { transaction: { inputs: Array<{ txid: string; vout: number; valueSats: string }>; outputs: Array<{ scriptHex: string; valueSats: string }> } } | null {
  if (a.status !== 'decoded') return null;
  if (a.inputs.some((i) => i.prevoutValueSats === null || i.txid === null || i.vout === null)) return null;
  return {
    transaction: {
      inputs: a.inputs.map((i) => ({ txid: i.txid as string, vout: i.vout as number, valueSats: i.prevoutValueSats as string })),
      outputs: a.outputs.map((o) => ({ scriptHex: o.scriptHex || '', valueSats: o.valueSats || '0' }))
    }
  };
}
