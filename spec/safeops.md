# SafeOps v1

Status: active at protocol 1.2. Artifacts: `ordex.safeops-plan/v1`, `ordex.safeops-signed-result/v1`. Reference verifier: `verifier/safeops.js`. Vectors: `conformance/safeops-vectors.json`.

SafeOps turns planning into one executable, protocol aware operations desk: cardinal batch sends, ordinal and rune batch transfers, cardinal consolidations, split and postage preparation, recovery of unused padding, RBF replacement, CPFP children, inspection, and post broadcast monitoring. One plan describes one logical operation. One signature flow covers it.

## Who does what

The gateway composes plans and verifies signed results. The user signs every input with their own wallet or offline signer. The gateway never signs, never contributes funds, and never broadcasts on its own initiative: relaying a signed transaction happens only after an explicit user broadcast action.

## Inventory resolution

Before a plan exists, every candidate outpoint is resolved against the authorities into one inventory: Bitcoin Core amount and script, confirmation state, inscription ids and satpoints, rare sat ranges, rune allocations, Counterparty attachments, and any claim the desk does not recognize. The rules:

1. An outpoint whose inventory was never examined is refused (`INVENTORY_UNEXAMINED`). It is never assumed cardinal.
2. An unrecognized claim fails the plan closed (`UNKNOWN_CLAIM_FAILS_CLOSED`). Resolve the claim first.
3. Cardinal only operations refuse inputs that carry any tracked asset (`ASSET_IN_CARDINAL_OPERATION`).
4. A rune transfer refuses inputs without a rune allocation (`RUNE_INPUT_MISSING_ALLOCATION`).
5. Authorities that disagree, stale data, or an indexer behind its accepted checkpoint fail the resolution closed.

## The plan

A plan carries: schema and protocol version, network, operation kind, the chain checkpoint it was built against, an expiry height after that checkpoint, every selected input with its complete resolved inventory, the deterministic output map with recipient, change, and preserve roles, one asset transition per tracked asset naming its exact destination output, the fee with a permitted maximum, the signing policy with required indexes and the sighash type, human readable findings, and the digest.

The digest is SHA-256 over the sorted-key JSON of everything except the findings and the digest itself. A consumer can recompute it and must.

<!--
IMPLEMENTATION-HANDOFF [OX-P01] Preparation only; functional status FAIL, repair NOT IMPLEMENTED.
Coverage: OX-P-C015, OX-P-C016, OX-P-C017, OX-P-C018, OX-P-C019, OX-P-C020, OX-P-C021, OX-P-C022,
OX-P-C023. Evidence: P-R01, P-R02, P-R03, P-R04 in handoff/evidence.
Verified cause: SafeOps assumes every tracked asset follows input first sat; ignores inscription
offsets/ranges and rune allocation. Every output is subject to 546-sat dust, including runestones.
Duplicate outpoints and null signing also bypass refusal contract.
Required behavior: Protocol-specific SafeOps asset allocation and valid output policy. Governing
refs: P-S01 (Ord0.29.0 applicability; handbook accessed2026-09-29); P-S02 (Ord0.29.0
commit7e37a3bd3391044b39f5f11f20dfdb8b3764cd0e; runestone
blob98022fb2a25d587a59a4a2ac40cd9de9bc5a6d0b); P-S03 (Ord0.29.0;
blobbce2ae16336368bba3f7d70eed2a1493a67f45c9); P-S04 (v29.0 policy reference;
blobed3369282351766bcba38cf71c491b5916718971; installed node policy must be read); complete URLs in
reports/protocol.md.
Prerequisites/order: OX-P04, OX-P10. Related files: verifier/safeops.js, sdk/src/safeops.ts; Core
backend/src/ordex-v12 corresponding service and caller adapters.
1. Replace firstSatOutputIndex asset dispatch with adapters keyed by actual asset family. Resolve
inscription offsets as sum(prior input sats)+offset, track every rare-sat interval, decipher and
allocate Runes from authoritative balances, and use corrected Counterparty move semantics.
2. Expand inventory and transition schemas to bind outpoint, asset id, exact quantity,
satpoint/ranges, target script/party and checkpoint; reject unknown or incomplete inventories before
planning; compare complete transition multisets and forbid duplicate inputs.
3. Add explicit data output role, allow zero-value OP_RETURN only for required validated protocol
messages, and distinguish product postage policy from Bitcoin Core dust threshold; forbid unplanned
burns. Validate non-null signing object, exact permitted sighash and required index uniqueness.
4. Mirror JS reference and TypeScript SDK, correct spec/safeops.md, regenerate schema from
spec/openapi.json through its generator, wire Core SafeOps inventory/builder/shield to same
adapters. Never treat labels/signaturePresent booleans as authoritative proof.
Validation (PROPOSED NEW tests, commands unverified until implemented):
verifier/safeops.protocol-safety.test.js, sdk/test/safeops.protocol-safety.test.js. node --test
verifier/safeops.test.js verifier/safeops.protocol-safety.test.js; npm --prefix sdk run build; node
--test sdk/test/safeops.test.js sdk/test/safeops.protocol-safety.test.js.
Assertions/evidence: P-R01 wrong destination refuses; offset0 and1500 correct destinations match
ord0.29; Duplicate inputs/null inventory/signing return stable refusals; Real zero-sat rune message
accepted only when exact allocation proved; Signet actual BTC/Ordinal/Runes/SafeOps split/RBF/CPFP
confirm and match node/indexer outputs. Offline probes are not end-to-end PASS; require actual
Signet transaction, authoritative indexed outcome and consumer readback where applicable.
Rollback: Version changed binding schema; invalidate old unsafe unsigned plans and replan. Retain
signed/broadcast evidence and monitor; never reinterpret old digests as new version. Roll back
public actionability if adapters fail.
-->

