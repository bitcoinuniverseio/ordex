# Security

## Reporting

Report a suspected vulnerability privately through GitHub Security Advisories
on this repository. Please include what you observed, how to reproduce it, and
what an attacker gains. Do not open a public issue for an unfixed
vulnerability, and do not test against other people's listings or funds.

## What Ordex is, in security terms

Ordex composes and verifies Bitcoin transactions. It never signs, never holds
or contributes funds, never broadcasts on its own initiative, and never asks
for a seed phrase or a private key. A page that asks you for either is not
Ordex.

Chain and protocol facts come from a Bitcoin Core node and protocol indexers
the operator runs. Where an order was published is separate evidence from what
those authorities proved, and Ordex keeps the two apart everywhere it reports.

## The failure this design exists to prevent

A public ask is signed `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`. Composed
carelessly, a purchase is a valid transaction that pays the seller and returns
the asset to them. It is not rejected by any node, and a buyer who did not read
the outputs would not notice until the asset failed to arrive.

[spec/purchase.md](spec/purchase.md) states the two rules that prevent it and
the invariant Ordex checks on every final transaction before a node is asked to
accept it.

## Threats, and the mechanism that answers each

Every mechanism named below is implemented and tested in the gateway; this
table is a map of the code, not a wish list.

| Threat | What answers it |
| --- | --- |
| A seller PSBT arranged so a valid purchase pays the seller and returns them the asset | The two placement rules and the sat flow invariant in [spec/purchase.md](spec/purchase.md), checked on every final transaction before a node is asked. |
| A wallet that mutates the transaction after approval | Preflight rebinds the final bytes to the order's exact terms, refuses any mismatch, and answers with the exact bytes it checked so the buyer broadcasts those and no others. |
| A stale listing raced by another buyer or spent elsewhere | The order is reverified against the chain immediately before quoting and before preflight; a verification past its freshness bound closes the handoff; a public ask is described as raceable, never reserved. |
| A malformed runestone that burns every rune its inputs carry | The runestone is deciphered exactly as the protocol does on every preflight. A cenotaph spending a rune bearing or unexamined input is refused. |
| Padding or funding outputs that carry assets | Every output a buyer names is checked against the ord index before composition; an inscription, a rune balance, or an unexamined output is refused. |
| A request body that lies about values or scripts | Value and script are read from Bitcoin Core, never from the request. |
| A hidden marketplace output | There is none to hide: the gateway adds no fee and no royalty output, and states both as zero. |
| A forged or replayed OpenOrdex event | The event id is recomputed from the NIP-01 serialization, the Schnorr signature is verified, and a replay lands on the same artifact digest, where it merges as evidence instead of creating a second order. |
| A source that repeats a dead or altered listing | Source claims never outrank the node and the ord index; a duplicate artifact cannot change the existing order's terms; named provenance is accepted only from its own verified adapter. |
| A withdrawal by someone other than the seller | Withdrawal requires a signature from the key owning the output the listing sells, over a challenge bound to the order and a time window. |
| Bulk artifact harvesting | The signed artifact is released only through its own rate limited route, and only while the order is live. |
| An outpoint assumed cardinal because one index answered empty | SafeOps inventory resolution requires an examined answer per outpoint, refuses unexamined inputs, and fails closed on any claim it cannot resolve ([spec/safeops.md](spec/safeops.md)). |
| A batch operation that silently drops a tracked asset into fee or change | Every tracked asset in a plan names one destination output, and the destination must be the output receiving the input's first sat; the plan refuses otherwise. |
| A plan that changed between review and signature | The execution shield re-reads every input, protocol claim, and fee immediately before signature and before broadcast, invalidates the signing session on any change, and displays exactly what changed. |
| A wallet or offline signer returning different bytes than presented | The signed result is compared against the expected transaction manifest; changed inputs, outputs, scripts, values, fee bound, asset destinations, sighash types, or foreign signatures each refuse with a stable code ([spec/cold-signing.md](spec/cold-signing.md)). |
| A swap counterparty withholding the final signature | Every swap input commits with SIGHASH_ALL, so a transaction with one party's signatures alone cannot confirm; a stall is possible, asset loss is not ([spec/swaps.md](spec/swaps.md)). |
| A private swap link read by the server | The terms are encrypted client side; only ciphertext and routing metadata reach the server, the key travels in the URL fragment, and logs never contain it. |
| A replayed or forged webhook delivery | Deliveries carry an HMAC-SHA256 signature over timestamp, delivery id, and body digest, verified constant time with a clock tolerance; the SDK verifier enforces both. |
| A webhook worker tricked into calling internal infrastructure | Delivery egress is isolated with allowlist resolution, private-address refusal, redirect and response size bounds, and strict timeouts. |
| A tampered or forged collection manifest | The membership root and document digest recompute from content, the signature address must equal the creator address, and supersession and revocation are creator-signed; the gateway cannot rewrite what signatures protect ([spec/collection-manifest.md](spec/collection-manifest.md)). |
| A Counterparty attachment lost or undeclared across a spend | Attachment records declare co-traveling assets, the spend trace re-derives the destination output, and any mismatch, shortfall, or duplicated outpoint refuses ([spec/counterparty-utxo-asset.md](spec/counterparty-utxo-asset.md)). |
| A lagging Counterparty node answering as truth | The heritage market fails closed unless the self-hosted authority reports ready, fresh, and on-network; there is no public API fallback in production. |
| An xpub or address set uploaded silently | Watch-only profiles stay local by default; any upload needs an explicit warning and an explicit opt-in, and synchronized profiles are encrypted client side. |
| A stream consumer silently missing events | Events come from the transactional outbox, replay by cursor with at-least-once delivery and id deduplication, and reversals are explicit reverted events. |

## Boundaries a compatible client should keep

- Sign the buyer's own inputs only. The seller's half arrives signed; signing
  over it destroys the signature the purchase depends on.
- Never spend an output carrying an inscription or a rune balance as fees or as
  padding. Treat "the index has not examined this output" as unknown, not as
  empty.
- Read amounts from your own node, not from a request body.
- Show the exact asset movement, the exact payment, and the exact fee before
  the wallet prompt, not after it.
- Recheck immediately before releasing an artifact, before signing, and before
  broadcasting. A check describes the moment it ran.
- Treat a public ask as raceable. Do not describe one as reserved.

## Known limits

- Withdrawal removes a listing from discovery. It cannot unpublish a signed
  artifact already distributed elsewhere. Only spending the offered output
  makes such an artifact unusable.
- Verification is a moment, not a guarantee about the next block.
- A confirmed Bitcoin transaction is difficult to reverse.
