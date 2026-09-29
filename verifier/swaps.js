// Reference verifier for Ordex atomic swap links and the OTC desk.
//
// This file restates spec/swaps.md as executable checks. It validates the
// structure and digest binding of a swap intent, and it proves that an
// acceptance plan settles both sides in one transaction or not at all.
// Proving the BIP-322 identity signature, reading the current state of every
// outpoint, and running node preflight remain the caller's responsibility;
// the gateway performs all three before it accepts an intent or builds a
// session.
//
// Every amount is an atomic integer carried as a decimal string and handled
// as BigInt. Floating point never appears here.

import { createHash } from 'node:crypto';

import { checkTransitionShapes, deriveAssetFlow, matchTransitions, readInventory } from './asset-flow.js';
import {
  MAX_OP_RETURN_RELAY_BYTES,
  bytesToHex,
  dustThresholdSats,
  parseTransaction,
  serializeTransaction,
  unsignedCopy,
  verifyInputSignature,
} from './bitcoin-tx.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const ASSET_TYPES = ['BTC', 'ORDINAL', 'RARE_SAT', 'RUNE', 'COUNTERPARTY'];
export const SWAP_INTENT_SCHEMA = 'ordex.swap-intent/v1';
export const SWAP_ACCEPTANCE_SCHEMA = 'ordex.swap-acceptance-plan/v2';
export const SWAP_SIGNED_TRANSACTION_SCHEMA = 'ordex.swap-signed-transaction/v1';

export function parseSats(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

/** Serialize any JSON value with object keys sorted recursively. */
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 over the signed content of an intent: everything except the
 * digest itself and the identity signature. Lowercase hex.
 */
export function swapIntentDigest(intent) {
  const binding = {};
  for (const [key, value] of Object.entries(intent)) {
    if (key === 'digest' || key === 'makerIdentityProof') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}

const refuse = (code, reason) => ({ ok: false, code, reason });

function validOutpoint(outpoint) {
  return (
    !!outpoint &&
    typeof outpoint.txid === 'string' &&
    HEX64.test(outpoint.txid) &&
    Number.isInteger(outpoint.vout) &&
    outpoint.vout >= 0
  );
}

function validGives(gives) {
  if (!Array.isArray(gives) || gives.length === 0) return false;
  return gives.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.assetType !== 'string' || !ASSET_TYPES.includes(entry.assetType)) return false;
    if (!validOutpoint(entry.outpoint)) return false;
    if (parseSats(entry.quantitySats) === null) return false;
    if (entry.assetType === 'BTC') {
      return entry.assetId === undefined || typeof entry.assetId === 'string';
    }
    return typeof entry.assetId === 'string' && entry.assetId.length > 0;
  });
}

function validRequires(requires) {
  if (!Array.isArray(requires) || requires.length === 0) return false;
  return requires.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.assetType !== 'string' || !ASSET_TYPES.includes(entry.assetType)) return false;
    if (parseSats(entry.minQuantitySats) === null) return false;
    if (entry.assetType === 'BTC') {
      return entry.assetId === undefined || typeof entry.assetId === 'string';
    }
    if (typeof entry.assetId !== 'string' || entry.assetId.length === 0) {
      // An ORDINAL may instead name one inscription id as the asset id.
      return entry.assetType === 'ORDINAL' && typeof entry.inscriptionId === 'string' && entry.inscriptionId.length > 0;
    }
    return true;
  });
}

/**
 * Verify a swap intent.
 *
 * intent:
 *   schema, protocolVersion, network, visibility ('PUBLIC'|'PRIVATE'),
 *   makerReceiveScriptHex, gives [], requires [], maxMakerFeeSats,
 *   expiryHeight, nonce, createdAtHeight, checkpoint { height, blockHash },
 *   takerBinding? { address }, adapterVersions [],
 *   makerIdentityProof { kind, address, signature }, digest
 *
 * Answers { ok: true, digest } or { ok: false, code, reason }.
 */
