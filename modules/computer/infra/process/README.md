# Selected process ownership

This source slice owns one process operation in Go. It is not registered in the
product route, and its tests do not qualify native execution. The active
TypeScript sandbox/watchdog and Claude peer remain in place.

## Trusted composition

Boot supplies one already admitted immutable execution lease, a prepared native
launch, a durable reservation owner, a dedicated no-IO gate and a clock to
`app/services/process.New`. The published `contracts/process.Contract` maps
independent DTOs to that service. Consumers reach Computer through this contract;
Task and Chat private implementations are never imported here.

Start/Read/Cancel requests contain only operation/handle correlation and bounded
output offsets. The added Prepare contract accepts exact arguments/stdin and
runtime/session/model/admission correlation, but cannot supply executable,
environment, root approval, task/turn identity, a deadline or another lease. The captured task binding and physical-root
seal must still match current Computer permission. The selected workspace must
have current shell verification. A new turn or reconnect cannot replace the
captured execution lease or widen the prepared command.

`infra/process.New` captures and copies a trusted `Command`. Native Start requires
its sealed `Seatbelt` producer; a bare nil-returning `Qualification` callback
cannot reach the old direct executable path. The compiler and its binding execute
nothing. It requires an independently implemented native `Qualification` for the
exact wrapped launch. That port is read-only current evidence inspection, never a
probe, provider call, command dispatch or operation reissue. The later held-role checkpoint below adds a real, one-shot synthetic conformance
producer, limited to its exact disposable fixture. General product qualification
and parent-side use remain unavailable.

Native preflight measures the approved root, canonical cwd, an operation-private
0700 scratch directory with exact owner/device/inode, and every selected
executable plus `/usr/bin/sandbox-exec`. Measured executable descriptors stay open
through the single start attempt. These measurements do not prove continuous
kernel/pathname identity or effective policy enforcement. The qualified mechanism
and native witnesses remain activation prerequisites owned by normal composition.

Direct and anchored producers share the same measurement implementation. The
anchored producer measures after reservation and the current-owner check, keeps
the original deadline, and rechecks current authority before its one bootstrap.
It retains the executable descriptors through that synchronous bootstrap attempt;
measurement failure cannot call the bootstrap. Separate disposable Darwin tests
cover changed roots, scratch modes/identity, symlink/hardlink and executable-pin
refusals, plus actual descriptor retention and closure after partial measurement.
Those tests execute no command and do not qualify the anchor/held role transport.

Environment is explicit, including the empty-environment case. Parent environment
is never copied. Command input and environment remain transient private process
inputs; the reservation contains correlation, digest and deadline, not command
text, input, output or credentials.

## One attempt and current authority

The existing journal owner implements `Reservation.Reserve`. Its known durable
receipt must exactly match the immutable intent before the native attempt.
Existing, missing, crossed or uncertain receipts never authorize another spawn,
including after restart. The service records an irreversible refused/unknown
start; repeating Start observes the same selected outcome or handle.

Permission is checked before reservation, after reservation, after native
preparation immediately before Start, and for final output disclosure. IO never
runs inside Computer or peer inspect callbacks. The root injects the selected
published current Chat/Task peer through the existing execution lease; there is
no process-specific authority system or latest-task lookup.

The fixed deadline remains the original lease deadline. The current ordinary
execution budget is 15 seconds; this slice does not expand it for shell or Claude.
A current-owner watch stops after its first denied/unknown observation and requests
cleanup on the already owned child. Cancellation, timeout, authority loss and
output overflow share one irreversible signal attempt. A refused/unknown signal
is not followed by escalation, a new signal, another executor or a numeric PID
probe.

## Native evidence and output

The production boundary uses `os/exec` and retains the exact `os.Process` object.
It calls Wait once on that child and signals only through that owning object.
There is no lookup or kill by numeric PID/PGID. The Darwin producer creates a
dedicated group but does not infer the group's identity or absence after reaping
its leader. Other platforms refuse native start.

