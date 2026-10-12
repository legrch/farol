# Selected process ownership

## Current product composition

The packaged desktop host conditionally registers the root-scoped Shell producer
through `boot/connectorshell.go` and `boot/nativeruntime.go`. It requires compiled
support, resource/runtime qualification and mutation-capable profile storage.
Version-1 profiles retain their readable Go route without Shell or migration;
source Dev also retains the File route because it has no protected app bundle.
Package attestation failures still refuse startup rather than selecting a fallback.
The normal producer uses `RootScopedGit` under the captured `approved-roots-v1`
policy; it does not activate the separate `QualifiedGitRead` selection below.

Source registration is not release qualification. Disposable packaged MCP checks
cover bounded Bash, synthetic Git and observation of an original result after
MCP reconnect. Ordinary Git configuration/hooks, external Shell, cancellation and
subsequent retirement remain unqualified. A stop ACK can precede loss of the
supervisor's command-exit observation; the unknown original operation must remain
preserved without replay. A requested stop targets the original retained root,
then sends TERM once to the watchdog's own anchored group so ordinary descendants
close inherited pipes.
The observer survives that TERM to collect actual root exit and drain output.
An already observed root is not signalled again; its anchored group can still
receive the original stop while pipes remain open. The supervisor
finishes only after final observations and already queued control ACKs have been
written. Acknowledged control can settle with independently observed root/output
and supervisor completion; refused or lost control remains unknown. A refused
root or group stop retires only the observer with a failure status, without an
alternate signal. Detached or TERM-resistant descendants can still
retain pipes until the original deadline; neither accepted group TERM nor
observed pipe EOF establishes complete descendant cleanup. See [current approval boundaries](../../../../docs/sandbox-approvals.md)
and [Computer parity](../../../../docs/computer-parity.md) for the selected contract
and the separate native, source and installed evidence.

## Bounded GS1 Git read selection — source only

`SeatbeltSelection.Git = QualifiedGitRead` with its non-nil `GitReadSelection`
adds an explicit strict read selection to the existing producer. It requires
the SAME captured `LegacyProtectedFiles` owner/task policy; it cannot silently
switch a saved policy or reinterpret `approved-roots-v1`. Existing `DenyGit`,
`WorkspaceGit` and `RootScopedGit` behavior remains unchanged. The name describes
the required native gate, not an already acquired qualification certificate.

The trusted binding contains the pinned Git executable path, exact worktree,
Git directory and common directory, and each directory's device/inode identity.
`Command.Root`/`RootIdentity` retain the original approved root; `Command.Cwd`
must equal the worktree and the selected task subtree. The selected approved
workspace must have `GitHistoryApproved` and matching `GitMetadata` paths.
External linked-worktree metadata and tool/config roots must independently
exist in both the captured approval and task grant, with physical identity,
subtree scope and Shell verification. Discovery, HOME, PATH and a `.git` pointer
grant nothing. Missing or conflicting authority refuses before reservation.
Explicit exclusions currently refuse this multi-root selection rather than
being dropped. Broad HOME/protected-store scopes remain refused.

`GitReadArguments(binding, view)` constructs exactly `GitReadStatus`,
`GitReadDiff` or `GitReadStagedDiff`. The existing Prepare invocation carries
that exact argv and empty stdin. Other options, an alternate executable/cwd,
environment injection or `Write=true` refuse. Every selected root is narrowed
to read access; only private scratch and normal output devices remain writable.
The existing profile digest seals the Git binding and approved ancestors.
Preflight opens all three directories relative to retained approved ancestor
descriptors, checks the supplied identities and rechecks all named paths before
the single existing dispatch. Partial measurement failures close every acquired
handle. These are preflight observations, not continuous exec/object guarantees.

Explicit `--git-dir`/`--work-tree` and `GIT_COMMON_DIR` prevent pointer/config
discovery from choosing another metadata path. Optional index locks are disabled
and the pager is suppressed for bounded output. Normal Git config/includes,
hooks, fsmonitor, diff drivers and interpreter/toolchain execution are not
secretly disabled or redirected to an alternate HOME. Their actual files and
executables still need approved scopes; granting HOME's value supplies none.
Read-only scope may refuse a tool requiring writes. Arbitrary process trees
remain unqualified. There is no new executor, shell parser, result owner,
admission store, journal or fallback.

### Exact Lead glue and remaining gate

At the historical GS1 base, `boot/nativeruntime.go` left `connector.processes`
unset. The current normal producer above fills that seam for `RootScopedGit`,
but does not select the closed GS1 views. `boot/computerconnector.go` still
requires both process and mutation producers before admitting Shell;
`boot/connectorprocesswire.go` owns retained Start/Read/Cancel. Catalogue refresh
cannot select the separate GS1 producer.