export function verifySwapIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    return refuse('MALFORMED_INTENT', 'Expected an intent object.');
  }
  if (intent.schema !== SWAP_INTENT_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The intent schema is not ordex.swap-intent/v1.');
  }
  if (typeof intent.protocolVersion !== 'string' || !/^1\.[2-9][0-9]*$/.test(intent.protocolVersion)) {
    return refuse('PROTOCOL_UNSUPPORTED', 'The intent protocol version must be 1.2 or a later 1.x.');
  }
  if (typeof intent.network !== 'string' || !NETWORKS.includes(intent.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (intent.visibility !== 'PUBLIC' && intent.visibility !== 'PRIVATE') {
    return refuse('VISIBILITY_INVALID', 'Visibility must be PUBLIC or PRIVATE.');
  }
  if (typeof intent.makerReceiveScriptHex !== 'string' || !EVEN_HEX.test(intent.makerReceiveScriptHex)) {
    return refuse('RECEIVE_SCRIPT_INVALID', 'The maker receive script must be lowercase hex bytes.');
  }
  if (!validGives(intent.gives)) {
    return refuse('GIVES_INVALID', 'The intent must give at least one exact outpoint with an exact quantity.');
  }
  if (!validRequires(intent.requires)) {
    return refuse('REQUIRES_INVALID', 'The intent must require at least one exact asset with a minimum quantity.');
  }
  const maxMakerFee = parseSats(intent.maxMakerFeeSats);
  if (maxMakerFee === null || maxMakerFee < 0n) {
    return refuse('FEE_BUDGET_INVALID', 'maxMakerFeeSats must be an exact non-negative decimal string.');
  }
  if (
    !intent.checkpoint ||
    !Number.isInteger(intent.checkpoint.height) ||
    intent.checkpoint.height < 0 ||
    typeof intent.checkpoint.blockHash !== 'string' ||
    !HEX64.test(intent.checkpoint.blockHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The intent must carry the chain checkpoint it was signed against.');
  }
  if (!Number.isInteger(intent.expiryHeight) || intent.expiryHeight <= intent.checkpoint.height) {
    return refuse('EXPIRY_INVALID', 'The expiry height must be a block after the checkpoint height.');
  }
  if (typeof intent.nonce !== 'string' || intent.nonce.length < 8 || intent.nonce.length > 128) {
    return refuse('NONCE_INVALID', 'The intent must carry a nonce of 8 to 128 characters.');
  }
  if (!Array.isArray(intent.adapterVersions) || intent.adapterVersions.length === 0) {
    return refuse('ADAPTER_VERSIONS_MISSING', 'The intent must name the protocol adapter versions it relies on.');
  }
  const proof = intent.makerIdentityProof;
  if (!proof || proof.kind !== 'bip322' || typeof proof.address !== 'string' || proof.address.length === 0) {
    return refuse('MAKER_PROOF_INVALID', 'The intent must carry a bip322 maker identity proof with an address.');
  }
  if (
    intent.takerBinding !== undefined &&
    (typeof intent.takerBinding !== 'object' ||
      typeof intent.takerBinding.address !== 'string' ||
      intent.takerBinding.address.length === 0)
  ) {
    return refuse('TAKER_BINDING_INVALID', 'A taker binding must name an address.');
  }

  const digest = swapIntentDigest(intent);
  if (intent.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The intent digest does not match its signed content.');
  }
  return { ok: true, digest };
}

/**
 * SHA-256 over the sorted-key JSON of an acceptance plan without its digest:
 * the one immutable identity both parties sign against.
 */
export function swapAcceptanceDigest(acceptance) {
  const binding = {};
  for (const [key, value] of Object.entries(acceptance)) {
    if (key === 'digest') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}

const U32_MAX = 0xffffffff;
const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= U32_MAX;

/** Asset types each adapter settles, and the adapter versions this verifier runs. */
const ADAPTER_OF = { ORDINAL: 'ordinals', RARE_SAT: 'ordinals', RUNE: 'runes', COUNTERPARTY: 'counterparty' };
const SUPPORTED_ADAPTERS = { ordinals: ['1.2'], runes: ['1.2'], counterparty: ['1.2'] };

const requiredId = (r) => (r.assetType === 'ORDINAL' && (r.assetId === undefined || r.assetId === '') ? r.inscriptionId : r.assetId);

/** The unsigned transaction an acceptance plan describes. */
export function swapUnsignedTransaction(acceptance) {
  return {
    version: acceptance.transaction.version,
    lockTime: acceptance.transaction.lockTime,
    inputs: acceptance.tx.inputs.map((input) => ({
      txid: input.outpoint.txid,
      vout: input.outpoint.vout,
      scriptSigHex: '',
      sequence: input.sequence,
      witness: [],
    })),
    outputs: acceptance.tx.outputs.map((output) => ({ valueSats: String(parseSats(output.valueSats)), scriptHex: output.scriptHex })),
  };
}

/**
 * Verify that an acceptance plan settles an intent in one transaction.
 *
 * acceptance:
 *   schema, intentDigest, network, checkpoint { height, blockHash },
 *   taker { receiveScriptHex, changeScriptHex?, identityProof? },
 *   transaction { version, lockTime },
 *   tx { inputs  [{ outpoint, party, valueSats, scriptPubKeyHex, sequence,
 *                   inventory }],
 *        outputs [{ scriptHex, valueSats }] },
 *   assetTransitions [{ assetType, assetId, fromInput?, toOutput, quantity }],
 *   fee { feeSats, makerFeeSats, takerFeeSats },
 *   signing { sighashPolicy: 'ALL' }, digest
 *
 * Every asset movement is derived from the inputs' inventories by the owning
 * protocol's rule. The maker must receive every required asset at its
 * receive script, the taker must receive every given asset at its receive
 * script, every other asset returns to its owner, every output belongs to one
 * party, and each party's fee share is computed from its value flow.
 *
 * Answers { ok: true, digest, makerFeeSats, takerFeeSats } or a refusal.
 */
// OX-P02: P-R09 accepted a required Rune that never arrived and P-R10 a maker asset
// paid back to the maker. Consideration is now judged by asset identity and quantity
// at the owning party's script, never by a BTC value, and fee shares come from each
// party's actual value flow with postage kept with the asset it carries.
export function verifySwapAcceptance(acceptance, intent) {
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    return refuse('MALFORMED_ACCEPTANCE', 'Expected an acceptance plan object.');
  }
  if (acceptance.schema !== SWAP_ACCEPTANCE_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The acceptance schema is not ordex.swap-acceptance-plan/v2. Build the plan again.');
  }
  const intentVerdict = verifySwapIntent(intent);
  if (!intentVerdict.ok) return intentVerdict;
  if (acceptance.intentDigest !== intent.digest) {
    return refuse('INTENT_DIGEST_MISMATCH', 'The acceptance plan was not built from this intent.');
  }
  if (acceptance.network !== intent.network) {
    return refuse('NETWORK_MISMATCH', 'The acceptance plan was built for a different network.');
  }
  const checkpoint = acceptance.checkpoint;
  if (
    !checkpoint ||
    !Number.isInteger(checkpoint.height) ||
    checkpoint.height < intent.checkpoint.height ||
    typeof checkpoint.blockHash !== 'string' ||
    !HEX64.test(checkpoint.blockHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The plan must carry the checkpoint its outpoints were revalidated at, no earlier than the intent.');
  }
  if (checkpoint.height + 1 >= intent.expiryHeight) {
    return refuse('INTENT_EXPIRED', 'The intent expires before this plan could confirm.');
  }
  if (
    !acceptance.transaction ||
    !isU32(acceptance.transaction.version) ||
    acceptance.transaction.version < 1 ||
    !isU32(acceptance.transaction.lockTime)
  ) {
    return refuse('TRANSACTION_INVALID', 'The plan must fix the transaction version and locktime.');
  }
  const taker = acceptance.taker;
  if (
    !taker ||
    typeof taker.receiveScriptHex !== 'string' ||
    !EVEN_HEX.test(taker.receiveScriptHex) ||
    (taker.changeScriptHex !== undefined && (typeof taker.changeScriptHex !== 'string' || !EVEN_HEX.test(taker.changeScriptHex)))
  ) {
    return refuse('TAKER_INVALID', 'The plan must name the taker receive script, and a change script only as hex.');
  }
  if (intent.takerBinding !== undefined) {
    const proof = taker.identityProof;
    if (!proof || proof.kind !== 'bip322' || proof.address !== intent.takerBinding.address) {
      return refuse('TAKER_BINDING_MISMATCH', 'This intent is bound to one taker, and the plan does not carry that taker identity proof.');
    }
  }
  const makerScripts = new Set([intent.makerReceiveScriptHex]);
  const takerScripts = new Set([taker.receiveScriptHex, ...(taker.changeScriptHex ? [taker.changeScriptHex] : [])]);
  if ([...takerScripts].some((script) => makerScripts.has(script))) {
    return refuse('PARTY_SCRIPTS_OVERLAP', 'The taker would receive at a maker script, so nothing could prove which party an output belongs to.');
  }
  if (!acceptance.signing || acceptance.signing.sighashPolicy !== 'ALL') {
    return refuse(
      'UNCLOSED_SIGHASH',
      'Every input must commit to every output (SIGHASH_ALL), or one party could move its asset without the other receiving theirs.',
    );
  }
  for (const entry of [...intent.gives, ...intent.requires]) {
    const adapter = ADAPTER_OF[entry.assetType];
    if (!adapter) continue;
    const pinned = intent.adapterVersions.find((a) => a && a.protocol === adapter);
    if (!pinned || !SUPPORTED_ADAPTERS[adapter].includes(pinned.version)) {
      return refuse('ADAPTER_UNSUPPORTED', `The intent relies on ${adapter} adapter ${pinned ? pinned.version : 'none'}, which this verifier does not run.`);
    }
    const quantity = entry.assetType === 'ORDINAL' ? entry.quantitySats ?? entry.minQuantitySats : null;
    if (quantity !== null && quantity !== '1') {
      return refuse('QUANTITY_UNSUPPORTED', 'An inscription is exchanged whole: its quantity is 1.');
    }
  }

  const tx = acceptance.tx;
  if (!tx || !Array.isArray(tx.inputs) || tx.inputs.length < 2 || !Array.isArray(tx.outputs) || tx.outputs.length < 2) {
    return refuse('ATOMICITY_IMPOSSIBLE', 'A swap settles both sides in one transaction with inputs and outputs from both parties.');
  }

  let totalIn = 0n;
  const inputs = [];
  const inputByOutpoint = new Map();
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const input = tx.inputs[i];
    if (!validOutpoint(input && input.outpoint)) {
      return refuse('INPUT_OUTPOINT_INVALID', `Input ${i} does not carry a lowercase txid and vout.`);
    }
    if (input.party !== 'maker' && input.party !== 'taker') {
      return refuse('INPUT_PARTY_INVALID', `Input ${i} must name the maker or the taker.`);
    }
    const value = parseSats(input.valueSats);
    if (value === null) {
      return refuse('INPUT_VALUE_INVALID', `Input ${i} does not carry an exact decimal value.`);
    }
    if (typeof input.scriptPubKeyHex !== 'string' || !EVEN_HEX.test(input.scriptPubKeyHex)) {
      return refuse('INPUT_SCRIPT_INVALID', `Input ${i} does not carry the script of the output it spends.`);
    }
    if (!isU32(input.sequence)) {
      return refuse('INPUT_SEQUENCE_INVALID', `Input ${i} does not fix its sequence number.`);
    }
    const key = `${input.outpoint.txid}:${input.outpoint.vout}`;
    if (inputByOutpoint.has(key)) {
      return refuse('INPUT_DUPLICATED', `Input ${key} appears more than once.`);
    }
    const read = readInventory(input.inventory, i, value, input.outpoint);
    if (!read.assets) return read;
    inputByOutpoint.set(key, i);
    inputs.push({ outpoint: input.outpoint, party: input.party, value, assets: read.assets });
    totalIn += value;
  }
  if (!inputs.some((input) => input.party === 'taker')) {
    return refuse('ATOMICITY_IMPOSSIBLE', 'The taker contributes no input, so this is not a swap.');
  }

  // Every maker commitment is spent exactly once, by the maker, and carries
  // what the intent says it gives. No uncommitted maker input appears.
  for (const give of intent.gives) {
    const key = `${give.outpoint.txid}:${give.outpoint.vout}`;
    const index = inputByOutpoint.get(key);
    if (index === undefined) {
      return refuse('MAKER_OUTPOINT_MISSING', `The committed outpoint ${key} is not spent by the acceptance plan.`);
    }
    const input = inputs[index];
    if (input.party !== 'maker') {
      return refuse('MAKER_OUTPOINT_REASSIGNED', `The committed outpoint ${key} is claimed by the taker.`);
    }
    const quantity = BigInt(give.quantitySats);
    const held =
      give.assetType === 'BTC'
        ? input.value >= quantity
        : input.assets.some(
            (a) =>
              a.assetType === give.assetType &&
              a.assetId === give.assetId &&
              (give.assetType === 'RUNE' ? BigInt(a.amount) >= quantity : give.assetType === 'COUNTERPARTY' ? BigInt(a.quantitySats) >= quantity : true),
          );
    if (!held) {
      return refuse('GIVE_NOT_HELD', `The committed outpoint ${key} does not carry the ${give.assetType} the intent gives.`);
    }
  }
  for (const [key, index] of inputByOutpoint) {
    if (inputs[index].party !== 'maker') continue;
    if (!intent.gives.some((give) => `${give.outpoint.txid}:${give.outpoint.vout}` === key)) {
      return refuse('UNEXPECTED_MAKER_INPUT', `Input ${key} spends an outpoint the intent never committed.`);
    }
  }

  // Every output belongs to exactly one party, apart from one zero-value
  // runestone when runes move.
  const carriesRunes = inputs.some((input) => input.assets.some((a) => a.assetType === 'RUNE'));
  let totalOut = 0n;
  const owners = [];
  let dataOutputs = 0;
  for (let i = 0; i < tx.outputs.length; i += 1) {
    const output = tx.outputs[i];
    if (typeof (output && output.scriptHex) !== 'string' || !EVEN_HEX.test(output.scriptHex)) {
      return refuse('OUTPUT_SCRIPT_INVALID', `Output ${i} does not carry lowercase hex script bytes.`);
    }
    const value = parseSats(output.valueSats);
    if (value === null) {
      return refuse('OUTPUT_VALUE_INVALID', `Output ${i} does not carry an exact decimal value.`);
    }
    if (output.scriptHex.startsWith('6a')) {
      dataOutputs += 1;
      if (value !== 0n) return refuse('DATA_OUTPUT_BURNS_VALUE', `Output ${i} would burn ${output.valueSats} sats in an OP_RETURN.`);
      if (dataOutputs > 1 || !carriesRunes || !output.scriptHex.startsWith('6a5d')) {
        return refuse('DATA_OUTPUT_NOT_PERMITTED', 'The only data output a swap may carry is one runestone for the runes it moves.');
      }
      if (output.scriptHex.length / 2 > MAX_OP_RETURN_RELAY_BYTES) {
        return refuse('DATA_OUTPUT_NONSTANDARD', `The runestone exceeds the ${MAX_OP_RETURN_RELAY_BYTES} byte relay limit.`);
      }
      owners.push('data');
    } else {
      if (value < dustThresholdSats(output.scriptHex)) {
        return refuse('DUST_OUTPUT', `Output ${i} is below the ${dustThresholdSats(output.scriptHex)} sat dust threshold for its script.`);
      }
      const owner = makerScripts.has(output.scriptHex) ? 'maker' : takerScripts.has(output.scriptHex) ? 'taker' : null;
      if (!owner) {
        return refuse('OUTPUT_UNOWNED', `Output ${i} pays a script that belongs to neither party.`);
      }
      owners.push(owner);
    }
    totalOut += value;
  }
  if (!owners.includes('maker') || !owners.includes('taker')) {
    return refuse('ATOMICITY_IMPOSSIBLE', 'Both parties must receive an output.');
  }
  const fee = totalIn - totalOut;
  if (fee < 0n) {
    return refuse('VALUE_NOT_CONSERVED', 'The outputs exceed the inputs.');
  }

  const transitions = acceptance.assetTransitions;
  const shapes = checkTransitionShapes(transitions, tx.outputs.length);
  if (!shapes.ok) return shapes;
  const flow = deriveAssetFlow({
    network: intent.network,
    height: checkpoint.height + 1,
    inputs,
    outputs: tx.outputs,
  });
  if (!flow.ok) return flow;
  const matched = matchTransitions(transitions, flow.movements);
  if (!matched.ok) return matched;

  // Where each asset lands, by party.
  const gives = new Map(intent.gives.filter((g) => g.assetType !== 'BTC').map((g) => [`${g.assetType}|${g.assetId}`, g]));
  const requires = new Map(intent.requires.filter((r) => r.assetType !== 'BTC').map((r) => [`${r.assetType}|${requiredId(r)}`, r]));
  const runeTotals = new Map();
  const runeKey = (party, runeId) => `${party}|${runeId}`;
  for (const input of inputs) {
    for (const a of input.assets) {
      if (a.assetType !== 'RUNE') continue;
      const k = runeKey(`${input.party}In`, a.assetId);
      runeTotals.set(k, (runeTotals.get(k) ?? 0n) + BigInt(a.amount));
    }
  }
  const crossed = new Map();
  const kept = new Set();
  const received = new Map();
  for (const m of flow.movements) {
    const owner = owners[m.toOutput];
    if (m.assetType === 'RUNE') {
      const k = runeKey(`${owner}Out`, m.assetId);
      runeTotals.set(k, (runeTotals.get(k) ?? 0n) + BigInt(m.quantity));
      continue;
    }
    const from = inputs[m.fromInput].party;
    const key = `${m.assetType}|${m.assetId}`;
    if (from === 'maker' && gives.has(key)) {
      if (tx.outputs[m.toOutput].scriptHex !== taker.receiveScriptHex) {
        return refuse('MAKER_ASSET_NOT_DELIVERED', `${m.assetType} ${m.assetId} would not reach the taker receive script.`);
      }
      if (m.assetType === 'COUNTERPARTY' && m.quantity !== gives.get(key).quantitySats) {
        return refuse('GIVE_QUANTITY_MISMATCH', `Counterparty moves all ${m.quantity} of ${m.assetId}, not the ${gives.get(key).quantitySats} the intent gives.`);
      }
    } else if (from === 'taker' && requires.has(key)) {
      if (owner !== 'maker') {
        return refuse('CONSIDERATION_SHORTFALL', `${m.assetType} ${m.assetId} the maker requires would not reach the maker.`);
      }
      received.set(key, (received.get(key) ?? 0n) + BigInt(m.quantity));
    } else if (owner !== from) {
      return refuse('ASSET_MISDIRECTED', `${m.assetType} ${m.assetId} belongs to the ${from} and would land with the ${owner}.`);
    }
    if (m.assetType === 'ORDINAL' || m.assetType === 'RARE_SAT') {
      if (from === owner) kept.add(m.toOutput);
      else crossed.set(m.toOutput, owner);
    }
  }
  // Postage travels with a sat-bound asset across parties, not as payment. An
  // output holding both a traded and an owner's own sat-bound asset has no
  // single meaning, so it is refused.
  let makerPostageIn = 0n;
  let takerPostageIn = 0n;
  for (const [output, owner] of crossed) {
    if (kept.has(output)) {
      return refuse('ASSET_OUTPUT_MIXED', `Output ${output} carries a traded sat-bound asset together with its owner's own.`);
    }
    const value = BigInt(tx.outputs[output].valueSats);
    if (owner === 'maker') makerPostageIn += value;
    else takerPostageIn += value;
  }
  for (const [key, give] of gives) {
    const [assetType, assetId] = key.split('|');
    if (assetType === 'RUNE') {
      const gain = (runeTotals.get(runeKey('takerOut', assetId)) ?? 0n) - (runeTotals.get(runeKey('takerIn', assetId)) ?? 0n);
      if (gain !== BigInt(give.quantitySats)) {
        return refuse('MAKER_ASSET_NOT_DELIVERED', `The taker would gain ${gain} of rune ${assetId}, not the ${give.quantitySats} the intent gives.`);
      }
    } else if (!flow.movements.some((m) => m.assetType === assetType && m.assetId === assetId)) {
      return refuse('MAKER_ASSET_NOT_DELIVERED', `${assetType} ${assetId} is not moved by this transaction.`);
    }
  }
  for (const [key, requirement] of requires) {
    const [assetType, assetId] = key.split('|');
    const minimum = assetType === 'ORDINAL' ? 1n : BigInt(requirement.minQuantitySats);
    const got =
      assetType === 'RUNE'
        ? (runeTotals.get(runeKey('makerOut', assetId)) ?? 0n) - (runeTotals.get(runeKey('makerIn', assetId)) ?? 0n)
        : (received.get(key) ?? 0n);
    if (got < minimum) {
      return refuse('CONSIDERATION_SHORTFALL', `The maker would receive ${got} of ${assetType} ${assetId}, less than the ${minimum} it requires.`);
    }
  }
  const runeIds = new Set([...runeTotals.keys()].map((k) => k.split('|')[1]));
  for (const runeId of runeIds) {
    if (gives.has(`RUNE|${runeId}`) || requires.has(`RUNE|${runeId}`)) continue;
    for (const party of ['maker', 'taker']) {
      const gain = (runeTotals.get(runeKey(`${party}Out`, runeId)) ?? 0n) - (runeTotals.get(runeKey(`${party}In`, runeId)) ?? 0n);
      if (gain !== 0n) return refuse('ASSET_MISDIRECTED', `Rune ${runeId} would move between the parties though neither side trades it.`);
    }
  }

  // Fee shares from value flow: each party's net change, with postage kept
  // with the asset it carries, measured against the BTC terms of the intent.
  const feeSpec = acceptance.fee;
  if (!feeSpec || typeof feeSpec !== 'object') {
    return refuse('FEE_INVALID', 'The acceptance plan must carry a fee object.');
  }
  const declaredFee = parseSats(feeSpec.feeSats);
  const makerFee = parseSats(feeSpec.makerFeeSats);
  const takerFee = parseSats(feeSpec.takerFeeSats);
  if (declaredFee === null || makerFee === null || takerFee === null) {
    return refuse('FEE_INVALID', 'Fee contributions must be exact decimal strings.');
  }
  if (declaredFee !== fee) {
    return refuse('FEE_CHANGED', 'The declared fee does not match the transaction.');
  }
  let makerIn = 0n;
  let makerOut = 0n;
  inputs.forEach((input) => {
    if (input.party === 'maker') makerIn += input.value;
  });
  tx.outputs.forEach((output, i) => {
    if (owners[i] === 'maker') makerOut += BigInt(output.valueSats);
  });
  const btcGiven = intent.gives.filter((g) => g.assetType === 'BTC').reduce((n, g) => n + BigInt(g.quantitySats), 0n);
  const btcRequired = intent.requires.filter((r) => r.assetType === 'BTC').reduce((n, r) => n + BigInt(r.minQuantitySats), 0n);
  const makerBtcChange = makerOut - makerPostageIn - makerIn + takerPostageIn;
  const makerFeeActual = btcRequired - btcGiven - makerBtcChange;
  if (makerFeeActual > parseSats(intent.maxMakerFeeSats)) {
    return btcRequired > 0n
      ? refuse('CONSIDERATION_SHORTFALL', `The maker would receive less BTC than the ${btcRequired} sats it requires within its fee budget.`)
      : refuse('FEE_BUDGET_EXCEEDED', `The maker would contribute ${makerFeeActual} sats, above the budget the intent approved.`);
  }
  const takerFeeActual = fee - makerFeeActual;
  if (makerFee !== makerFeeActual || takerFee !== takerFeeActual) {
    return refuse(
      'FEE_SPLIT_INVALID',
      `From the value flow the maker contributes ${makerFeeActual} and the taker ${takerFeeActual}, not the ${feeSpec.makerFeeSats} and ${feeSpec.takerFeeSats} declared.`,
    );
  }

  const digest = swapAcceptanceDigest(acceptance);
  if (acceptance.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The acceptance digest does not match the plan.');
  }
  return { ok: true, digest, makerFeeSats: makerFeeActual.toString(), takerFeeSats: takerFeeActual.toString() };
}

/**
 * Verify the fully signed settlement transaction of an accepted swap: the
 * exact planned transaction, every input signed and verified, every signature
 * closing the transaction with SIGHASH_ALL (or the Taproot default).
 *
 * signed: { schema, acceptanceDigest, signedTxHex }
 */
// OX-P02: a settlement is proved from its bytes. Both parties' signatures must
// verify over the planned transaction, and only a closing sighash is accepted.
export function verifySwapSignedTransaction(signed, acceptance, intent) {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    return refuse('MALFORMED_SIGNED_RESULT', 'Expected a signed settlement object.');
  }
  if (signed.schema !== SWAP_SIGNED_TRANSACTION_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The signed settlement schema is not ordex.swap-signed-transaction/v1.');
  }
  const plan = verifySwapAcceptance(acceptance, intent);
  if (!plan.ok) return plan;
  if (signed.acceptanceDigest !== plan.digest) {
    return refuse('ACCEPTANCE_DIGEST_MISMATCH', 'The signed settlement was not produced from this acceptance plan.');
  }
  const parsed = parseTransaction(signed.signedTxHex);
  if (!parsed.ok) return refuse('MALFORMED_SIGNED_RESULT', parsed.reason);
  const tx = parsed.tx;
  if (bytesToHex(serializeTransaction(unsignedCopy(tx))) !== bytesToHex(serializeTransaction(swapUnsignedTransaction(acceptance)))) {
    return refuse('TRANSACTION_CHANGED', 'The signed settlement is not the planned transaction.');
  }
  const prevouts = acceptance.tx.inputs.map((input) => ({ valueSats: String(parseSats(input.valueSats)), scriptHex: input.scriptPubKeyHex }));
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const verdict = verifyInputSignature(tx, i, prevouts);
    if (verdict.status === 'UNSIGNED') return refuse('SIGNATURE_MISSING', `Input ${i} of the ${acceptance.tx.inputs[i].party} is unsigned.`);
    if (verdict.status === 'UNSUPPORTED') return refuse('SIGNATURE_UNVERIFIABLE', `Input ${i} spends a script this verifier cannot check.`);
    if (verdict.status !== 'VALID') return refuse('SIGNATURE_INVALID', `Input ${i} carries a signature that does not verify against the planned transaction.`);
    const closing = verdict.type === 'p2tr' ? [0x00, 0x01] : [0x01];
    if (!closing.includes(verdict.sighashType)) {
      return refuse('UNCLOSED_SIGHASH', `Input ${i} was signed without committing to every input and output.`);
    }
  }
  return { ok: true, txid: parsed.txid };
}
