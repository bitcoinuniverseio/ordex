# Offers v1

A listing lets a seller name a price and wait. An offer inverts that: a buyer
commits funds first, and a seller who holds an eligible Feline can accept.
This document is the exact contract for the three offer kinds Ordex v1.1
carries, the funded output that holds a buyer's commitment, the acceptance
transaction that settles it, and the recovery path that returns the funds when
no seller ever accepts.

Two sentences describe the trust model honestly, because a customer deciding
whether to post an offer deserves the second one as much as the first:

- A valid acceptance requires two independent policy signers, and after the
  expiry height the buyer can recover alone.
- Before expiry, the two policy signers together could spend the funded
  output outside these rules, so an offer is not trustless, and nothing here
  may describe it as trustless.

Ordex never holds a customer's private key. The policy signers are operated by
the collection deployment that runs a gateway; the protocol only fixes what
they may sign and what every verifier can recheck for itself.

## The three offer kinds

| Kind | Scope | An eligible Feline is one that |
| --- | --- | --- |
| `ITEM` | one exact inscription | has exactly the named inscription ID. |
| `COLLECTION` | a whole collection | is included in the manifest the named collection root commits to. |
| `TRAIT` | one trait value | is included in that root and carries exactly the named trait name and value. |

A collection or trait offer binds to one confirmed collection root. The root is
part of the terms, so acceptance is provable against a fixed manifest instead
of against "whatever the collection is this week". When the collection
publishes a new root, existing offers keep binding the root they were posted
with, and a buyer who wants the new root posts new offers.

## Offer terms

The terms are an object with schema `ordex.offer-terms/v1`:

| Field | Type | Present | Meaning |
| --- | --- | --- | --- |
| `schema` | string | always | The literal `ordex.offer-terms/v1`. |
| `protocolVersion` | string | always | The gateway protocol version the terms were written for, `1.1` or later. |
| `network` | string | always | `mainnet`, `testnet`, `signet`, or `regtest`. |
| `offerKind` | string | always | `ITEM`, `COLLECTION`, or `TRAIT`. |
| `collectionId` | string | always | The collection the scope names. |
| `collectionRoot` | string | always | Lowercase hex SHA-256 collection Merkle root the scope binds to. |
| `itemInscriptionId` | string | `ITEM` only | The exact inscription the offer buys. |
| `traitName` | string | `TRAIT` only | The exact trait name. |
| `traitValue` | string | `TRAIT` only | The exact trait value. |
| `criteriaHash` | string | always | SHA-256 over the exact serialized scope criteria the buyer accepted, so a verifier can recheck scope membership without trusting a description of it. |
| `buyerReceiveScript` | string | always | Lowercase hex script the bought Feline must land in. |
| `priceSats` | string | always | Exact price paid to the seller, atomic sats as a decimal string. |
| `maxNetworkFeeSats` | string | always | The largest fee an acceptance may pay, decimal string. |
| `expiryHeight` | integer | always | Block height after which acceptance is refused and recovery is allowed. |
| `buyerRecoveryKey` | string | always | Lowercase hex x-only key that can recover the funded output alone after `expiryHeight`. |

Every amount is an atomic integer carried as a decimal string. Floating point
never appears. `expiryHeight` is a non-negative safe integer below
2^31, because a locktime that a node cannot parse is a locktime that means
nothing.

The `offerTermsHash` is SHA-256 over the terms serialized as UTF-8 JSON with
object keys sorted recursively and no insignificant whitespace. Two parties
that hold the same terms hold the same hash, and a hash that matches nothing is
refused everywhere. Verifiers recompute it; nobody is asked to trust a hash
they cannot rederive.

## The funded offer output

A posted offer is one Taproot output the buyer funded and signed. Its address
commits to exactly two script leaves, so the output cannot be spent in a way
its address does not describe.

### Acceptance leaf

```
<offerTermsHash 32 bytes> OP_DROP
<policyKeyA> OP_CHECKSIG
<policyKeyB> OP_CHECKSIGADD
OP_2 OP_EQUAL
```

Both policy signatures are required. `CHECKSIGADD` accumulates, so the leaf
evaluates to true only when each independent key signed this exact script, and
the script embeds the terms hash, so the leaf itself, the tree, the Merkle
root, the tweak, and the output address all change if one term changes. No
single policy key can spend the output. The two signatures commit to the
acceptance transaction through the tapscript sighash, so a signer approves one
transaction, not a policy.

### Recovery leaf

```
<expiryHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP
<buyerRecoveryKey> OP_CHECKSIG
```

After the expiry height has been reached, the buyer signs this leaf alone and
takes the whole output back. Before expiry the leaf is unusable, which is what
makes the commitment real for the seller during the window they can accept.

### The policy signers

The two policy keys belong to two independent signer services. Each service
verifies the acceptance policy on its own evidence, keeps its own keys and
credential store, and appends its own audit record before answering. The
protocol constrains what they may sign; the deployment must make them
independent, because two services sharing a credential are one service.

A policy signer answers a signature request only when it independently
proves, from its own authorities:

- the offer output is currently unspent;
- the offer output's committed terms hash equals the hash of the exact offer
  terms presented for acceptance;
- the offered Feline is currently owned by the accepting seller, and its
  current outpoint is the input the acceptance names;
- the Feline belongs to the confirmed collection root in the terms;
- for an `ITEM` offer, the Feline is exactly the named inscription; for a
  `TRAIT` offer, the root, the exact trait name, and the exact trait value all
  match, with an inclusion proof;
