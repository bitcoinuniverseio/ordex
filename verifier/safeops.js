// Reference verifier for Ordex SafeOps v1.
//
// This file restates spec/safeops.md as executable checks. It answers two
// questions about an already prepared operation: is the plan internally
// sound and asset safe, and does a signed result still match the plan the
// user agreed to. Reading live input values, protocol inventories, and
// mempool state from Bitcoin Core, ord, and the other chain authorities is
// the caller's responsibility; the gateway runs those reads first and then
// these same checks.
//
// Every amount is an atomic integer carried as a decimal string and handled
// as BigInt. Floating point never appears here.

import { createHash } from 'node:crypto';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const OPERATION_KINDS = [
  'BTC_BATCH_SEND',
  'ORDINAL_BATCH_TRANSFER',
  'RUNE_BATCH_TRANSFER',
  'CARDINAL_CONSOLIDATION',
  'SPLIT_AND_POSTAGE',
  'RECOVERY',
  'RBF_REPLACE',
  'CPFP_CHILD',
];
const OUTPUT_ROLES = ['recipient', 'change', 'preserve'];
const CARDINAL_ONLY_KINDS = ['BTC_BATCH_SEND', 'CARDINAL_CONSOLIDATION'];
export const SAFEOPS_PLAN_SCHEMA = 'ordex.safeops-plan/v1';
export const SAFEOPS_SIGNED_RESULT_SCHEMA = 'ordex.safeops-signed-result/v1';
export const SAFEOPS_PROTOCOL_MIN = '1.2';

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
 * SHA-256 over the binding content of a plan: everything except the digest
 * itself and the human oriented findings. Lowercase hex.
 */
export function safeopsPlanDigest(plan) {
  const binding = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key === 'digest' || key === 'findings') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}

const refuse = (code, reason) => ({ ok: false, code, reason });

/**
 * The output index that receives the first sat of input `fromInput`: the
 * first output whose accumulated value passes the range start. Returns -1
 * when no output absorbs the range start, meaning those sats can only be
 * the fee.
 */
function firstSatOutputIndex(inputValues, fromInput, outputs) {
  let rangeStart = 0n;
  for (let i = 0; i < fromInput; i += 1) rangeStart += inputValues[i];
  let accumulated = 0n;
  for (let j = 0; j < outputs.length; j += 1) {
    accumulated += parseSats(outputs[j].valueSats);
    if (accumulated > rangeStart) return j;
  }
  return -1;
}

function validOutpoint(outpoint) {
  return (
    !!outpoint &&
    typeof outpoint.txid === 'string' &&
    HEX64.test(outpoint.txid) &&
    Number.isInteger(outpoint.vout) &&
    outpoint.vout >= 0
  );
}

function trackedAssets(inventory) {
  if (!inventory || typeof inventory !== 'object') return [];
  return [
    ...((inventory.inscriptions || []).map((a) => ({ assetType: 'ORDINAL', assetId: a.inscriptionId || a }))),
    ...((inventory.runeAllocations || []).map((a) => ({ assetType: 'RUNE', assetId: a.runeId || a }))),
    ...((inventory.counterpartyAssets || []).map((a) => ({ assetType: 'COUNTERPARTY', assetId: a.assetId || a }))),
    ...((inventory.rareSatRanges || []).map((a) => ({ assetType: 'RARE_SAT', assetId: a.rangeId || a }))),
    ...((inventory.unknownClaims || []).map((a) => ({ assetType: 'UNKNOWN', assetId: String(a) }))),
  ];
}

