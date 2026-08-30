# Completing a public ask

This is the exact arrangement a compatible client must build, and the exact
reason each part of it exists. Getting it wrong does not produce an invalid
transaction that a node rejects. It produces a valid transaction that pays the
seller and gives them their asset back.

## The seller half

An Ordex public ask is one PSBT with one input and one output.

- The input spends the output being sold. It is signed
  `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`.
- The output pays the seller the asking price.

`ANYONECANPAY` means the signature commits to that one input and to no other,
so a buyer may add their own inputs freely. `SINGLE` means the signature
commits to the output at the same index as the signed input, and to no other,
so a buyer may add their own outputs freely.

## Rule one: the indexes must match

The seller signed while their input sat at index 0, so the signature commits to
whatever output ends up at the index the input ends up at.

**A buyer must place the seller's payment output at the same index as the
seller's input.** Any other placement is an invalid signature.

Ordex verifies this by locating the index the two share rather than by
requiring a fixed one. A transaction that carries the offered outpoint at more
than one index is refused: one signature would then answer for two positions.

## Rule two: that index cannot be zero

Sats leave a transaction in input order. The offered output occupies the range
that begins after the total value of every earlier input, and each output is
paid from that stream in order.

Put the offered input first and the seller's payment output is the first
destination its sats reach. For a 546 sat inscription output against a 250,000
sat price, the inscription, its exact sat position, and its postage are all
inside the payment going back to the seller. The transaction is valid, the
seller is paid, and the buyer receives nothing.

**A buyer must place inputs ahead of the offered one, and outputs ahead of the
seller's payment that cover the whole range the offered output occupies.**

Stated as an invariant Ordex checks on every final transaction, where `n` is
the index the seller's input and payment output share:

```
sum(output_value[0 .. n-1]) >= sum(input_value[0 .. n-1]) + input_value[n]
```

The left side is what the outputs ahead of the payment absorb. The right side
is the last sat of the offered output's range. When the left side is the
larger, every sat of the offered output has already been paid out before the
seller's payment begins.

This holds whatever the inscription's offset inside its output is, and it
protects rare sats and postage for the same reason, so it needs no offset
lookup to be correct.

## The arrangement Ordex builds

```
inputs                                outputs
0  buyer padding output               0  buyer payment address, = padding total
1  buyer padding output               1  buyer asset address, = offered value
2  the offered output (seller)        2  seller payment (seller)
3+ buyer funding outputs              3  buyer change, when above dust
```

Reading it against the two rules:

- The seller's input and the seller's payment are both at index 2.
- Outputs 0 and 1 absorb `padding + offered`, which is exactly
  `input_value[0] + input_value[1] + input_value[2]`, so the invariant holds
  with equality and the offered output's sats land whole in output 1.

Padding is two outputs between 600 and 10,000 sats. Two, because that is the
number that places the seller's input at index 2 with room for the merged
padding and the asset ahead of the payment. Small, because output 0 returns the
padding to the buyer: a large output spent there would send the buyer's own
money to their asset address instead of leaving it as change.

Change below 546 sats is paid as fee rather than created, because an output
below dust is one nothing can ever spend.

## What Ordex refuses

Before a transaction reaches a node, Ordex refuses it when:

- the offered outpoint appears at no index, or at more than one;
- the seller's payment output is not at the seller input's index, or its script
  or value differs from the order's terms;
- the sat flow invariant above does not hold;
- the values of the inputs ahead of the offered one cannot be read from the
  node, so the invariant cannot be evaluated at all.

Before composing, Ordex refuses when:

- a named padding or funding output is spent, or unknown to the node;
- a named output carries an inscription or a rune balance, because an output
  holding an asset is not spare change;
- the ord index has not examined a named output, because "not examined" is not
  "carries nothing";
- the asset receive address is the address being paid;
- the same output is named twice, or the output being bought is named as
  funding;
- the funding does not cover the price and the fee.

## What Ordex never does

Ordex composes and verifies. It does not sign, does not hold or contribute
funds, and does not broadcast on its own initiative. A buyer's wallet signs the
buyer's own inputs, the seller's half arrives already signed and is never
touched, and the transaction reaches the network only after the buyer asks for
it. Ordex never asks for a seed phrase or a private key.

## A public ask can be raced

Anyone holding the signed artifact can complete it. A successful check
describes the moment it ran, not the next block. Two buyers can build valid
transactions from the same ask, and only one of them can confirm. Ordex says so
at the point of decision rather than describing an ask as reserved.