Lead can map only the three closed input views to `GitReadArguments`, build the
trusted `GitReadSelection` and `Command` from the SAME immutable lease snapshot,
then compose `NewSeatbelt` with the actual independent `Qualification`. Use its
`Environment(false)` on the empty-args/empty-stdin/unbound trusted template and
the existing `NewSupervisedPreparer` or separately qualified anchored producer.
Prepare on the SAME selected instance with the existing runtime/session/model/
admission binding, and return that exact `processsvc.Selected` plus
`NewObservationWorkspace` for the original root to `connectorShellSelection`.
Keep the existing reservation/result/reconnect owner and original deadline.
No app/contract/schema DTO extension is needed for this source selection.
The only additive trusted composition input is `SeatbeltSelection.GitRead`.
The string request must never be passed to a shell or arbitrary argv parser.

This patch does not supply the missing production `Qualification`. Its current
one-shot fixture implementation is restricted to disposable `/private/tmp`
roots and cannot certify an actual writer. The historical readable protected
hardlink remains a failing gate. Before activation Lead must provide effective
object/alias confinement evidence for the exact roots and launch, with normal
config/toolchain behavior, and qualify the retained process lifecycle in the
serialized native lane. Path-only Seatbelt or a nil-returning callback is not a
substitute. A changed policy or additional root requires normal owner authority;
it cannot be invented to make this constructor pass.

CPU regressions cover closed views, all-root read narrowing, scope/metadata/
identity drift, descriptor retention and partial closure, existing Prepare and
pre-reservation refusal, and retained binary reads without a second dispatch.
The watchdog double retains a clean root exit and output as `Unknown` with
group/descendant cleanup unverified. That is not real Git status/diff, native
hooks/toolchain or external reconnect evidence. Host qualification, root wiring,
aggregate/risk review and real GS1 acceptance remain Lead-owned. Historical
refused/unknown operations are neither replayed nor replaced.

The opt-in `approved-roots-v1` compiler is documented in [Root-scoped access and approvals](../../../../docs/sandbox-approvals.md). It preserves the existing process/lease/journal owners; the compiler alone grants no execution authority. Current conditional product wiring is described above. The strict credential-alias gate below remains historical evidence for the legacy policy, not a qualification of the new root-scoped contract.

This source slice owns one process operation in Go. Its controlled tests do not
qualify native execution. The root-scoped product producer reuses the existing
watchdog resource; separate legacy TypeScript and Claude paths remain in place.

The opt-in Darwin test `TestNativeSeatbeltCredentialAliases` is an explicit
native policy gate (`go test -tags farol_native_process
./modules/computer/infra/process -run '^TestNativeSeatbeltCredentialAliases$'
-count=1`). It runs one bounded `/bin/cat` child under the actual generated
Seatbelt profile, using only disposable synthetic files. On October 6, 2026,
the allowed baseline succeeded and direct credential, symlink and outside-root
reads were denied, but a hardlink revealed the protected synthetic content.
The exact child exited and the gate **failed**. This demonstrates a confinement
gap, not process/product qualification. Do not activate that legacy-policy
selection or substitute a permissive qualification callback while its gate is unresolved.
The build tag keeps this real native operation out of ordinary pure tests.

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

The fixed deadline remains the original lease deadline. Root-scoped Shell has
up to ten minutes for preparation and execution, capped by current owner expiry.
Legacy Shell and ordinary read/mutation leases retain their 15-second budget.
Progress reads use a separate short READ lease and never renew the process.
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
again. The original deadline is never reset. The invocation constructor accepts
up to the ten-minute process ceiling; trusted admission selects the actual
budget, and legacy native strategies retain their existing shorter limits.

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
anchor is still alive at publication. The direct and held-leaf producers now pass
independent private stdout/stderr witnesses through their existing writer inputs.
Each witness must observe pipe EOF and successfully copy through the SAME bounded
collector. Existing output truncation/overflow facts remain separate.
`Cmd.Wait` returning nil or `ExitError` alone proves no drain: Go can mask a pipe
copy error or `WaitDelay` behind nonzero/signal exit. A forced pipe close, collector
error, missing/replaced witness or optimization that bypasses EOF remains
unverified. Nonzero/signal exits may supply drain evidence only with BOTH actual
EOF/copy witnesses; all existing kernel exec/exit, no-fork, owner and deadline
requirements still apply. This adds no broader containment claim. Root may map
whole-operation cleanup
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

### Root held-control adapter checkpoint

