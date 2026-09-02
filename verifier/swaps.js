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

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const ASSET_TYPES = ['BTC', 'ORDINAL', 'RARE_SAT', 'RUNE', 'COUNTERPARTY'];
export const SWAP_INTENT_SCHEMA = 'ordex.swap-intent/v1';
export const SWAP_ACCEPTANCE_SCHEMA = 'ordex.swap-acceptance-plan/v1';

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
 * Verify a swap acceptance plan against its intent.
 *
 * acceptance:
 *   schema, intentDigest, network,
 *   tx { inputs  [{ txid, vout, party, valueSats }],
 *        outputs [{ scriptHex, valueSats, role }] },
 *   assetTransitions [{ assetType, assetId, fromInput, toOutput }],
 *   fee { feeSats, makerFeeSats, takerFeeSats },
 *   signing { sighashPolicy }
 *
 * The invariant this check proves: with SIGHASH_ALL on every input, no
 * transaction carrying only one party's signatures can confirm, so neither
 * side can lose its asset while the other withholds the final signature.
 */
export function verifySwapAcceptance(acceptance, intent) {
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    return refuse('MALFORMED_ACCEPTANCE', 'Expected an acceptance plan object.');
  }
  if (acceptance.schema !== SWAP_ACCEPTANCE_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The acceptance schema is not ordex.swap-acceptance-plan/v1.');
  }
  const intentVerdict = verifySwapIntent(intent);
  if (!intentVerdict.ok) return intentVerdict;
  if (acceptance.intentDigest !== intent.digest) {
    return refuse('INTENT_DIGEST_MISMATCH', 'The acceptance plan was not built from this intent.');
  }
  if (acceptance.network !== intent.network) {
    return refuse('NETWORK_MISMATCH', 'The acceptance plan was built for a different network.');
  }
  const tx = acceptance.tx;
  if (!tx || !Array.isArray(tx.inputs) || tx.inputs.length < 2 || !Array.isArray(tx.outputs) || tx.outputs.length < 2) {
    return refuse(
      'ATOMICITY_IMPOSSIBLE',
      'A swap settles both sides in one transaction with inputs and outputs from both parties.',
    );
  }
  if (
    !acceptance.signing ||
    acceptance.signing.sighashPolicy !== 'ALL'
  ) {
    return refuse(
      'UNCLOSED_SIGHASH',
      'Every input must commit to every output (SIGHASH_ALL), or one party could move its asset without the other receiving theirs.',
    );
  }

  let totalIn = 0n;
  const inputByOutpoint = new Map();
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const input = tx.inputs[i];
    if (!validOutpoint(input && input.outpoint)) {
      return refuse('INPUT_OUTPOINT_INVALID', `Input ${i} does not carry a lowercase txid and vout.`);
    }
    if (input.party !== 'maker' && input.party !== 'taker') {
      return refuse('INPUT_PARTY_INVALID', `Input ${i} must name the maker or the taker.`);
    }
    const value = parseSats(input && input.valueSats);
    if (value === null) {
      return refuse('INPUT_VALUE_INVALID', `Input ${i} does not carry an exact decimal value.`);
    }
    const key = `${input.outpoint.txid}:${input.outpoint.vout}`;
    if (inputByOutpoint.has(key)) {
      return refuse('INPUT_DUPLICATED', `Input ${key} appears more than once.`);
    }
    inputByOutpoint.set(key, { index: i, party: input.party, value });
    totalIn += value;
  }

  // Every maker commitment must be spent by exactly one maker input, and no
  // maker input may spend anything the intent did not commit.
  for (const give of intent.gives) {
    const key = `${give.outpoint.txid}:${give.outpoint.vout}`;
    const input = inputByOutpoint.get(key);
    if (!input) {
      return refuse('MAKER_OUTPOINT_MISSING', `The committed outpoint ${key} is not spent by the acceptance plan.`);
    }
    if (input.party !== 'maker') {
      return refuse('MAKER_OUTPOINT_REASSIGNED', `The committed outpoint ${key} is claimed by the taker.`);
    }
  }
  for (const [key, input] of inputByOutpoint) {
    if (input.party !== 'maker') continue;
    const committed = intent.gives.some(
      (give) => `${give.outpoint.txid}:${give.outpoint.vout}` === key,
    );
    if (!committed) {
      return refuse('UNEXPECTED_MAKER_INPUT', `Input ${key} spends an outpoint the intent never committed.`);
    }
  }

  let totalOut = 0n;
  for (let i = 0; i < tx.outputs.length; i += 1) {
    const output = tx.outputs[i];
    if (typeof (output && output.scriptHex) !== 'string' || !EVEN_HEX.test(output.scriptHex)) {
      return refuse('OUTPUT_SCRIPT_INVALID', `Output ${i} does not carry lowercase hex script bytes.`);
    }
    const value = parseSats(output && output.valueSats);
    if (value === null) {
      return refuse('OUTPUT_VALUE_INVALID', `Output ${i} does not carry an exact decimal value.`);
    }
    if (value < 546n) {
      return refuse('DUST_OUTPUT', `Output ${i} is below the 546 sat dust floor.`);
    }
    totalOut += value;
  }
  const fee = totalIn - totalOut;
  if (fee < 0n) {
    return refuse('VALUE_NOT_CONSERVED', 'The outputs exceed the inputs.');
  }
  const feeSpec = acceptance.fee;
  if (!feeSpec || typeof feeSpec !== 'object') {
    return refuse('FEE_INVALID', 'The acceptance plan must carry a fee object.');
  }
  const declaredFee = parseSats(feeSpec.feeSats);
  const makerFee = parseSats(feeSpec.makerFeeSats);
  const takerFee = parseSats(feeSpec.takerFeeSats);
  if (declaredFee === null || makerFee === null || takerFee === null || declaredFee < 0n) {
    return refuse('FEE_INVALID', 'Fee contributions must be exact decimal strings.');
  }
  if (makerFee + takerFee !== declaredFee) {
    return refuse('FEE_SPLIT_INVALID', 'The maker and taker contributions must equal the declared fee.');
  }
  if (fee !== declaredFee) {
    return refuse('FEE_CHANGED', 'The declared fee does not match the transaction.');
  }
  if (makerFee > parseSats(intent.maxMakerFeeSats)) {
    return refuse('FEE_BUDGET_EXCEEDED', 'The maker contribution exceeds the budget the intent approved.');
  }

  // Each required criterion must be satisfied by an output paying the maker
  // receive script with at least the minimum quantity.
  for (const criterion of intent.requires) {
    const minimum = parseSats(criterion.minQuantitySats);
    const satisfied = tx.outputs.some(
      (output) =>
        output.scriptHex === intent.makerReceiveScriptHex &&
        parseSats(output.valueSats) >= minimum,
    );
    if (!satisfied) {
      return refuse(
        'CONSIDERATION_SHORTFALL',
        `No output pays the maker receive script at least ${criterion.minQuantitySats} for ${criterion.assetType}.`,
      );
    }
  }

  // Every asset the maker gives must be delivered to a taker asset output
  // through an explicit transition, and every taker asset must be preserved
  // or delivered the same way. An unassigned asset could land in the fee
  // region or in unrelated change. For every non-BTC asset the declared
  // destination must also be the output that receives the input's first
  // sat: the first output whose accumulated value passes the range start.
  const transitions = Array.isArray(acceptance.assetTransitions) ? acceptance.assetTransitions : [];
  const inputValues = tx.inputs.map((input) => parseSats(input.valueSats));
  const firstSatOutput = (fromInput) => {
    let rangeStart = 0n;
    for (let i = 0; i < fromInput; i += 1) rangeStart += inputValues[i];
    let accumulated = 0n;
    for (let j = 0; j < tx.outputs.length; j += 1) {
      accumulated += parseSats(tx.outputs[j].valueSats);
      if (accumulated > rangeStart) return j;
    }
    return -1;
  };
  const seen = new Set();
  const checkAsset = (assetType, assetId, fromIndex, label) => {
    const key = `${assetType}:${assetId}`;
    if (seen.has(key)) {
      return refuse('ASSET_TRANSITION_DUPLICATED', `Asset ${key} is assigned to more than one transition.`);
    }
    seen.add(key);
    const transition = transitions.find((t) => t && t.assetType === assetType && t.assetId === assetId);
    if (!transition) {
      return refuse(`${label}_UNASSIGNED`, `Asset ${key} has no destination in the asset transitions.`);
    }
    if (!Number.isInteger(transition.fromInput) || transition.fromInput !== fromIndex) {
      return refuse(
        'TRANSITION_SOURCE_MISMATCH',
        `Asset ${key} declares input ${transition.fromInput} but rides on input ${fromIndex}.`,
      );
    }
    const output = tx.outputs[transition.toOutput];
    if (!Number.isInteger(transition.toOutput) || !output) {
      return refuse('TRANSITION_OUTPUT_MISSING', `Asset ${key} names output ${transition.toOutput}, which does not exist.`);
    }
    if (assetType !== 'BTC' && transition.toOutput !== firstSatOutput(fromIndex)) {
      return refuse(
        'TRANSITION_SAT_FLOW_MISMATCH',
        `Asset ${key} declares output ${transition.toOutput}, but the sat range of input ${fromIndex} begins in a different output.`,
      );
    }
    return null;
  };
  for (const give of intent.gives) {
    const key = `${give.outpoint.txid}:${give.outpoint.vout}`;
    const error = checkAsset(give.assetType, give.assetId || 'BTC', inputByOutpoint.get(key).index, 'MAKER_ASSET');
    if (error) return error;
  }
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const input = tx.inputs[i];
    if (input.party !== 'taker') continue;
    for (const carried of Array.isArray(input.assets) ? input.assets : []) {
      const error = checkAsset(carried.assetType, carried.assetId || 'BTC', i, 'TAKER_ASSET');
      if (error) return error;
    }
  }

  return { ok: true };
}
