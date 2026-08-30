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
