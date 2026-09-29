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
| `ITEM` | one exact inscription | has exactly the named inscription ID and is a member of the named collection root. |
| `COLLECTION` | a whole collection | is a member of the collection the named root commits to. |
| `TRAIT` | one trait value | is a member of that root and one of the members the buyer accepted as carrying exactly the named trait name and value. |

Every offer binds to one confirmed collection root. The root is part of the
terms, so acceptance is provable against a fixed member set instead of against
"whatever the collection is this week". When the collection publishes a new
root, existing offers keep binding the root they were posted with, and a buyer
who wants the new root posts new offers. Offers bind collections whose member
identity is the inscription ID.

<!-- OX-P05: P-R14 (buyer script placement passed for delivery), P-R15 (missing
locktime passed) and P-R16 (timestamp expiry passed) are closed by proving
delivery from the Feline satpoint and every leaf, tree, locktime and signature
from the transaction bytes. Buyer padding was removed: the buyer signs nothing
at acceptance, so no acceptance can depend on a buyer signature that was never
given. -->

## Offer terms

The terms are an object with schema `ordex.offer-terms/v1`:

| Field | Type | Present | Meaning |
| --- | --- | --- | --- |
| `schema` | string | always | The literal `ordex.offer-terms/v1`. |
| `protocolVersion` | string | always | The gateway protocol version the terms were written for, `1.1` or later. |
| `network` | string | always | `mainnet`, `testnet`, `signet`, or `regtest`. |
| `offerKind` | string | always | `ITEM`, `COLLECTION`, or `TRAIT`. |
| `collectionId` | string | always | The collection the scope names. |
| `collectionRoot` | string | always | Lowercase hex membership root of that collection (the manifest `membershipRoot`). |
| `itemInscriptionId` | string | `ITEM` only | The exact inscription the offer buys. |
| `traitName` | string | `TRAIT` only | The exact trait name. |
| `traitValue` | string | `TRAIT` only | The exact trait value. |
| `criteriaHash` | string | always | Lowercase hex commitment to the scope the buyer accepted; see below. |
| `buyerReceiveScriptHex` | string | always | Lowercase hex of a spendable script (not `OP_RETURN`). The Feline, buyer change, and a recovery all pay it. |
| `priceSats` | string | always | Exact price paid to the seller, atomic sats as a decimal string. |
| `maxNetworkFeeSats` | string | always | The largest fee an acceptance may pay, decimal string. |
| `expiryHeight` | integer | always | Block height from which acceptance is refused and recovery can confirm; see below. |
| `buyerRecoveryKeyHex` | string | always | Lowercase hex x-only public key, a valid curve point, that can recover the funded output alone after expiry. |

Every amount is an atomic integer carried as a decimal string. Floating point
never appears. `expiryHeight` is a safe integer from 0 to 499999999: it is the
argument of a height-domain `CHECKLOCKTIMEVERIFY`, and a locktime of 500000000
or more is a timestamp, which a height can never satisfy.

`criteriaHash` is recomputed wherever the terms alone determine it:

- `ITEM` and `COLLECTION`: SHA-256 over the sorted-key JSON of
  `{ domain: "ordex.offer-criteria/v1", offerKind, collectionId, collectionRoot, itemInscriptionId }`
  (`itemInscriptionId` for `ITEM` only). Terms carrying any other value are
  refused.
- `TRAIT`: the collection root does not commit to trait values, so the buyer
  commits to the eligible members themselves. `criteriaHash` is the Merkle root
  over leaves SHA-256 of sorted-key JSON
  `{ domain: "ordex.offer-trait-member/v1", collectionId, collectionRoot, traitName, traitValue, memberIdentity }`,
  with interior nodes SHA-256 of `{ domain: "ordex.offer-trait-node/v1", left, right }`,
  children in ascending order, leaves sorted, and a lone node promoted, exactly
  as the collection membership tree is built. The buyer's wallet computes it
  from the member list it showed the buyer (`offerCriteriaHash`), and every
  acceptance proves its Feline against it (`buildTraitMemberProof`).

The `offerTermsHash` is SHA-256 over the terms serialized as UTF-8 JSON with
object keys sorted recursively and no insignificant whitespace. Two parties
that hold the same terms hold the same hash, and a hash that matches nothing is
refused everywhere. Verifiers recompute it; nobody is asked to trust a hash
they cannot rederive.

## The funded offer output

A posted offer is one Taproot output the buyer funded and signed. Its internal
key is BIP341's unspendable point
`H = 50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0`, so no
key path exists, and its tree is exactly two leaves at depth one, so the output
cannot be spent in a way its address does not describe. `offerOutputTree`
returns every byte below from the terms and the two policy keys.

### Acceptance leaf

