# Counterparty heritage assets v1

Status: active at protocol 1.2. Artifacts: `ordex.counterparty-utxo-asset/v1`. Reference verifier: `verifier/counterparty-asset.js`. Vectors: `conformance/counterparty-asset-vectors.json`.

The heritage market brings legacy and current Counterparty assets, including named assets, numeric assets, subassets, and long names, into the non-custodial Ordex model: UTXO-attached assets, exact PSBT settlement, one transaction, no escrow. Stamps and SRC-20 keep their existing surfaces; nothing here duplicates them.

## Identity

Asset identity is the authoritative numeric Counterparty asset id plus current ledger state. A ticker or name alone is never an identity (`ASSET_ID_REQUIRED`). Records carry the name, the numeric id, divisibility, and the exact atomic quantity as a decimal string.

## The authority

One self-hosted Counterparty Core deployment is the only production authority. A record may be produced only while it reports ready, matches the intended network, reaches the accepted Bitcoin Core height, and carries stable ledger, transaction-list, and message hashes (`AUTHORITY_NOT_READY`). Every record binds the block height, block hash, and ledger hash it was read at, so any consumer can judge freshness. There is no public API fallback in production, ever. A lagging node fails the market closed rather than opening it on stale truth.

## The attachment record

A record states that an exact quantity of one asset is attached to one outpoint right now, controlled by one address, with the co-traveling assets on the same outpoint declared. An undeclared co-traveling asset is how unrelated assets get burned, so the declaration is part of the record and part of every verification that moves the outpoint.

<!-- OX-P10: the move rules below restate Counterparty Core v11.4.0 (commit
e4d1315654b79bb7207cd9f45a8d7b6d5255a290): gettxinfo.py select_utxo_destination,
move.py move_assets, blocks.py parse_tx and protocol_changes.json. An attachment
is a ledger balance on an outpoint, not a sat, so ordinal sat flow never applies. -->

## Attachment follows the spend

An attached balance lives in the Counterparty ledger on an outpoint. It does not ride a sat range. When a transaction spends one or more attached outpoints, Counterparty picks **one destination for all of them**: the first output whose script it does not pass over as `OP_RETURN`. Every positive balance of every attached input is credited to that output, whatever the BTC values and input positions are.

The destination is read from raw script bytes exactly as `select_utxo_destination` reads them:

| Output script | Passed over? |
| --- | --- |
| begins with `OP_RETURN` and decodes cleanly | yes |
| a single push of the byte `0x6a`, which renders like `OP_RETURN` | yes |
| any script that fails to decode, including `OP_RETURN` followed by a truncated push | no, it is a destination |
| an empty script | no, it is a destination |
| any script ending in `OP_CHECKMULTISIG` | no, it is a destination |
| anything else | no, it is a destination |

When there is no destination at all, what happens depends on the network's activation heights:

| Network | UTXO support from | Detach on spend from |
| --- | --- | --- |
| mainnet | 866000 | 871900 |
| testnet (testnet3) | 2925800 | 3195137 |
| testnet4, signet, regtest | 0 | 0 |

With detach on spend active, a spend with no destination returns each balance to its owner address. Before it, the balances stay on the spent outpoint and nothing can move them again.

A Counterparty message in the same transaction changes the order, not the rule. With an attach message the existing attachments still move to the destination after the attach is parsed. With a detach message the automatic move does not run at all: the detach decides where the assets go, and that is an address, not an output.

`counterpartyMoveDestination` returns the destination index, `counterpartyUtxoGates` the active gates, and `counterpartyMoveOutcome` the whole outcome of a spend: `NONE`, `MOVE`, `DETACH_BY_SPEND`, `STRANDED` or `DETACH_MESSAGE`, with every asset listed from its source input. The outcome needs the ledger's attachment list for **every** input, `[]` for none (`INPUT_ATTACHMENTS_UNKNOWN`), because any attached input moves to the same output as the one being traded.

`verifyAttachmentFollows` checks one recorded attachment against a planned spend and refuses when:

1. The plan names no real output (`DESTINATION_MISSING`), no input spends the recorded outpoint (`OUTPOINT_NOT_SPENT`) or it appears twice (`OUTPOINT_DUPLICATED`).
2. The spent value differs from the record (`SOURCE_VALUE_MISMATCH`).
3. An input lacks its ledger attachment list, an output script is not hex, or the message kind is unknown (`INPUT_ATTACHMENTS_UNKNOWN`, `OUTPUT_SCRIPT_INVALID`, `COUNTERPARTY_MESSAGE_UNKNOWN`).
4. UTXO support is not active at the height the spend is evaluated at, by default the record's checkpoint height plus one (`UTXO_SUPPORT_INACTIVE`).
5. The ledger lists different assets on the outpoint than the record declares (`ATTACHMENT_INVENTORY_MISMATCH`).
6. Another input carries attachments that would co-move to the same output (`OTHER_ATTACHMENTS_COMOVE`).
7. The spend detaches instead of moving (`DETACH_NOT_A_MOVE`, `NO_DESTINATION_DETACHES`) or strands the balance (`NO_DESTINATION_STRANDS`).
8. Counterparty credits another output than the plan names (`DESTINATION_MISMATCH`), or the credited output begins `OP_RETURN` and can never be spent (`DESTINATION_UNSPENDABLE`).

After confirmation, and again after any reorg, `verifyCounterpartyLedgerEvents` reconciles the `UTXO_MOVE`, `ATTACH_TO_UTXO` and `DETACH_FROM_UTXO` events the ledger recorded for the transaction against the exact events the plan expected, at a stated block height, block hash and ledger hash. An event that is missing, unexpected or not valid is refused (`LEDGER_EVENT_MISSING`, `LEDGER_EVENT_UNEXPECTED`, `LEDGER_EVENT_INVALID`).

## Attach and detach

An attach request names the asset by its numeric Counterparty asset id (`assetId`, a decimal string); a name is only an optional display hint that must match the ledger record for that id. Attachment and detachment are composed for the user, never for the service: the composition returns an unsigned PSBT, the exact XCP gas, the exact miner fee, the resulting outpoint, the consequences, and any unrelated assets that would also move. The user signs with their own wallet. The server never holds XCP, BTC, or the attached asset. Composed transactions pass Bitcoin Core preflight before signature, and the expected Counterparty event is confirmed after confirmation; reorgs reverse the marketplace state through explicit reversed events.

## Protection everywhere

Counterparty-attached outputs are never cardinal. SafeOps inventories, wallet selection, marketplace funding, swaps, and consolidations all read the same attachment registry, and an operation that would move an attached outpoint without preserving its complete declared inventory fails closed.

## Trading path

Listings are Ordex asks over the attached outpoint, but the sat-flow invariant that places an inscription does not place an attachment. A heritage settlement is built so that the buyer's receive output is the first output Counterparty does not pass over, with no other attached input in the transaction, and `verifyAttachmentFollows` must accept that exact output before anyone signs. Legacy dispensers and order history may be displayed read-only with clear labeling. Nothing in the product sends BTC to a legacy dispenser address or encourages it.

## Readiness gates

The heritage surface answers `GET /api/ordex/heritage/readiness` with server readiness, network, checkpoint, ledger hash, and lag. Listing, buying, attach, detach, and swap surfaces are actionable only while readiness holds, and every response names the authority it proved against.
