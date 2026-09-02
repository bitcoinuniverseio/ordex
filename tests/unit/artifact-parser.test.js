import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePsbtBytes, payloadToBytes, readCompactSize } from '../../site/src/lib/artifacts/parser.js';
import { compareParsedArtifacts, MUTATION_FIXTURES } from '../../site/src/lib/artifacts/comparison.js';

test('artifact parser: readCompactSize decodes standard and flags overlong encodings', () => {
  // Standard single byte
  const buf1 = new Uint8Array([0x42]);
  const res1 = readCompactSize(buf1, 0);
  assert.equal(res1.value, 0x42n);
  assert.equal(res1.bytesRead, 1);
  assert.ok(res1.isStandardEncoding);

  // 16-bit compact size (0xfd followed by 2 bytes)
  const buf2 = new Uint8Array([0xfd, 0x00, 0x01]);
  const res2 = readCompactSize(buf2, 0);
  assert.equal(res2.value, 256n);
  assert.equal(res2.bytesRead, 3);
  assert.ok(res2.isStandardEncoding);

  // Overlong 16-bit encoding of value 10
  const bufOverlong = new Uint8Array([0xfd, 0x0a, 0x00]);
  const resOverlong = readCompactSize(bufOverlong, 0);
  assert.equal(resOverlong.value, 10n);
  assert.equal(resOverlong.isStandardEncoding, false);
});

test('artifact parser: parsePsbtBytes validates magic and preserves unknown fields', () => {
  // Valid magic with one dummy map
  const validHex = '70736274ff01fc046f7264780000';
  const bytes = payloadToBytes(validHex);
  const result = parsePsbtBytes(bytes);

  assert.ok(result.magicValid);
  assert.equal(result.totalByteLength, bytes.length);
  assert.ok(result.hasUnknownFields);
  assert.equal(result.globalMap.unknownEntries.length, 1);
  assert.equal(result.globalMap.unknownEntries[0].isProprietary, true);
});

test('artifact comparison: detects dangerous mutations and classified differences', () => {
  const fixA = MUTATION_FIXTURES.find(f => f.id === 'mut-reorder-output');
  assert.ok(fixA);

  const bytesA = payloadToBytes(fixA.rawFixtureHexA);
  const parsedA = parsePsbtBytes(bytesA);

  const bytesB = payloadToBytes(fixA.rawFixtureHexB);
  const parsedB = parsePsbtBytes(bytesB);

  const report = compareParsedArtifacts(parsedA, parsedB);
  assert.ok(report.hasDangerousMutations);
  assert.equal(report.overallVerdict, 'DANGEROUS');
});
