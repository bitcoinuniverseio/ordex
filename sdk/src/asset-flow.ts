/**
 * Where every asset of a transaction goes, typed.
 *
 * The same code as verifier/asset-flow.js at the repository root, shared by
 * the SafeOps and swap verifiers. Inscriptions and rare sat ranges follow
 * their absolute sat position, runes the ord 0.29.0 allocation, and
 * Counterparty attachments the Counterparty Core v11.4.0 move rule.
 */

import { counterpartyMoveOutcome } from './counterparty.js';
import { allocateRunes } from './runes.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const RUNE_ID = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const INSCRIPTION_ID = /^[0-9a-f]{64}i(0|[1-9][0-9]*)$/;

const parseSats = (value: unknown): bigint | null =>
  typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : null;
const listOf = (value: unknown[] | undefined): unknown[] => (value === undefined ? [] : value);

export interface AssetFlowRefusal {
  ok: false;
  code: string;
  reason: string;
}

const refuse = (code: string, reason: string): AssetFlowRefusal => ({ ok: false, code, reason });

export type InventoryAsset =
  | { assetType: 'ORDINAL' | 'RARE_SAT'; assetId: string; offset: bigint; count: bigint }
  | { assetType: 'RUNE'; assetId: string; amount: string }
  | { assetType: 'COUNTERPARTY'; assetId: string; name: string; quantitySats: string };

export interface AssetInventory {
  examined?: unknown;
  inscriptions?: unknown[];
  rareSatRanges?: unknown[];
  runeAllocations?: unknown[];
  counterpartyAssets?: unknown[];
  unknownClaims?: unknown[];
}

/** Validate one input's inventory and list the assets it carries. */
export function readInventory(
  inventory: AssetInventory | undefined | null,
  index: number,
  value: bigint,
  outpoint: { txid: string; vout: number }
): { assets: InventoryAsset[] } | AssetFlowRefusal {
  if (!inventory || typeof inventory !== 'object' || inventory.examined !== true) {
    return refuse('INVENTORY_UNEXAMINED', `Input ${index} was never examined against the protocol authorities.`);
  }
  const bad = (what: string): AssetFlowRefusal => refuse('INVENTORY_INVALID', `Input ${index} ${what}.`);
  const record = inventory as Record<string, unknown>;
  for (const field of ['inscriptions', 'rareSatRanges', 'runeAllocations', 'counterpartyAssets', 'unknownClaims']) {
    if (record[field] !== undefined && !Array.isArray(record[field])) return bad(`lists ${field} as something other than an array`);
  }
  const claims = listOf(inventory.unknownClaims);
  if (claims.length > 0) {
    return refuse(
      'UNKNOWN_CLAIM_FAILS_CLOSED',
      `Input ${index} carries an unrecognized claim (${String(claims[0])}); resolve it before planning.`
    );
  }
  const assets: InventoryAsset[] = [];
  for (const raw of listOf(inventory.inscriptions)) {
    const entry = raw as { inscriptionId?: unknown; offset?: unknown; satpoint?: unknown } | null;
    const offset = parseSats(entry?.offset);
    if (!entry || typeof entry.inscriptionId !== 'string' || !INSCRIPTION_ID.test(entry.inscriptionId)) {
      return bad('names an inscription without a valid inscription id');
    }
    if (offset === null || offset >= value) return bad(`places ${entry.inscriptionId} at an offset the input does not have`);
    if (entry.satpoint !== undefined && entry.satpoint !== `${outpoint.txid}:${outpoint.vout}:${String(entry.offset)}`) {
      return bad(`gives ${entry.inscriptionId} a satpoint that is not this input at this offset`);
    }
    assets.push({ assetType: 'ORDINAL', assetId: entry.inscriptionId, offset, count: 1n });
  }
  for (const raw of listOf(inventory.rareSatRanges)) {
    const entry = raw as { rangeId?: unknown; offset?: unknown; count?: unknown } | null;
    const offset = parseSats(entry?.offset);
    const count = parseSats(entry?.count);
    if (!entry || typeof entry.rangeId !== 'string' || entry.rangeId.length === 0) return bad('names a rare sat range without an id');
    if (offset === null || count === null || count === 0n || offset + count > value) {
      return bad(`places rare sat range ${entry.rangeId} outside the input`);
    }
    assets.push({ assetType: 'RARE_SAT', assetId: entry.rangeId, offset, count });
  }
  const runes = new Set<string>();
  for (const raw of listOf(inventory.runeAllocations)) {
    const entry = raw as { runeId?: unknown; amount?: unknown } | null;
    if (!entry || typeof entry.runeId !== 'string' || !RUNE_ID.test(entry.runeId) || parseSats(entry.amount) === null) {
      return bad('lists a rune balance without an exact rune id and amount');
    }
    if (runes.has(entry.runeId)) return bad(`lists rune ${entry.runeId} twice`);
    runes.add(entry.runeId);
    assets.push({ assetType: 'RUNE', assetId: entry.runeId, amount: entry.amount as string });
  }
  for (const raw of listOf(inventory.counterpartyAssets)) {
    const entry = raw as { name?: unknown; assetId?: unknown; quantitySats?: unknown } | null;
    const quantity = parseSats(entry?.quantitySats);
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      typeof entry.assetId !== 'string' ||
      !DECIMAL.test(entry.assetId) ||
      quantity === null ||
      quantity === 0n
    ) {
      return bad('lists a Counterparty attachment without a name, a numeric asset id and an exact quantity');
    }
    assets.push({ assetType: 'COUNTERPARTY', assetId: entry.assetId, name: entry.name, quantitySats: entry.quantitySats as string });
  }
  return { assets };
}

