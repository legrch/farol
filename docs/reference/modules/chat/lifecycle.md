# Ordinary Chat lifecycle owner

Status: integrated Go lifecycle, with qualification boundaries below.
The Go owner uses the existing `domain/turn.Queue`; there is no new delegated task
engine or browser implementation. The earlier admission projection now has an
actual handle producer. Source tests use the concrete per-owner Mutex and injected
journal, browser and result-retention fixtures. The
[controlled normal Desktop journey](../../../desktop-core.md#controlled-normal-desktop-chat)
at `56ed3941` proves an ordinary typed first message without Computer admission,
two React/Go turns, explicit result ACK and settlement, clean
Quit, same-build/profile restart and current-authorized reads of both answers.
That exact Dev witness uses a synthetic provider; later source changes are not
automatically covered. Production account/control/output qualification,
external Responses next-user-turn delivery and
installed acceptance remain open.

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
The native journal's `NewAfterRetirement` consumes the exact qualified successor
scope and original one-shot clean-retirement proof. Current-authorized history reads
can recover exact retained answers through that chain. They never reconstruct
live conversation handles, current admission or Send authority. See the
[durable result contract](infra/results/durable.md) for its storage and failure
boundaries; arbitrary crash or cross-build recovery is not implied.

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

`boot/chataccountauthorization.go` prepares the account-only final Send guard
for ordinary typed Chat. Trusted composition supplies an existing private
explicit account grant, the original conversation binding and its selected
account ID. The guard checks a fresh observation from the actual dispatch,
requires its approved principal to match that selected account, then checks the
original conversation or its exact current successor under account -> Chat
gates. Follow may change turn, operation and generation while retaining the
same profile/backend/owner/session/task/epoch/participant. A replaced or revoked
grant cannot be restored from a copied receipt.

This guard grants no Computer access and creates no read intent, model engine or
registry. File-derived conversations retain their existing Computer/disclosure
guard. `CreateAuthorized` captures the function port before journal admission;
legacy unguarded admission cannot replay that binding. A late invalid callback or
context clears an earlier positive disclosure check under the owning gate.

The compound `chat.conversation.start` wire effect now resolves the existing Go
model policy, mints the private account approval and calls `CreateAuthorized`.
It returns the original handle and immutable selection before Prepare or Send.
The normal host's explicit inspect/confirm flow supplies the observed principal;
it grants no Computer access. `chat.conversation.account.revoke` uses the same
retained account service across all successor handles. Each admitted account
reserves one slot in the bounded operation ledger for withdrawal; failed creation
requests cannot exhaust that slot. Unknown outcomes remain consumed.

`ReadConversationClient.startAuthorized` uses this effect and the existing
Prepare/Send/progress/frame-ACK/result-ACK/Follow path. It retains the original
attempt, including errors, and refuses changed input or crossing start paths.
The host must preserve one active PrepareNext consumer. The exact assembled
typed-start path passed at `56ed3941` with the controlled provider; production
account/profile qualification remains open.

| Case subset                            | Executable source evidence                                                                                                                                                                                       | Layer and remaining witness                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| M03 account recheck/withdrawal         | `TestChatStartFinalAccountMismatchPreventsOriginalAndSuccessorSend`, `TestChatStartRevokeAnyHandleHasNoBrowserIOAndPreventsSend`, `TestChatStartWithdrawalSurvivesAdmissionCapacity` in `boot/chatstart_test.go` | Actual Go owners, injected journal/browser. Native/current provider account change remains separate.      |
| M07 early output and exact second turn | `TestChatStartResolvesApprovesAndFollowsOnlyAfterACKAndSettlement` in `boot/chatstart_test.go`                                                                                                                   | Actual Go resolver/approval/lifecycle; injected browser. Typed React/DOM witness is separate.             |
| M09 lost admission/replay              | `TestChatStartDuplicateOperationIncludingLostJournalOutcomeNeverCreatesSecondOwner` in `boot/chatstart_test.go`; authorized-start cases in `tests/unit/read-conversation.test.ts`                                | Go injected publication and TS injected transport; neither proves provider uncertainty recovery.          |
| Explicit confirmation                  | `tests/unit/account-observation-confirmation.test.ts` and `tests/unit/read-account-confirmation.test.ts`                                                                                                         | Mechanical current-binding/principal comparison and retained attempts; no real browser account authority. |

The assembled M07 and known-command-repeat M09 subsets use
`go-core-startup.e2e.mjs --chat-two-turn --chat-typed --chat-history-reopen --run-native`
with exact source/build pins. At `56ed3941`, actual React first Send and Follow
produced exactly two accepted fixture Sends; explicit ACK and Go settlement/release
preceded Follow. Original inspect/start replay and changed-prompt refusal left
the provider ledger, journal, configuration and current UI unchanged. Independent
Computer observations found no grants or participants. This does not establish
provider-unknown recovery or every transient native operation; those retain their
separate lower-layer and live qualification requirements.

The injected `TestChatAccountAuthorization*` tests in
`boot/chataccountauthorization_test.go` map the M03 account-recheck subset to
actual private approval and final Send capabilities. They include requested
account mismatch, revocation/replacement/expiry, crossed lineage, exact Follow
after ACK/settlement, and an expired first-turn capability. The three-turn case
preserves supported TurnID reuse at a later generation. Read-intent promotion is
only the test's existing capability factory; no Computer read or ordinary typed
Create endpoint is exercised. Normal UI/account/profile and native Send evidence
remain higher-boundary requirements.

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
`Conversation.Observe` validates one bounded semantic event and maps it to those
transitions. Cancel/Dispose use the existing browser port and exact reservation.
Every incoming event must bind the captured view/document generation; body
correlation cannot select another live handle. Source and controlled-port checks
do not qualify all native cancellation and disposal outcomes.

## Result, delivery and slot reuse

`Finish` derives terminal state under the gate, withdraws membership, copies only
bounded result bytes into the accepted retention port, then commits metadata.
Known retention must match route, result and byte count. Unknown retention or its
late reply cannot publish result-ready or settled absence. Repeated Finish cannot
repeat retention. Normal startup uses the bounded durable result store. The
journal retains exact publication metadata, not prompt/answer/raw error text;
Activity remains content-free. Retirement re-reads the retained bytes before
publishing its handoff. A stored file alone cannot establish a completed result,
delivery ACK, settled lifecycle or reusable worker.

Cancellation before Send retains the original known-cancel policy, including
separate positive cleanup for a reserved surface. Cancellation after Send stays
Unknown. Client ACK and positive exact lifecycle settlement are separate; both
are required for Release. Historical identity/binding remains unchanged after
slot reuse, and the old route cannot open the new document.

Result acknowledgement and frame acknowledgement remain different operations.
The lifecycle generates bounded Responses frames; the external HTTP adapter is
separate and does not yet establish the business ACK needed for an ordinary next
user turn. The pure stream tests remain source evidence, not selected-client or
live-provider acceptance.

## Text conversation capacity

The current prompt and joined answer limits are each 8192 UTF-8 bytes. A prompt
above that bound is refused before admission. A browser event's larger transport
limit does not widen the joined-answer limit. Retention, frame cardinality and
encoded frame/buffer sizes are additional independent bounds.

If an answer crosses its limit after a useful delta, observation returns
`CHAT_LIFECYCLE_UNSETTLED` and fences the owner. The already emitted text is not
promoted to a truncated completed result. Ordinary observation, Send, Follow,
ACK and replacement admission cannot resolve that fence or free the worker.
This conservative behavior also blocks other work under that lifecycle owner;
automatic cancellation or recovery after overflow is not implemented.

The M10 capacity subset is executable in
`app/services/lifecycle/bytebounds_test.go`:

- `TestConversationPromptByteBoundaries` checks 8191/8192/8193-byte ASCII,
  Cyrillic, emoji and escaped-control inputs before actual fixture Send.
- `TestConversationOutputByteBoundaries` first delivers a useful delta, then
  exposes the remaining generated text. It checks exact retained bytes at the
  accepted limits and no completed publication, ACK, Follow or new Send after
  overflow.
- `TestConversationEscapedFrameByteBudget` separates raw answer bytes from
  encoded delivery capacity and checks the same conservative refusal path.

These are pure lifecycle tests with injected browser/journal/retention ports.
The adapter call counter is not a physical provider acceptance ledger. Composer
encoding, actual transport backpressure and packaged/live-provider limits remain
separate higher-boundary witnesses; this is not complete M10 acceptance.

## Checks and integration handoff

`infra/repos/lifecycle.AcquirePreservationInspection` retains the original existing read-only claim over a complete canonical snapshot, including nonempty writes, plans, recorded retirement and UNKNOWN history. Its copied `Inspection` contains metadata only. The original caller's absolute deadline is captured once before IO and remains effective even if context timer delivery lags. Every final `Verify` re-decodes the snapshot and checks the original named physical file, claim, scope and digest; failure poisons that lease, while `Close` releases only its descriptors. This separate observation path neither relaxes empty-only inspection nor constructs a lifecycle writer, clean retirement, successor, live handle or replay authority. Whole-profile preservation, original process/Computer settlement and fresh-owner admission remain separate enclosing work. The explicit `-chat-preservation-native` fixture lane checks actual disposable files, flock, byte/metadata preservation, substitution, relocation, cancellation and deadline expiry with synthetic canonical records; it does not prove an assembled writable restart.

`infra/repos/handoff.AcquirePreservationInspection` separately retains the existing handoff claim over an initial empty namespace or a full canonical chain containing nonempty recorded retirements. The same canonical transition, replay and cross-build rules run through the existing no-write/no-poison scanner facade. Original empty-only callers retain their original scanner and predicates. Observation copies scalar/stage metadata without retirement receipts or live origin/terminal capabilities; a chain with no records carries no persisted scope binding, so composition must independently bind lifecycle and roots. Each canonical head must otherwise name the selected current scope through its original publication or consumed successor. The original fixed deadline and physical identity/digest rechecks govern the whole retained lease. Corrupt/incomplete/staged or UNKNOWN-fenced handoff namespaces remain refused without repair. This observation is not original host/child closure, whole-profile preservation or admission. Pure chain tests and the explicit disposable native lane cover all stored stages, complete ancestor validation, cross-build/replay refusal, lock retention, substitution, relocation and expiry; recorded synthetic ACK/terminal values are not actual process receipts.

Targeted race tests cover the actual owner and real Mutex gate: journal publication
before lost reply, current withdrawal before IO, whole-callback serialization,
completion/cancel during pending journal/browser/retention effects, wrong receipts,
late replies, no repeat Send, exact immutable handles, five-slot waiting/reuse,
Computer call history, counter/retention bounds and metadata privacy.

These fixtures do not themselves qualify durable storage, Desktop binding at
actual IO, Computer's final native disclosure or provider calls. The linked
Desktop evidence records the separate normal-startup and restart witnesses.
Aggregate checks and applicable independent review remain candidate gates.
Installation, live-provider qualification and full cutover acceptance remain
separate from a source checkpoint.