```
<offerTermsHash 32 bytes> OP_DROP
<policyKeyA> OP_CHECKSIG
<policyKeyB> OP_CHECKSIGADD
OP_2 OP_EQUAL
```

In bytes: `20 <offerTermsHash> 75 20 <policyKeyA> ac 20 <policyKeyB> ba 52 87`.
Both policy signatures are required. `CHECKSIGADD` accumulates, so the leaf
evaluates to true only when each independent key signed, and the witness is
`<sigB> <sigA> <leaf> <control block>`. The leaf embeds the terms hash, so the
leaf, the tree, the tweak, and the address all change if one term changes. No
single policy key can spend the output.

### Recovery leaf

```
<expiryHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP
<buyerRecoveryKey> OP_CHECKSIG
```

In bytes: `<minimal push of expiryHeight> b1 75 20 <buyerRecoveryKey> ac`. The
height is pushed as the minimal script number: `00` for 0, `51` to `60` for 1
to 16, otherwise its little-endian bytes with a sign byte when the top bit is
set (120000 is `03c0d401`, 499999999 is `04ff64cd1d`). The witness is
`<signature> <leaf> <control block>`.

The control block of each leaf is `c0` or `c1` (the output key parity), then
`H`, then the hash of the other leaf. A verifier rebuilds the leaves, the tree
and the output key and requires the funded output script, each revealed leaf
and each control block to equal them byte for byte. A script that merely
contains a key or an opcode byte somewhere is not a leaf.

### The policy signers

The two policy keys are distinct valid x-only keys, neither of them the buyer
recovery key nor `H`. They belong to two independent signer services. Each
service keeps its own key and credential store, verifies the acceptance on its
own evidence, and appends its own audit record before answering. The protocol
constrains what they may sign; the deployment must make them independent,
because two services sharing a credential are one service.

The signing contract: a policy signer receives the acceptance (unsigned or
partly signed) and signs exactly one message, the BIP341 script path
signature hash of the funded input under the acceptance leaf with
`SIGHASH_DEFAULT`, which `offerPolicySighash` returns after every acceptance
rule below except signatures has passed. It signs only when it also proves,
from its own authorities:

- the funded output is currently unspent and is the output the terms, the two
  policy keys and `H` produce;
- the offered Feline is currently at the outpoint the acceptance names, owned
  by the accepting seller, and the inventory of every input is what the ord,
  runes and Counterparty authorities report;
- the Feline belongs to the collection root, and for `TRAIT`, to the committed
  trait set;
- the current height is below `expiryHeight`;
- the node would accept the transaction.

A signer that cannot prove every line refuses, and a refusal is an answer, not
an error to retry into submission. A policy signature with any hash type other
than `SIGHASH_DEFAULT` or `SIGHASH_ALL` is refused, because it would leave part
of the transaction open to change.

## Acceptance

Acceptance is one transaction, `ordex.offer-acceptance/v2`:

```
inputs                                outputs
0..s-1  seller inputs (the Feline     0..a-1  asset outputs: exactly the seller
        input among them)                     input sats, one of them the buyer
s       the funded offer output               asset output, the rest seller
                                              returns
                                      a       seller payment, = priceSats
                                      a+1     buyer change, when above dust
```

The seller builds the transaction and signs every seller input with
`SIGHASH_ALL` (or the Taproot default), committing to the whole arrangement.
The two policy signers spend the funded output under the acceptance leaf. The
buyer signs nothing at acceptance time; the buyer's only commitment is the
funded output, signed when funding. There are no buyer padding inputs: a seller
output ahead of the buyer asset output takes the sats that precede the Feline,
so no input of the buyer's could ever be spent without a buyer signature, and
no verifier ever has to assume one. An input described as the buyer's is
refused (`BUYER_INPUT_UNAUTHORIZED`).

The acceptance document names the seller payment script and an optional seller
return script, the delivered Feline and its outpoint, the membership proof (and
for `TRAIT`, the trait proof), every input with its outpoint, party (`SELLER`
or `OFFER`), value, script and authority inventory, and the transaction bytes.
Every asset movement is derived, never declared: inscriptions and rare sat
ranges by absolute sat position, runes by the ord 0.29.0 allocation, and
Counterparty attachments by the Counterparty Core move rule.

The rules an acceptance must satisfy, each recheckable by anyone:

1. The terms verify, the two policy keys are valid and distinct, and the funded
   output is exactly the output they produce (`OFFER_OUTPUT_MISMATCH`,
   `POLICY_KEYS_INVALID`).
2. It is checked at a known height below `expiryHeight`, on the terms' network,
   with a height-domain locktime no later than that height, and no input
   carries a relative timelock (`OFFER_EXPIRED`, `NETWORK_MISMATCH`,
   `LOCKTIME_INVALID`, `SEQUENCE_INVALID`).