/**
 * Verify a SafeOps plan.
 *
 * plan:
 *   schema, protocolVersion, network, operationKind, createdAtHeight,
 *   expiryHeight, checkpoint { height, blockHash },
 *   inputs  [{ outpoint {txid, vout}, valueSats, inventory {
 *             examined, inscriptions [], runeAllocations [],
 *             counterpartyAssets [], rareSatRanges [], unknownClaims [] } }],
 *   outputs [{ scriptHex, valueSats, role }],
 *   assetTransitions [{ assetType, assetId, fromInput, toOutput }],
 *   fee { feeSats, maxFeeSats, feeRateSatsPerVb },
 *   signing { requiredIndexes [], sighashType },
 *   findings [], digest
 *
 * Answers { ok: true, digest } or { ok: false, code, reason }.
 */
export function verifySafeOpsPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return refuse('MALFORMED_PLAN', 'Expected a plan object.');
  }
  if (plan.schema !== SAFEOPS_PLAN_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The plan schema is not ordex.safeops-plan/v1.');
  }
  if (typeof plan.protocolVersion !== 'string' || !/^1\.[2-9][0-9]*$/.test(plan.protocolVersion)) {
    return refuse('PROTOCOL_UNSUPPORTED', 'The plan protocol version must be 1.2 or a later 1.x.');
  }
  if (typeof plan.network !== 'string' || !NETWORKS.includes(plan.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof plan.operationKind !== 'string' || !OPERATION_KINDS.includes(plan.operationKind)) {
    return refuse('OPERATION_KIND_UNKNOWN', 'The operation kind is not one this protocol names.');
  }
  if (!Array.isArray(plan.inputs) || plan.inputs.length === 0) {
    return refuse('INPUTS_EMPTY', 'A plan must select at least one input.');
  }
  if (!Array.isArray(plan.outputs)) {
    return refuse('MALFORMED_PLAN', 'Expected an outputs array.');
  }
  if (
    !plan.checkpoint ||
    !Number.isInteger(plan.checkpoint.height) ||
    plan.checkpoint.height < 0 ||
    typeof plan.checkpoint.blockHash !== 'string' ||
    !HEX64.test(plan.checkpoint.blockHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The plan must carry the chain checkpoint it was built against.');
  }
  if (!Number.isInteger(plan.expiryHeight) || plan.expiryHeight <= plan.checkpoint.height) {
    return refuse('EXPIRY_INVALID', 'The expiry height must be a block after the checkpoint height.');
  }
  if (!plan.fee || typeof plan.fee !== 'object') {
    return refuse('FEE_INVALID', 'The plan must carry a fee object.');
  }
  const declaredFee = parseSats(plan.fee.feeSats);
  const maxFee = parseSats(plan.fee.maxFeeSats);
  if (declaredFee === null || maxFee === null || declaredFee < 0n || declaredFee > maxFee) {
    return refuse('FEE_INVALID', 'feeSats and maxFeeSats must be exact decimal strings and fee <= maxFee.');
  }

  // Every selected input must carry an examined inventory. An input whose
  // inventory was never examined is refused, never assumed cardinal.
  let totalIn = 0n;
  const inputValues = [];
  for (let i = 0; i < plan.inputs.length; i += 1) {
    const input = plan.inputs[i];
    if (!validOutpoint(input && input.outpoint)) {
      return refuse('INPUT_OUTPOINT_INVALID', `Input ${i} does not carry a lowercase txid and vout.`);
    }
    const value = parseSats(input && input.valueSats);
    if (value === null) {
      return refuse('INPUT_VALUE_INVALID', `Input ${i} does not carry an exact decimal value.`);
    }
    const inventory = input.inventory;
    if (!inventory || typeof inventory !== 'object' || inventory.examined !== true) {
      return refuse('INVENTORY_UNEXAMINED', `Input ${i} was never examined against the protocol authorities.`);
    }
    const assets = trackedAssets(inventory);
    if (CARDINAL_ONLY_KINDS.includes(plan.operationKind) && assets.length > 0) {
      return refuse(
        'ASSET_IN_CARDINAL_OPERATION',
        `Input ${i} carries ${assets[0].assetType} ${assets[0].assetId}; this operation moves cardinal value only.`,
      );
    }
    if (plan.operationKind === 'RUNE_BATCH_TRANSFER') {
      const hasRune = (inventory.runeAllocations || []).length > 0;
      if (!hasRune) {
        return refuse('RUNE_INPUT_MISSING_ALLOCATION', `Input ${i} carries no rune allocation.`);
      }
    }
    inputValues.push(value);
    totalIn += value;
  }

  let totalOut = 0n;
  for (let i = 0; i < plan.outputs.length; i += 1) {
    const output = plan.outputs[i];
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
    if (typeof output.role !== 'string' || !OUTPUT_ROLES.includes(output.role)) {
      return refuse('OUTPUT_ROLE_UNKNOWN', `Output ${i} does not name a recipient, change, or preserve role.`);
    }
    totalOut += value;
  }

  if (totalIn !== totalOut + declaredFee) {
    return refuse(
      'VALUE_NOT_CONSERVED',
      'The inputs do not equal the outputs plus the declared fee, so the plan cannot be built as written.',
    );
  }

  // Every tracked asset on a selected input must be assigned to exactly one
  // existing output. An unassigned tracked asset could land in the fee
  // region or in unrelated change, so the plan is refused. The destination
  // of a tracked asset is the output that receives the input's first sat:
  // the first output whose accumulated value passes the sat range start.
  const transitions = Array.isArray(plan.assetTransitions) ? plan.assetTransitions : [];
  const transitionKeys = new Set();
  for (let i = 0; i < plan.inputs.length; i += 1) {
    for (const asset of trackedAssets(plan.inputs[i].inventory)) {
      if (asset.assetType === 'UNKNOWN') {
        return refuse(
          'UNKNOWN_CLAIM_FAILS_CLOSED',
          `Input ${i} carries an unrecognized claim (${asset.assetId}); resolve it before planning.`,
        );
      }
      const key = `${asset.assetType}:${asset.assetId}`;
      if (transitionKeys.has(key)) {
        return refuse('ASSET_TRANSITION_DUPLICATED', `Asset ${key} is assigned to more than one transition.`);
      }
      transitionKeys.add(key);
      const transition = transitions.find(
        (t) => t && t.assetType === asset.assetType && t.assetId === asset.assetId,
      );
      if (!transition) {
        return refuse('TRACKED_ASSET_UNASSIGNED', `Asset ${key} has no destination in the asset transitions.`);
      }
      if (!Number.isInteger(transition.fromInput) || transition.fromInput !== i) {
        return refuse(
          'TRANSITION_SOURCE_MISMATCH',
          `Asset ${key} declares input ${transition.fromInput} but rides on input ${i}.`,
        );
      }
      if (!Number.isInteger(transition.toOutput) || !plan.outputs[transition.toOutput]) {
        return refuse('TRANSITION_OUTPUT_MISSING', `Asset ${key} names output ${transition.toOutput}, which does not exist.`);
      }
      if (transition.toOutput !== firstSatOutputIndex(inputValues, i, plan.outputs)) {
        return refuse(
          'TRANSITION_SAT_FLOW_MISMATCH',
          `Asset ${key} declares output ${transition.toOutput}, but the sat range of input ${i} begins in a different output.`,
        );
      }
    }
  }

  if (!Array.isArray(plan.signing) && typeof plan.signing !== 'object') {
    return refuse('SIGNING_INVALID', 'The plan must carry a signing object.');
  }
  if (!Array.isArray(plan.signing.requiredIndexes) || plan.signing.requiredIndexes.length === 0) {
    return refuse('SIGNING_INVALID', 'The plan must name at least one required signing index.');
  }
  for (const index of plan.signing.requiredIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= plan.inputs.length) {
      return refuse('SIGNING_INVALID', `Signing index ${String(index)} is not one of the selected inputs.`);
    }
  }

  const digest = safeopsPlanDigest(plan);
  if (plan.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The plan digest does not match its binding content.');
  }
  return { ok: true, digest };
}