Root Wait, pipe drain, group cleanup and descendant cleanup are separate facts.
The direct producer always reports group and descendant cleanup as unverified
when root Wait settles. A clean root exit, an accepted cancellation request or a
lost Wait observation cannot produce terminal-complete or a qualified Claude
result. Unknown remains sticky. No fake supervisor supplies positive proof.

Retained stdout/stderr share a 4 MiB ceiling. Each read returns at most 64 KiB from
each stream, with byte offsets and independent byte copies. The public DTO carries
base64 rather than assuming UTF-8. Root exit uses bounded pipe drain; incomplete
drain also prevents terminal-complete. Output is disclosed only under the current
selected authority. Cleanup control may still target the retained exact child
after output permission expires; it does not renew that permission.

## Required integration and qualification

Lead owns root boot/cmd/transport and journals. Product activation still needs:

- exact durable reservation/result receipts and authoritative reconnect routing;
- a qualified native confinement producer for the selected immutable command;
- an anchored supervisor with qualified group/cohort and parent-death cleanup,
  composed through the existing Go executable's root entry;
- native disposable qualification of root exit, descendants, signal refusal,
  deadline, output/backpressure and crash windows;
- normal product shell/Git and Claude journeys, then duplicate-executor retirement.

This slice does not create a second Go helper/watchdog or private wire protocol.
It does not restore a process from a PID or infer live admission from journal or
startup bytes. Root-owned integration must preserve existing unknown/refused
operations without retry or probing their children.

## Verification scope

The application tests use clock-controlled authority, reservation and native
boundary doubles. They cover fixed expiry, revoke/generation/root changes,
reservation-before-effect, restart/unknown/conflict, immutable handle selection,
current output disclosure and cancel ACK versus terminal facts.

The infrastructure tests inject the private OS boundary and manual timer. They
exercise one owning handle, Wait uncertainty, output paging/limits, deadline,
owner loss and a refused signal without invoking native spawn, shell, signal,
daemon or provider. A positive cohort observation is supplied only by a labelled
application parser double; the real direct producer never emits that proof.

Race/full CI, native tests, independent risk review, package, installed route and
live provider qualification are outside this bounded source result. Completed
source checks cannot be promoted to those evidence levels.

## Selected invocation construction

The source-only constructor increment adds independent published
`contracts/process.Invocation`, `PrepareRequest`, `PrepareResponse` and
`Contract.Prepare`. The consumer first calls Prepare on its selected operation's
contract, then existing Start/Read/Cancel on that SAME contract. Observe/reconnect
never builds another CLI invocation or guesses a latest session. Prepare receipt
is correlation only: it is not durable reservation, native launch, capability
qualification, provider input acceptance or final result.

Trusted root composition creates `infra/process.NewPreparer(runtimeID, template,
qualification, clock)`, then `app/services/process.NewForInvocation(operationID,
lease, preparer, reservation, gate, clock)` and publishes `contracts/process.New`.
The existing New constructors remain compatible. Template owns executable/hash,
workspace/root/cwd/physical identity, write mode and explicit environment. Template
args/stdin/binding must be empty so it cannot silently prepend/replace the selected
input. The required Qualification has no permissive default; NewPreparer itself
executes nothing and never calls Qualify.

The consumer supplies one exact runtime/session/model/admission plus bounded
arguments (at most 256 / 64 KiB) and stdin (at most 1 MiB). The configured runtime
ID must match. AdmissionID is checked against the SAME selected lease's
Grant.AuthorityID under current owners; a body ID is never lookup/admission proof.
Preparation retains independent copies and permanently rejects payload rebind.
Root supplies the exact admitted Grant.AuthorityID as the selected consumer
correlation; Tasks need not import Computer app/domain to obtain it. It is not
a token that grants permission. Session/model remain opaque correlation. Tasks
owns provider CLI flag construction,
provider capability/entitlement and observed session/model verification; Computer
neither interprets provider transcripts nor invents a CLI/task engine. A header is
not proof that the CLI actually used that session/model: selected args and runtime
observations must agree in Task's provider adapter.