function outputAt(outputValues: bigint[], position: bigint): number {
  let end = 0n;
  for (let j = 0; j < outputValues.length; j += 1) {
    end += outputValues[j] ?? 0n;
    if (position < end) return j;
  }
  return -1;
}

export interface AssetMovement {
  assetType: string;
  assetId: string;
  fromInput?: number;
  toOutput: number;
  quantity: string;
}

export interface FlowInput {
  outpoint: { txid: string; vout: number };
  value: bigint;
  assets: InventoryAsset[];
}

/**
 * Derive every asset movement of a transaction. Runes are fungible and name
 * no input.
 */
// OX-P01, OX-P02: one derivation feeds SafeOps and swaps, so neither verifier can
// fall back to a shared first-sat rule for assets whose protocol moves them otherwise.
export function deriveAssetFlow(args: {
  network: unknown;
  height: number;
  inputs: FlowInput[];
  outputs: Array<{ scriptHex: string; valueSats: string }>;
}): { ok: true; movements: AssetMovement[] } | AssetFlowRefusal {
  const { network, height, inputs, outputs } = args;
  const outputValues = outputs.map((o) => BigInt(o.valueSats));
  const scripts = outputs.map((o) => o.scriptHex);
  const movements: AssetMovement[] = [];

  let inputStart = 0n;
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i] as FlowInput;
    for (const asset of input.assets) {
      if (asset.assetType !== 'ORDINAL' && asset.assetType !== 'RARE_SAT') continue;
      const start = inputStart + asset.offset;
      const first = outputAt(outputValues, start);
      const last = outputAt(outputValues, start + asset.count - 1n);
      if (first === -1 || last === -1) {
        return refuse('ASSET_TO_FEE', `${asset.assetType} ${asset.assetId} would land in the fee and be lost to the miner.`);
      }
      if (first !== last) {
        return refuse('RARE_SAT_RANGE_SPLIT', `Rare sat range ${asset.assetId} would be split across outputs ${first} and ${last}.`);
      }
      movements.push({ assetType: asset.assetType, assetId: asset.assetId, fromInput: i, toOutput: first, quantity: asset.count.toString() });
    }
    inputStart += input.value;
  }

  if (inputs.some((input) => input.assets.some((a) => a.assetType === 'RUNE'))) {
    const allocation = allocateRunes(
      scripts,
      inputs.map((input) => ({
        indexed: true,
        balances: input.assets.flatMap((a) => (a.assetType === 'RUNE' ? [{ runeId: a.assetId, amount: a.amount }] : [])),
      }))
    );
    if (!allocation.ok) return refuse(allocation.code, allocation.reason);
    if (allocation.burned.length > 0) {
      return refuse(
        allocation.runestone === 'CENOTAPH' ? 'CENOTAPH_BURNS_BALANCE' : 'ALLOCATION_BURNS_BALANCE',
        'Confirming this transaction would destroy rune balances its inputs carry.'
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
          attachments: input.assets.flatMap((a) =>
            a.assetType === 'COUNTERPARTY' ? [{ name: a.name, assetId: a.assetId, quantitySats: a.quantitySats }] : []
          ),
        })),
        outputs: scripts.map((scriptHex) => ({ scriptHex })),
      },
      { network, height }
    );
    if (!outcome.ok) return refuse(outcome.code, outcome.reason);
    if (outcome.operation !== 'MOVE') {
      return refuse(
        'COUNTERPARTY_NOT_MOVED',
        `Counterparty would ${outcome.operation === 'STRANDED' ? 'strand' : 'detach'} the attached assets instead of moving them.`
      );
    }
    for (const moved of outcome.moved) {
      const toOutput = moved.toOutput as number;
      if ((scripts[toOutput] ?? '').startsWith('6a')) {
        return refuse('ASSET_TO_FEE', `Counterparty asset ${moved.assetId} would be credited to an unspendable output.`);
      }
      movements.push({ assetType: 'COUNTERPARTY', assetId: moved.assetId, fromInput: moved.fromInput, toOutput, quantity: moved.quantitySats });
    }
  }

  return { ok: true, movements };
}

