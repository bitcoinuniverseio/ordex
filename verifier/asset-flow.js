// Where every asset of a transaction goes, by the rule of the protocol that
// owns it. Shared by the SafeOps and swap verifiers.
//
// Inscriptions and rare sat ranges sit on sats: their absolute position is the
// sum of the values of the inputs before theirs plus their offset. Runes are
// allocated as ord 0.29.0 allocates them (verifier/runes.js). Counterparty
// attachments move as Counterparty Core v11.4.0 moves them
// (verifier/counterparty-asset.js). None of these is a first-sat shortcut.
//
// Every amount is an atomic integer carried as a decimal string and handled
// as BigInt.

import { counterpartyMoveOutcome } from './counterparty-asset.js';
import { allocateRunes } from './runes.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const RUNE_ID = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const INSCRIPTION_ID = /^[0-9a-f]{64}i(0|[1-9][0-9]*)$/;

const parseSats = (value) => (typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : null);
const listOf = (value) => (value === undefined ? [] : value);
const refuse = (code, reason) => ({ ok: false, code, reason });

/**
 * Validate one input's inventory and list the assets it carries.
 *
 * inventory: { examined, inscriptions [{ inscriptionId, offset, satpoint? }],
 *   rareSatRanges [{ rangeId, offset, count }], runeAllocations
 *   [{ runeId, amount }], counterpartyAssets [{ name, assetId, quantitySats }],
 *   unknownClaims [] }
 *
 * Returns { assets } or a refusal. Sat-bound assets carry offset and count as
 * BigInt; runes and Counterparty assets carry their exact quantity.
 */
export function readInventory(inventory, index, value, outpoint) {
  if (!inventory || typeof inventory !== 'object' || inventory.examined !== true) {
    return refuse('INVENTORY_UNEXAMINED', `Input ${index} was never examined against the protocol authorities.`);
  }
  const bad = (what) => refuse('INVENTORY_INVALID', `Input ${index} ${what}.`);
  for (const field of ['inscriptions', 'rareSatRanges', 'runeAllocations', 'counterpartyAssets', 'unknownClaims']) {
    if (inventory[field] !== undefined && !Array.isArray(inventory[field])) return bad(`lists ${field} as something other than an array`);
  }
  if (listOf(inventory.unknownClaims).length > 0) {
    return refuse(
      'UNKNOWN_CLAIM_FAILS_CLOSED',
      `Input ${index} carries an unrecognized claim (${String(inventory.unknownClaims[0])}); resolve it before planning.`,
    );
  }
  const assets = [];
  for (const entry of listOf(inventory.inscriptions)) {
    const offset = parseSats(entry?.offset);
    if (!entry || typeof entry.inscriptionId !== 'string' || !INSCRIPTION_ID.test(entry.inscriptionId)) {
      return bad('names an inscription without a valid inscription id');
    }
    if (offset === null || offset >= value) return bad(`places ${entry.inscriptionId} at an offset the input does not have`);
    if (entry.satpoint !== undefined && entry.satpoint !== `${outpoint.txid}:${outpoint.vout}:${entry.offset}`) {
      return bad(`gives ${entry.inscriptionId} a satpoint that is not this input at this offset`);
    }
    assets.push({ assetType: 'ORDINAL', assetId: entry.inscriptionId, offset, count: 1n });
  }
  for (const entry of listOf(inventory.rareSatRanges)) {
    const offset = parseSats(entry?.offset);
    const count = parseSats(entry?.count);
    if (!entry || typeof entry.rangeId !== 'string' || entry.rangeId.length === 0) return bad('names a rare sat range without an id');
    if (offset === null || count === null || count === 0n || offset + count > value) {
      return bad(`places rare sat range ${entry.rangeId} outside the input`);
    }
    assets.push({ assetType: 'RARE_SAT', assetId: entry.rangeId, offset, count });
  }
  const runes = new Set();
  for (const entry of listOf(inventory.runeAllocations)) {
    if (!entry || typeof entry.runeId !== 'string' || !RUNE_ID.test(entry.runeId) || parseSats(entry.amount) === null) {
      return bad('lists a rune balance without an exact rune id and amount');
    }
    if (runes.has(entry.runeId)) return bad(`lists rune ${entry.runeId} twice`);
    runes.add(entry.runeId);
    assets.push({ assetType: 'RUNE', assetId: entry.runeId, amount: entry.amount });
  }
  for (const entry of listOf(inventory.counterpartyAssets)) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      typeof entry.assetId !== 'string' ||
      !DECIMAL.test(entry.assetId) ||
      parseSats(entry.quantitySats) === null ||
      parseSats(entry.quantitySats) === 0n
    ) {
      return bad('lists a Counterparty attachment without a name, a numeric asset id and an exact quantity');
    }
    assets.push({ assetType: 'COUNTERPARTY', assetId: entry.assetId, name: entry.name, quantitySats: entry.quantitySats });
  }
  return { assets };
}

