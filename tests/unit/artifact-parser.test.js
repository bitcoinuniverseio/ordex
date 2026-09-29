import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  parsePsbtBytes,
  parseArtifact,
  parseRawTransaction,
  payloadToBytes,
  readCompactSize,
  serializePsbt,
  serializeTransaction,
  bytesToHex,
  determineLocktime,
  isValidPublicKey,
  MAX_PAYLOAD_BYTES
} from '../../site/src/lib/artifacts/parser.js';

// OX-S01: the normative BIP174 v1.4.4 and BIP370 test vectors, extracted from the pinned
// blobs by scripts/docs/extract-bip-psbt-vectors.mjs.
const vectors = JSON.parse(await readFile(new URL('../fixtures/psbt/bip-vectors.json', import.meta.url), 'utf8'));

test('fixtures come from the pinned specification blobs', () => {
  assert.equal(vectors.source.bip174.blob, 'ecaa5d127fdcd257dde8b119f78729841946121b');
  assert.equal(vectors.source.bip370.blob, '93b56e883a3c1a64d7a3c1da66a542d52a37ee03');
  assert.equal(vectors.bip174.invalid.length, 20);
  assert.equal(vectors.bip174.valid.length, 10);
  assert.equal(vectors.bip370.invalid.length, 24);
  assert.equal(vectors.bip370.valid.length, 13);
  assert.equal(vectors.bip370.locktime.length, 9);
});

test('readCompactSize decodes values and flags non-minimal encodings', () => {
  assert.deepEqual(readCompactSize(new Uint8Array([0x42]), 0), { value: 0x42n, bytesRead: 1, isStandardEncoding: true });
  const r = readCompactSize(new Uint8Array([0xfd, 0x00, 0x01]), 0);
  assert.equal(r.value, 256n);
  assert.equal(r.isStandardEncoding, true);
  assert.equal(readCompactSize(new Uint8Array([0xfd, 0x0a, 0x00]), 0).isStandardEncoding, false);
  assert.throws(() => readCompactSize(new Uint8Array([0xfe, 0x01]), 0), /Truncated/);
});

test('every BIP174 and BIP370 invalid vector is refused, never decoded', () => {
  for (const c of [...vectors.bip174.invalid, ...vectors.bip370.invalid]) {
    const r = parsePsbtBytes(payloadToBytes(c.hex));
    assert.notEqual(r.status, 'decoded', c.name);
    assert.ok(r.errors.length > 0, c.name);
  }
});

test('invalid vectors are refused for the rule they exercise', () => {
  const reason = (list, name) => parsePsbtBytes(payloadToBytes(list.find((c) => c.name.startsWith(name)).hex)).errors[0];
  assert.match(reason(vectors.bip174.invalid, 'PSBT with duplicate keys'), /Duplicate key/);
  assert.match(reason(vectors.bip174.invalid, 'PSBT missing outputs'), /separator/);
  assert.match(reason(vectors.bip174.invalid, 'PSBT where one input has a filled scriptSig'), /non-empty scriptSig/);
  assert.match(reason(vectors.bip174.invalid, 'PSBT where inputs and outputs are provided but without'), /requires the global unsigned transaction/);
  assert.match(reason(vectors.bip174.invalid, 'PSBT with unsigned tx serialized with witness'), /without witness data/);
  assert.match(reason(vectors.bip174.invalid, 'PSBT with invalid pubkey length'), /not a valid public key/);
  assert.match(reason(vectors.bip370.invalid, 'PSBTv2 but with PSBT_GLOBAL_UNSIGNED_TX'), /must not include the global unsigned transaction/);
  assert.match(reason(vectors.bip370.invalid, 'PSBTv0 but with PSBT_OUT_AMOUNT'), /not allowed in a version 0 PSBT/);
  assert.match(reason(vectors.bip370.invalid, 'PSBTv2 missing PSBT_IN_PREVIOUS_TXID'), /previous txid/);
  assert.match(reason(vectors.bip370.invalid, 'PSBTv2 with PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 0'), /Required Height Locktime/);
});