The actual native mapping puts arguments/stdin into the existing Command and
runtime/session/model/admission into its optional Binding. Its digest covers all
these values plus trusted executable, environment and physical scope. Absent
Binding is omitted from JSON so legacy command fingerprints stay unchanged.
Command/input stays transient; root reservation stores only existing intent,
correlation, digest and original deadline. No journal/result/ACK owner is added.

Prepare validates current authority before and after the producer construction,
then discloses the bounded metadata under the same owners. No preparation IO runs
inside either owner or application gate. Start refuses unprepared/pending state,
checks immutable seal/invocation drift and uses the existing durable Reserve ->
current guard -> one Spawn path. Refused/unknown preparation/start cannot be
reconstructed, moved to another executor or reset by a new turn/reconnect.
Known preparation survives denied disclosure and can be observed without building
again. The original ordinary deadline is never reset or widened beyond 15 seconds.

### Concrete remaining dependency before real Claude

The selected constructor is usable source; it does not qualify O4. Root must bind
one published contract per admitted invocation, inject actual durable reservation
and retained result/reconnect ownership, an explicit approved CLI/hash/environment
and an effective Qualification for that exact command. Qualification must enforce
filesystem/credential/network/Git restrictions and reject permission bypass,
`--bare`, alternate authentication HOME and model/session mismatches as applicable
to the selected provider policy. Tasks must map its exact session/model/admission
and supported flags/input format through this contract and interpret correlated
structured provider observations. No Task source is changed in this increment. Stdin is one initial immutable byte
payload, not a persistent input/steer channel. Exact-session continuation needs a
new legitimately admitted invocation after the prior invocation's qualified
settlement, keeping the SAME provider session and supported resume flags. An
unknown prior invocation cannot be replaced to obtain continuation.

The direct Darwin producer still measures paths/executable before spawn rather
than proving descriptor continuity through exec, and still retains only the root
os.Process. Root must compose an anchored supervisor/cohort producer through the
existing Go executable, with exact incarnation/operation ownership, qualified
parent-death cleanup and group/descendant settlement. It must retain authoritative
receipt/evidence across root exit, cancellation, timeout, observer loss and crash.
No numeric PID/PGID lookup or new helper/watchdog/authority/journal is supplied.

A real Claude terminal claim requires SAME admitted invocation, actual provider
result/session evidence, exact root Wait, bounded pipe drain AND qualified group
and descendant cleanup. Root Wait (even exit 0), Setpgid, Kill acknowledgement,
path/hash preflight and fake-port PASS are insufficient. Current direct producer
always reports cohort cleanup unverified; Computer therefore keeps Unknown rather
than promoting it to Terminal. Native qualification/disposable tests and a bounded
cheap selected CLI journey are Lead's lane. No provider or OS process was started
for this constructor's tests, and all prior refused/unknown operations remain
frozen. Full CI/race/native/review/commit/integration are still canonical-lane work.

## Restrictive Seatbelt construction checkpoint

Root composes `NewSeatbelt(selection, nativeQualification)` from the SAME selected
lease's coherent `port.AccessSnapshot`, exact runtime ID, selected executable/hash
pins, owner home, and one operation-private scratch path/identity. This bounded
implementation accepts scratch only directly below `/private/tmp` with a `farol-`
basename. Root owns creation, lifecycle and cleanup; this module creates no scratch
factory, journal, helper executable, scheduler or authority record. Snapshot copying
runs without IO. Approval/Grant remain the existing authority owners; the compiler
neither issues permission nor changes their lifetime. Current guards and the original
15-second execution lease remain unchanged.