/** The output holding absolute sat position `position`, or -1 for the fee. */
function outputAt(outputValues, position) {
  let end = 0n;
  for (let j = 0; j < outputValues.length; j += 1) {
    end += outputValues[j];
    if (position < end) return j;
  }
  return -1;
}

/**
 * Derive every asset movement of a transaction.
 *
 * args: { network, height (the height the spend is evaluated at),
 *   inputs [{ outpoint { txid, vout }, value (BigInt), assets }] with assets
 *   from readInventory, outputs [{ scriptHex, valueSats }] }
 *
 * Returns { ok: true, movements } where movements lists
 * { assetType, assetId, fromInput?, toOutput, quantity } (runes are fungible
 * and name no input), or a refusal: ASSET_TO_FEE, RARE_SAT_RANGE_SPLIT, a
 * rune allocation refusal, or a Counterparty move refusal.
 */
// OX-P01, OX-P02: one derivation feeds SafeOps and swaps, so neither verifier can
// fall back to a shared first-sat rule for assets whose protocol moves them otherwise.
export function deriveAssetFlow({ network, height, inputs, outputs }) {
  const outputValues = outputs.map((o) => BigInt(o.valueSats));
  const scripts = outputs.map((o) => o.scriptHex);
  const movements = [];

  let inputStart = 0n;
  inputs.forEach((input, i) => {
    for (const asset of input.assets) {
      if (asset.assetType !== 'ORDINAL' && asset.assetType !== 'RARE_SAT') continue;
      const start = inputStart + asset.offset;
      movements.push({
        assetType: asset.assetType,
        assetId: asset.assetId,
        fromInput: i,
        first: outputAt(outputValues, start),
        last: outputAt(outputValues, start + asset.count - 1n),
        quantity: asset.count.toString(),
      });
    }
    inputStart += input.value;
  });
  for (const m of movements) {
    if (m.first === -1 || m.last === -1) {
      return refuse('ASSET_TO_FEE', `${m.assetType} ${m.assetId} would land in the fee and be lost to the miner.`);
    }
    if (m.first !== m.last) {
      return refuse('RARE_SAT_RANGE_SPLIT', `Rare sat range ${m.assetId} would be split across outputs ${m.first} and ${m.last}.`);
    }
    m.toOutput = m.first;
    delete m.first;
    delete m.last;
  }

  if (inputs.some((input) => input.assets.some((a) => a.assetType === 'RUNE'))) {
    const allocation = allocateRunes(
      scripts,
      inputs.map((input) => ({
        indexed: true,
        balances: input.assets.filter((a) => a.assetType === 'RUNE').map((a) => ({ runeId: a.assetId, amount: a.amount })),
      })),
    );
    if (!allocation.ok) return refuse(allocation.code, allocation.reason);
    if (allocation.burned.length > 0) {
      return refuse(
        allocation.runestone === 'CENOTAPH' ? 'CENOTAPH_BURNS_BALANCE' : 'ALLOCATION_BURNS_BALANCE',
        'Confirming this transaction would destroy rune balances its inputs carry.',
      );
    }
    if (allocation.mintUnresolved) {
      return refuse('RUNE_MINT_UNRESOLVED', 'This runestone mints a rune whose minted amount was not supplied, so the allocation is not exact.');
    }
    for (const a of allocation.allocations) {
      movements.push({ assetType: 'RUNE', assetId: a.runeId, toOutput: a.output, quantity: a.amount });
    }
  }

  if (inputs.some((input) => input.assets.some((a) => a.assetType === 'COUNTERPARTY'))) {
    const outcome = counterpartyMoveOutcome(
      {
        inputs: inputs.map((input) => ({
          txid: input.outpoint.txid,
          vout: input.outpoint.vout,
          attachments: input.assets
            .filter((a) => a.assetType === 'COUNTERPARTY')
            .map((a) => ({ name: a.name, assetId: a.assetId, quantitySats: a.quantitySats })),
        })),
        outputs: scripts.map((scriptHex) => ({ scriptHex })),
      },
      { network, height },
    );
    if (!outcome.ok) return refuse(outcome.code, outcome.reason);
    if (outcome.operation !== 'MOVE') {
      return refuse(
        'COUNTERPARTY_NOT_MOVED',
        `Counterparty would ${outcome.operation === 'STRANDED' ? 'strand' : 'detach'} the attached assets instead of moving them.`,
      );
    }
    for (const moved of outcome.moved) {
      if (scripts[moved.toOutput].startsWith('6a')) {
        return refuse('ASSET_TO_FEE', `Counterparty asset ${moved.assetId} would be credited to an unspendable output.`);
      }
      movements.push({ assetType: 'COUNTERPARTY', assetId: moved.assetId, fromInput: moved.fromInput, toOutput: moved.toOutput, quantity: moved.quantitySats });
    }
  }

  return { ok: true, movements };
}

