// OX-S09: hand-built reproducers for refusal branches the single-mutation search cannot reach
// (branches behind digests, signatures or transaction bytes, and verifier entry points with no
// checked-in vector of their own). Each builder starts from a checked-in conformance case and
// returns a JSON Patch computed with the verifiers' own helpers and the deterministic test
// signer (scripts/vector-signer.mjs, test keys only). Every result is run through the real
// verifier and kept only when it returns exactly the code; the entries are written into
// site/src/lib/diagnostics/reproducers.json as derivation "authored", where
// scripts/docs/discover-reproducers.mjs keeps them while they still reproduce.
//
//   node scripts/docs/author-reproducers.mjs

import fs from 'node:fs';
import { allCases, runCase, REPRODUCERS_PATH } from './discover-reproducers.mjs';
import { applyPatch } from '../../site/src/lib/diagnostics/patch.mjs';
import { bytesToHex, parseTransaction, serializeTransaction } from '../../verifier/bitcoin-tx.js';
import { safeopsPlanDigest } from '../../verifier/safeops.js';
import { expectedTransactionDigest } from '../../verifier/offline-signing.js';
import { swapAcceptanceDigest, swapIntentDigest, swapUnsignedTransaction, SWAP_SIGNED_TRANSACTION_SCHEMA } from '../../verifier/swaps.js';
import { p2trKeyPath, p2wpkhScript, signP2wpkh, signTaprootKeyPath, testKey } from '../vector-signer.mjs';

const P2WSH = `0020${'11'.repeat(32)}`;
const cases = allCases();
const accepted = (family, variant) => cases.filter((c) => c.family === family && c.variant === variant && c.case.expected?.ok === true);
const replace = (path, value) => ({ op: 'replace', path, value });
const add = (path, value) => ({ op: 'add', path, value });
const editTx = (hex, fn) => {
  const parsed = parseTransaction(hex);
  if (!parsed.ok) return null;
  const tx = structuredClone(parsed.tx);
  if (fn(tx) === false) return null;
  return bytesToHex(serializeTransaction(tx));
};

// Swap settlements, signed the way tests/verifier/swaps.consideration.test.js does.
const MAKER_KEY = testKey('swap-maker');
const TAKER_KEY = testKey('swap-taker');
const SWAP_KEYS = { [p2trKeyPath(MAKER_KEY).scriptHex]: MAKER_KEY, [p2wpkhScript(TAKER_KEY)]: TAKER_KEY };
function settle(acceptance, { skip = [], tamper } = {}) {
  const tx = swapUnsignedTransaction(acceptance);
  const prevouts = acceptance.tx.inputs.map((input) => ({ valueSats: input.valueSats, scriptHex: input.scriptPubKeyHex }));
  tx.inputs.forEach((input, i) => {
    if (skip.includes(i)) return;
    const script = prevouts[i].scriptHex;
    if (!SWAP_KEYS[script]) {
      input.witness = [`${'22'.repeat(71)}`, `02${'33'.repeat(32)}`];
      return;
    }
    input.witness = script.startsWith('5120') ? [signTaprootKeyPath(tx, i, prevouts, SWAP_KEYS[script], 0x00)] : signP2wpkh(tx, i, prevouts, SWAP_KEYS[script], 0x01);
  });
  if (tamper) tamper(tx);
  return { schema: SWAP_SIGNED_TRANSACTION_SCHEMA, acceptanceDigest: acceptance.digest, signedTxHex: bytesToHex(serializeTransaction(tx)) };
}
const settledSwaps = () => accepted('swaps', 'acceptance').filter((c) => Object.values(c.case.acceptance.tx.inputs).every((i) => SWAP_KEYS[i.scriptPubKeyHex]));

