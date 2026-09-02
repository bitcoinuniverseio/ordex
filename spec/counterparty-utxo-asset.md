# Counterparty heritage assets v1

Status: active at protocol 1.2. Artifacts: `ordex.counterparty-utxo-asset/v1`. Reference verifier: `verifier/counterparty-asset.js`. Vectors: `conformance/counterparty-asset-vectors.json`.

The heritage market brings legacy and current Counterparty assets, including named assets, numeric assets, subassets, and long names, into the non-custodial Ordex model: UTXO-attached assets, exact PSBT settlement, one transaction, no escrow. Stamps and SRC-20 keep their existing surfaces; nothing here duplicates them.

## Identity

Asset identity is the authoritative numeric Counterparty asset id plus current ledger state. A ticker or name alone is never an identity (`ASSET_ID_REQUIRED`). Records carry the name, the numeric id, divisibility, and the exact atomic quantity as a decimal string.

## The authority

One self-hosted Counterparty Core deployment is the only production authority. A record may be produced only while it reports ready, matches the intended network, reaches the accepted Bitcoin Core height, and carries stable ledger, transaction-list, and message hashes (`AUTHORITY_NOT_READY`). Every record binds the block height, block hash, and ledger hash it was read at, so any consumer can judge freshness. There is no public API fallback in production, ever. A lagging node fails the market closed rather than opening it on stale truth.

## The attachment record

A record states that an exact quantity of one asset is attached to one outpoint right now, controlled by one address, with the co-traveling assets on the same outpoint declared. An undeclared co-traveling asset is how unrelated assets get burned, so the declaration is part of the record and part of every verification that moves the outpoint.

## Attachment follows the spend

When a UTXO carrying an attachment is spent, the asset follows the input range. The destination is the first output whose accumulated value passes the sat range start of the attached outpoint: the same first-sat rule that decides inscription delivery. `verifyAttachmentFollows` re-derives the destination from the spending transaction alone and refuses when:

1. No input spends the recorded outpoint (`OUTPOINT_NOT_SPENT`) or it appears twice (`OUTPOINT_DUPLICATED`).
2. The spent value differs from the record, so the range cannot be traced (`SOURCE_VALUE_MISMATCH`).
3. A readable value is missing anywhere the trace needs one (`INPUT_VALUE_UNKNOWN`, `OUTPUT_VALUE_UNKNOWN`).
4. No output absorbs the range start, meaning the attachment fell into the fee region (`SAT_FLOW_SHORTFALL`).
5. The trace lands on a different output than the plan promised (`DESTINATION_MISMATCH`).

## Attach and detach

Attachment and detachment are composed for the user, never for the service: the composition returns an unsigned PSBT, the exact XCP gas, the exact miner fee, the resulting outpoint, the consequences, and any unrelated assets that would also move. The user signs with their own wallet. The server never holds XCP, BTC, or the attached asset. Composed transactions pass Bitcoin Core preflight before signature, and the expected Counterparty event is confirmed after confirmation; reorgs reverse the marketplace state through explicit reversed events.

## Protection everywhere

Counterparty-attached outputs are never cardinal. SafeOps inventories, wallet selection, marketplace funding, swaps, and consolidations all read the same attachment registry, and an operation that would move an attached outpoint without preserving its complete declared inventory fails closed.

## Trading path

Listings are Ordex asks over the attached outpoint: the seller's signed input commits the outpoint, the buyer's payment output sits at the same index, and the sat-flow invariant guarantees the attachment lands in the buyer's output. Legacy dispensers and order history may be displayed read-only with clear labeling. Nothing in the product sends BTC to a legacy dispenser address or encourages it.

## Readiness gates

The heritage surface answers `GET /api/ordex/heritage/readiness` with server readiness, network, checkpoint, ledger hash, and lag. Listing, buying, attach, detach, and swap surfaces are actionable only while readiness holds, and every response names the authority it proved against.
