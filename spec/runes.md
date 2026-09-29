# Not burning the runes a purchase spends

This is the one rule that decides whether a rune balance survives a
transaction. Getting it wrong does not produce an invalid transaction that a
node rejects. It produces a valid transaction that confirms normally and
destroys every rune it spent.

## Where a rune balance lives

A rune balance is not held by an address. It is held by an output, and it is
moved by the **runestone**: the first output in the transaction whose script
begins `OP_RETURN OP_13`.

A transaction with no runestone sends every balance it spends to its first
non-`OP_RETURN` output. That is a transfer. It destroys the balances only when
there is no such output.

## The cenotaph

A runestone the protocol cannot read is a **cenotaph**. Every rune carried by
every input of that transaction is destroyed.

Nothing else in a purchase pipeline sees this coming:

- The transaction is well formed, so a node accepts it.
- Its fees are ordinary, so a fee check passes.
- Its inputs are unspent, so an output check passes.
- Its sat flow can be perfectly correct, so an inscription safety check passes.

The transaction is valid Bitcoin. Only reading the runestone the way the
protocol reads it reveals the loss, which is why a compatible client must read
it before asking anyone to sign.

## Reading the runestone

Take the first output whose script starts `OP_RETURN OP_13`. Concatenate its
remaining data pushes into one payload. Read the payload as a sequence of
base-128 varints, then as `(tag, value)` pairs until tag `0`, the body, after
which the remaining integers are edicts in groups of four.

Walk the script directly. A general purpose script decompiler is free to
rewrite a data push into its minimal opcode form, and that rewrite is lossy
here: a one byte payload comes back as an opcode and is read as a cenotaph it
is not.

`OP_0` is an empty push, not an opcode.

<!-- OX-P04: this document and verifier/runes.js follow ord 0.29.0 (commit
7e37a3bd3391044b39f5f11f20dfdb8b3764cd0e) field by field. A recognized tag number is
not a consumed field, and a readable runestone is not burn safety; the differential
oracle in conformance/ord-differential keeps both claims checked against ord itself. -->

## What makes it a cenotaph

Reading a field is not the same as seeing its tag. ord consumes each field
with `Tag::take`: the field is removed only when it carries the right number of
values and every value is in range. A rejected value stays behind, and so does
a second copy of a field read once. After every known field has had its chance
to be consumed, whatever is left decides the verdict.

| Flaw | Condition |
| --- | --- |
| `INVALID_SCRIPT` | a push claims more bytes than the script carries |
| `OPCODE` | any true opcode appears after the magic number |
| `VARINT` | a varint is unterminated, longer than 19 groups, or overflows a u128 |
| `TRUNCATED_FIELD` | a tag has no value after it |
| `TRAILING_INTEGERS` | the body ends with fewer than four integers left |
| `EDICT_RUNE_ID` | a delta carries the rune id past a u64 block or u32 tx, or names block 0 with a nonzero tx |
| `EDICT_OUTPUT` | an edict addresses an output beyond the output count |
| `SUPPLY_OVERFLOW` | an etching's premine plus cap times amount overflows a u128 |
| `UNRECOGNIZED_FLAG` | a flag bit is left after Etching is taken, and Terms and Turbo are taken only inside an etching |
| `UNRECOGNIZED_EVEN_TAG` | any **even** field is left unconsumed |

Only the first flaw found is reported, in the order above from the message
flaws through supply, flags and leftover fields, exactly as ord records it.

An unconsumed **odd** field is ignorable. That asymmetry is what lets the
format grow without turning every future field into a burn for older readers.

The even fields that are easy to leave behind:

| Tag | Consumed only when |
| --- | --- |
| 2 Flags | once; a second value is left over |
| 4 Rune, 6 Premine | the Etching flag is set |
| 8 Cap, 10 Amount | Etching and Terms are both set |
| 12, 14 Height, 16, 18 Offset | Etching and Terms are both set, and the value fits a u64 |
| 20 Mint | two values are present, block fits a u64, tx fits a u32, and block 0 has tx 0 |
| 22 Pointer | the value fits a u32 and addresses a real output |

So `OP_RETURN OP_13` followed by pointer 1 twice is a cenotaph: one pointer is
consumed, the other stays. So is a premine without the Etching flag, and so is
a Mint tag with only one value.