/** [code, coveredSiteFamily, family, variant, note, (case) => patch | null, bases?] */
export const BUILDERS = [
  // SafeOps signed results: the transaction bytes differ from the plan before any signature check.
  ['INPUT_SET_CHANGED', 'safeops', 'safeops', 'signed', 'The signed transaction drops the last planned input.', (c) => {
    const hex = editTx(c.signed.signedTxHex, (tx) => void tx.inputs.pop());
    return hex && [replace('/signed/signedTxHex', hex)];
  }],
  ['INPUT_ORDER_CHANGED', 'safeops', 'safeops', 'signed', 'The signed transaction swaps the first two inputs.', (c) => {
    const hex = editTx(c.signed.signedTxHex, (tx) => (tx.inputs.length < 2 ? false : void ([tx.inputs[0], tx.inputs[1]] = [tx.inputs[1], tx.inputs[0]])));
    return hex && [replace('/signed/signedTxHex', hex)];
  }],
  ['OUTPUT_SET_CHANGED', 'safeops', 'safeops', 'signed', 'The signed transaction adds an output the plan does not have.', (c) => {
    const hex = editTx(c.signed.signedTxHex, (tx) => void tx.outputs.push({ ...tx.outputs[0] }));
    return hex && [replace('/signed/signedTxHex', hex)];
  }],
  ['VALUE_CHANGED', 'safeops', 'safeops', 'signed', 'The signed transaction pays one sat more on output 0.', (c) => {
    const hex = editTx(c.signed.signedTxHex, (tx) => void (tx.outputs[0].valueSats = String(BigInt(tx.outputs[0].valueSats) + 1n)));
    return hex && [replace('/signed/signedTxHex', hex)];
  }],
  ['SIGNATURE_UNVERIFIABLE', 'safeops', 'safeops', 'signed', 'Input 0 of the plan is a P2WSH output, a script this verifier does not execute.', (c) => {
    const plan = structuredClone(c.plan);
    plan.inputs[0].scriptPubKeyHex = P2WSH;
    const digest = safeopsPlanDigest(plan);
    return [replace('/plan/inputs/0/scriptPubKeyHex', P2WSH), replace('/plan/digest', digest), replace('/signed/planDigest', digest)];
  }],

  // Offline signing: the same byte-level differences, and an unverifiable script.
  ['INPUT_SET_CHANGED', 'offline-signing', 'offline-signing', 'signed', 'The signed transaction drops the last input the manifest presented.', (c) => {
    const hex = editTx(c.signed.signedTxHex, (tx) => void tx.inputs.pop());
    return hex && [replace('/signed/signedTxHex', hex)];
  }],
  ['VALUE_CHANGED', 'offline-signing', 'offline-signing', 'signed', 'The signed transaction pays one sat more on output 0.', (c) => {
    const hex = editTx(c.signed.signedTxHex, (tx) => void (tx.outputs[0].valueSats = String(BigInt(tx.outputs[0].valueSats) + 1n)));
    return hex && [replace('/signed/signedTxHex', hex)];
  }],
  ['SIGNATURE_UNVERIFIABLE', 'offline-signing', 'offline-signing', 'signed', 'Input 0 of the manifest is a P2WSH output, a script this verifier does not execute.', (c) => {
    const manifest = structuredClone(c.manifest);
    manifest.unsignedTx.inputs[0].scriptPubKeyHex = P2WSH;
    const digest = expectedTransactionDigest(manifest);
    return [replace('/manifest/unsignedTx/inputs/0/scriptPubKeyHex', P2WSH), replace('/manifest/digest', digest), replace('/signed/manifestDigest', digest)];
  }],

  // Swap settlements (verifySwapSignedTransaction), built from accepted acceptance plans.
  ['MALFORMED_SIGNED_RESULT', 'swaps', 'swaps', 'signed', 'The settlement is a list, not a signed settlement object.', () => [add('/signed', [])], settledSwaps],
  ['ACCEPTANCE_DIGEST_MISMATCH', 'swaps', 'swaps', 'signed', 'The settlement names another acceptance plan digest.', (c) => [add('/signed', { ...settle(c.acceptance), acceptanceDigest: '0'.repeat(64) })], settledSwaps],
  ['TRANSACTION_CHANGED', 'swaps', 'swaps', 'signed', 'The signed settlement pays one sat less on its last output.', (c) => [add('/signed', settle(c.acceptance, { tamper: (tx) => (tx.outputs.at(-1).valueSats = String(BigInt(tx.outputs.at(-1).valueSats) - 1n)) }))], settledSwaps],
  ['SIGNATURE_MISSING', 'swaps', 'swaps', 'signed', 'Input 1 is left unsigned.', (c) => [add('/signed', settle(c.acceptance, { skip: [1] }))], settledSwaps],
  ['SIGNATURE_INVALID', 'swaps', 'swaps', 'signed', 'Input 0 carries a signature over other data.', (c) => [add('/signed', settle(c.acceptance, { tamper: (tx) => (tx.inputs[0].witness = ['11'.repeat(64)]) }))], settledSwaps],
  ['SIGNATURE_UNVERIFIABLE', 'swaps', 'swaps', 'signed', 'A taker input is a P2WSH output, a script this verifier does not execute.', (c) => {
    const acceptance = structuredClone(c.acceptance);
    const i = acceptance.tx.inputs.findIndex((x) => x.party === 'taker');
    if (i < 0) return null;
    acceptance.tx.inputs[i].scriptPubKeyHex = P2WSH;
    acceptance.digest = swapAcceptanceDigest(acceptance);
    return [replace(`/acceptance/tx/inputs/${i}/scriptPubKeyHex`, P2WSH), replace('/acceptance/digest', acceptance.digest), add('/signed', settle(acceptance))];
  }, settledSwaps],

  // Rune allocation (verifyRuneAllocation), from checked-in rune cases.
  ['MALFORMED_RUNE_EXPECTATION', 'runes', 'runes', 'allocation', 'The expected allocation is a string, not a list.', () => [add('/expectedAllocation', 'all to output 0')], () => cases.filter((c) => c.family === 'runes' && c.case.expected?.safe === true)],
  ['RUNE_INPUT_UNPROVEN', 'runes', 'runes', 'allocation', 'Input 0 was not examined by the rune index.', (c) => (c.inputs.length ? [add('/expectedAllocation', []), replace('/inputs/0/indexed', false)] : null), () => cases.filter((c) => c.family === 'runes' && c.case.expected?.safe === true)],

  // Offer acceptances and recoveries: edits of the transaction bytes and descriptions.
  ['PARTY_SCRIPTS_OVERLAP', 'offers', 'offers', 'acceptance', 'The seller payment script is the buyer receive script.', (c) => [replace('/acceptance/seller/paymentScriptHex', c.offer.terms.buyerReceiveScriptHex)]],
  ['INPUT_DUPLICATED', 'offers', 'offers', 'acceptance', 'The first seller input is spent twice.', (c) => {
    const hex = editTx(c.acceptance.transactionHex, (tx) => void tx.inputs.splice(1, 0, structuredClone(tx.inputs[0])));
    return hex && [replace('/acceptance/transactionHex', hex), add('/acceptance/inputs/1', c.acceptance.inputs[0])];
  }],
  ['DUST_OUTPUT', 'offers', 'offers', 'acceptance', 'Output 0 carries one sat, below the dust threshold for its script.', (c) => {
    const hex = editTx(c.acceptance.transactionHex, (tx) => void (tx.outputs[0].valueSats = '1'));
    return hex && [replace('/acceptance/transactionHex', hex)];
  }],
  ['BUYER_ASSET_OUTPUT_MISSING', 'offers', 'offers', 'acceptance', 'The asset output meant for the buyer pays the seller instead.', (c) => {
    const buyer = c.offer.terms.buyerReceiveScriptHex;
    const hex = editTx(c.acceptance.transactionHex, (tx) => {
      const j = tx.outputs.findIndex((o) => o.scriptHex === buyer);
      if (j < 0) return false;
      tx.outputs[j].scriptHex = c.acceptance.seller.paymentScriptHex;
    });
    return hex && [replace('/acceptance/transactionHex', hex)];
  }],
  ['SELLER_OUTPUT_MISSING', 'offers', 'offers', 'acceptance', 'The transaction ends after the asset outputs, with no seller payment.', (c) => {
    const parsed = parseTransaction(c.acceptance.transactionHex);
    for (let keep = parsed.tx.outputs.length - 1; keep >= 1; keep -= 1) {
      const hex = editTx(c.acceptance.transactionHex, (tx) => void (tx.outputs = tx.outputs.slice(0, keep)));
      const patch = [replace('/acceptance/transactionHex', hex)];
      if (runCase('offers', 'acceptance', applyPatch(c, patch)).code === 'SELLER_OUTPUT_MISSING') return patch;
    }
    return null;
  }],
  ['POLICY_WITNESS_INVALID', 'offers', 'offers', 'acceptance', 'The offer input witness has one element instead of four.', (c) => {
    const hex = editTx(c.acceptance.transactionHex, (tx) => void (tx.inputs.at(-1).witness = [tx.inputs.at(-1).witness[0] || '00']));
    return hex && [replace('/acceptance/transactionHex', hex)];
  }],
  ['DUST_OUTPUT', 'offers', 'offers', 'recovery', 'The recovery pays one sat, below the dust threshold for its script.', (c) => {
    const hex = editTx(c.recovery.transactionHex, (tx) => void (tx.outputs[0].valueSats = '1'));
    return hex && [replace('/recovery/transactionHex', hex)];
  }],
  ['RECOVERY_WITNESS_INVALID', 'offers', 'offers', 'recovery', 'The recovery witness has two elements instead of three.', (c) => {
    const hex = editTx(c.recovery.transactionHex, (tx) => void (tx.inputs[0].witness = tx.inputs[0].witness.slice(0, 2)));
    return hex && [replace('/recovery/transactionHex', hex)];
  }],

  // Swap acceptance plans.
  ['MAKER_OUTPOINT_REASSIGNED', 'swaps', 'swaps', 'acceptance', 'The input spending the maker commitment is attributed to the taker.', (c) => {
    const g = c.intent.gives[0].outpoint;
    const i = c.acceptance.tx.inputs.findIndex((x) => x.outpoint.txid === g.txid && x.outpoint.vout === g.vout);
    return i < 0 ? null : [replace(`/acceptance/tx/inputs/${i}/party`, 'taker')];
  }],
  ['DATA_OUTPUT_NONSTANDARD', 'swaps', 'swaps', 'acceptance', 'The runestone output is 84 bytes, over the 83 byte relay limit.', (c) => {
    const j = c.acceptance.tx.outputs.findIndex((o) => o.scriptHex.startsWith('6a5d'));
    return j < 0 ? null : [replace(`/acceptance/tx/outputs/${j}/scriptHex`, `6a5d4c50${'00'.repeat(80)}`)];
  }],
  ['ASSET_OUTPUT_MIXED', 'swaps', 'swaps', 'acceptance', "The taker's own inscription lands on the output that receives the maker's inscription.", (c) => {
    const a = c.acceptance;
    const makerIn = a.tx.inputs.findIndex((x) => x.party === 'maker' && x.inventory?.inscriptions?.length);
    const takerIn = a.tx.inputs.findIndex((x) => x.party === 'taker');
    if (makerIn !== 0 || takerIn !== 1 || a.tx.outputs[0].scriptHex !== a.taker.receiveScriptHex || !a.taker.changeScriptHex) return null;
    const change = a.tx.outputs.findIndex((o, j) => j > 0 && o.scriptHex === a.taker.changeScriptHex);
    if (change < 0) return null;
    const id = `${'f'.repeat(64)}i0`;
    return [
      replace('/acceptance/tx/outputs/0/valueSats', String(BigInt(a.tx.outputs[0].valueSats) + 100n)),
      replace(`/acceptance/tx/outputs/${change}/valueSats`, String(BigInt(a.tx.outputs[change].valueSats) - 100n)),
      add('/acceptance/tx/inputs/1/inventory/inscriptions', [{ inscriptionId: id, offset: '0' }]),
      add('/acceptance/assetTransitions/-', { assetType: 'ORDINAL', assetId: id, fromInput: 1, toOutput: 0, quantity: '1' })
    ];
  }],
  ['GIVE_QUANTITY_MISMATCH', 'swaps', 'swaps', 'acceptance', 'The intent gives 1 unit of a Counterparty asset, but the committed outpoint holds 2 and Counterparty moves them all.', (c) => {
    const give = c.intent.gives[0];
    if (give.assetType !== 'ORDINAL') return null;
    const i = c.acceptance.tx.inputs.findIndex((x) => x.outpoint.txid === give.outpoint.txid && x.outpoint.vout === give.outpoint.vout);
    if (i < 0) return null;
    const intent = structuredClone(c.intent);
    intent.gives[0] = { assetType: 'COUNTERPARTY', assetId: '137', outpoint: give.outpoint, quantitySats: '1' };
    intent.adapterVersions = [...intent.adapterVersions, { protocol: 'counterparty', version: '1.2' }];
    intent.digest = swapIntentDigest(intent);
    const moved = c.acceptance.assetTransitions.findIndex((t) => t.assetId === give.assetId);
    return [
      replace('/intent/gives/0', intent.gives[0]),
      replace('/intent/adapterVersions', intent.adapterVersions),
      replace('/intent/digest', intent.digest),
      replace('/acceptance/intentDigest', intent.digest),
      replace(`/acceptance/tx/inputs/${i}/inventory`, { examined: true, counterpartyAssets: [{ name: 'RAREPEPE', assetId: '137', quantitySats: '2' }] }),
      replace(`/acceptance/assetTransitions/${moved}`, { assetType: 'COUNTERPARTY', assetId: '137', fromInput: i, toOutput: 0, quantity: '2' })
    ];
  }],

  // SafeOps plans (and the shared asset flow they run).
  ['DATA_OUTPUT_NONSTANDARD', 'safeops', 'safeops', 'plan', 'The runestone output is 84 bytes, over the 83 byte relay limit.', (c) => {
    const j = c.plan.outputs.findIndex((o) => o.role === 'data');
    if (j < 0) return null;
    const plan = structuredClone(c.plan);
    plan.outputs[j].scriptHex = `6a5d4c50${'00'.repeat(80)}`;
    return [replace(`/plan/outputs/${j}/scriptHex`, plan.outputs[j].scriptHex), replace('/plan/digest', safeopsPlanDigest(plan))];
  }],
  ['RUNE_MINT_UNRESOLVED', 'asset-flow', 'safeops', 'plan', 'The runestone also mints the rune the inputs carry, and no mint result is supplied.', (c) => {
    const j = c.plan.outputs.findIndex((o) => o.role === 'data');
    if (j !== 0 || !c.plan.inputs.some((i) => i.inventory?.runeAllocations?.some((r) => r.runeId === '840000:1'))) return null;
    const plan = structuredClone(c.plan);
    plan.outputs[0].scriptHex = '6a5d1014c0a2331401160000c0a23301f40301';
    return [replace('/plan/outputs/0/scriptHex', plan.outputs[0].scriptHex), replace('/plan/digest', safeopsPlanDigest(plan))];
  }],

  ['COUNTERPARTY_NOT_MOVED', 'asset-flow', 'safeops', 'plan', 'Every output is the zero-value runestone (a zero-amount rune allocation makes it permitted) and the whole input value is the fee, so Counterparty finds no destination and detaches the attachment.', (c) => {
    if (!c.plan.inputs.some((i) => i.inventory?.counterpartyAssets?.length)) return null;
    const plan = structuredClone(c.plan);
    const total = plan.inputs.reduce((n, i) => n + BigInt(i.valueSats), 0n);
    plan.inputs.forEach((i) => (i.inventory.runeAllocations = [{ runeId: '840000:1', amount: '0' }]));
    plan.outputs = [{ scriptHex: '6a5d00', valueSats: '0', role: 'data' }];
    plan.fee = { ...plan.fee, feeSats: String(total), maxFeeSats: String(total) };
    plan.assetTransitions = [];
    plan.digest = safeopsPlanDigest(plan);
    return [replace('/plan', plan)];
  }],

  // Offline signing: a PSBT whose inputs force both locktime kinds, and a forged foreign signature.
  ['LOCKTIME_UNDETERMINED', 'offline-signing', 'offline-signing', 'signed', 'A PSBT v2 whose first input requires a time locktime and second a height locktime.', (c) => {
    const inputs = c.manifest.unsignedTx.inputs;
    if (inputs.length < 2) return null;
    return [replace('/signed', { schema: c.signed.schema, manifestDigest: c.signed.manifestDigest, psbt: psbtV2BothLocktimes(c.manifest.unsignedTx) })];
  }],
  ['FOREIGN_SIGNATURE_INVALID', 'offline-signing', 'offline-signing', 'signed', "The other party's preserved signature is presented with one byte changed, identically in the manifest and the PSBT.", (c) => {
    const i = c.manifest.unsignedTx.inputs.findIndex((x) => x.preservedSignature?.witness?.length);
    if (i < 0 || c.signed.psbt === undefined) return null;
    const sig = c.manifest.unsignedTx.inputs[i].preservedSignature.witness[0];
    const forged = `${sig.slice(0, 2) === '00' ? '01' : '00'}${sig.slice(2)}`;
    const raw = Buffer.from(c.signed.psbt, /^[0-9a-f]+$/.test(c.signed.psbt) ? 'hex' : 'base64');
    const at = raw.indexOf(Buffer.from(sig, 'hex'));
    if (at < 0) return null;
    Buffer.from(forged, 'hex').copy(raw, at);
    const manifest = structuredClone(c.manifest);
    manifest.unsignedTx.inputs[i].preservedSignature.witness[0] = forged;
    const digest = expectedTransactionDigest(manifest);
    return [
      replace(`/manifest/unsignedTx/inputs/${i}/preservedSignature/witness/0`, forged),
      replace('/manifest/digest', digest),
      replace('/signed/manifestDigest', digest),
      replace('/signed/psbt', raw.toString('base64'))
    ];
  }],

  // Counterparty ledger events (verifyCounterpartyLedgerEvents), for an attachment-follows case.
  ...ledgerBuilders()
];

