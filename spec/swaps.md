# Atomic swap links and the OTC desk v1

Status: active at protocol 1.2. Artifacts: `ordex.swap-intent/v1`, `ordex.swap-acceptance-plan/v1`. Reference verifier: `verifier/swaps.js`. Vectors: `conformance/swap-vectors.json`.

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

The builder revalidates every maker outpoint, resolves the taker's selection, orders inputs for sat-flow safety, and produces one immutable unsigned-transaction digest. The verifier proves:

1. Both parties contribute inputs and outputs; a one-sided transaction cannot settle (`ATOMICITY_IMPOSSIBLE`).
2. Every input commits to every output with SIGHASH_ALL (`UNCLOSED_SIGHASH`). With that closure, a transaction carrying only one party's signatures cannot confirm, so refusing the final signature can stall a swap but can never take the other party's asset.
3. Every maker-committed outpoint is spent exactly once, by the maker side (`MAKER_OUTPOINT_MISSING`, `MAKER_OUTPOINT_REASSIGNED`, `INPUT_DUPLICATED`), and no uncommitted maker input appears (`UNEXPECTED_MAKER_INPUT`).
4. Every required criterion is paid to the maker receive script at no less than its minimum (`CONSIDERATION_SHORTFALL`).
5. Fee conservation holds, the maker and taker contributions sum to it, and the maker share stays inside the intent budget (`FEE_CHANGED`, `FEE_SPLIT_INVALID`, `FEE_BUDGET_EXCEEDED`).
6. Every given asset and every taker asset is delivered through an explicit transition to the output that receives the input's first sat, so no asset lands in the fee region, in unrelated change, or at the wrong party (`MAKER_ASSET_UNASSIGNED`, `TAKER_ASSET_UNASSIGNED`, `TRANSITION_SAT_FLOW_MISMATCH`).

<!--
IMPLEMENTATION-HANDOFF [OX-P02] Preparation only; functional status FAIL, repair NOT IMPLEMENTED.
Coverage: OX-P-C024, OX-P-C025, OX-P-C026, OX-P-C027, OX-P-C028, OX-P-C029, OX-P-C030, OX-P-C031,
OX-P-C032, OX-P-C033, OX-P-C034. Evidence: P-R09, P-R10 in handoff/evidence.
Verified cause: verifySwapAcceptance satisfies every requires item with a BTC output value, ignores
required asset identity/quantity, and accepts give transitions back to maker script. Shared
first-sat shortcut is wrong for nonzero inscription offsets, Runes, and Counterparty.
Required behavior: Verify bilateral swap consideration and actual destination ownership. Governing
refs: P-S01 (Ord0.29.0 applicability; handbook accessed2026-09-29); P-S02 (Ord0.29.0
commit7e37a3bd3391044b39f5f11f20dfdb8b3764cd0e; runestone
blob98022fb2a25d587a59a4a2ac40cd9de9bc5a6d0b); P-S03 (Ord0.29.0;
blobbce2ae16336368bba3f7d70eed2a1493a67f45c9); P-S06 (BIP341;
blob0764e6cb762b6c17d3b3430af5532e0c63365993); complete URLs in reports/protocol.md.
Prerequisites/order: OX-P01, OX-P03, OX-P04, OX-P10. Related files: verifier/swaps.js,
sdk/src/swaps.ts; Core backend/src/ordex-v12 corresponding service and caller adapters.
1. Resolve complete authoritative input inventories and both parties' controlled receive/change
scripts before construction; enforce maker/taker ownership proof and optional taker binding.
2. Evaluate each consideration by family+asset identity+atomic quantity delivered to
makerReceiveScriptHex using actual protocol allocation, aggregate obligations without double
counting one output; use BTC value only for BTC.
3. Require every maker give reaches authenticated taker receive script with committed quantity and
every unrelated asset is preserved to its owner; require both distinct party input sets and
reconcile actual fee contribution from party value flow, not caller labels.
4. Extend acceptance contract and intent binding where necessary; compare parsed full transaction,
approved sighash, signatures and complete inventories; fail unknown capabilities closed. Correct
spec/swaps.md and mirror SDK; wire Core planner to same verification.
Validation (PROPOSED NEW tests, commands unverified until implemented):
verifier/swaps.consideration.test.js, sdk/test/swaps.consideration.test.js. node --test
verifier/swaps.test.js verifier/swaps.consideration.test.js; npm --prefix sdk run build; node --test
sdk/test/swaps.test.js sdk/test/swaps.consideration.test.js.
Assertions/evidence: Required Rune absent/wrong ID/wrong quantity refuses; Maker give returned to
maker refuses even with taker role label; Distinct parties, no extra outputs/fee theft; every
settlement cohort both directions settles one actual Signet tx; Taker
refusal/expired/withdrawn/private tamper/replay/network mismatch/reorg leaves recoverable truthful
state. Offline probes are not end-to-end PASS; require actual Signet transaction, authoritative
indexed outcome and consumer readback where applicable.
Rollback: Invalidate unbroadcast affected sessions and request fresh participant approval for new
digest; retain private ciphertext, historical intents, signatures and chain outcomes. Stop matching
if corrected adapters unavailable.
-->

## Lifecycle

DRAFT, LIVE, PRIVATE, MATCHING, AWAITING_MAKER_SIGNATURE, AWAITING_TAKER_SIGNATURE, READY_FOR_PREFLIGHT, READY_FOR_BROADCAST, MEMPOOL, CONFIRMED, EXPIRED, WITHDRAWN, CONFLICTED, INVALIDATED, REORGED. A swap becomes unavailable immediately when a committed outpoint is spent, ownership changes, an authority goes stale, or the intent expires. Every transition appends an event; a reorg appends an explicit reverted event.

## Settlement cohort

Production settlement ships for BTC to Ordinal, Ordinal to BTC, Ordinal to Ordinal, BTC to Rare Sat, Rare Sat to BTC, Rune to BTC, BTC to Rune, Rune to Rune, and Counterparty UTXO-attached assets through the heritage adapter. A protocol joins only when an exact ownership resolver, transaction builder, signed-transaction verifier, settlement reconciler, and reorg handler all exist for it. A portfolio reader alone never qualifies a protocol.

## Adversarial coverage

The vectors and production tests cover counterfeit asset claims, spent maker and taker inputs, wrong network, changed recipients, output reordering, fee theft, hidden extra outputs, asset-bearing change, unexpected OP_RETURN, rune cenotaphs, partial signatures, wrong sighash, replayed and expired intents, ciphertext tampering, taker identity substitution, mempool conflict, reorg, and one party refusing the final signature.
