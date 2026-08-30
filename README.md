# Ordex

**Portable Bitcoin orders, verified before you act.**

Ordex lets signed PSBT order evidence travel across compatible Bitcoin markets. A listing carries the details needed to understand what is being offered, where it came from, and when its inputs were last checked, without handing custody to Ordex.

## Why Ordex

- **Portable evidence:** discover the same signed order across compatible venues.
- **Fresh context:** every listing shows when it was last checked, and Ordex checks it again before handing it to your wallet.
- **Clear provenance:** review the publisher, asset claim, order terms, and lifecycle together, with where a listing was published kept separate from what was proven on chain.
- **Owner-only management:** only the key that owns the output a listing sells can remove that listing.
- **User-controlled signing:** Nostr approval stays inside your NIP-07 signer.
- **Non-custodial by design:** Ordex does not hold funds, sign, fund, combine, broadcast, or settle trades for you.

## What Ordex covers

Ordex builds, verifies, and hands over Bitcoin PSBTs. Its markets are Bitcoin PSBT,
Ordinals, Bitmap, BRC-20, TAP, DMT, UNAT, Names, OP Inscriptions, OP-20, OP Names,
Taproot OP_DROP, ARC-20, Runes, Alkanes, Mezcal, and DUST20. It has no artifact
builder, verifier, or source adapter for Dogecoin or Counterparty assets, so those
markets are not listed and no Bitcoin transaction is ever presented under a
protocol label Ordex did not verify.

## Explore

- [Meet Ordex](docs/index.html)
- [Start safely](docs/quickstart.html)
- [How portable orders work](docs/protocol-guide.html)
- [Get help](docs/troubleshooting.html)

## Stay in control

Ordex is an evidence and discovery layer, not a wallet. Never enter a seed phrase or private key into an Ordex page. Before approving any Bitcoin transaction, review the asset, inputs, outputs, destination, and fee in a wallet you trust. Verification describes a moment in time, so check the order again immediately before settlement. Bitcoin transactions are difficult to reverse once confirmed.