export interface StatedTransition {
  assetType: string;
  assetId: string;
  fromInput?: number;
  toOutput: number;
  quantity: string;
}

const transitionKey = (t: { assetType: string; assetId: string; fromInput?: number | undefined; toOutput: number; quantity: string }): string =>
  `${t.assetType}|${t.assetId}|${t.fromInput ?? ''}|${t.toOutput}|${t.quantity}`;

/** Validate the shape of stated transitions against an output count. */
export function checkTransitionShapes(transitions: unknown, outputCount: number): { ok: true } | AssetFlowRefusal {
  if (!Array.isArray(transitions)) return refuse('TRANSITION_INVALID', 'Expected an assetTransitions array.');
  for (const raw of transitions) {
    const t = raw as { assetType?: unknown; assetId?: unknown; toOutput?: unknown; quantity?: unknown } | null;
    if (!t || typeof t !== 'object' || typeof t.assetType !== 'string' || typeof t.assetId !== 'string') {
      return refuse('TRANSITION_INVALID', 'Every asset transition names an asset type and id.');
    }
    if (typeof t.toOutput !== 'number' || !Number.isInteger(t.toOutput) || t.toOutput < 0 || t.toOutput >= outputCount) {
      return refuse('TRANSITION_OUTPUT_MISSING', `Asset ${t.assetType}:${t.assetId} names output ${String(t.toOutput)}, which does not exist.`);
    }
    if (parseSats(t.quantity) === null) return refuse('TRANSITION_INVALID', `Asset ${t.assetType}:${t.assetId} carries no exact quantity.`);
  }
  return { ok: true };
}

/**
 * Require stated transitions to equal derived movements as a complete
 * multiset. Runes compare as totals per output and rune.
 */
export function matchTransitions(transitions: StatedTransition[], movements: AssetMovement[]): { ok: true } | AssetFlowRefusal {
  const sum = (list: Array<{ toOutput: number; assetId: string; quantity: string }>): Map<string, bigint> => {
    const totals = new Map<string, bigint>();
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
      `Output ${output} would receive ${(actual.get(mismatch) ?? 0n).toString()} of rune ${runeId}, not the ${(planned.get(mismatch) ?? 0n).toString()} stated.`
    );
  }

  const stated = new Map<string, number>();
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
          : `${d.assetType} ${d.assetId} has no destination in the asset transitions.`
      );
    }
    stated.set(key, count - 1);
  }
  for (const [key, count] of stated) {
    if (count > 0) return refuse('TRANSITION_UNEXPECTED', `A transition states a movement no input asset makes: ${key.split('|').slice(0, 2).join(' ')}.`);
  }
  return { ok: true };
}