Use `Seatbelt.Environment(write)` for the trusted template, then pass Seatbelt as
the existing Qualification to `NewPreparer`. Selected arguments/stdin/model/session/
admission continue through the published Prepare DTO unchanged. The optional
`Command.Confinement` binds profile/parameter/pin/scratch-identity content and exact
mechanism hash into the original reservation digest. Replacing policy after that
seal refuses. Legacy absent bindings retain their encoding, but native start
requires a runtime-bound selected invocation and the new confined launch.

The producer constructs `(deny default)`, exact selected subtree reads, workspace
writes only for the captured write mode with existing ownership, operation-private
scratch, literal pinned executable rules and read-only OS loader paths. Ancestors
receive literal metadata access only. Owner and Grant exclusions deny both read and
write; mandatory credential stores are denied under selected root and owner home,
with a nested ASCII-name pattern. Paths are passed as `-D` parameters, never
interpolated into SBPL. Newline/control/invalid paths, unknown modes, exact-only
shell scopes, changed generation/root/runtime/hash, denied cwd and injected env
refuse before native evidence or spawn. The native boundary constructs only the
`/usr/bin/sandbox-exec -D ... -p <profile> -- <selected executable> <args>` route.
Kernel application/start failure is never followed by an unsandboxed fallback.

Network defaults to unconditional deny, including undeclared loopback/IPv6 and
child networking. Network-allow selection is currently refused before effects;
no approved endpoint/IPC mechanism is invented. This does not yet qualify a real
networked provider CLI. External Git global/system config and prompts are disabled
through the exact environment; owner HOME and injected tokens/loader/config vars
are not inherited. Workspace Git is supported by the policy compiler only for
explicitly history-approved metadata/common-directory equal to the selected
subtree's `.git`. Linked worktrees/external metadata are refused. Repository-local
config/hooks remain subject to the same filesystem, literal executable and network
policy; arbitrary hooks/external owner config are not claimed as qualified parity.

Required native evidence still includes actual SBPL parsing and enforcement,
process-tree inheritance, undeclared local/external egress denial, symlink/hardlink
and case/Unicode/diacritic aliases, runtime/pin/descriptor continuity and hostile
repository config/hooks. Source regex/parameter tests cannot establish those OS
properties. Where this mechanism cannot enforce the existing authority semantics,
its native Qualification must refuse; passing a few happy-path probes cannot fill
that gap. The later held-role producer supplies only fixture-scoped conformance; this
compiler checkpoint alone supplies no positive native qualification.

The anchored supervisor, parent-death control and complete cohort settlement remain
separate root-entry prerequisites. Direct root Wait/pipe drain still leaves group
and descendant cleanup unverified. No native process, runtime probe, real endpoint
or provider was executed for the compiler/launch tests. A labelled qualification
double tests only exact command mapping and refusal propagation. Independent review,
native/race/full CI, package, normal route activation and installed/live acceptance
remain Lead's serialized work.

`app/services/process.PolicyBound` is a pure consumer port on the existing preparer
and prepared launch. Current guards compare participant/task/admission identity
and recompile profile values from the SAME coherent current snapshot. The digest
must still match before preparation, reservation, native check and disclosure.
This prevents a broader parent/other participant profile, or a new exclusion below
cwd, from passing a cwd-only check. Comparison performs no IO or native evidence
lookup under owner/app gates. Permission and expiry stay with the existing domain
and execution lease. Whole-launch argv limits are checked before sealing/reservation.

## Fresh held-role native primitives checkpoint

This increment implements native primitives under Computer ownership, not a
second Task engine, authority system, journal, wire decoder or helper executable.
`NewQualificationAttempt(clock).Run(ctx, original, wrapped, fixture, deadline)`
performs actual synthetic file opens/content-hash verification and permission
checks, then controlled IPv4/IPv6 connect attempts with no payload. It belongs
inside the SAME pinned Farol Go held role, AFTER the selected Seatbelt profile was
applied and BEFORE release. Every path is synthetic. A failure or missing vector
consumes the one attempt; there is no retry, alternate runtime or cached PASS.

