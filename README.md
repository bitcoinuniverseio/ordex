# Ordex

**Portable Bitcoin orders, verified before you act.**

[![Documentation](https://img.shields.io/badge/docs-live-brightgreen.svg)](https://bitcoinuniverseio.github.io/ordex/)
[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-active-success)](https://bitcoinuniverseio.github.io/ordex/)
[![CI](https://github.com/bitcoinuniverseio/ordex/actions/workflows/ci.yml/badge.svg)](https://github.com/bitcoinuniverseio/ordex/actions/workflows/ci.yml)

> 🌐 **Interactive Documentation & Protocol Workspace**: [https://bitcoinuniverseio.github.io/ordex/](https://bitcoinuniverseio.github.io/ordex/)

Ordex lets signed PSBT order evidence travel across compatible Bitcoin markets. A listing carries the details needed to understand what is being offered, where it came from, and when its inputs were last checked, without handing custody to Ordex.

## Interactive Workspace & Tool Links

Every component of Ordex runs client-side with zero custody, zero tracking, and local verification:

| Workspace / Product | Description | Direct Link |
| :--- | :--- | :--- |
| 🚀 **Ordex Launchpad** | Platform hub, mission progress, and quick onboarding | [Launchpad](https://bitcoinuniverseio.github.io/ordex/) |
| 🧭 **Mission Workspace** | 9 end-to-end mission workflows across 8 standard stages | [Mission Workspace](https://bitcoinuniverseio.github.io/ordex/workspace/) |
| 🧪 **Transaction Sandbox** | 15 deterministic multi-actor protocol scenarios | [Transaction Sandbox](https://bitcoinuniverseio.github.io/ordex/sandbox/) |
| 🔍 **Artifact Lens** | PSBT parser, byte inspector, and mutation detector | [Artifact Lens](https://bitcoinuniverseio.github.io/ordex/inspect/) |
| 🛑 **Failure Navigator** | 172-rule diagnostic engine and remediation assistant | [Failure Navigator](https://bitcoinuniverseio.github.io/ordex/diagnose/) |
| 🤖 **Agent Bridge** | Claude Desktop, Codex, MCP endpoint & integration guides | [Agent Bridge](https://bitcoinuniverseio.github.io/ordex/agents/) |
| 🎬 **Guided Product Tours** | Step-by-step interactive visual tours | [Product Tours](https://bitcoinuniverseio.github.io/ordex/tour/) |
| 🔬 **Protocol Lab** | Sat-flow diagrams and live client-side verifiers | [Protocol Lab](https://bitcoinuniverseio.github.io/ordex/lab/) |
| ⚖️ **Conformance Studio** | 151 deterministic vector test runner & gateway doctor | [Conformance Studio](https://bitcoinuniverseio.github.io/ordex/verify/) |
| 🗺️ **Visual Protocol Atlas** | Animated sat-flow and cryptographic invariant atlas | [Visual Protocol Atlas](https://bitcoinuniverseio.github.io/ordex/atlas/) |
| 📡 **API Reference & Playground** | OpenAPI 3.1 interactive runner for all 78 operations | [API Reference](https://bitcoinuniverseio.github.io/ordex/reference/api/) |
| 🛑 **Refusal Codes Catalog** | 172 error codes, trigger conditions, and remediations | [Refusal Codes](https://bitcoinuniverseio.github.io/ordex/reference/refusal-codes/) |
| 📦 **Integration Kits** | Pinned Node.js, Browser, and Worker starter generators | [Integration Kits](https://bitcoinuniverseio.github.io/ordex/kits/) |

## Why Ordex

- **Portable evidence:** discover the same signed order across compatible venues.
- **Fresh context:** every listing shows when it was last checked, and Ordex checks it again before handing it to your wallet.
- **Clear provenance:** review the publisher, asset claim, order terms, and lifecycle together, with where a listing was published kept separate from what was proven on chain.
- **Owner-only management:** only the key that owns the output a listing sells can remove that listing.
- **User-controlled signing:** your wallet signs your own inputs, and Nostr approval stays inside your NIP-07 signer.
- **Non-custodial by design:** Ordex does not hold funds, does not sign, does not contribute funds, and does not broadcast on its own initiative.

## What Ordex covers

Ordex builds, verifies, and hands over Bitcoin PSBTs. Its markets are Bitcoin PSBT,
Ordinals, Bitmap, BRC-20, TAP, DMT, UNAT, Names, OP Inscriptions, OP-20, OP Names,
Taproot OP_DROP, ARC-20, Runes, Alkanes, Mezcal, and DUST20. Counterparty heritage
assets join at protocol 1.2 through the self-hosted Counterparty authority, with
UTXO-attached settlement and no legacy dispenser path. Dogecoin is still out of
scope, and no Bitcoin transaction is ever presented under a protocol label Ordex
did not verify.

## The 1.2 products

Protocol 1.2 is additive: every 1.0 and 1.1 operation is unchanged.

- **SafeOps and the Execution Shield** ([spec](spec/safeops.md)): an executable
  operations desk for batch sends, ordinal and rune transfers, consolidations,
  RBF, and CPFP, with fail-closed inventory resolution, a shield that re-verifies
  every input before each signature, and post-broadcast monitoring.
- **Atomic Swap Links and the OTC Desk** ([spec](spec/swaps.md)): maker intents,
  encrypted private links, and settlement in exactly one transaction where both
  sides move or nothing does.
- **Realtime Developer Network** ([spec](spec/events.md), [AsyncAPI](spec/asyncapi.json)):
  the ordex-event/v1 envelope over SSE, WebSocket, and signed webhooks, with
  cursor replay and seven-day retention.
- **Counterparty Heritage Market** ([spec](spec/counterparty-utxo-asset.md)):
  UTXO-attached Counterparty assets under one readiness-gated self-hosted
  authority, with the attachment-follow rule proven for every spend.
- **Cold Signer and Watch-Only Mode** ([spec](spec/cold-signing.md)): one
  SignerAdapter for wallet, file, QR, and hardware signing, built on the expected
  transaction manifest and its nine refusals.
- **Collection Provenance Registry** ([spec](spec/collection-manifest.md)):
  creator-signed manifests with offline membership proofs, supersession, and
  revocation.

## Buying is four named steps

Review the purchase, approve it in your wallet, read the node's own verdict,
then send it. The exact price, fee, change, and receiving address are shown
before the wallet prompt, and nothing reaches the network until you ask for it.

Copying the raw signed order is still there for a wallet Ordex cannot drive,
behind a disclosure that says what you take on if you use it.

## Explore the Documentation

- [Getting Started (5-Minute Quickstart)](https://bitcoinuniverseio.github.io/ordex/start)
- [Protocol Concepts & Trust Model](https://bitcoinuniverseio.github.io/ordex/learn)
- [Developer Workflows & Recipes](https://bitcoinuniverseio.github.io/ordex/build)
- [SafeOps & Operations Guide](https://bitcoinuniverseio.github.io/ordex/operate)
- [Technical Reference Overview](https://bitcoinuniverseio.github.io/ordex/reference)
- [Release History](https://bitcoinuniverseio.github.io/ordex/releases)

## Build against Ordex

- [Completing a public ask](spec/purchase.md), and the two rules that decide
  whether the asset reaches the buyer or goes back to the seller
- [Order lifecycle](spec/lifecycle.md)
- [Portable orders](spec/interoperability.md): import, export, and OpenOrdex
- [The gateway API](spec/api.md), explained route by route
- [The OpenAPI 3.1 contract](spec/openapi.json), the same routes field by field
- [The AsyncAPI 3.0 streaming contract](spec/asyncapi.json)
- [The typed SDK](sdk/README.md), generated from that contract
- [Conformance vectors](conformance/purchase-vectors.json) and the
  [reference verifier](verifier/purchase.js) that runs them with `npm test`
- [Security policy](SECURITY.md)

## Stay in control

Ordex is an evidence and discovery layer, not a wallet. Never enter a seed phrase or private key into an Ordex page. Before approving any Bitcoin transaction, review the asset, inputs, outputs, destination, and fee in a wallet you trust. Verification describes a moment in time, so check the order again immediately before settlement. Bitcoin transactions are difficult to reverse once confirmed.
