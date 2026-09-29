// The transactions libbitcoinconsensus judges: every acceptance and recovery
// in conformance/offer-vectors.json whose spent outputs are all described.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseTransaction } from '../../verifier/bitcoin-tx.js';

export function scriptCorpus() {
  const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../offer-vectors.json', import.meta.url)), 'utf8'));
  const cases = [];
  for (const c of vectors.cases) {
    let txHex;
    let prevouts;
    if (c.kind === 'acceptance' && typeof c.acceptance.transactionHex === 'string') {
      txHex = c.acceptance.transactionHex;
      prevouts = c.acceptance.inputs.map((input) => ({ valueSats: input.valueSats, scriptHex: input.scriptPubKeyHex }));
    } else if (c.kind === 'recovery' && typeof c.recovery.transactionHex === 'string') {
      txHex = c.recovery.transactionHex;
      prevouts = [{ valueSats: c.offer.fundedOutput.valueSats, scriptHex: c.offer.fundedOutput.scriptPubKeyHex }];
    } else {
      continue;
    }
    const parsed = parseTransaction(txHex);
    if (!parsed.ok || parsed.tx.inputs.length !== prevouts.length) continue;
    cases.push({ name: `${c.kind}: ${c.name}`, txHex, prevouts });
  }
  return cases;
}