/**
 * Verify a signed SafeOps result against its plan.
 *
 * signed:
 *   schema, planDigest,
 *   tx { inputs  [{ txid, vout, valueSats, signaturePresent, sighashType? }],
 *        outputs [{ scriptHex, valueSats }] }
 */
export function verifySafeOpsSignedResult(signed, plan) {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    return refuse('MALFORMED_SIGNED_RESULT', 'Expected a signed result object.');
  }
  if (signed.schema !== SAFEOPS_SIGNED_RESULT_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The signed result schema is not ordex.safeops-signed-result/v1.');
  }
  const planVerdict = verifySafeOpsPlan(plan);
  if (!planVerdict.ok) return planVerdict;

  if (signed.planDigest !== plan.digest) {
    return refuse(
      'PLAN_DIGEST_MISMATCH',
      'The signed result was not produced from this plan. Refresh the plan and sign again.',
    );
  }
  const tx = signed.tx;
  if (!tx || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) {
    return refuse('MALFORMED_SIGNED_RESULT', 'The signed result must carry transaction inputs and outputs.');
  }

  if (tx.inputs.length !== plan.inputs.length) {
    return refuse('INPUT_SET_CHANGED', 'The signed transaction does not spend exactly the planned inputs.');
  }
  for (let i = 0; i < plan.inputs.length; i += 1) {
    const planned = plan.inputs[i];
    const actual = tx.inputs[i];
    if (!actual || actual.txid !== planned.outpoint.txid || actual.vout !== planned.outpoint.vout) {
      return refuse('INPUT_ORDER_CHANGED', `Input ${i} was reordered or substituted after the plan was agreed.`);
    }
    const value = parseSats(actual && actual.valueSats);
    if (value === null || value !== parseSats(planned.valueSats)) {
      return refuse('INPUT_VALUE_CHANGED', `Input ${i} no longer carries its planned value.`);
    }
  }

  if (tx.outputs.length !== plan.outputs.length) {
    return refuse('OUTPUT_SET_CHANGED', 'The signed transaction does not carry exactly the planned outputs.');
  }
  for (let i = 0; i < plan.outputs.length; i += 1) {
    const planned = plan.outputs[i];
    const actual = tx.outputs[i];
    if (!actual || actual.scriptHex !== planned.scriptHex) {
      return refuse('SCRIPT_CHANGED', `Output ${i} no longer pays the planned script.`);
    }
    if (parseSats(actual && actual.valueSats) !== parseSats(planned.valueSats)) {
      return refuse('VALUE_CHANGED', `Output ${i} no longer carries its planned value.`);
    }
  }

  let totalIn = 0n;
  let totalOut = 0n;
  for (const input of tx.inputs) totalIn += parseSats(input.valueSats);
  for (const output of tx.outputs) totalOut += parseSats(output.valueSats);
  const fee = totalIn - totalOut;
  if (fee !== parseSats(plan.fee.feeSats)) {
    return refuse('FEE_CHANGED', 'The signed transaction fee no longer matches the planned fee.');
  }

  const required = new Set(plan.signing.requiredIndexes);
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const signedInput = tx.inputs[i];
    const hasSignature = signedInput.signaturePresent === true;
    if (required.has(i) && !hasSignature) {
      return refuse('SIGNATURE_MISSING', `Input ${i} is required to sign and is still unsigned.`);
    }
    if (!required.has(i) && hasSignature) {
      return refuse('UNEXPECTED_SIGNATURE', `Input ${i} was not part of the signing policy but carries a signature.`);
    }
    if (hasSignature && plan.signing.sighashType && signedInput.sighashType !== plan.signing.sighashType) {
      return refuse('SIGHASH_CHANGED', `Input ${i} was signed with a different sighash than the plan approved.`);
    }
  }

  return { ok: true };
}
