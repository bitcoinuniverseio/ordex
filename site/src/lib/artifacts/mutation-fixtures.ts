/**
 * OX-S01: Wallet Mutation Lab fixtures. Artifact A is a real BIP174 test vector; artifact B
 * is A with exactly the change the title names, re-serialized through the strict parser, so
 * every B decodes and differs from A only in that field. Equal-size changes (an amount,
 * one script byte, a vout, a sequence, the locktime, a sighash) are included on purpose:
 * they keep the byte length identical and must still be reported.
 */

import { parsePsbtBytes, payloadToBytes, serializePsbt, serializeTransaction, bytesToHex, type ParsedArtifactResult } from './parser.js';
import { UPDATED_WITH_SIGHASH, SIGNED_BY_FIRST_SIGNER, COMBINED, FINALIZED, EXTRACTED_TX, UNKNOWN_FIELDS_ONE, UNKNOWN_FIELDS_COMBINED } from './bip-fixtures.js';
import type { DifferenceSeverity } from './comparison.js';

export interface MutationFixture {
  id: string;
  name: string;
  description: string;
  expectedSeverity: DifferenceSeverity;
  /** The comparison difference id this fixture must produce. */
  expectedDifferenceId: string;
  rawFixtureHexA: string;
  rawFixtureHexB: string;
}

const clone = (p: ParsedArtifactResult) => ({
  globalMap: { ...p.globalMap, entries: p.globalMap.entries.map((e) => ({ ...e, valueData: Uint8Array.from(e.valueData) })) },
  inputMaps: p.inputMaps.map((m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, valueData: Uint8Array.from(e.valueData) })) })),
  outputMaps: p.outputMaps.map((m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, valueData: Uint8Array.from(e.valueData) })) }))
});

/** Change the v0 global unsigned transaction and re-serialize the PSBT. */
function withUnsignedTx(hexA: string, edit: (tx: NonNullable<ParsedArtifactResult['transaction']>) => void): string {
  const parsed = parsePsbtBytes(payloadToBytes(hexA));
  if (parsed.status !== 'decoded' || !parsed.transaction) throw new Error('Fixture base does not decode');
  const tx = JSON.parse(JSON.stringify(parsed.transaction));
  edit(tx);
  const maps = clone(parsed);
  const entry = maps.globalMap.entries.find((e) => e.keyType === 0x00)!;
  entry.valueData = serializeTransaction(tx);
  return bytesToHex(serializePsbt(maps));
}

function withInputField(hexA: string, input: number, keyType: number, value: Uint8Array): string {
  const parsed = parsePsbtBytes(payloadToBytes(hexA));
  const maps = clone(parsed);
  const entry = maps.inputMaps[input].entries.find((e) => e.keyType === keyType);
  if (!entry) throw new Error('Fixture field missing');
  entry.valueData = value;
  return bytesToHex(serializePsbt(maps));
}

const A = UPDATED_WITH_SIGHASH;

