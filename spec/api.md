# The Ordex gateway API

Every route below is served under `/api/ordex`. Amounts and protocol quantities
are atomic integers carried as strings, never as floating point numbers.

The exact request and response shape of every route, field by field, is the
machine readable contract in [openapi.json](openapi.json). This page explains
the decisions; the contract states the wire format, and the two are kept in
step in the same commit.

The contract carries a protocol version. Reads answer `200`. Every write
answers `201`. A client that pins a version gets that version's behavior for
every operation it names; additive operations such as offers, replacement, and
batch purchase arrived at `1.1` without changing any `1.0` operation.

## Reads

| Route | Answers |
| --- | --- |
| `GET /health` | The observed verification verdict, not the configuration. |
| `GET /protocol` | The protocol contract this gateway speaks. |
| `GET /catalog` | The markets this gateway serves, and what it verifies for each. |
| `GET /orders` | One page of the orderbook. |
| `GET /orders/:id` | One order. |
| `GET /activity` | The appended lifecycle log, newest first. |
| `GET /orders/:id/ownership-challenge` | The message a listing owner signs before managing it. |
| `GET /orders/:id/nostr-envelope` | The unsigned kind 802 event announcing this listing, for the seller's own NIP-07 signer. |

`GET /orders/:id/artifact` is separate on purpose. A browse response carrying
raw PSBTs would hand every public ask to anything that can read the market, so
the artifact is its own rate limited request and is released only while the
order is live.

## Paging is keyset, never offset

`GET /orders` takes `limit` and `cursor`, and answers with `nextCursor`.
`nextCursor` is empty when the page is the last one; `hasMore` is derived from
it rather than from a total that concurrent writes can move.

A cursor names the exact row the previous page ended on: its sort column value
and its order id. Every sort ends on the order id, which is unique, so the
ordering is total and the resume point is exact.

This is not decoration. With an offset, a listing sold, withdrawn, repriced, or
reconciled between two reads shifts every later row, and the next page skips a
listing or repeats one. A keyset cursor is unaffected by anything that happens
behind it.

A malformed cursor is a `400`. It is never answered with the first page:
resuming somewhere the caller did not ask for is how a paging client loops
forever without noticing.

Sorts: `newest`, `oldest`, `price_asc`, `price_desc`, `token_asc`,
`protocol_asc`, `validation_newest`. An unpriced order sorts after every priced
one in both price directions.

## Filters

`protocol`, `protocols`, `group`, `token`, `source`, `state`, `safety`,
`orderClass`, `signature`, `side`, `seller`, `search`, `includeWithdrawn`, and
the indexed asset filters `assetInscriptionId` and `assetOutpoint`.

The asset filters resolve through an index of each order's claims, so asking
which orders sell one output reads the few rows that do rather than the whole
book.

## Writes

| Route | Does |
| --- | --- |
| `POST /orders/import` | Takes a signed artifact and verifies it. |
| `POST /orders/openordex-event` | Takes a signed OpenOrdex event and verifies it. |
| `POST /orders/build` | Builds the unsigned seller half. |
| `POST /orders/publish` | Takes the signed seller half and publishes it. |
| `POST /orders/{id}/replace` | Replaces a live ask with a freshly signed one for the same output: the old order leaves the book as `REPLACED` and the new one goes live, in one step. |
| `POST /orders/:id/revalidate` | Rechecks one order against both authorities. |
| `POST /orders/:id/withdraw` | Removes a listing, proved by the key owning the output it sells. |
| `POST /orders/:id/quote` | Composes the buyer half and states the exact terms. |
| `POST /orders/:id/preflight` | Verifies a signed purchase and asks the node whether it would accept it. |
| `POST /orders/batch-purchase` | Composes several live asks into one transaction when every seller half can coexist. See [batch-purchase.md](batch-purchase.md). |
| `POST /orders/batch-preflight` | Verifies a signed batch and asks the node about the exact composed bytes. |
| `POST /offers` | Takes funded-output evidence and exact offer terms, verifies both, and publishes the offer. See [offers.md](offers.md). |
| `GET /offers` | One page of the offer book, keyset paged like the orders. |
| `GET /offers/:id` | One offer with its current lifecycle state and freshness. |
| `POST /offers/:id/revalidate` | Rechecks one offer against both authorities. |
| `POST /offers/:id/withdraw` | Removes an offer from discovery, proved by the buyer's recovery key. |
| `POST /offers/:id/acceptance-plan` | States the exact acceptance arrangement for one live offer against one seller outpoint, preserves included. |
| `POST /offers/:id/preflight` | Verifies a built acceptance, policy signatures included, and asks the node whether it would accept it. |

Every write is rate limited.

One further route exists outside the public surface:
`POST /admin/orders/:id/withdraw` removes a listing as operator moderation. It
requires the operator's HTTP Basic credentials configured on the gateway, and
no public route ever requires them.

## `POST /orders/:id/quote`

The caller names its own outputs and nothing else:

```json
{
  "assetReceiveAddress": "...",
  "paymentAddress": "...",
  "paddingUtxos": [{ "txid": "...", "vout": 0 }, { "txid": "...", "vout": 1 }],
  "fundingUtxos": [{ "txid": "...", "vout": 2 }],
  "feeRateSatsPerVb": 4
}
```

Value and script are read from Bitcoin Core, never taken from the request, so a
buyer cannot make a purchase look cheaper by describing their own funding
wrongly. Each named output is checked against the ord index first.

The answer carries the unsigned buyer half, the index the seller's input and
payment share, and the exact economics: `sellerProceedsSats`,
`marketplaceFeeSats`, `creatorRoyaltySats`, `networkFeeSats`, `changeSats`,
`paddingSats`, `totalBuyerCostSats`, both addresses, the checkpoint, and an
expiry. A fee or a royalty of zero is stated as zero rather than omitted.

See [purchase.md](purchase.md) for the arrangement and why it is the only safe
one.

## `POST /orders/:id/preflight`

Takes either `finalTxHex` or the `signedPsbt` a wallet actually answers with.
Given a PSBT it finalises only inputs the buyer already signed: it creates no
signature and changes no input, output, or amount, and an unsigned input is an
error rather than a guess.

It rechecks the order against the chain, binds the transaction to the order,
proves the sat flow invariant, then asks the node itself whether it would
accept the result. It answers with the exact bytes it checked, so a buyer
broadcasts those and no others.

Ordex does not broadcast. That is the buyer's own step, taken deliberately
after they have seen the node's verdict.