The private in-memory `NativeQualification` binds original and wrapped command,
profile/mechanism, stdin/environment, invocation correlation, self process and
exact original deadline. `Qualify` is read-only inspection; it does not rerun the
probes. `RunHeldGuest` consumes a shared one-shot dispatch claim, measures physical root/cwd and the selected executable, enables root's live
readiness responses through its `ready` callback, then waits for the existing
parent's one release and invokes
`syscall.Exec` once in that SAME process. Even a copied qualification cannot reset
dispatch. Expiry, parent EOF, wrong command/process, failed control close or exec
refusal never extends the deadline or dispatches again. No serialized proof can
restore a qualification on restart. The open executable descriptor is retained,
but pathname continuity through Darwin exec is still a native activation gate.

**Scope:** this producer currently requires a read-only disposable workspace
directly under `/private/tmp/farol-*`, all eight baseline/denial vectors and both
controlled loopback families. It is not a certificate for owner Brain/code roots,
write-capable shell, arbitrary aliases, Git hooks, networked Task providers or a
whole process tree. A PASS from injected CPU probes establishes none of those OS
properties. It cannot be transported to the parent as a public token or used as
the parent's direct-spawn Qualification. Do not activate ordinary production
execution by substituting this fixture proof for the full port contract.

### Exact root boot interface

The existing executable and common transport must implement these consumer-owned
Go interfaces; Computer defines no encoding, frame, command-line role or schema:

| Root responsibility                                                            | Computer interface / function                                  | Required evidence                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start one fresh anchor role of the pinned existing Go image                    | `NewAnchor(bootstrap, reporter, clock)` then `Anchor.Run(...)` | Anchor is its own CURRENT private group leader; no unrelated children or user execution in this role                                                                                  |
| Start one held leaf, with the exact selected Seatbelt plan and command binding | `HeldBootstrap.StartHeld(ctx, Command, stdout, stderr)`        | Retained exact `*exec.Cmd`, original cwd/env/input, `WaitDelay` in `(0, 1s]`, bounded nonblocking output collectors, no new leaf group and no `CommandContext` even with `Cancel=nil` |
| Prove same held leaf before and after listener registration                    | `HeldGate.Ready(ctx)`                                          | Two actual same-child round trips bound to pinned image, profile digest, incarnation and operation; not an input echo or startup-cache receipt                                        |
| Release once after the current guard and listener                              | `HeldGate.Release(ctx)`                                        | Existing current execution authority, original deadline, child-qualified fixture result, exactly one release; unknown ACK remains unknown                                             |
| Observe parent loss / owner stop                                               | `AnchorControl{ParentGone, Cancel}`                            | Existing common control EOF and execution-authority revocation/generation/stop signal; no PID polling, latest-task lookup or replacement admission                                    |
| Publish one typed observation                                                  | `AnchorReporter.Publish(ctx, AnchorReport)`                    | Existing common result/ACK and exact operation correlation; one publication attempt, bounded by the original lease                                                                    |
| Execute in the held leaf                                                       | `QualificationAttempt.Run` then `RunHeldGuest`                 | Same process/profile/immutable command and deadline, actual controlled baselines, one consumed dispatch; control/baseline FDs closed or close-on-exec                                 |

The owner for the root roles, composition and common schema is Lead. Expected
root touch points are `boot/computer.go`, `boot/computeringress.go`,
`boot/nativeruntime.go`, and `cmd/farol/main.go`; none is modified by this delta.
Root must include the pinned Go image in the selected executable set BEFORE the
original profile/command seal, select its role through the existing transport,
validate its actual launch profile and preserve the existing fresh
root/cwd/scratch/pin preflight. `RunHeldGuest` calls the root-owned `ready(ctx)`
callback only after its physical root/cwd and executable checks. Both live Ready
barriers must require that state; an early startup response cannot substitute for
it. Keep command stdin separate from control.
The original command and wrapped selected launch stay sealed; root does not
rebind a wider profile to make bootstrap work. The common transport owns parsing
unknown values, correlation, result ACK and durable reconnect; these interfaces
are composition ports, not a private transport protocol.

