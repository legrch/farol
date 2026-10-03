# Computer selected-owner peer adapters

Status: Computer-owned source adapter only. This slice starts from pinned
dependency-only UNACCEPTED 94c2beb1e81a08f7f36656d88fb4a59885ea5992;
accepted integration remains acb131d9e7d483296d4edac262cf881cddfb91bb.
Chat/Task admission and Computer authority/lease/discovery dependencies are not
production acceptance. There is no normal app registration, authority producer,
real Chat/Task owner, persistence adapter, package or installed G1 qualification
in this slice. Active TS/Python routes remain authoritative.

## Published owners and consumer mapping

infra/peer/admission.NewChat accepts only the concrete published
modules/chat/contracts/admission.Current for one ordinary model turn.
NewTask accepts only modules/task/contracts/admission.Contract for one
delegated coding task. Both implement Computer's existing
port.CurrentTaskAdmission; their private interfaces support labelled injected
contract doubles in tests, not additional production constructors.

Trusted assembly selects the appropriate successful owning admission before
calling either constructor. Construction does not inspect, admit or prove current
membership. It cannot select a task from request IDs, provider lineage, status,
a cached launch document, a restored Computer participant or an ambient latest
task. An ordinary Chat failure never selects the delegated Task owner, or vice
versa. Each call uses that same selected published owner again.

Owner/session/task/TaskEpoch/participant/turn are explicitly copied into an
independent Computer binding, without aliases or numeric narrowing. The peers
import no neighbor app/domain/infra, create no business protocol and store no
positive binding. Missing membership invokes inspect with nil. A consumer
rejection, including its original wrapped unknown, remains unchanged. Broken
callback cardinality, invalid inspection, unavailable or unsettled owner state
never becomes successful absence or positive admission.

Only existing Computer error vocabulary crosses this peer:

| Published owner fact                                                 | Computer failure                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| Chat mismatch / Task identity mismatch                               | AUTHORITY_TASK_MISMATCH / task-grant                   |
| Chat/Task cancelled or cancelled context                             | WORKSPACE_REQUEST_CANCELLED / native-workspace         |
| Invalid, unavailable, unsettled, unknown or unclassified owner error | COMPUTER_AUTHORITY_STORE_UNAVAILABLE / authority-store |

Every mapped failure has retry=never. The authority-store label is the existing
Computer current-owner failure vocabulary; it does not claim the peer observed
native persistence. Raw owner diagnostics and future owner codes are sanitized.
No refusal/unknown operation is retried, reselected or reexecuted.

## Readonly constructor and lock order

Root assembly, owned by Core/Lead, needs these existing constructors. The values
below are already trusted owner objects/values, not parsed request bodies:

    current, err := peeradmission.NewChat(chatCurrent) // or NewTask(taskCurrent)
    if err != nil {
        return err
    }
    issuer, err := executionsvc.New(accessOwner, current, clock, admittedCeiling)
    if err != nil {
        return err
    }
    lease, err := issuer.Admit(ctx, authority.List) // Read uses authority.Read
    if err != nil {
        return err
    }
    service, err := workspacesvc.NewForExecution(lease, nativeWorkspace, clock)
    if err != nil {
        return err
    }
    contract := workspacect.New(service)
    // Core registers its existing parsed readonly route with this operation owner.

Use List for catalogue/bootstrap, which retain their existing internal read
capability requirements. Reuse the exact operation lease across every phase,
both catalogue context passes, both bootstrap passes and final disclosure.
A constructor or new request cannot extend an old operation's fixed deadline.
Turn/call/body generation correlation still belongs to the actual owning route;
the peer's membership projection is not per-call dispatch permission.

The current Core desktop.ReadMethod accepts a preconstructed Computer contract.
Registering a contract with one fixed lease for an entire connection would reuse
one operation's admission/deadline. Core must supply operation-owned construction
after parsing and trusted owner selection, preserving its existing schema and
response mapping. It must also validate the active owning call's turn/generation/
CallID; a response echo matching request IDs is correlation, not owner proof.
This slice does not modify that common method or introduce a competing wire.

Order remains native Computer qualification -> Computer snapshot gate ->
synchronous published Chat/Task owner gate -> pure inspection/disclosure.
The entire owner entry and callback perform no IO, journal work, mutation or
reentrancy. Workspace IO runs after these gates return. No owner-held path may
enter Computer. Completion/revoke invalidates under the owning lifecycle gate,
releases it, then performs any separate Computer update. Pending/unknown
persistence or coordinated changes must fence positive membership before IO and
cannot publish a stale route after a late commit.

## Required real normal application producers

The normal TS host must supply current existing owner settings and trusted
profile/Computer binding, approved physical workspace identities, approval
generation and exact task/participant narrowing. Core must select the accepted
trusted ingress/handshake and register the existing read family. Copying a
request or trusting UID alone does not establish that source. Go AccessRepository
must remain the sole coherent approval/participant owner; parallel independently
mutable TS/Go consent is not a valid bridge. Current updates/revocation must be
acknowledged only after the authoritative transition, retaining existing
generation/lineage tombstones and unknown publication fences.

The Chat application still needs its real BoundTurn owner and durable committed
admission/persistence sequencing described by Chat's published admission proposal.
Delegated Task needs its selected existing lifecycle owner and corresponding
persistence fence. Provider status, restored metadata and in-memory stand-ins
cannot replace either. Restart/reconnect requires independently current real
membership plus the original Computer ceiling; it cannot resurrect an unknown or
revoked route. Backend incarnation, TaskEpoch, Computer generation, turn generation
and CallID remain separate. No peer-owned journal or second authority is added.

## Evidence and remaining gates

Injected tests run actual Computer execution lease, workspace application and
published contracts for read/catalogue/bootstrap. They check explicit mapping,
copy isolation, source-gate preservation, simulated qualification-before-gates,
workspace IO outside both gates, fixed deadlines, foreign task rejection, and
revocation/mismatch/unsettled/generation/deadline changes after the first workspace
response discarding all output without another workspace call.

Source owner gates, qualification and workspace responses are memory doubles.
Tests exercise no native filesystem/process, durable publication, real provider
turn, common transport, normal app constructor or installed connector.
Production no-IO owner entry and real cross-owner locking remain unqualified.
Required R4 review and canonical full gate remain pending; targeted policy tests
cannot replace them. The earlier failed native group observation is preserved,
not retried or substituted by this slice. Lead reserves broader/native/package/
live work. G1 and same-chat Brain/code renewal acceptance remain outstanding.
