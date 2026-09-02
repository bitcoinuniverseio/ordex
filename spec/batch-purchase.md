# Buying several asks in one transaction

A sweep is one transaction that settles several live asks at once. It is
offered only when every seller half can coexist in a single transaction with
every invariant intact, and it is refused with per-order reasons when they
cannot, so a client can fall back to separate purchases without guessing.

This document is the exact composition Ordex v1.1 builds and the exact
reasons each part exists. Read [purchase.md](purchase.md) first: a sweep is
that arrangement repeated, and the two rules that decide who receives the
asset apply to every ask in the batch.

## The arrangement

Each ask contributes one seller input, signed
`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`, and one seller payment output at the
same index. `ANYONECANPAY` is what makes a batch possible at all: each seller
signed one input and one output and committed to neither neighbor, so many
signed halves can sit side by side in one transaction none of them foresaw.

For up to eight asks, Ordex composes:

```
inputs                                  outputs
0..2T-1  buyer padding inputs           0..      one padding merge and one buyer
                                                  asset output per ask, each block
                                                  ahead of its ask's payment
j_1..    seller input, ask one          k_1      seller payment, ask one
j_2..    seller input, ask two          k_2      seller payment, ask two
...                                     ...      ...
last buyer funding inputs              last     buyer change, when above dust
```

where each ask is laid out as the block [two padding inputs, seller input]
with the matching outputs [padding merge, buyer asset output] placed so that
the buyer asset output for ask `i` sits before the seller input of ask `i`,
and the seller payment sits at exactly the seller input's index. The funding
inputs that pay for the prices come from the buyer and may sit anywhere, and
each padding merge absorbs its own two padding inputs plus the postage of the
Feline ahead of it.

Read against the stream, ask by ask: the outputs ahead of a payment absorb
every earlier block and exactly the sat range of that ask's seller input, so
each Feline lands whole in its own buyer asset output, never inside any
payment going back to a seller, and never inside another ask's asset output.
Because each seller signed `SINGLE | ANYONECANPAY`, the proof is per ask and
the batch adds no trust to any of them.

## What Ordex refuses before composing

- any ask that is not live, not fresh, or not actionable;
- the same ask twice, or an ask whose seller input another ask in the batch
  already claims;
- a batch larger than eight asks, or zero asks;
- a named padding or funding output that is spent, unknown to the node, or
  carries an inscription or a rune balance, or that the ord index has not
  examined;
- funding that does not cover every price and the fee at the requested rate.

## What Ordex refuses before handing the result over

Each completed batch is checked ask by ask with the same rules a single
purchase checks: the offered outpoint appears exactly once, the seller
payment sits at the shared index with the exact script and price, and the
outputs ahead of that payment absorb the whole range the offered output
occupies. A batch is also refused when:

- two asks would need the same output index for different purposes;
- the composed transaction exceeds the gateway's size and weight bounds;
- the fee actually paid exceeds the fee the buyer approved.

## No partial result

A sweep that cannot prove every ask proves nothing. There is no version that
settles some asks and quietly drops the rest, because a buyer reviewing one
transaction has approved one set of movements, not a subset of them. When
composition or verification fails, the answer names every refused order with
its refusal code, and the buyer either fixes the batch or buys the survivors
one at a time through the ordinary routes.
