# Not burning the runes a purchase spends

This is the one rule that decides whether a rune balance survives a
transaction. Getting it wrong does not produce an invalid transaction that a
node rejects. It produces a valid transaction that confirms normally and
destroys every rune it spent.

## Where a rune balance lives

A rune balance is not held by an address. It is held by an output, and it is
moved by the **runestone**: the first output in the transaction whose script
begins `OP_RETURN OP_13`.

A transaction with no runestone does not destroy anything. Runes that no edict
assigns go to the first non-`OP_RETURN` output. That is a transfer, and it is
safe.

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

## What makes it a cenotaph

| Flaw | Condition |
| --- | --- |
| `INVALID_SCRIPT` | a push claims more bytes than the script carries |
| `OPCODE` | any true opcode appears after the magic number |
| `VARINT` | a varint is unterminated, longer than 19 groups, or overflows a u128 |
| `TRUNCATED_FIELD` | a tag has no value after it |
| `TRAILING_INTEGERS` | the body ends with fewer than four integers left |
| `EDICT_RUNE_ID` | a delta carries the rune id past a u64 block or u32 tx, or names block 0 with a nonzero tx |
| `EDICT_OUTPUT` | an edict addresses an output beyond the output count |
| `UNRECOGNIZED_FLAG` | tag 2 carries a bit outside Etching, Terms and Turbo, or Terms or Turbo without Etching |
| `UNRECOGNIZED_EVEN_TAG` | an unrecognized **even** tag remains after the known tags are consumed |

An unrecognized **odd** tag is ignorable. That asymmetry is what lets the
format grow without turning every future field into a burn for older readers.

Two details are easy to miss and both destroy balances:

- An edict may address the output **count** itself, one past the last index.
  That means split across every non-`OP_RETURN` output, and it is valid.
- A pointer, tag 22, that addresses no real output is never consumed as a
  pointer. Tag 22 is even, so the leftover is what makes the transaction a
  cenotaph. The flaw is an unrecognized even tag, not a separate pointer error.

## The rule a client must apply

Before a wallet is asked to sign, and again before the final transaction is
released:

1. Decipher the runestone of the exact final transaction.
2. If it is not a cenotaph, the purchase is safe with respect to runes.
3. If it is a cenotaph, ask the rune index what each input being spent carries.
4. Refuse if any input holds a rune balance. Confirming would destroy it.
5. Refuse if the index has not examined any input. Not having looked is not the
   same fact as having found nothing, and an unreachable index proves nothing
   either, so a failed lookup counts as unexamined.
6. A cenotaph whose every input is examined and rune free destroys nothing and
   may proceed.

Step 5 is the one clients get wrong. An unproven output treated as empty is how
a balance gets spent as change.

Deciphering is pure computation over output scripts, so it costs nothing and
belongs on every purchase. The index only needs to be asked once the answer is
already a cenotaph, which keeps a rare safety case off the normal path.

## Conformance

`verifier/runes.js` restates this document as executable checks, and
`sdk/src/runes.ts` is the same verifier typed for SDK consumers. Both run
against `conformance/rune-burn-vectors.json`, so neither can drift from this
document or from the other without a test failing.

The vector file carries 25 cases: 8 that must be accepted and 17 that must be
refused, covering every flaw above, both refusal codes, and the adversarial
varint encodings.