/** A minimal PSBT v2 (BIP370) for a transaction, with conflicting required locktimes. */
function psbtV2BothLocktimes(unsigned) {
  const le = (n, bytes) => {
    const b = Buffer.alloc(bytes);
    if (bytes === 8) b.writeBigUInt64LE(BigInt(n));
    else b.writeUInt32LE(Number(n));
    return b;
  };
  const compact = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.concat([Buffer.from([0xfd]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; })()]));
  const pair = (type, value) => Buffer.concat([compact(1), Buffer.from([type]), compact(value.length), value]);
  const parts = [Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff])];
  parts.push(pair(0x02, le(unsigned.version, 4)), pair(0x04, compact(unsigned.inputs.length)), pair(0x05, compact(unsigned.outputs.length)), pair(0xfb, le(2, 4)), Buffer.from([0x00]));
  unsigned.inputs.forEach((input, i) => {
    parts.push(pair(0x0e, Buffer.from(input.txid, 'hex').reverse()), pair(0x0f, le(input.vout, 4)), pair(0x10, le(input.sequence, 4)));
    if (i === 0) parts.push(pair(0x11, le(500000001, 4)));
    if (i === 1) parts.push(pair(0x12, le(1, 4)));
    parts.push(Buffer.from([0x00]));
  });
  for (const output of unsigned.outputs) {
    const script = Buffer.from(output.scriptPubKeyHex ?? output.scriptHex, 'hex');
    parts.push(pair(0x03, le(output.valueSats, 8)), pair(0x04, script), Buffer.from([0x00]));
  }
  return Buffer.concat(parts).toString('base64');
}