export const MUTATION_FIXTURES: MutationFixture[] = [
  {
    id: 'mut-preserve',
    name: 'Identical bytes',
    description: 'Artifact B is exactly artifact A.',
    expectedSeverity: 'Expected',
    expectedDifferenceId: 'diff-none',
    rawFixtureHexA: A,
    rawFixtureHexB: A
  },
  {
    id: 'mut-signer-adds',
    name: 'Signer adds signatures',
    description: 'The first BIP174 signer adds partial signatures and changes nothing else.',
    expectedSeverity: 'Expected',
    expectedDifferenceId: 'Input 0-added-',
    rawFixtureHexA: A,
    rawFixtureHexB: SIGNED_BY_FIRST_SIGNER
  },
  {
    id: 'mut-finalize',
    name: 'Finalizer replaces signatures with final scripts',
    description: 'The BIP174 finalizer adds final scriptSig and witness and removes the fields they replace.',
    expectedSeverity: 'Expected',
    expectedDifferenceId: 'Input 0-added-',
    rawFixtureHexA: COMBINED,
    rawFixtureHexB: FINALIZED
  },
  {
    id: 'mut-extract',
    name: 'Extracted transaction',
    description: 'The finalized PSBT against the transaction the BIP174 extractor produces.',
    expectedSeverity: 'Expected',
    expectedDifferenceId: 'diff-format',
    rawFixtureHexA: FINALIZED,
    rawFixtureHexB: EXTRACTED_TX
  },
  {
    id: 'mut-amount-plus-one',
    name: 'Output amount raised by 1 sat',
    description: 'Output 0 pays one more sat. The byte length is unchanged.',
    expectedSeverity: 'Dangerous',
    expectedDifferenceId: 'diff-output-0-amount',
    rawFixtureHexA: A,
    rawFixtureHexB: withUnsignedTx(A, (tx) => {
      tx.outputs[0].valueSats = (BigInt(tx.outputs[0].valueSats) + 1n).toString();
    })
  },
  {
    id: 'mut-reorder-output',
    name: 'Outputs reordered',
    description: 'Outputs 0 and 1 swap places, breaking SIGHASH_SINGLE pairing.',
    expectedSeverity: 'Dangerous',
    expectedDifferenceId: 'diff-outputs-reordered',
    rawFixtureHexA: A,
    rawFixtureHexB: withUnsignedTx(A, (tx) => {
      tx.outputs.reverse();
    })
  },
  {
    id: 'mut-script-byte',
    name: 'One output script byte changed',
    description: 'The last byte of output 1 script changes, redirecting the payment.',
    expectedSeverity: 'Dangerous',
    expectedDifferenceId: 'diff-output-1-script',
    rawFixtureHexA: A,
    rawFixtureHexB: withUnsignedTx(A, (tx) => {
      const s = tx.outputs[1].scriptHex;
      tx.outputs[1].scriptHex = s.slice(0, -2) + (s.slice(-2) === 'ff' ? '00' : 'ff');
    })
  },
  {
    id: 'mut-outpoint',
    name: 'Spent outpoint changed',
    description: 'Input 1 spends output 2 instead of output 1 of the same transaction.',
    expectedSeverity: 'Dangerous',
    expectedDifferenceId: 'diff-inputs-changed',
    rawFixtureHexA: A,
    rawFixtureHexB: withUnsignedTx(A, (tx) => {
      tx.inputs[1].vout = tx.inputs[1].vout + 1;
    })
  },
  {
    id: 'mut-sequence',
    name: 'Input sequence changed',
    description: 'Input 0 signals replaceability with a different sequence.',
    expectedSeverity: 'Dangerous',
    expectedDifferenceId: 'diff-input-0-sequence',
    rawFixtureHexA: A,
    rawFixtureHexB: withUnsignedTx(A, (tx) => {
      tx.inputs[0].sequence = 0xfffffffd;
    })
  },
  {
    id: 'mut-locktime',
    name: 'Locktime changed',
    description: 'The transaction locktime moves to height 900000.',
    expectedSeverity: 'Dangerous',
    expectedDifferenceId: 'diff-locktime',
    rawFixtureHexA: A,
    rawFixtureHexB: withUnsignedTx(A, (tx) => {
      tx.locktime = 900000;
    })
  },
  {
    id: 'mut-sighash',
    name: 'Sighash downgraded',
    description: 'Input 0 sighash changes from ALL to SINGLE|ANYONECANPAY.',
    expectedSeverity: 'Dangerous',
    expectedDifferenceId: 'diff-input-0-sighash',
    rawFixtureHexA: A,
    rawFixtureHexB: withInputField(A, 0, 0x03, Uint8Array.from([0x83, 0, 0, 0]))
  },
  {
    id: 'mut-strip-unknown',
    name: 'Unknown fields stripped',
    description: 'A wallet drops unknown key-value pairs it did not recognize.',
    expectedSeverity: 'Review required',
    expectedDifferenceId: 'Input 0-removed-',
    rawFixtureHexA: UNKNOWN_FIELDS_COMBINED,
    rawFixtureHexB: UNKNOWN_FIELDS_ONE
  }
];