`boot/processheld.go` implements the existing `HeldGate` with the common framed
JSON-RPC transport and canonical `api/desktop/v1` types. The trusted constructor
captures compiled build, profile, backend, operation, sealed command, anchor and
held-child identity plus the original deadline. Two distinct live barriers follow
the held role's explicit Prepared callback. Release consumes one attempt and
requires both barriers. The server writes the complete OK frame before signalling
release, so closing control FDs before exec cannot truncate that ACK itself.
Local write completion is not peer receipt, execution or terminal evidence.

The held server selects terminal rejection: an invalid envelope, crossed context
or rejected call closes that channel. Ordinary desktop/connector servers retain
their existing behavior. The client also permanently closes on refused/unknown
exchange, timeout or ordering failure. There is no replay, reopened server or new
execution lease. Pure memory-pipe tests cover the actual generated envelopes,
lost ACK, raw-peer attempts to correct a rejected release, and both serialized
and concurrent local delivery callbacks. This adapter is not registered on the
ordinary backend or external MCP. Root CLI/FD provenance, bootstrap selection,
native qualification/Prepared wiring and an actual held exec remain required.

### Independent output EOF checkpoint

The focused CPU regression first reproduced the direct producer's incorrect
`ExitError => drained` classification. Memory-stream tests now cover both EOFs,
last bytes accompanying EOF, binary retention, missing/reused/shared witnesses,
forced-close/read/collector errors and short writes. Direct leaf wait/drain still
leaves group and descendant cleanup unverified. Anchor parser doubles retain the
existing no-fork requirements for nonzero/signal reports. These are CPU evidence,
not native process, kqueue, confinement or production qualification.

Go 1.26.2's Darwin `os/exec` copier uses `io.Copy` from an `os.File` pipe; that
file's `WriteTo` delegates to the witness's `ReadFrom`. The witness strips further
copy optimizations to observe actual EOF and successful retention. If a different
copier bypasses the witness, classification fails closed. Collectors keep the
existing bounded nonblocking requirement. Input acceptance is a separate fact:
a quick-exit stdin EPIPE is not output EOF or command-input acceptance.

`TestNativeOwnedLeafDrain` is prepared behind `farol_native_process`. It uses the
exact built Go test image as a disposable synthetic leaf, large unread stdin,
binary stdout/stderr, nonzero exit and one original-handle signal exit. It retains
one original `Cmd`/`os.Process`, waits once, bounds drain and self-expiry, and keeps
unknown evidence rather than retrying or selecting another launcher. This is a
lower-boundary lifecycle fixture without a Qualification callback, shell, legacy
watchdog, connector, held role or kqueue/no-fork certificate. It cannot qualify an
arbitrary process tree or the production route. On failure its remaining cases
stop; an unknown wait/drain/stop retains the exact disposable directory.

CPU and compile-only checks:

```sh
GOCACHE=/private/tmp/farol-shell-lifecycle-go-cache go test ./modules/computer/infra/process -count=1
GOCACHE=/private/tmp/farol-shell-lifecycle-go-cache go test -race ./modules/computer/infra/process -count=1
GOCACHE=/private/tmp/farol-shell-lifecycle-go-cache go vet ./modules/computer/infra/process
GOCACHE=/private/tmp/farol-shell-lifecycle-go-cache go test -tags farol_native_process ./modules/computer/infra/process -run '^$' -count=1
```

After Lead confirms exclusive serialized native-lane access, run the following
exact selector once with normal local tooling permissions. A denied/unknown
operation stops this route; do not retry or reroute it:

```sh
GOCACHE=/private/tmp/farol-shell-lifecycle-go-cache go test -tags farol_native_process ./modules/computer/infra/process -run '^TestNativeOwnedLeafDrain$' -count=1 -v
```

On 11 October 2026, the exact selector above passed once on source
`52085c1d88039a618c7450c1acb2a177aea5fa9a`, Darwin ARM64 with Go 1.26.2,
after the serialized OTA lane completed. Both synthetic leaf cases retained
one original Wait and both output EOF/copy witnesses; quick nonzero exit used
no stop, and the signal case used one original-handle stop. The test image
SHA-256 was `bbc84089c7846d406b947fc7bc5e301f4bd9be2bef235377fbf99094a8701dd5`.
Group/descendant cleanup and stdin acceptance remain unverified by this test.

Root-owned activation, effective confinement, real held exec/kernel no-fork trace, exact
anchor result/ACK/Wait, descendant/unknown cases, independent review, aggregate
checks, package/installed/live and release gates remain open. `connector.processes`
remains unset; no shared contract, authority, boot/schema or desktop change is
included here.
