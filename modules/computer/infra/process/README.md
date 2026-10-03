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
probe, provider call, command dispatch or operation reissue. No implementation of
that native evidence port is supplied by this checkpoint.

Native preflight measures the approved root, canonical cwd, an operation-private
0700 scratch directory with exact owner/device/inode, and every selected
executable plus `/usr/bin/sandbox-exec`. Measured executable descriptors stay open
through the single start attempt. These measurements do not prove continuous
kernel/pathname identity or effective policy enforcement. The qualified mechanism
and native witnesses remain activation prerequisites owned by normal composition.

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
that gap. This checkpoint supplies no positive implementation of Qualification.

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
