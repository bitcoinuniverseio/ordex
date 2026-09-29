import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COUNTERPARTY_UTXO_ACTIVATION,
  counterpartyMoveDestination,
  counterpartyMoveOutcome,
  counterpartyUtxoGates,
  verifyCounterpartyLedgerEvents,
} from './counterparty-asset.js';

// OX-P10: parity with Counterparty Core v11.4.0 (commit e4d13156):
// gettxinfo.py select_utxo_destination and get_utxos_info, move.py move_assets,
// blocks.py parse_tx ordering, and protocol_changes.json activation heights.

const P2WPKH = '0014' + 'bb'.repeat(20);
const P2TR = '5120' + 'aa'.repeat(32);
const TX_A = 'a'.repeat(64);
const TX_C = 'c'.repeat(64);
const SPEND_TXID = 'f'.repeat(64);
const RAREPEPE = { name: 'RAREPEPE', assetId: '137', quantitySats: '1' };
const PEPECASH = { name: 'PEPECASH', assetId: '18279', quantitySats: '100' };
const MAINNET = { network: 'mainnet', height: 900001 };

test('select_utxo_destination: the first output Counterparty does not pass over', () => {
  const cases = [
    [[P2WPKH, P2TR], 0],
    [['6a0401020304', P2WPKH], 1],
    [['6a', '6a5d0100', P2TR], 2],
    // An empty script raises inside script_to_asm, and a DecodeError is a destination.
    [['', P2WPKH], 0],
    // A push that runs past the end fails to decode: a destination, OP_RETURN or not.
    [['6a4c', P2WPKH], 0],
    [['6a5d04', P2WPKH], 0],
    // asm renders a one-byte push of 0x6a exactly like OP_RETURN.
    [['016a', P2WPKH], 1],
    // A script ending in OP_CHECKMULTISIG has its first element turned into an int.
    [['6a51ae', P2WPKH], 0],
    [['ae', P2WPKH], 0],
    [['6a01ae', P2WPKH], 0],
    [['6a0401020304', '6a'], null],
  ];
  for (const [scripts, expected] of cases) {
    assert.equal(counterpartyMoveDestination(scripts), expected, scripts.join(','));
  }
  assert.equal(counterpartyMoveDestination(['6A']), undefined);
  assert.equal(counterpartyMoveDestination(null), undefined);
});

test('activation gates are exact at the pinned heights', () => {
  assert.deepEqual(counterpartyUtxoGates('mainnet', 865999), { utxoSupport: false, spendUtxoToDetach: false });
  assert.deepEqual(counterpartyUtxoGates('mainnet', 866000), { utxoSupport: true, spendUtxoToDetach: false });
  assert.deepEqual(counterpartyUtxoGates('mainnet', 871899), { utxoSupport: true, spendUtxoToDetach: false });
  assert.deepEqual(counterpartyUtxoGates('mainnet', 871900), { utxoSupport: true, spendUtxoToDetach: true });
  assert.deepEqual(counterpartyUtxoGates('testnet', 3195136), { utxoSupport: true, spendUtxoToDetach: false });
  assert.deepEqual(counterpartyUtxoGates('testnet', 3195137), { utxoSupport: true, spendUtxoToDetach: true });
  for (const network of ['signet', 'testnet4', 'regtest']) {
    assert.deepEqual(counterpartyUtxoGates(network, 0), { utxoSupport: true, spendUtxoToDetach: true });
  }
  assert.equal(counterpartyUtxoGates('bitcoin', 1), null);
  assert.equal(counterpartyUtxoGates('mainnet', -1), null);
  assert.equal(Object.isFrozen(COUNTERPARTY_UTXO_ACTIVATION.mainnet), true);
});

const tx = (inputs, outputs, extra = {}) => ({
  inputs: inputs.map(([txid, vout, attachments]) => ({ txid, vout, attachments })),
  outputs: outputs.map((scriptHex) => ({ scriptHex })),
  ...extra,
});

test('every attached asset of every input moves to the one destination', () => {
  const outcome = counterpartyMoveOutcome(
    tx([[TX_A, 0, [PEPECASH]], [TX_C, 2, [RAREPEPE]]], ['6a0401020304', P2WPKH, P2TR]),
    MAINNET
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.operation, 'MOVE');
  assert.equal(outcome.destinationIndex, 1);
  assert.deepEqual(
    outcome.moved.map((m) => [m.fromInput, m.source, m.name, m.quantitySats, m.toOutput]),
    [
      [0, `${TX_A}:0`, 'PEPECASH', '100', 1],
      [1, `${TX_C}:2`, 'RAREPEPE', '1', 1],
    ]
  );
});

