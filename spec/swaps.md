# Atomic swap links and the OTC desk

Status: active at protocol 1.2. Artifacts: `ordex.swap-intent/v1`, `ordex.swap-acceptance-plan/v2`, `ordex.swap-signed-transaction/v1`. Reference verifier: `verifier/swaps.js`. Vectors: `conformance/swap-vectors.json`.

A swap is a non-custodial, asset-for-asset exchange settled in exactly one Bitcoin transaction: either both sides move exactly as agreed or nothing moves. There is no prefunded output, no escrow, no policy signer, no server signature, and no counterparty risk beyond the usual mempool economics. This is not the 1.1 funded offer system and does not share its runtime.

## The two stage model

1. The maker signs a `swap-intent/v1`: what they give (exact outpoints), what they require (exact criteria), where they receive, their fee budget, and an expiry.
2. When a taker selects exact eligible inputs, the gateway builds one deterministic acceptance plan: a single transaction spending the maker's committed outpoints and the taker's selected outpoints, paying exact consideration to the maker receive script and delivering exact assets to the taker. Each participant signs only their own inputs. The transaction is relayed only after every required signature exists, the complete transaction passes node preflight, and the user takes the explicit broadcast action.

The maker never pre-signs a transaction before the taker's inputs exist. Non-interactive sighash constructions may only be introduced through new conformance vectors that prove the maker's assets, requested consideration, destination, and fee cannot change; until then the interactive two-party flow is the only path.

## The intent

An intent carries: maker identity proof (BIP-322 over the intent digest, verified by the gateway before publication), network, visibility (`PUBLIC` or `PRIVATE`), the maker receive script, exact gives (asset type, outpoint, exact quantity), exact requires (asset type, asset id or inscription id, minimum quantity), the maximum maker fee contribution, expiry height after the signed checkpoint, a nonce, the protocol adapter versions, an optional taker binding, and the digest. The digest is SHA-256 over the sorted-key JSON of everything except the identity proof and the digest itself.

Public intents may be indexed and streamed. Private intents are never listed, never logged in plaintext, and never exposed in events.

## Private encrypted links

A private link is created client side: a random 256-bit key encrypts the intent with an authenticated cipher, only the ciphertext and routing metadata reach the server, and the key travels in the URL fragment, which browsers never send. Sharing is by link or QR. Links expire and can be destroyed. The server cannot read the terms, and logs never contain the fragment, the key, or decrypted payloads. Optionally the intent binds to a taker BIP-322 identity so the link alone is insufficient.

## The acceptance plan

The builder revalidates every maker outpoint at a checkpoint, resolves the taker's selection and its receive and change scripts, reads the authorities' inventory of every input, and produces one immutable plan, `ordex.swap-acceptance-plan/v2`, with its digest. The plan fixes the transaction version and locktime, every input's outpoint, party, value, script, sequence and inventory, every output, the asset transitions, and the fee split. A v1 plan is refused (`SCHEMA_UNSUPPORTED`) and built again.

Every asset movement is derived, not declared: inscriptions and rare sat ranges follow their absolute sat position, runes the ord 0.29.0 allocation, and Counterparty attachments the Counterparty Core move rule. The stated transitions must equal the derived movements exactly. The verifier proves:

1. Both parties contribute inputs and receive outputs; a one-sided transaction cannot settle (`ATOMICITY_IMPOSSIBLE`).
2. Every input commits to every output with SIGHASH_ALL (`UNCLOSED_SIGHASH`). With that closure, a transaction carrying only one party's signatures cannot confirm, so refusing the final signature can stall a swap but can never take the other party's asset.
3. The plan was built from this intent, on its network, at a checkpoint no earlier than the intent's and in time to confirm before it expires (`INTENT_DIGEST_MISMATCH`, `NETWORK_MISMATCH`, `CHECKPOINT_INVALID`, `INTENT_EXPIRED`). A taker-bound intent needs that taker's identity proof (`TAKER_BINDING_MISMATCH`).
4. Every maker-committed outpoint is spent exactly once, by the maker side, and carries what the intent gives (`MAKER_OUTPOINT_MISSING`, `MAKER_OUTPOINT_REASSIGNED`, `INPUT_DUPLICATED`, `GIVE_NOT_HELD`); no uncommitted maker input appears (`UNEXPECTED_MAKER_INPUT`).
5. Every output pays the maker receive script or a taker script, and the two sets never overlap (`OUTPUT_UNOWNED`, `PARTY_SCRIPTS_OVERLAP`). The only other output allowed is one zero-value runestone when runes move.
6. Every given asset reaches the taker receive script with its exact quantity (`MAKER_ASSET_NOT_DELIVERED`, `GIVE_QUANTITY_MISMATCH`). Every required asset reaches the maker receive script in at least its quantity, judged by asset identity and never by a BTC value: an inscription whole, a rare sat range by count, a rune or Counterparty asset by the maker's net gain (`CONSIDERATION_SHORTFALL`). Every other asset returns to its owner (`ASSET_MISDIRECTED`).
7. The adapters the intent relies on are ones this verifier runs, and an inscription is exchanged with quantity 1 (`ADAPTER_UNSUPPORTED`, `QUANTITY_UNSUPPORTED`).
8. Fee shares come from value flow, not labels. The postage of a sat-bound asset moves with the asset. With that, the maker's share is its BTC requirement, minus its BTC gives, minus its net BTC change; it must stay inside the intent budget, and the declared split must equal the computed one (`FEE_BUDGET_EXCEEDED`, `CONSIDERATION_SHORTFALL`, `FEE_SPLIT_INVALID`, `FEE_CHANGED`). The carrier sats of a rune or Counterparty output count as BTC.

`verifySwapSignedTransaction` then proves the fully signed settlement from its bytes: it is exactly the planned transaction, and every input of both parties carries a signature that verifies with SIGHASH_ALL or the Taproot default (`TRANSACTION_CHANGED`, `SIGNATURE_MISSING`, `SIGNATURE_INVALID`, `UNCLOSED_SIGHASH`).

<!-- OX-P02: v2 replaced a BTC-value consideration check and a first-sat shortcut
with derived, protocol-specific movements judged per party, so a missing Rune
(P-R09) or a maker asset paid back to the maker (P-R10) is refused. -->

## Lifecycle

DRAFT, LIVE, PRIVATE, MATCHING, AWAITING_MAKER_SIGNATURE, AWAITING_TAKER_SIGNATURE, READY_FOR_PREFLIGHT, READY_FOR_BROADCAST, MEMPOOL, CONFIRMED, EXPIRED, WITHDRAWN, CONFLICTED, INVALIDATED, REORGED. A swap becomes unavailable immediately when a committed outpoint is spent, ownership changes, an authority goes stale, or the intent expires. Every transition appends an event; a reorg appends an explicit reverted event.

## Settlement cohort

Production settlement ships for BTC to Ordinal, Ordinal to BTC, Ordinal to Ordinal, BTC to Rare Sat, Rare Sat to BTC, Rune to BTC, BTC to Rune, Rune to Rune, and Counterparty UTXO-attached assets through the heritage adapter. A protocol joins only when an exact ownership resolver, transaction builder, signed-transaction verifier, settlement reconciler, and reorg handler all exist for it. A portfolio reader alone never qualifies a protocol.

## Adversarial coverage

The vectors and production tests cover counterfeit asset claims, spent maker and taker inputs, wrong network, changed recipients, output reordering, fee theft, hidden extra outputs, asset-bearing change, unexpected OP_RETURN, rune cenotaphs, partial signatures, wrong sighash, replayed and expired intents, ciphertext tampering, taker identity substitution, mempool conflict, reorg, and one party refusing the final signature.