The explicit parent adapter is `NewAnchoredPreparer(operationID, runtimeID,
template, policy, bootstrap, executionContext, clock)`. Construction and invocation
preparation execute nothing. `NewPreparer` keeps its existing conservative direct
boundary; root must select the anchored constructor explicitly. Root must bind
its operation ID to the SAME service/reservation intent and its immutable lease.
The parent maps the existing service's `SpawnRequest.Deadline` and SAME current
owner `Check` to `AnchorBootstrap.StartAnchor`, over Lead's existing common role
transport. No app/contract DTO, root boot, command role or common schema changes
are part of this source delta.

`AnchorLaunch` carries exact operation/seal correlation, independent copies of the
sealed original and selected wrapped command, and the original deadline. The
bootstrap returns the exact retained owning `*exec.Cmd` and `AnchorLink`, including
on a possible start with an uncertain ACK. It must use `exec.Command`, set
`WaitDelay` in `(0, 1s]` before Start, and retain exclusive Cmd ownership. Root
validates actual pinned image/profile/backend/incarnation and unknown frames;
these typed ports do not establish that evidence themselves. The current owner
check runs before start and adjacent to held release outside owner/app gates.

The parent waits the SAME owning Cmd exactly once, receives one correlated
qualified no-fork `AnchorReceipt`, and closes retained control IO. Successful
cleanup requires BOTH exact clean anchor Wait/bounded drain AND the known guest
exec/kernel-exit/Wait/drain/no-fork receipt, plus the SAME final owner/deadline
check. A stop, missing/crossed receipt, lost ACK, wait/drain error, unsupported
platform or owner/expiry change remains unverified. `AnchorLink.Receive` must
honor its bounded context; `Close` must be safe against concurrent Receive/stop.
One `RequestStop` on that retained link has a separately bounded cleanup budget;
it never extends execution/output permission and has no process/signal fallback.

A possible-start resource stays inside the SAME immutable `Prepared` even though
the existing public Start returns outcome-unknown. `Preparer.RetainedHandle()` is
read-only trusted root cleanup correlation, never output access, body-driven
lookup, admission or a restart/reissue. Repeated preparation returns that same
selection; changed invocation or a second Spawn cannot replace it. Root owns
retention/reconnect of the same live service/preparer/control objects through its
existing owner; this adapter adds no durable journal or authority system.

Root composition and native qualification remain **route dependencies**. A CPU
contract test with injected bootstrap/Wait proves mapping and conservative state
classification only. It does not prove a production or native process route.
No process can be reconstructed or resumed from a journal/PID after an unknown
start, release, publish or stop. An admitted lease keeps its original deadline;
outer TaskGrant reissue neither renews it nor stops it solely because the outer
grant expired. The execution context and ParentGone belong to the retained
backend/anchor and existing execution owner, not an outer ChatGPT turn or MCP
request/response context. Ordinary connector reconnect alone cannot cancel an
admitted operation. Actual backend parent death stays conservative; it never
restores/reissues that operation. Owner revocation/generation changes continue to
win.

### Anchored observation and its limits

Darwin installs an `EVFILT_PROC` listener for the exact retained, still-held leaf,
requires its successful registration receipt and a second same-child barrier,
then releases once. It retains fork/exec/exit observations from that listener.
The listener is not a post-reap numeric lookup; concurrent close is serialized
with bounded event waits to prevent FD reuse. A fork immediately makes the cohort
unverified and requests the one anchor stop. Native event errors, observer loss,
incomplete drain, no observed exec/exit, owner loss and deadline do the same.