- the acceptance pays the buyer's receive script the exact Feline, and pays
  the seller exactly `priceSats`;
- no output takes any other asset from the seller's input, and no output
  exists that the terms do not describe except buyer change;
- the fee is at or below `maxNetworkFeeSats`;
- the current height is below `expiryHeight`;
- the node would accept the transaction.

A signer that cannot prove every line refuses, and a refusal is an answer, not
an error to retry into submission.

## Acceptance

Acceptance is one transaction. The arrangement below is the exact one a
compatible client must build, and every rule after it exists because getting
it wrong produces a valid transaction that pays the wrong party rather than
an invalid one a node rejects:

```
inputs                                outputs
0..k-1  buyer padding inputs          0        merged padding, buyer payment script
k       seller's Feline input         1        buyer asset script, = Feline postage
k+1     the offer output              2..k-1   seller preserves, one per other
                                               asset in the Feline output's sat
                                               range, in sat order
                                      k        seller payment script, = priceSats
                                      last     buyer change, when above dust
```

The seller's input sits at index `k` and signs
`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` against the seller payment output,
which sits at the same index `k`. That is the same half a public ask uses, so
an ask and an offer acceptance are one arrangement a wallet already
understands. The offer output is spent by the acceptance leaf with the two
policy signatures, at the input right after the seller's, so its sats flow
into the seller payment, the change, and the fee, and never backwards over
the Feline's range. The buyer signs nothing at acceptance time; the buyer
signed when funding the offer.

Read against the stream:

- Outputs `0..k-1` absorb exactly `sum(inputs 0..k)`: the padding merge, the
  Feline postage, and every preserve's postage add up to the padding inputs
  plus the whole Feline output value. The equality places the Feline's sat
  range wholly inside output 1 and each preserved asset wholly inside its own
  output, in sat order.
- The payment at index `k` is the first destination the offer output's sats
  reach, and it takes exactly `priceSats`.
- Whatever the offer output funded beyond the price is buyer change or fee,
  and the fee is bounded by the terms.

The rules an acceptance must satisfy, each recheckable by anyone:

1. The offer outpoint is spent exactly once, by the acceptance leaf witness
   carrying both policy signatures against the tree that commits the terms
   hash.
2. The seller's Feline input appears exactly once, and the seller payment
   output sits at the same index with exactly the script and value the
   seller's signature commits to.
3. Outputs ahead of the seller payment absorb the whole sat range the Feline
   input occupies, so the Feline lands whole in the buyer asset output and
   never inside the payment going back to the seller. This is the same
   invariant a purchase checks, with the seller input in the offered role.
4. The seller payment is exactly `priceSats` to the script the terms committed
   to. Not one sat more, not one sat less.
5. The fee actually paid, `sum(inputs) - sum(outputs)`, is at or below
   `maxNetworkFeeSats`.
6. Every other inscription or tracked asset in the seller's Feline output is
   preserved, in sat order, in outputs the seller owns. The buyer receives the
   Feline and nothing else, and the seller loses the Feline and nothing else.
7. The current height is below `expiryHeight`.

The node is the final authority on signature validity and consensus rules.
Ordex refuses a transaction before a node sees it when any of the seven rules
fails, and asks the node whether it would accept the result before anyone
broadcasts.

## Recovery

Recovery is one transaction: the offer output spent by the recovery leaf, with
`nLockTime` at or after `expiryHeight`, paying the entire output value minus
the fee to `buyerReceiveScript`. Anyone may broadcast it; only the buyer's key
can sign it. A recovery attempt before expiry is invalid by consensus, because
`CHECKLOCKTIMEVERIFY` refuses to evaluate before its height, so no one has to
trust a gateway to enforce the calendar.

After a recovery confirms, the offer is `RECOVERED`, and every surface reads
it as closed. After an acceptance confirms, the offer is `ACCEPTED`, and the
orderbook records which order the acceptance settled.

## Offer lifecycle

| State | What it means |
| --- | --- |
| `PENDING_CONFIRMATION` | The funded output is in the mempool or otherwise unconfirmed. The offer is not live. |
| `LIVE` | The funded output is confirmed and unspent, and both authorities currently agree the terms are satisfiable. |
| `ACCEPTED` | A transaction carrying this offer's exact acceptance confirmed. |
| `RECOVERED` | A transaction spending the output by the recovery leaf confirmed. |
| `MEMPOOL_CONFLICTED` | An unconfirmed transaction spends the funded output. It can still be replaced or dropped. |
| `SPENT` | The funded output was spent on chain by a transaction that was neither its acceptance nor its recovery. |
| `EXPIRED` | The current height passed `expiryHeight` with the output unspent. Recovery is now the only path. |
| `WITHDRAWN` | The buyer proved ownership of the recovery key before expiry and removed the offer from discovery. Withdrawal is discovery, not cancellation; only a spend settles the funds. |
| `REJECTED` | The posted evidence was unusable: malformed terms, wrong network, or a root that does not exist. |

An offer that ages past its freshness bound is presented as stale and cannot
be accepted through Ordex until it revalidates, exactly as a listing is.
Stale is a presentation verdict, not a state: the chain decides when the funds
move.

## What Ordex never does

Ordex composes, verifies, and records. It does not hold a policy key, does not
sign, does not custody the funded output, and does not broadcast on its own
initiative. The buyer funds and posts, two independent signers approve one
acceptance each, the seller signs one input, and every broadcast is a
deliberate act by the party who owns the money that moves.