const transitionKey = (t) => `${t.assetType}|${t.assetId}|${t.fromInput ?? ''}|${t.toOutput}|${t.quantity}`;

/** Validate the shape of stated transitions against an output count. */
export function checkTransitionShapes(transitions, outputCount) {
  if (!Array.isArray(transitions)) return refuse('TRANSITION_INVALID', 'Expected an assetTransitions array.');
  for (const t of transitions) {
    if (!t || typeof t !== 'object' || typeof t.assetType !== 'string' || typeof t.assetId !== 'string') {
      return refuse('TRANSITION_INVALID', 'Every asset transition names an asset type and id.');
    }
    if (!Number.isInteger(t.toOutput) || t.toOutput < 0 || t.toOutput >= outputCount) {
      return refuse('TRANSITION_OUTPUT_MISSING', `Asset ${t.assetType}:${t.assetId} names output ${t.toOutput}, which does not exist.`);
    }
    if (parseSats(t.quantity) === null) return refuse('TRANSITION_INVALID', `Asset ${t.assetType}:${t.assetId} carries no exact quantity.`);
  }
  return { ok: true };
}

/**
 * Require stated transitions to equal derived movements as a complete
 * multiset. Runes compare as totals per output and rune, since they are
 * fungible; everything else compares one movement at a time.
 */
export function matchTransitions(transitions, movements) {
  const sum = (list) => {
    const totals = new Map();
    for (const m of list) {
      const key = `${m.toOutput}|${m.assetId}`;
      totals.set(key, (totals.get(key) ?? 0n) + BigInt(m.quantity));
    }
    return totals;
  };
  const statedRunes = transitions.filter((t) => t.assetType === 'RUNE');
  const movedRunes = movements.filter((m) => m.assetType === 'RUNE');
  if (movedRunes.length === 0 && statedRunes.length > 0) {
    return refuse('TRANSITION_UNEXPECTED', 'The transitions move runes no input carries.');
  }
  const planned = sum(statedRunes);
  const actual = sum(movedRunes);
  const mismatch = [...new Set([...planned.keys(), ...actual.keys()])].find((key) => (planned.get(key) ?? 0n) !== (actual.get(key) ?? 0n));
  if (mismatch) {
    const [output, runeId] = mismatch.split('|');
    return refuse(
      'RUNE_ALLOCATION_MISMATCH',
      `Output ${output} would receive ${(actual.get(mismatch) ?? 0n).toString()} of rune ${runeId}, not the ${(planned.get(mismatch) ?? 0n).toString()} stated.`,
    );
  }

  const stated = new Map();
  for (const t of transitions) {
    if (t.assetType === 'RUNE') continue;
    const key = transitionKey(t);
    stated.set(key, (stated.get(key) ?? 0) + 1);
  }
  for (const d of movements) {
    if (d.assetType === 'RUNE') continue;
    const key = transitionKey(d);
    const count = stated.get(key) ?? 0;
    if (count === 0) {
      const named = transitions.some((t) => t.assetType === d.assetType && t.assetId === d.assetId);
      return refuse(
        named ? 'TRANSITION_MISMATCH' : 'TRACKED_ASSET_UNASSIGNED',
        named
          ? `${d.assetType} ${d.assetId} moves to output ${d.toOutput} with quantity ${d.quantity}, which the transitions do not state.`
          : `${d.assetType} ${d.assetId} has no destination in the asset transitions.`,
      );
    }
    stated.set(key, count - 1);
  }
  for (const [key, count] of stated) {
    if (count > 0) return refuse('TRANSITION_UNEXPECTED', `A transition states a movement no input asset makes: ${key.split('|').slice(0, 2).join(' ')}.`);
  }
  return { ok: true };
}