## Asset safety rules

1. Value conservation: inputs equal outputs plus the declared fee, exactly, in BigInt. No other total is accepted (`VALUE_NOT_CONSERVED`).
2. Every tracked asset has exactly one transition to an existing output (`TRACKED_ASSET_UNASSIGNED`, `TRANSITION_OUTPUT_MISSING`).
3. The transition destination must be the output that receives the input's first sat: the first output whose accumulated value passes the input range start (`TRANSITION_SAT_FLOW_MISMATCH`). This is the same rule that decides inscription delivery everywhere else in Ordex, so no plan can send an asset to the fee region, to unrelated change, or to the wrong recipient.
4. Outputs respect the 546 sat dust floor (`DUST_OUTPUT`).
5. Nothing outside the selected inputs can move. A plan names its inputs exactly; a signed result spending anything else is refused.

## Partitioning at scale

One logical operation may carry up to 500 asset transfers or 1,000 cardinal recipients. When a single transaction would exceed weight, input, output, ancestor, descendant, or node policy limits, the desk partitions the operation into deterministic standard transactions before the first signature. Every generated transaction, dependency, fee, and recipient is shown first. An operation is never silently split after signatures have begun.

## The execution shield

Immediately before every signature and again before broadcast, the desk refreshes every input from Bitcoin Core, refreshes protocol ownership and satpoints, checks mempool spends and replacements, and refreshes fee estimates. If anything changed, the previous signing session is invalidated instead of silently adapted, the exact change is displayed, and the plan is rebuilt with a new digest. A marketplace purchase that would sign over a conflicting spend is blocked with a precise reason before the wallet opens.

## Signed results

A signed result carries the plan digest and the normalized transaction: inputs with signature presence and sighash type, outputs with script and value. The verifier refuses when:

1. The plan digest does not match (`PLAN_DIGEST_MISMATCH`).
2. The inputs or outputs differ from the plan in identity, order, script, or value (`INPUT_SET_CHANGED`, `INPUT_ORDER_CHANGED`, `INPUT_VALUE_CHANGED`, `OUTPUT_SET_CHANGED`, `SCRIPT_CHANGED`, `VALUE_CHANGED`).
3. The recomputed fee differs from the plan (`FEE_CHANGED`).
4. A required index is unsigned (`SIGNATURE_MISSING`), an index outside the policy carries a signature (`UNEXPECTED_SIGNATURE`), or a sighash differs from the approved type (`SIGHASH_CHANGED`).

Every signed PSBT is reverified after the wallet returns. Verification disagreement between browser, backend, SDK, and reference implementation is a release blocker.

## RBF and CPFP

RBF is offered only when node policy accepts the replacement and the user controls every input it requires. The replacement preserves every asset-bearing output, every third-party payment, every seller output, and every amount that may not legally change. The incremental fee comes only from verified user-owned cardinal change or newly added user-owned cardinal inputs. The user sees old fee, new fee, incremental fee, old and new effective fee rate, and every changed input or output.

CPFP is offered only when the user controls a spendable output whose spending moves no tracked asset. The child fee is computed from the combined parent-and-child package fee rate under Bitcoin Core package, ancestor, descendant, dust, and standardness policy. An asset-bearing output may fund a child only when the child provably preserves the complete asset inventory.

## Monitoring

After the explicit broadcast, the operation is monitored for mempool admission, conflicts, replacement, confirmation, drop, and reorg. Each transition appends an `ordex-event/v1` envelope. A reorg produces an explicit reverted event naming the event it reverses, and the operation state returns to a recoverable terminal, never to an ambiguity.