test('each operation is distinct and follows the active gates', () => {
  const inputs = [[TX_C, 2, [RAREPEPE]]];
  assert.equal(counterpartyMoveOutcome(tx([[TX_A, 0, []]], [P2WPKH]), MAINNET).operation, 'NONE');
  assert.equal(counterpartyMoveOutcome(tx(inputs, ['6a']), MAINNET).operation, 'DETACH_BY_SPEND');
  assert.equal(counterpartyMoveOutcome(tx(inputs, ['6a']), { network: 'mainnet', height: 871899 }).operation, 'STRANDED');
  assert.equal(
    counterpartyMoveOutcome(tx(inputs, [P2WPKH], { counterpartyMessage: 'detach' }), MAINNET).operation,
    'DETACH_MESSAGE'
  );
  // Before spend_utxo_to_detach a detach id is no supported message, so the move runs.
  assert.equal(
    counterpartyMoveOutcome(tx(inputs, [P2WPKH], { counterpartyMessage: 'detach' }), { network: 'mainnet', height: 870000 })
      .operation,
    'MOVE'
  );
  assert.equal(counterpartyMoveOutcome(tx(inputs, [P2WPKH], { counterpartyMessage: 'attach' }), MAINNET).operation, 'MOVE');
  assert.equal(counterpartyMoveOutcome(tx(inputs, [P2WPKH]), { network: 'mainnet', height: 865000 }).code, 'UTXO_SUPPORT_INACTIVE');
});

test('incomplete or malformed observations are refused, never guessed', () => {
  assert.equal(counterpartyMoveOutcome(tx([[TX_A, 0, undefined]], [P2WPKH]), MAINNET).code, 'INPUT_ATTACHMENTS_UNKNOWN');
  assert.equal(
    counterpartyMoveOutcome(tx([[TX_A, 0, [{ name: 'X', assetId: 'X', quantitySats: '1' }]]], [P2WPKH]), MAINNET).code,
    'INPUT_ATTACHMENTS_UNKNOWN'
  );
  assert.equal(counterpartyMoveOutcome(tx([[TX_A, 0, []], [TX_A, 0, []]], [P2WPKH]), MAINNET).code, 'OUTPOINT_DUPLICATED');
  assert.equal(counterpartyMoveOutcome(tx([[TX_A, 0, []]], ['zz']), MAINNET).code, 'OUTPUT_SCRIPT_INVALID');
  assert.equal(counterpartyMoveOutcome(tx([[TX_A, 0, []]], [P2WPKH]), { network: 'mainnet' }).code, 'CONTEXT_INVALID');
  assert.equal(counterpartyMoveOutcome(null, MAINNET).code, 'MALFORMED_TRANSACTION');
});

const CHECKPOINT = { height: 900010, blockHash: '0'.repeat(63) + '1', ledgerHash: 'e'.repeat(64) };
const moveEvent = (overrides = {}) => ({
  event: 'UTXO_MOVE',
  txHash: SPEND_TXID,
  source: `${TX_C}:2`,
  destination: `${SPEND_TXID}:0`,
  asset: 'RAREPEPE',
  quantity: '1',
  status: 'valid',
  ...overrides,
});
const expectation = {
  txHash: SPEND_TXID,
  events: [{ event: 'UTXO_MOVE', source: `${TX_C}:2`, destination: `${SPEND_TXID}:0`, asset: 'RAREPEPE', quantity: '1' }],
};

test('ledger events must match the expected moves exactly once', () => {
  const unrelated = moveEvent({ txHash: 'd'.repeat(64), asset: 'OTHER' });
  assert.equal(verifyCounterpartyLedgerEvents(expectation, { checkpoint: CHECKPOINT, events: [moveEvent(), unrelated] }).ok, true);
  assert.equal(verifyCounterpartyLedgerEvents(expectation, { checkpoint: CHECKPOINT, events: [] }).code, 'LEDGER_EVENT_MISSING');
  assert.equal(
    verifyCounterpartyLedgerEvents(expectation, {
      checkpoint: CHECKPOINT,
      events: [moveEvent(), moveEvent({ asset: 'PEPECASH', quantity: '100' })],
    }).code,
    'LEDGER_EVENT_UNEXPECTED'
  );
  assert.equal(
    verifyCounterpartyLedgerEvents(expectation, { checkpoint: CHECKPOINT, events: [moveEvent({ destination: `${SPEND_TXID}:1` })] }).code,
    'LEDGER_EVENT_UNEXPECTED'
  );
  assert.equal(
    verifyCounterpartyLedgerEvents(expectation, { checkpoint: CHECKPOINT, events: [moveEvent({ status: 'invalid: reorg' })] }).code,
    'LEDGER_EVENT_INVALID'
  );
  assert.equal(
    verifyCounterpartyLedgerEvents(expectation, { checkpoint: { height: 1 }, events: [moveEvent()] }).code,
    'CHECKPOINT_INVALID'
  );
  const detach = {
    txHash: SPEND_TXID,
    events: [{ event: 'DETACH_FROM_UTXO', source: `${TX_C}:2`, destination: 'bc1qowner', asset: 'RAREPEPE', quantity: '1' }],
  };
  assert.equal(
    verifyCounterpartyLedgerEvents(detach, {
      checkpoint: CHECKPOINT,
      events: [moveEvent({ event: 'DETACH_FROM_UTXO', destination: 'bc1qowner' })],
    }).ok,
    true
  );
});