3. The Feline is the named inscription for `ITEM`, proves membership in the
   collection root, and for `TRAIT` proves membership in the committed trait
   set (`SCOPE_MISMATCH`, `COLLECTION_MEMBERSHIP_NOT_PROVEN`,
   `TRAIT_NOT_PROVEN`).
4. Every input is described once and in order; the funded output is spent
   exactly once, as the last input, with its funded value and script; the
   Feline is on a seller input (`OFFER_INPUT_POSITION`, `OFFER_INPUT_MISMATCH`,
   `FELINE_NOT_HELD`).
5. The asset outputs absorb exactly the sats of the seller inputs, so the offer
   output's sats never reach them; exactly one pays the buyer receive script and
   the rest pay seller scripts; then the seller payment pays exactly
   `priceSats` to the seller payment script; then at most one buyer change
   output; nothing else, no data output and no dust
   (`ASSET_OUTPUTS_UNBALANCED`, `SELLER_VALUE_MISMATCH`, `OUTPUT_UNDESCRIBED`,
   `DUST_OUTPUT`).
6. The fee actually paid, `sum(inputs) - sum(outputs)`, is at or below
   `maxNetworkFeeSats` (`FEE_OVER_MAXIMUM`).
7. The Feline lands in the buyer asset output, and every other asset lands
   with its owner: the seller's other inscriptions, rare sats, runes and
   Counterparty attachments in seller outputs (`FELINE_NOT_DELIVERED`,
   `ASSET_MISDIRECTED`). The buyer receives the Feline and nothing else of the
   seller's, and the seller loses the Feline and nothing else.
8. Both policy signatures verify under the exact acceptance leaf and control
   block, and every seller input carries a verifying closing signature
   (`POLICY_SIGNATURES_MISSING`, `POLICY_SIGNATURE_INVALID`,
   `ACCEPTANCE_LEAF_MISMATCH`, `CONTROL_BLOCK_MISMATCH`, `SIGNATURE_MISSING`,
   `UNCLOSED_SIGHASH`). A missing signature is refused, never assumed.

`verifyOfferAcceptance` answers the txid, the fee, and the indexes of the funded
input, the Feline input, the buyer asset output and the seller payment. The
node is the final authority on consensus and relay; Ordex refuses a
transaction before a node sees it when any rule fails, and asks the node
whether it would accept the result before anyone broadcasts. An acceptance
signed while the tip is below expiry can still confirm after expiry if it was
not mined in time; a policy signature cannot be withdrawn once given.

## Recovery

Recovery is one transaction, `ordex.offer-recovery/v2`: the funded output
alone, spent by the exact recovery leaf and control block with a
`SIGHASH_DEFAULT` or `SIGHASH_ALL` signature by the buyer recovery key, paying
one output to `buyerReceiveScriptHex` of at least its dust threshold. Its
`nLockTime` is a height at or after `expiryHeight` and below 500000000, and its
input sequence is not final (`0xffffffff` disables the locktime), so
`CHECKLOCKTIMEVERIFY` passes. Consensus lets it confirm from block
`expiryHeight + 1`; a recovery attempt any earlier is invalid by consensus, so
no one has to trust a gateway to enforce the calendar. Anyone may broadcast it;
only the buyer's key can sign it.

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
| `EXPIRED` | The current height reached `expiryHeight` with the output unspent. Acceptance is refused; recovery confirms from the next block. |
| `WITHDRAWN` | The buyer proved ownership of the recovery key before expiry and removed the offer from discovery. Withdrawal is discovery, not cancellation; only a spend settles the funds. |
| `REJECTED` | The posted evidence was unusable: malformed terms, wrong network, a root that does not exist, or a funded output that is not the tree the terms and policy keys produce. |

An offer that ages past its freshness bound is presented as stale and cannot
be accepted through Ordex until it revalidates, exactly as a listing is.
Stale is a presentation verdict, not a state: the chain decides when the funds
move. A reorganization that removes the block confirming an acceptance or a
recovery returns the offer to `MEMPOOL_CONFLICTED` while the spend waits in the
mempool, or to `LIVE` or `EXPIRED` if it was dropped. A refused or abandoned
acceptance is retried only by building and verifying a new one at the current
height; nothing is retried into submission.

Outputs funded under earlier drafts of this contract, with a different internal
key, leaf or expiry domain, are never reinterpreted: this verifier refuses them
(`OFFER_OUTPUT_MISMATCH` or a terms refusal), and their funds remain
recoverable exactly as their own recovery leaf states.

## What Ordex never does

Ordex composes, verifies, and records. It does not hold a policy key, does not
sign, does not custody the funded output, and does not broadcast on its own
initiative. The buyer funds and posts, two independent signers approve one
acceptance each, the seller signs its own inputs, and every broadcast is a
deliberate act by the party who owns the money that moves.