For a qualified no-fork trace only, kernel exit followed by ONE exact child Wait,
valid exit details and bounded pipe drain can publish `GuestCohortClosed`. The
anchor is still alive at publication. The current native producer sets successful
drain only when `Cmd.Wait` returns
nil: Go may hide drain errors behind a non-zero `ExitError`. Non-zero/signal exits
therefore remain unverified here and require independently retained EOF evidence
before any later positive classification. Root may map whole-operation cleanup
only after a known correlated result/ACK AND independently waiting/draining the
exact
anchor with the expected clean exit. A root-only Wait, report alone, killed anchor,
accepted signal or missing child is insufficient. CPU doubles that emit a closed
guest are parser/control witnesses, not native cohort qualification.

The kernel interface's `NOTE_TRACK` family is unsupported on current Darwin;
this implementation does not invent descendant tracking with `ps`, numeric
probes or a successor. The private anchor's one `SIGKILL` targets its OWN current
live group, including self. It is never an old/cohort PGID reconstruction,
post-reap check, fallback or escalation. Acceptance is only a stop request; an
escaped descendant or refused signal remains unverified. Cancel/timeout/crash
cannot currently become positive arbitrary-tree settlement. Root must never run
`NewAnchor` in the ordinary backend's group. General shell/Git/Task trees require
a separately qualified containment/settlement mechanism or explicit refusal.

### Minimal fresh native recipe — prepared, not executed

Lead's serialized native lane must use NEW synthetic files, listeners, private
state, exact roles and immutable fixture identity. Never reuse any old failed or
unknown cohort, operation, PID, profile directory or connector call.

1. Establish unconfined baselines once: same-UID regular readable files with
   measured synthetic hashes, an existing writable read-only-mode probe target,
   controlled IPv4 and IPv6 listeners with retained identity, exact private
   scratch mode/owner/device/inode, approved physical fixture root and all
   pinned images. The fixture nonce is correlation, not ownership proof.
2. Make the forbidden outside file readable at baseline. Create a SAME-INODE
   hardlink under the allowed subtree to that outside file without adding a
   denial rule merely for the hardlink name. Create a physically verified
   case/Unicode/diacritic alias of an existing excluded synthetic target. This
   fixture must exercise authority equivalence, not an unrelated denied name.
   Baseline each vector before confinement; ENOENT, ELOOP, connection refusal
   or timeout can never stand in for policy denial.
3. Launch the SAME pinned Go image's held role under the actual selected SBPL,
   with independently correlated profile/operation/image evidence. Run every
   real conformance vector once. An unexpectedly readable alias/hardlink or
   connect/open success is a failure even if ordinary reads work. The current
   path-only Seatbelt rules may fail these vectors; reject before release and
   retain that mechanism gap. Do not drop vectors, widen grants or switch executor.
4. In a separate freshly owned accepted case, prove held-before-registration,
   both same-child barriers, conformance-before-release, exact final executable,
   single release/exec, no-fork command exit, kernel exit, exact child Wait and
   bounded drain, result ACK and exact clean anchor Wait. Only that correlated
   native trace can qualify the restricted no-fork classification.
5. Fresh cases must exercise `fork`, `vfork` and `posix_spawn`, event coalescing and
   registration races, descendants keeping output open or escaping the group,
   lost observer/control/result ACK, parent death, cancellation, fixed timeout,
   owner revoke/generation change and refused stop. Every unsupported or unknown
   tree must stay unverified. Prove exact owned cleanup independently without
   post-reap PID/PGID probes. Do not declare broad cohort qualification merely
   because the selected no-fork case passes.

No native/process fixture, race/full CI, provider, package, installation or
production connector call was performed for this increment. CPU checks use
private injected probes/bootstrap/listener/stop/reporter boundaries and cover
all required vectors, seal/lease/process drift, one dispatch/publication/stop,
owner loss and conservative guest-vs-anchor evidence. Native qualification,
independent risk review, full CI and any source commit are still Lead-lane gates.
