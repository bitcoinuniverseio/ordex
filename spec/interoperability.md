# Portable orders: import, export, and OpenOrdex

A signed PSBT is the whole order. Everything around it, where it was seen,
what price it claims, what asset it names, is evidence that travels with it,
and evidence never outranks what the node and the ord index prove. This page
states exactly how an order enters an Ordex gateway, how it leaves, and what
a compatible OpenOrdex event must look like.

## Identity is the artifact, not the venue

An order's identity is the digest of its artifact. Import the same signed
PSBT twice, from two venues or two clients, and the gateway holds one order
with two pieces of source evidence, not two orders. The digest is published
on every order as `inspection.digest`.

Two consequences follow:

- A duplicate import cannot change the existing order's terms. The same
  artifact arriving with a different claimed protocol, token, side, or price
  is refused, because one signature cannot mean two different offers.
- New evidence merges. A source not yet recorded is appended, a newly named
  asset claim is appended, and the order's validation is refreshed. A
  withdrawn order stays withdrawn; new evidence does not resurrect it.

## Import: `POST /api/ordex/orders/import`

The request carries the artifact and, optionally, claims: an asset, a price,
a protocol, a token, a side. The gateway inspects the PSBT, verifies the
offered output against Bitcoin Core, verifies the asset claim against the
local ord index, and decides the state itself. A claim can make an order
easier to find; it cannot make an order more verified.

Provenance is restricted. A direct import is recorded as `direct-import`.
The named sources `openordex-nostr802` and `ord-offers` are accepted only
from their own verified source adapters, so a pasted request cannot dress
itself as evidence from a venue nothing actually read.

## OpenOrdex events: `POST /api/ordex/orders/openordex-event`

The gateway accepts OpenOrdex compatible Nostr events of kind `802` and
verifies them completely before anything is imported:

1. `pubkey` must be 64 hexadecimal characters, `sig` 128, `id` 64.
2. `created_at` must be a positive integer.
3. `id` must equal the SHA-256 of the NIP-01 serialization
   `[0, pubkey, created_at, kind, tags, content]`.
4. `sig` must be a valid Schnorr signature by `pubkey` over `id`.

Any failure is a refusal, and an event that passes is recorded as
`openordex-nostr802` evidence with `signatureVerified: true` and the event
id as the source id.

The event's content is the artifact. The tags the gateway reads:

| Tag | Carries |
| --- | --- |
| `i` | The inscription id the order claims to sell. |
| `u` | The outpoint the order claims, as `txid:vout`. |
| `s` | The claimed price in sats. |
| `protocol` | The catalog protocol id. |
| `token` | The token label, where the protocol has one. |
| `t` | The side: `buy` becomes a BID, anything else an ASK. |

The asset claim is used only when both `i` and `u` parse. As everywhere,
these tags are discovery evidence; the node and the ord index decide what is
actually true.

## Export: the envelope and the artifact

`GET /api/ordex/orders/:id/nostr-envelope` answers the unsigned kind 802
event announcing a listing, with the tags above plus `n` (network), `d`
(order id), and `status` (current state). The gateway holds no Nostr keys:
the customer's own NIP-07 signer adds `pubkey`, `id`, and `sig`, the browser
publishes to the relays the customer chooses, and the signed event can then
be handed back through the OpenOrdex import route. A withdrawn order is
refused an envelope, because removing a listing from discovery and then
announcing it again is a contradiction.

Publishing is one directional on purpose. The gateway never subscribes to a
relay, so relay settings change where a listing is announced, never what a
customer sees while browsing this gateway.

`GET /api/ordex/orders/:id/artifact` releases the signed artifact itself. It
is its own rate limited request, answered only while the order is live, so a
browse response can never leak every public ask to a scraper.

## What a source may never do

A source supplies signed order evidence. It may never override ownership,
UTXO state, protocol state, or chain state, and a gateway that lets it has
stopped being an Ordex gateway. Anyone can stand up a venue that repeats a
listing; only the chain can say whether the listing is still real.