An edict may address the output **count** itself, one past the last index.
That means split across every non-`OP_RETURN` output, and it is valid.

## Where a readable runestone sends each balance

A runestone that is not a cenotaph can still destroy balances. The allocation
follows ord 0.29.0's rune updater:

1. Sum every input's balance per rune. A mint adds its minted amount.
2. Apply the edicts in order. Each takes from the running balance of its rune:
   amount 0 means all that is left, a larger amount is capped at what is left.
   An edict for a rune no input carries does nothing, and rune `0:0` names
   the transaction's own etching.
3. An edict addressed to the output count splits across every
   non-`OP_RETURN` output: amount 0 divides the balance evenly with the
   remainder going to the first outputs, any other amount is given to each
   output in turn until the balance runs out.
4. Whatever is left goes to the pointer, or to the first non-`OP_RETURN`
   output when there is no pointer.

A balance burns when it is allocated to an `OP_RETURN` output, including a
pointer or edict that names the runestone output itself, and when it is left
with no non-`OP_RETURN` output to fall to. A cenotaph burns everything.

## The rule a client must apply

Before a wallet is asked to sign, and again before the final transaction is
released:

1. Decipher the runestone of the exact final transaction.
2. Ask the rune index what each input being spent carries, as exact balances.
3. Refuse a cenotaph when any input holds a rune balance, or when any input was
   never examined.
4. Otherwise find every burn path: an edict or pointer that names an
   `OP_RETURN` output, or no non-`OP_RETURN` output for the leftover. Without
   one, nothing burns.
5. With a burn path, refuse when any input was never examined, and allocate the
   exact balances. Refuse when anything burns. When the index reported only
   counts, refuse unless the loss is certain anyway, which it is when the
   runestone has no edicts.
6. A mint of a rune the inputs also carry needs the minted amount from the
   index before the allocation is exact.

Not having looked is not the same fact as having found nothing, and an
unreachable index proves nothing either, so a failed lookup counts as
unexamined. An unproven output treated as empty is how a balance gets spent as
change.

That is burn safety. It is necessary for signing and never sufficient: a
builder, a preflight or a swap must also prove that every balance lands where
the plan says, as the complete multiset of `{ output, runeId, amount }`.
`verifyRuneAllocation` does that, and it refuses when any input was not
examined or lists no exact balances.

| Refusal | Meaning |
| --- | --- |
| `CENOTAPH_BURNS_BALANCE` | a cenotaph spends a rune balance |
| `CENOTAPH_WITH_UNPROVEN_INPUT` | a cenotaph spends an input the index never examined |
| `ALLOCATION_BURNS_BALANCE` | a readable runestone, or none, sends a balance to an `OP_RETURN` or to no output |
| `BURN_PATH_WITH_UNPROVEN_INPUT` | a burn path exists and an input was never examined |
| `RUNE_BALANCES_REQUIRED` | a burn path exists and the index reported counts, not balances |
| `RUNE_OUTPUTS_INCOMPLETE` | not every output script was supplied |
| `RUNE_MINT_UNRESOLVED` | the runestone mints a rune the inputs carry and the minted amount is unknown |
| `MALFORMED_RUNE_BALANCE` | a balance, a rune id or a count is malformed or contradictory |
| `RUNE_INPUT_UNPROVEN` | allocation only: an input was never examined |
| `RUNE_ALLOCATION_MISMATCH` | allocation only: the balances would not land where the plan says |

## Conformance

`verifier/runes.js` restates this document as executable checks, and
`sdk/src/runes.ts` is the same verifier typed for SDK consumers. Both run
against `conformance/rune-burn-vectors.json`, so neither can drift from this
document or from the other without a test failing.

The vector file carries 88 cases: 32 that must be accepted and 56 that must be
refused, covering every flaw above, every burn safety refusal, the ord field
consumption rules, u128 supply overflow, varint limits and malformed pushes.

`conformance/ord-differential` holds a small Rust program that runs the pinned
ord 0.29.0 `ordinals` crate on every vector and on 1500 seeded random
transactions, and records its answers. Both implementations must match those
answers field by field, deciphered runestone and allocation alike.
