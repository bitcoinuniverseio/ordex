# SafeOps v2

Status: active at protocol 1.2. Artifacts: `ordex.safeops-plan/v2`, `ordex.safeops-signed-result/v2`. A v1 plan or result is refused (`SCHEMA_UNSUPPORTED`) and replanned; its digest is never reinterpreted under v2 rules. Reference verifier: `verifier/safeops.js`. Vectors: `conformance/safeops-vectors.json`.

SafeOps turns planning into one executable, protocol aware operations desk: cardinal batch sends, ordinal and rune batch transfers, cardinal consolidations, split and postage preparation, recovery of unused padding, RBF replacement, CPFP children, inspection, and post broadcast monitoring. One plan describes one logical operation. One signature flow covers it.

## Who does what

The gateway composes plans and verifies signed results. The user signs every input with their own wallet or offline signer. The gateway never signs, never contributes funds, and never broadcasts on its own initiative: relaying a signed transaction happens only after an explicit user broadcast action.

## Inventory resolution

Before a plan exists, every candidate outpoint is resolved against the authorities, at one checkpoint, into one inventory: Bitcoin Core amount and script, confirmation state, every inscription with its offset inside the input, every rare sat range with its offset and length, every rune balance with its exact amount, every Counterparty attachment with its numeric asset id and exact quantity, and any claim the desk does not recognize. The rules:

1. An outpoint whose inventory was never examined is refused (`INVENTORY_UNEXAMINED`). It is never assumed cardinal.
2. An inventory that lists an asset without its exact position or quantity, places it outside the input, or lists the same inscription or range on two inputs is refused (`INVENTORY_INVALID`).
3. An unrecognized claim fails the plan closed (`UNKNOWN_CLAIM_FAILS_CLOSED`). Resolve the claim first.
4. Cardinal only operations refuse inputs that carry any tracked asset (`ASSET_IN_CARDINAL_OPERATION`).
5. A rune transfer spends at least one input with a rune allocation. Its other inputs either carry a rune allocation or carry no tracked asset at all, so asset-free inputs can fund postage, change and fee for a rune that sits on a dust output; an input carrying any other asset without a rune allocation is refused (`RUNE_INPUT_MISSING_ALLOCATION`).
6. Authorities that disagree, stale data, or an indexer behind its accepted checkpoint fail the resolution closed.

## The plan

A plan carries: schema and protocol version, network, operation kind, the chain checkpoint it was built against, an expiry height after that checkpoint, the transaction version and locktime, every selected input with its outpoint, value, the script it spends, its sequence and its complete resolved inventory, the deterministic output map with recipient, change, preserve, and data roles, one transition per derived asset movement with its exact quantity, the fee with a permitted maximum, the signing policy, human readable findings, and the digest. Together the transaction fields, inputs and outputs fix the unsigned transaction byte for byte.

A selected outpoint appears once (`INPUT_DUPLICATED`). Each input names the script it spends (`INPUT_SCRIPT_INVALID`) and its sequence (`INPUT_SEQUENCE_INVALID`), and the plan names the version and locktime (`TRANSACTION_INVALID`).

The digest is SHA-256 over the sorted-key JSON of everything except the findings and the digest itself. A consumer can recompute it and must.

<!-- OX-P01: v2 derives every asset movement from the protocol that owns it instead
of one first-sat shortcut, binds the complete unsigned transaction, and proves
signatures from signed bytes. The P-R01 to P-R04 counterexamples are vectors. -->

## Asset safety rules

1. Value conservation: inputs equal outputs plus the declared fee, exactly, in BigInt. No other total is accepted (`VALUE_NOT_CONSERVED`).
2. Every asset moves by the rule of the protocol that owns it, and the plan's transitions must equal the derived movements as a complete multiset: nothing missing (`TRACKED_ASSET_UNASSIGNED`), nothing different (`TRANSITION_MISMATCH`), nothing extra (`TRANSITION_UNEXPECTED`), and never an output that does not exist (`TRANSITION_OUTPUT_MISSING`).
   - **Inscriptions** sit on one sat: the sum of the values of the inputs before theirs plus their offset. They land in the output whose range holds that sat. An inscription 1,500 sats into a 2,000 sat input, spent into outputs of 1,000 and 900, lands in output 1.
   - **Rare sat ranges** land whole in one output or the plan is refused (`RARE_SAT_RANGE_SPLIT`).
   - **Runes** are allocated exactly as ord 0.29.0 does it (see `spec/runes.md`) from the exact input balances, and each output must receive exactly the amount the transitions state (`RUNE_ALLOCATION_MISMATCH`). Any burn, from a cenotaph, an edict or pointer naming an OP_RETURN, or no spendable output, is refused (`CENOTAPH_BURNS_BALANCE`, `ALLOCATION_BURNS_BALANCE`).
   - **Counterparty attachments** move, all of them, to the first output Counterparty does not pass over (see `spec/counterparty-utxo-asset.md`). A spend that would detach or strand them instead is refused (`COUNTERPARTY_NOT_MOVED`).