function ledgerBuilders() {
  const txHash = 'c'.repeat(64);
  const event = { event: 'UTXO_MOVE', txHash, source: `${'a'.repeat(64)}:0`, destination: `${txHash}:0`, asset: 'XCP', quantity: '100000000', status: 'valid' };
  const expected = { txHash, events: [{ event: event.event, source: event.source, destination: event.destination, asset: event.asset, quantity: event.quantity }] };
  const checkpoint = { height: 900000, blockHash: '0'.repeat(63) + '1', ledgerHash: 'd'.repeat(64) };
  const bases = () => cases.filter((c) => c.family === 'counterparty-asset' && c.variant === 'record' && c.case.expected?.ok === true).slice(0, 1);
  const with_ = (exp, obs) => () => [add('/expectedEvents', exp), add('/observedEvents', obs)];
  return [
    ['EVENTS_MALFORMED', 'counterparty-asset', 'counterparty-asset', 'ledger', 'The expectation names no transaction id.', with_({ events: [] }, { checkpoint, events: [] }), bases],
    ['LEDGER_EVENT_INVALID', 'counterparty-asset', 'counterparty-asset', 'ledger', 'The ledger recorded the move with status invalid.', with_(expected, { checkpoint, events: [{ ...event, status: 'invalid: insufficient funds' }] }), bases],
    ['LEDGER_EVENT_UNEXPECTED', 'counterparty-asset', 'counterparty-asset', 'ledger', 'The ledger moved a different quantity than the plan expected.', with_(expected, { checkpoint, events: [{ ...event, quantity: '1' }] }), bases],
    ['LEDGER_EVENT_MISSING', 'counterparty-asset', 'counterparty-asset', 'ledger', 'The ledger holds no event for the expected move.', with_(expected, { checkpoint, events: [] }), bases]
  ];
}