test('every valid vector decodes with exact map counts and re-serializes to the same bytes', () => {
  for (const c of [...vectors.bip174.valid, ...vectors.bip174.parsesButFailsSigner, ...vectors.bip370.valid, ...vectors.bip174.roleSequence]) {
    const r = parsePsbtBytes(payloadToBytes(c.hex));
    assert.equal(r.status, 'decoded', `${c.name || c.step}: ${r.errors[0]}`);
    assert.equal(r.inputMaps.length, r.inputsCount);
    assert.equal(r.outputMaps.length, r.outputsCount);
    assert.equal(bytesToHex(serializePsbt(r)), c.hex, `${c.name || c.step} does not round trip`);
    assert.equal(r.sha256, createHash('sha256').update(Buffer.from(c.hex, 'hex')).digest('hex'));
  }
});

test('a one-input one-output v0 PSBT reports 1/1 and v2 reports version 2', () => {
  const unknown = vectors.bip174.valid.find((c) => c.name.startsWith('PSBT with unknown types in the inputs'));
  const r = parsePsbtBytes(payloadToBytes(unknown.hex));
  assert.equal(r.format, 'PSBT_V0');
  assert.equal(r.inputsCount, 1);
  assert.equal(r.outputsCount, 1);
  assert.ok(r.hasUnknownFields);
  const v2 = parsePsbtBytes(payloadToBytes(vectors.bip370.valid[0].hex));
  assert.equal(v2.format, 'PSBT_V2');
  assert.equal(v2.psbtVersion, 2);
  assert.equal(v2.inputsCount, 1);
  assert.equal(v2.outputsCount, 2);
  assert.equal(v2.version, 2);
  assert.match(v2.inputs[0].txid, /^[0-9a-f]{64}$/);
  assert.match(v2.outputs[0].valueSats, /^\d+$/);
});

test('zero-input and empty unsigned transactions are valid PSBTs', () => {
  for (const name of ['PSBT with global unsigned tx that has 0 inputs and 0 outputs', 'PSBT with 0 inputs']) {
    const c = vectors.bip174.valid.find((v) => v.name === name);
    const r = parsePsbtBytes(payloadToBytes(c.hex));
    assert.equal(r.status, 'decoded', name);
    assert.equal(r.inputsCount, 0);
  }
});

test('BIP370 locktime determination matches every vector, including the undeterminable case', () => {
  for (const c of vectors.bip370.locktime) {
    const r = parsePsbtBytes(payloadToBytes(c.hex));
    assert.equal(r.status, 'decoded', c.name);
    assert.equal(r.locktime, c.locktime, c.name);
  }
  assert.equal(determineLocktime(null, []), 0);
  assert.equal(determineLocktime(77, []), 77);
});

test('prevout amounts come from witness or non-witness UTXOs checked against the spent txid', () => {
  const updated = vectors.bip174.roleSequence[2];
  const r = parsePsbtBytes(payloadToBytes(updated.hex));
  assert.equal(r.inputs.length, 2);
  for (const input of r.inputs) assert.match(input.prevoutValueSats, /^\d+$/);
  assert.equal(r.inputs[0].sighashType, 1);
});

test('raw transactions decode, compute txid, and round trip in legacy and SegWit form', () => {
  const legacyHex = vectors.bip174.invalid[0].hex; // "Network transaction, not PSBT format"
  const legacy = parseRawTransaction(payloadToBytes(legacyHex));
  assert.equal(legacy.status, 'decoded');
  assert.equal(legacy.transaction.segwit, false);
  assert.equal(bytesToHex(serializeTransaction(legacy.transaction)), legacyHex);
  // The BIP174 valid P2PKH vector spends this exact transaction, so its txid is independently known.
  assert.equal(legacy.transaction.txid, 'e47b5b7a879f13a8213815cf3dc3f5b35af1e217f412829bc4f75a8ca04909ab');
  const segwit = parseRawTransaction(payloadToBytes(vectors.bip174.extractedTransaction));
  assert.equal(segwit.status, 'decoded');
  assert.equal(segwit.transaction.segwit, true);
  assert.equal(bytesToHex(serializeTransaction(segwit.transaction)), vectors.bip174.extractedTransaction);
  // The extracted transaction spends and pays exactly what the finalized PSBT describes.
  const finalized = parsePsbtBytes(payloadToBytes(vectors.bip174.roleSequence[6].hex));
  assert.deepEqual(segwit.transaction.inputs.map((i) => `${i.txid}:${i.vout}:${i.sequence}`), finalized.transaction.inputs.map((i) => `${i.txid}:${i.vout}:${i.sequence}`));
  assert.deepEqual(segwit.transaction.outputs, finalized.transaction.outputs);
  assert.notEqual(segwit.transaction.wtxid, segwit.transaction.txid);
});

