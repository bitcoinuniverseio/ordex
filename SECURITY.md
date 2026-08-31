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