3. A sat-bound asset never lands in the fee (`ASSET_TO_FEE`), and an output carrying an inscription or rare sat range holds at least the 546 sat product postage floor (`POSTAGE_BELOW_FLOOR`). Postage is an Ordex product rule.
4. Every spendable output meets the Bitcoin Core v29 dust threshold for its script at the default dust relay fee, for example 294 sats for P2WPKH, 330 for P2TR and P2WSH, 540 for P2SH and 546 for P2PKH (`DUST_OUTPUT`). Node preflight remains the relay authority.
5. An OP_RETURN output is a `data` output and a `data` output is an OP_RETURN (`DATA_OUTPUT_ROLE_MISMATCH`). It carries zero value (`DATA_OUTPUT_BURNS_VALUE`). The only data output a plan may carry is one runestone moving the runes the plan's inputs hold (`DATA_OUTPUT_NOT_PERMITTED`), within the 83 byte relay limit (`DATA_OUTPUT_NONSTANDARD`).
6. The user signs every selected input exactly once (`SIGNING_INVALID`), with `DEFAULT` (Taproot) or `ALL` only, so no input or output can change after signing (`SIGHASH_NOT_PERMITTED`).
7. Nothing outside the selected inputs can move. A plan names its inputs exactly; a signed result spending anything else is refused.

## Partitioning at scale

One logical operation may carry up to 500 asset transfers or 1,000 cardinal recipients. When a single transaction would exceed weight, input, output, ancestor, descendant, or node policy limits, the desk partitions the operation into deterministic standard transactions before the first signature. Every generated transaction, dependency, fee, and recipient is shown first. An operation is never silently split after signatures have begun.

## The execution shield

Immediately before every signature and again before broadcast, the desk refreshes every input from Bitcoin Core, refreshes protocol ownership and satpoints, checks mempool spends and replacements, and refreshes fee estimates. If anything changed, the previous signing session is invalidated instead of silently adapted, the exact change is displayed, and the plan is rebuilt with a new digest. A marketplace purchase that would sign over a conflicting spend is blocked with a precise reason before the wallet opens.

## Signed results

A signed result carries the plan digest and the complete signed transaction as hex (`signedTxHex`). The verifier reads the transaction from those bytes; a caller's statement that an input is signed proves nothing. It refuses when:

1. The plan digest does not match (`PLAN_DIGEST_MISMATCH`), or the bytes do not parse (`MALFORMED_SIGNED_RESULT`).
2. The version or locktime changed (`TRANSACTION_CHANGED`), or the inputs or outputs differ from the plan in identity, order, sequence, script, or value (`INPUT_SET_CHANGED`, `INPUT_ORDER_CHANGED`, `SEQUENCE_CHANGED`, `OUTPUT_SET_CHANGED`, `SCRIPT_CHANGED`, `VALUE_CHANGED`). With all of these equal the fee is the plan's fee.
3. An input is unsigned (`SIGNATURE_MISSING`), its signature does not verify against the plan's prevout scripts and values under the BIP143 or BIP341 signature hash (`SIGNATURE_INVALID`), or it spends a script the verifier cannot check (`SIGNATURE_UNVERIFIABLE`).
4. A signature uses another sighash than the plan approved (`SIGHASH_CHANGED`).

Every signed PSBT is reverified after the wallet returns. Verification disagreement between browser, backend, SDK, and reference implementation is a release blocker.

## RBF and CPFP

RBF is offered only when node policy accepts the replacement and the user controls every input it requires. The replacement preserves every asset-bearing output, every third-party payment, every seller output, and every amount that may not legally change. The incremental fee comes only from verified user-owned cardinal change or newly added user-owned cardinal inputs. The user sees old fee, new fee, incremental fee, old and new effective fee rate, and every changed input or output.

CPFP is offered only when the user controls a spendable output whose spending moves no tracked asset. The child fee is computed from the combined parent-and-child package fee rate under Bitcoin Core package, ancestor, descendant, dust, and standardness policy. An asset-bearing output may fund a child only when the child provably preserves the complete asset inventory.

## Monitoring

After the explicit broadcast, the operation is monitored for mempool admission, conflicts, replacement, confirmation, drop, and reorg. Each transition appends an `ordex-event/v1` envelope. A reorg produces an explicit reverted event naming the event it reverses, and the operation state returns to a recoverable terminal, never to an ambiguity.
