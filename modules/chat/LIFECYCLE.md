# Ordinary Chat lifecycle owner

Status: implemented source checkpoint, pending aggregate review and integration.
The Go owner uses the existing `domain/turn.Queue`; there is no new delegated task
engine or browser implementation. The earlier admission projection now has an
actual handle producer. Source tests use the concrete per-owner Mutex and injected
journal, browser and result-retention fixtures. Native durability, Desktop IO,
Computer composition, HTTP/SSE serving and installed acceptance remain unqualified.

## Construct and capture one route

Trusted ordinary Chat composition supplies these dependencies:

| Input              | Required semantics                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `JournalScope`     | Actual profile and fresh backend incarnation from boot, fixed for the owner's lifetime       |
| `Gate`             | Dedicated per-owner no-IO serialization, normally `infra/gate.New()`                         |
| `Journal`          | Exclusive fresh empty claim; atomic durable CAS append; exact known receipt; bounded context |
| `Browser`          | Desktop's existing narrow capability port, required for Prepare/Send                         |
| `Results`          | Delivery owner's actual bounded retention, required with Browser and for Finish              |
| `ResultBytesLimit` | Positive accepted retention budget pinned by composition whenever Results is supplied        |

Admission-only assembly may omit Browser/Results. Supplying Browser requires
Results and its positive accepted byte budget before a journal can be claimed;
an effective Send therefore cannot lack terminal retention.

`New` calls `Journal.OpenFresh` once outside the gate. A nonempty/reused claim,
wrong scope/revision, error, nil reply or cancelled context yields no owner.
An uncertain claim cannot be repeated or rerouted through a new repository instance.
The journal adapter must enforce scope ownership across all its instances.
There is no history restore API. Restarted records can inform reconciliation and
Activity, but cannot create current admission.

The ordinary request owner calls `Admit` using its trusted admitted owner/session/
task/TaskEpoch/participant/turn/operation identity and intent digest. These fields
must come from the real ordinary Chat request lifecycle, not be copied from an
incoming Computer body, provider status or an ambient latest-task lookup. The
profile/backend must match the captured scope. The actual queue admission and a
known exact journal append precede handle publication. Known duplicate admission
returns the same handle without another journal write; a changed epoch,
participant, digest or other identity conflicts. Closed routes cannot reopen.

Each `Handle` has private owner/identity state and immutable `Binding()`. Only the
exact registered handle is current; a struct copy or another owner's handle is
refused. There is no public handle constructor or lookup by request IDs. Capture
this handle once via `app/services/admission.New(handle)` and then
`contracts/admission.New(service)` for Computer's peer adapter. Use that same
published guard throughout one qualified Computer operation and final disclosure.
This is membership evidence; Computer still owns permission and execution leases.

## Candidate publication and failure windows

The owner keeps one committed queue and bounded handle registry. Every change
uses an independent `Queue.Clone`, including independent waiting storage and fixed
Computer-call tombstones. Uncommitted candidates never mutate published state.
The existing limits remain five slots, 256 pending requests, 1024 retained request
identities and 128 unique Computer calls per turn.

1. Under the gate, validate the exact handle and transition, capture the previous
   snapshot, derive the candidate and assign a monotonic fence. Mark the global
   transaction pending before releasing the gate. Every current guard is then
   unavailable, including guards for other turns sharing this journal/queue.
2. Perform bounded persistence or a required result-retention effect outside the
   gate. Journal writes include fixed scope, previous/next revisions, exact route,
   content-free transition metadata and any pending narrow browser effect.
3. Check the same pending object, route, fence, context and committed revision
   before and after IO. Only the exact known receipt publishes the candidate.
   A success after withdrawal/cancellation cannot restore positive membership.
4. Completion and Cancel serialize with the entire current callback. An accepted
   idle completion/cancel withdraws membership before retention/journal IO. If a
   closure overtakes an in-flight transaction, it immediately closes that route
   and poisons the owner's unresolved transaction. It starts no parallel write or
   compensating browser call. The late reply cannot publish its candidate.

The initial owner permits one transaction in flight, including its coordinated
browser effect. Other changes return classified `Busy` before IO. Pending or
unknown persistence is never known absence. Failed, nil, mismatched or cancelled
replies leave the owner unavailable. Counter exhaustion also withdraws positive
membership. There is no automatic retry, reset, cleanup or reconciliation API.
A future explicit reconciliation owner must resolve the retained journal/effect
before further work; creating another owner over the same scope is forbidden.

