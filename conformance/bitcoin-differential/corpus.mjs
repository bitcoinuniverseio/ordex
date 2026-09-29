// Seeded random transactions for the sighash differential. The same seed
// always yields the same cases, so run.mjs records rust-bitcoin's answers once
// and verifier/bitcoin-tx.differential.test.js replays them without Rust.

import { serializeTransaction, bytesToHex } from '../../verifier/bitcoin-tx.js';

function generator(seed) {
  let state = seed >>> 0;
  return (n) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % n;
  };
}

export function sighashCorpus(count = 120, seed = 0x5eed143) {
  const next = generator(seed);
  const bytes = (n) => Array.from({ length: n }, () => next(256).toString(16).padStart(2, '0')).join('');
  const script = () => {
    switch (next(6)) {
      case 0:
        return `0014${bytes(20)}`;
      case 1:
        return `5120${bytes(32)}`;
      case 2:
        return `76a914${bytes(20)}88ac`;
      case 3:
        return `a914${bytes(20)}87`;
      case 4:
        return `0020${bytes(32)}`;
      default:
        return `6a04${bytes(4)}`;
    }
  };
  const u32 = () => (next(0x10000) * 0x10000 + next(0x10000)) >>> 0;
  const cases = [];
  for (let c = 0; c < count; c += 1) {
    const inputCount = 1 + next(4);
    const outputCount = 1 + next(4);
    const tx = {
      version: [1, 2, 3, u32()][next(4)],
      lockTime: next(3) === 0 ? 0 : u32(),
      inputs: Array.from({ length: inputCount }, () => ({
        txid: bytes(32),
        vout: next(5),
        scriptSigHex: '',
        sequence: [0xffffffff, 0xfffffffd, 0, u32()][next(4)],
        witness: [],
      })),
      outputs: Array.from({ length: outputCount }, () => ({
        valueSats: String(next(0x100000) * 1000 + next(1000)),
        scriptHex: script(),
      })),
    };
    const prevouts = tx.inputs.map(() => ({ valueSats: String(next(0x100000) * 100 + next(100)), scriptHex: script() }));
    cases.push({
      name: `sighash-${c}`,
      txHex: bytesToHex(serializeTransaction(tx)),
      prevouts,
      ...(next(4) === 0 ? { annexHex: `50${bytes(next(8))}` } : {}),
      ...(next(2) === 0 ? { leafHashHex: bytes(32) } : {}),
    });
  }
  return cases;
}
