# Bounded restart traces

Starting source: `e0effcf372a7cab1357add513a24cd5b4c474a6a`; B0 and
`feature/agent-workflows` are unchanged. This delta adds evidence, not a runtime
scheduler, durable plan store, Task control adapter or production admission owner.
The earlier isolated lost-ACK and concurrent-result witnesses were inspected
first; these traces combine the missing states rather than repeat those cases.

## Executed finite queue

The fixed plan is A and B followed by C, which consumes `A+B` only after both
original results are accepted. Every reconstruction obtains the SAME plan from
an explicit controlled `tracePlanOwner.Original` input port. That fixture holds
synthetic immutable input in memory, not Task progress or persistent workflow
state. It proves the consumer of a trusted plan owner, not production restart
activation or recovery of the owner's original input.

- 28 record/request/result/delivery combinations: seven cuts, both first-sibling
  orders, and parent open/revoked after the second boundary. Each begins with
  one original sibling already completed and delivered. Cuts are lost durable
  admission ACK before provider IO, provider request ACK, terminal Finish ACK,
  result observation ACK, failure before recording the observed result, parent
  Send ACK, and delivery Finish ACK.
- Six cancellation combinations: both sibling orders with lost cancellation
  ACK, interrupted-result observation ACK, or interrupted-result delivery ACK.
  Cancellation cannot erase the first accepted sibling or feed C a cancelled
  or unknown result.
- One concurrency trace: two workflow callers calculate the same ready root,
  then share one controlled atomic one-slot admission owner. The actual Task
  provider records progress and withholds its synthetic lost ACK. A third reader
  reconnects and requests cancellation while the journal is pending. Only one
  admission callback/provider request occurs. Reopening retains the original
  unknown operation; a fresh controlled admission owner restores its reservation
  from that operation and refuses B even with a two-slot caller budget.
- Two negative controls: removing the global reservation allows B under that
  two-slot budget; directly bypassing workflow policy to request C before A/B,
  then completing A/B, leaves a failed temporal witness. These are intentional
  counterexamples, not reproduced consumer defects or production qualifications.

The reference checks actual provider/parent effect counters against original
operation IDs, exact parent and provider references. Unknown execution consumes
capacity; missing children in Reconnect never authorize dispatch; retained
completion feeds C once; revoked parents admit no new child while original
settlements remain readable. Parent delivery uncertainty stays separate from
child output acceptance. Repeated projection cannot resend an unknown delivery.

A transient test-only provider probe captures the real journal's original A/B
receipts at C's Dispatch boundary. It observes requests without granting or
blocking them. Independent inspection identified that a retrospective journal
check alone could miss premature dispatch followed by later completion; the
negative control proves the boundary witness detects that counterexample.

## Verification and limits

Run the new queue with:

```sh
go test -race ./modules/task/app/services/workflow -run '^TestTrace' -count=1
```

The bounded trace runs passed; no owned production-consumer defect was reproduced.
Targeted vet and Go architecture enforcement accompany the source checkpoint.
No unchanged broad CI is rerun for this test-only delta. Its earlier failures
remain recorded in [verification.md](verification.md), not superseded by these
passes. The final source/export receipt records exact tested commits and hashes.

The real Task service, selected Owner/Route, published DTO facade and existing
filesystem journal run in disposable Linux fixture roots. ACK cuts hide real
successful journal writes or controlled provider replies; the before-result cut
prevents that observation write. These are application boundary faults, not
power-loss/native qualification. The existing exact Cancel/Deliver adapter is
exclusive and sequential. The shared reservation owner and its reconstruction
are controlled test behavior, not production global admission or its durability.

W3 still needs owner-retained immutable original-plan activation. W6 still needs
the shipping SAME selected Task adapter, owner-atomic `CancelExact`/`DeliverExact`,
serialized global admission/parent checks, combined integration and formal R3.
LIVE and MAC remain open. There is no additional ready consumer defect or missing
combination identified within this finite queue; those external seams remain
precise requests in [integration.md](integration.md).