test('malformed raw transactions are malformed, not decoded', () => {
  const hex = vectors.bip174.extractedTransaction;
  assert.equal(parseRawTransaction(payloadToBytes(hex.slice(0, -2))).status, 'malformed');
  assert.equal(parseRawTransaction(payloadToBytes(`${hex}00`)).status, 'malformed');
  const noWitness = parseRawTransaction(payloadToBytes('0200000000010000000000'));
  assert.equal(noWitness.status, 'malformed');
});

test('parseArtifact routes PSBTs and transactions and never calls garbage decoded', () => {
  assert.equal(parseArtifact(vectors.bip174.roleSequence[0].hex).format, 'PSBT_V0');
  const b64 = Buffer.from(vectors.bip174.roleSequence[0].hex, 'hex').toString('base64');
  assert.equal(parseArtifact(b64).status, 'decoded');
  assert.equal(parseArtifact(vectors.bip174.extractedTransaction).format, 'RAW_BITCOIN_TX');
  const junk = parseArtifact('deadbeef');
  assert.equal(junk.status, 'malformed');
  assert.match(junk.errors[0], /Not a PSBT/);
  assert.equal(parseArtifact('xyz!').status, 'malformed');
  assert.equal(parseArtifact('abc').status, 'malformed');
});

test('an unsupported PSBT version is unsupported, not decoded', () => {
  const r = parsePsbtBytes(payloadToBytes('70736274ff01fb040100000000'));
  assert.equal(r.status, 'unsupported');
});

test('key types above 0xfc use a CompactSize key type and are kept as unknown bytes', () => {
  // A v0 PSBT with no inputs or outputs and one global key of type 0xfd00 01 (encoded fd 00 01).
  const unsignedTx = '0a' + '02000000' + '00' + '00' + '00000000';
  const unknownKey = '03' + 'fd0001' + '02' + 'beef';
  const hex = `70736274ff0100${unsignedTx}${unknownKey}00`;
  const r = parsePsbtBytes(payloadToBytes(hex));
  assert.equal(r.status, 'decoded', r.errors[0]);
  const entry = r.globalMap.entries.find((e) => e.keyType === 0x100);
  assert.ok(entry);
  assert.equal(entry.isUnknown, true);
  assert.equal(bytesToHex(serializePsbt(r)), hex);
  // A non-minimal key type encoding is refused.
  const bad = `70736274ff0100${unsignedTx}03fd100002beef00`;
  assert.equal(parsePsbtBytes(payloadToBytes(bad)).status, 'malformed');
});

test('the two MiB bound is enforced before allocation and on decoded bytes', () => {
  assert.throws(() => payloadToBytes('00'.repeat(MAX_PAYLOAD_BYTES + 1)), /exceeds/);
  const big = new Uint8Array(MAX_PAYLOAD_BYTES + 1);
  big.set([0x70, 0x73, 0x62, 0x74, 0xff]);
  assert.match(parsePsbtBytes(big).errors[0], /exceeds/);
});

test('public key validation checks the curve, not only the length', () => {
  const g = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
  assert.equal(isValidPublicKey(g), true);
  const offCurve = Buffer.from(g);
  offCurve[32] ^= 0x01;
  assert.equal(isValidPublicKey(Buffer.from('02' + '00'.repeat(32), 'hex')), false);
  assert.equal(isValidPublicKey(Buffer.from('05' + g.subarray(1).toString('hex'), 'hex')), false);
  assert.equal(typeof isValidPublicKey(offCurve), 'boolean');
});
