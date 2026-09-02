# Order lifecycle

Every state below is one the implementation can actually enter and leave. A
state nothing reaches is a lie told to the orderbook, to the market, and to any
monitoring built on either, so this list stays exactly as wide as the
transitions the validators and the reconciler make.

## States

| State | What it means |
| --- | --- |
| `PENDING_NODE` | The artifact parsed. Bitcoin Core has not confirmed the offered output is unspent. |
| `PENDING_ORD` | Core confirmed the output. The ord index has not confirmed the asset is where the order claims. |
| `LIVE` | Both authorities agreed, recently enough to act on. |
| `MEMPOOL_CONFLICTED` | An unconfirmed transaction spends the offered output. It can still be replaced or dropped. |
| `SPENT` | The offered output was spent on chain by a transaction Ordex did not observe settling this order. |
| `SETTLED` | The offered output was spent by a transaction carrying this order's exact payout. |
| `REJECTED` | The artifact is unusable: malformed, wrong network, or an unsupported order class. |
| `WITHDRAWN` | The owner of the offered output, or an operator, removed it from discovery. |
| `REPLACED` | The owner of the offered output published a fresh ask for the same output and this one left the book for it. A replaced order is terminal in the same sense a withdrawn one is: the funds only ever move when the output is spent. |

`MEMPOOL_CONFLICTED` and `SPENT` are deliberately separate. A mempool conflict
can still be replaced or dropped and the order can return to `LIVE`. A confirmed
spend does not come back short of a reorg.

`SPENT` and `SETTLED` are deliberately separate. An output can be spent for any
reason. Only a transaction carrying this order's payout output settles it, and
Ordex remembers the transaction its own preflight accepted so it can tell the
two apart.

## Actionability

Actionability is what a customer may do right now, and it is not the same
question as the state.

| Value | What it means |
| --- | --- |
| `REVIEW_ONLY` | Readable, not completable. |
| `HANDOFF_READY` | Checked against both authorities and completable now. |
| `BLOCKED` | Something about the artifact stops it being completed at all. |

A `LIVE` order whose verification has aged past its freshness bound is
`REVIEW_ONLY`, not `HANDOFF_READY`. Age is published with every order so the
distinction is visible rather than implied.

## Withdrawal is discovery, not cancellation

Removing a listing stops Ordex publishing it. It cannot unpublish a signed
artifact that is already elsewhere. The only way to make an already distributed
ask unusable is to spend the output it sells. Ordex says this rather than
describing withdrawal as cancellation.

## The activity log

Every transition is appended, with the state it came from, the state it went
to, the reason, and who caused it: the reconciler, the seller, an operator, or
an import. The activity feed reads that log, so an entry is something that
happened rather than a listing's current state restated after the fact.
