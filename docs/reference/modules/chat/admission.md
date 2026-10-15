# Ordinary Chat admission ownership

Status: source checkpoint. The published callback, projection and actual
`app/services/lifecycle.Service` owner are implemented. The owner mints private
handles only after its own queue admission and exact known journal commit. See
[lifecycle](lifecycle.md) for constructor and Desktop requirements.
A durable repository implementation, accepted Computer peer composition and
ordinary boot wiring still need qualification. Tests exercise the actual owner
and concrete Mutex gate with labelled injected journal/browser/retention ports;
they do not prove disk durability, production admission or native lock order.

## One owner and one lifecycle

The Chat application owns ordinary model turns through the existing
`domain/turn.Queue`. It must not introduce a parallel task engine. Delegated
Codex/Claude sessions belong to `modules/task` and use that module's own admission.
This callback provides current membership, not Computer permission or an execution
lease. Computer continues to own approval, capability policy and its immutable
operation lease.

Trusted Chat admission binds profile/backend incarnation, owner/session/task,
TaskEpoch, participant, turn/operation and TurnGeneration before calling Computer.
Only that admission can mint a `port.BoundTurn`; request-body generation, CallID,
provider status and startup caches cannot do so. TaskEpoch is the admitted task's
independent epoch, never inferred from TurnGeneration or a browser slot. Slot
ordinal remains presentation; backend, slot, view and document generations retain
their separate purposes.

The live owner captures one immutable `TurnBinding` for the admitted route.
`Binding()` only supplies correlation. Every phase and final disclosure call
`WithCurrent` again on that same route; there is no request-ID or latest-task
lookup. A public `contracts/admission.Current` wraps that required live handle.
Its service validates exact binding and Turn identity, settled persistence and
lifecycle, then explicitly maps independent DTOs:

| Value                                    | Purpose                                            |
| ---------------------------------------- | -------------------------------------------------- |
| owner/session/task/TaskEpoch             | Exact owning task membership                       |
| participant/turn                         | Exact admitted Computer participant and model turn |
| profile/backend/operation/TurnGeneration | Private Chat route fence                           |
| body generation/CallID/provider status   | Request and provider correlation only              |

The published contract contains the first two rows only. A future Computer-owned
`infra/peer` adapter imports this published contract and explicitly maps its six
fields into Computer's consumer-owned `CurrentTaskAdmission` binding. Neither
module imports a neighbor's domain/app/infra; React consumes Desktop's facade.

## Synchronous current-owner gate

Selected order: Computer native qualification completes first, then
`AccessRepository.WithSnapshot`, then Chat `BoundTurn.WithCurrent`. The Chat
entry itself and the complete nested callback perform no native IO, journal IO,
mutation, provider work or reentrancy. No Chat-held path may acquire Computer.
The callback is synchronous, exactly once, and serialized against actual
admission/binding/completion/revoke changes. It receives an independent value;
retaining or mutating that value creates no authority.

Known absence calls the consumer with nil. Unavailable, mismatched, pending or
unknown state returns a classified error without positive inspection. A cancelled
context and a broken callback protocol also fail closed. Consumer policy errors
are preserved; raw owner diagnostics cannot cross the published boundary.

The projection treats committed admitted/pending/running/awaiting-owner turns as
current membership. This does not authorize a Computer call without its separate
approval and exact fixed lease. Known result-ready/delivered/cancelled states are
absent even if delivery/disposal is incomplete. Unknown outcome is unavailable,
never settled absence or a reason to dispatch again. Provider acceptance alone
cannot create membership, and slot reuse still requires the original delivery
and positive lifecycle settlement evidence.

## Required owner and persistence sequencing

The concrete application owner is the only writer of its live admission registry
and queue. `infra/gate.Mutex` supplies dedicated injected serialization; pure
app/domain/contracts import no locks, filesystem or native adapters. The
consumer-owned `port.Journal` describes a fresh exclusive journal claim and
atomic CAS append of content-free transitions. `port.ResultRetention` keeps
actual delivery bytes separate, with an explicitly supplied accepted byte budget.
This source checkpoint defines no disk format, boot registration or new capacity
policy. The initial owner permits one transaction in flight, withdrawing all
positive views until persistence and any coordinated effect settle.

Admission and each lifecycle change must use this sequence:

1. Under the Chat gate, derive a candidate transition from the owned pure queue,
   bind the exact identity, and mark that route pending. Withdraw an earlier
   positive view before any unlocked persistence or coordinated effect. Retain
   an exact transition/revision fence so only that candidate may be committed.
2. Release the gate for bounded atomic journal IO. Persist identity and classified
   content-free lifecycle metadata; persist Send intent before Send. Result-ready
   publication also requires actual result retention by its delivery owner.
3. Reacquire the gate and publish the candidate as committed only if the exact
   route and revision remain current and both persistence and required effects
   are known. A late successful write must not resurrect a revoked/completed
   route or overwrite a newer transition. Failed/unknown persistence remains
   unavailable until an explicitly owned reconciliation resolves it.
4. Completion/revoke first invalidates current membership under the Chat gate,
   releases it, then makes any separate Computer update or journal write.
   Pending/unknown coordinated revocation returns unavailable, not known absence,
   and must never expose the former binding.
   If a consumer is already inside the callback, invalidation waits for its
   complete inspection/final-disclosure gate to finish.

The bound handle is returned only by successful actual admission after publication.
Its current view comes from live owner state under this gate, not a historical
journal read during inspection. Restarted metadata can inform explicit
reconciliation/Activity, but cannot restore positive native admission on its own.
Lost provider/Computer acknowledgements keep the existing unknown fence. There is
no automatic replay, compensating Send or executor reroute.

## Acceptance still required

Production assembly must obtain the handle from `lifecycle.Service.Admit`, then
capture the published current contract once for the operation. It must qualify
the actual entry/lock order and durable journal adapter. Source tests now cover
pending/unknown writes, completion/revoke during IO, exact late commit fencing,
retention before result publication and intent before one-shot Prepare/Send.
Native crash windows, explicit startup reconciliation and final disclosure through
the same fixed Computer lease remain required before boot can use the seam as
production admission proof.

The present race/conformance tests also exercise the concrete owner's gate and
port sequencing. `WithCurrent` has no journal/browser/retention entry call; its
consumer callback still must obey the pure, non-reentrant contract. Tests do not
prove Computer's native qualification or actual Desktop generation enforcement.
No browser/provider/network/native probe is introduced here, and the active
TypeScript route remains until its accepted vertical cutover.
