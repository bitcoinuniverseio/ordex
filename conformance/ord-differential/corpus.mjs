// Seeded random corpus for the ord 0.29.0 rune differential. The same seed
// always yields the same cases, so run.mjs can record ord's answers once and
// the verifier and SDK tests can replay them without a Rust toolchain.

const SPEND = ['0014' + '11'.repeat(20), '5120' + '22'.repeat(32), '51'];
const DATA = ['6a', '6a0401020304', '6a5d'];

const INTERESTING = [
  0n, 1n, 2n, 3n, 4n, 5n, 7n, 8n, 20n, 22n, 38n, 39n, 97n, 126n, 127n, 128n,
  0xd800n, 0x10ffffn, 0x110000n, 0x07ff_ffffn, 0x0800_0000n,
  (1n << 32n) - 1n, 1n << 32n, (1n << 64n) - 1n, 1n << 64n, 1n << 127n, (1n << 128n) - 1n,
  840000n,
];
const TAGS = [0n, 1n, 2n, 3n, 4n, 5n, 6n, 8n, 10n, 12n, 14n, 16n, 18n, 20n, 22n, 24n, 126n, 127n];

function generator(seed) {
  let state = seed >>> 0;
  return (n) => {
    // xorshift32: deterministic on every platform.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % n;
  };
}

function varint(value) {
  let n = value;
  const bytes = [];
  while (n >> 7n > 0n) {
    bytes.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return bytes;
}

const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

function pushes(payload, next) {
  // Split the payload into one to three pushes, sometimes non-minimal.
  const out = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const size = Math.min(payload.length - cursor, 1 + next(40));
    const chunk = payload.slice(cursor, cursor + size);
    if (next(5) === 0) out.push(0x4c, chunk.length, ...chunk);
    else out.push(chunk.length, ...chunk);
    cursor += size;
  }
  return out;
}

export function differentialCorpus(count = 1500, seed = 0x0d1ce5) {
  const next = generator(seed);
  const cases = [];
  for (let index = 0; index < count; index += 1) {
    const integers = [];
    const pairs = next(7);
    for (let i = 0; i < pairs; i += 1) {
      integers.push(TAGS[next(TAGS.length)]);
      integers.push(next(3) === 0 ? BigInt(next(5)) : INTERESTING[next(INTERESTING.length)]);
    }
    if (next(2) === 0) {
      integers.push(0n);
      const edicts = next(4);
      for (let i = 0; i < edicts; i += 1) {
        integers.push(next(3) === 0 ? 0n : [840000n, 1n, 2n][next(3)]);
        integers.push(BigInt(next(4)));
        integers.push(next(3) === 0 ? 0n : BigInt(1 + next(1500)));
        integers.push(BigInt(next(5)));
      }
      if (next(6) === 0) integers.push(BigInt(next(3)));
    }
    let payload = integers.flatMap(varint);
    if (next(12) === 0) payload = payload.concat([0x80]);
    let body = pushes(payload, next);
    if (next(15) === 0) body = body.concat([[0x4f, 0x51, 0x04, 0x4c][next(4)]]);
    // One case in ten carries no runestone at all.
    const runestone = next(10) === 0 ? DATA[next(2)] : '6a5d' + hex(body);

    const outputs = [];
    const extra = next(4);
    const position = next(extra + 1);
    for (let i = 0; i <= extra; i += 1) {
      if (i === position) outputs.push(runestone);
      else outputs.push(next(3) === 0 ? DATA[next(DATA.length)] : SPEND[next(SPEND.length)]);
    }

    const balances = [];
    for (const id of ['840000:1', '840000:2', '840000:4', '840001:0']) {
      if (next(2) === 0) balances.push({ runeId: id, amount: String(next(3) === 0 ? 1 : 1 + next(5000)) });
    }
    cases.push({
      name: `random-${index}`,
      outputScriptsHex: outputs,
      inputs: [{ indexed: true, balances }],
    });
  }
  return cases;
}