`WithCurrent` performs no IO at entry or inspection. It reads independent values
under the concrete gate, invoking its consumer synchronously exactly once on a
successful entry. Consumer errors are preserved. The published projection hides
pending/unknown state and known terminal membership. Unknown outcome stays
unavailable even after ACK; it cannot be converted into a reusable slot.

Lock order remains qualified Computer -> Computer `AccessRepository.WithSnapshot`
-> Chat current gate. No Chat-held path acquires Computer. Consumer callbacks must
be pure, non-reentrant and complete under the gate. Separate Computer updates
happen after Chat releases its gate. No root adapter or native lock-order
qualification is included in this range.

## Narrow Desktop lifecycle

`PrepareNext` selects the queue's next eligible turn internally; callers do not
select a route by ordinal. It commits the exact reservation and pending Prepare
intent before calling Desktop once with the same supplied absolute deadline.
The returned lease must match completely, and the actual view/document/conversation
must pass the domain binding rules. Ready publishes Pending; an exactly bound
OwnerRequired publishes AwaitingOwner. A second known settlement journal commit
precedes positive current membership. Sign-in-required, unavailable, malformed or
uncertain replies leave the reservation fenced; this checkpoint has no automatic
sign-in retry/disposal/reconciliation path.

`Send` captures the active exact domain binding and privately retained admission
digest. It commits Dispatch and a pending Send effect before passing transient
prompt input to Desktop once. Current membership stays withdrawn throughout IO
and the second settlement append. Submitted leaves Running without claiming
provider acceptance. Accept is a separate exactly bound transition. NotSent
retains a known Failed result before publication. A lost/error/nil/mismatched/
invalid/unknown response publishes sticky Unknown if its settlement can be
committed; otherwise the owner remains unresolved. Another Send is refused by
the existing domain intent fence in either case.

Desktop must enforce its lease, backend/view/document generations, conversation,
byte/sequence bounds and the absolute deadline at its actual IO boundary. The
owner's pre-effect check cannot make unlocked native IO atomic with a concurrent
revocation. Once the recorded effect starts, concurrent revoke is conservatively
unknown; even a later successful reply cannot restore membership. Browser errors
and raw adapter diagnostics never become journal text. There is no eval, script,
URL, cookie or storage capability. No second Chromium/DOM engine is introduced.

`Apply` accepts a closed content-free transition set: Enqueue, Accept, AwaitOwner,
Resume, Delta, Request/ResolveComputer, Acknowledge, Settle/SettlePrepared and
Release. Irrelevant fields and crossed identities are refused before persistence.
It records metadata only and executes no Computer operation or browser call.
Validated Observe-page mapping and the actual Cancel/Dispose adapters still need
their owned integration. Every incoming event must bind the exact captured
view/document generation; body correlation cannot select another live handle.

## Result, delivery and slot reuse

`Finish` derives terminal state under the gate, withdraws membership, copies only
bounded result bytes into the accepted retention port, then commits metadata.
Known retention must match route, result and byte count. Unknown retention or its
late reply cannot publish result-ready or settled absence. Repeated Finish cannot
repeat retention. Results remain transient delivery data; no prompt/answer/raw
error is stored in the lifecycle journal or Activity. Only the initial intent
fingerprint and classified metadata are journal inputs.

Cancellation before Send retains the original known-cancel policy, including
separate positive cleanup for a reserved surface. Cancellation after Send stays
Unknown. Client ACK and positive exact lifecycle settlement are separate; both
are required for Release. Historical identity/binding remains unchanged after
slot reuse, and the old route cannot open the new document.

The delivery owner must connect retention lifetime to committed client ACK, and
retain the existing bounded stream ordering, backpressure, replay and reconnect
contract. This range supplies no SSE adapter or result-retention implementation.
The pure stream tests remain source evidence, not socket/provider acceptance.

## Checks and integration handoff

Targeted race tests cover the actual owner and real Mutex gate: journal publication
before lost reply, current withdrawal before IO, whole-callback serialization,
completion/cancel during pending journal/browser/retention effects, wrong receipts,
late replies, no repeat Send, exact immutable handles, five-slot waiting/reuse,
Computer call history, counter/retention bounds and metadata privacy.

These fixtures do not qualify a durable journal, Desktop binding at actual IO,
Computer's final native disclosure, provider calls or ordinary production startup.
Aggregate `ci:fast` and fresh required review remain separate Lead-reserved gates.
No active TypeScript duplicate is removed, no boot/shared-file changes are included,
and no main integration, packaging, installation or publication is performed.
The earlier `33007e5` writer, failed canonical CI evidence and unknown resources
remain preserved. The new range is a source checkpoint, not product completion.