export function authorAll() {
  const out = [];
  const failed = [];
  for (const [code, covers, family, variant, note, build, basesFn] of BUILDERS) {
    const bases = basesFn ? basesFn() : accepted(family, variant);
    let done = null;
    for (const base of bases) {
      let patch;
      try {
        patch = build(base.case);
      } catch {
        continue;
      }
      if (!patch) continue;
      let candidate;
      try {
        candidate = applyPatch(base.case, patch);
      } catch {
        continue;
      }
      const verdict = runCase(family, variant, candidate);
      if (verdict.state === 'refused' && verdict.code === code) {
        done = { code, family, variant, base: base.id, patch, derivation: 'authored', note, ...(covers !== family ? { covers } : {}) };
        break;
      }
    }
    if (done) out.push(done);
    else failed.push(`${code}|${covers}`);
  }
  return { out, failed };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const { out, failed } = authorAll();
  const file = JSON.parse(fs.readFileSync(REPRODUCERS_PATH, 'utf8'));
  for (const r of out) {
    const { code, ...entry } = r;
    const list = (file.reproducers[code] ||= []);
    const key = entry.covers || entry.family;
    const at = list.findIndex((x) => (x.covers || x.family) === key);
    if (at >= 0) list[at] = entry;
    else list.push(entry);
  }
  fs.writeFileSync(REPRODUCERS_PATH, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`authored ${out.length}; not reproduced: ${failed.join(' ') || 'none'}`);
}
