# Go installed-helper recovery policy

`app/services/helperrecovery` prepares the existing helper's `inspect_recovery`
and `reconcile` behavior in Go. The selected updater still invokes
`resources/native/update_helper.py`. This service has no CLI, selected runtime
adapter, new journal, background recovery loop or relaunch route.

The existing input application owner parses one independently captured request
through a consumer-owned port. Recovery then uses the same operation's verified
journal, complete no-follow entry observations, expected app-tree checks, native
namespace effects and durable journal publication through its runtime port.
Trusted composition must bind that runtime to the same request and retain the
existing lease, slot, routes and admission until actual native return. Input
validation and an observed pair grant no effect authority.

## Native port implementation

`infra/native/execution.With` implements the runtime port inside one active `helperroutes.WithFiles` borrow. Composition supplies the same parsed request, the existing operation journal, its original absolute deadline, and the existing owner's lease/slot/admission and retained-unknown callbacks. Raw descriptors or request fields do not replace the live borrow. This adapter opens no route, acquires no lease, creates no second journal and selects no CLI route.

The adapter observes the five fixed names with no-follow descriptor-relative queries and checks a complete second scan. Only `ENOENT` proves absence. Sequential mutation-sensitive scans are not an atomic namespace snapshot. `rejected-target.json` is a record-presence observation, never an app-tree or namespace-effect operand. App-tree checks compose the existing physical verifier with the pure identity policy. A negative match requires an inspected original verification refusal; opaque, cleanup, native and cancellation failures remain errors. Namespace effects delegate to the existing one-attempt rename/exchange primitive under the owner's fence.

Methods serialize actual synchronous native return, including cleanup. They capture the original deadline once and enforce it independently of delayed timer notification; later caller contexts cannot renew it. Retained interfaces refuse after `With`, including after a panicking callback. Each effect consumes its attempt before I/O or cancellation; uncertainty is retained by the existing owner and survives a fresh adapter. The journal uses `ReadHelper`'s 8192-byte preparse bound and the existing revision-based CAS. Readback supplies no startup, effect, helper-exit or durability acceptance beyond the existing repository's own completed persistence contract. A scope that already completed a namespace or journal effect retains uncertainty in that same owner if a later method, the application callback or scope cancellation prevents completion; a successful individual call does not settle the enclosing recovery.

Disposable native filesystem tests cover tree identity/digest observations, fixed entry mutation, rename/exchange identity readback and borrowed-handle preservation. Route/admission/journal seams in these adapter tests are symbolic; the production entry refuses a missing live borrow. Deadline, actual-return, scope, classification and retained-unknown tests do not prove a live lease, installed helper, real process exit, package or OTA/rollback acceptance.

`WithInstallation` adds the admitted installation port under that same original scope and requires the caller's rejection repository, composed with the same operation descriptor and journal admission/gate. `Prepare` uses the bounded helper reader's confirmed-absence revision and the existing CAS to create only prepared; an existing, invalid or unreadable journal is never adopted. Subsequent phase writes retain the original revision chain. `RejectTarget` delegates the fixed failed-directory identity comparison to the borrowed repository. Each method consumes its effect attempt before cancellation or I/O; successful CAS or record acknowledgement makes a later fence refusal uncertain in the same owner. Real disposable journal tests cover absence, refusal, physical phase readback and post-write unknown retention; focused port-failure tests use symbolic rejection. Additional Darwin composition uses both actual repositories with one original gate and owner, verifies the physical rejected-directory binding and proves that a post-record fence refusal blocks the same journal writer. Admission, lease, route and quiescence remain symbolic, and these tests invent no app-tree acceptance, namespace exchange or terminal rollback phase. Neither entry closes a borrowed repository or selects the helper CLI.

## Application policy

`Inspect` is repeatable read-only preflight. `Reconcile` consumes one attempt
before any I/O or cancellation check, shared across copied wrappers. It never
retries a failed port, starts a prepared exchange in recovery, removes retained
state or replays a historical launch. A pre-exchange prepared pair records
`cancelled`; an already exchanged pair can finish naming its predecessor and
record `verified`. Repairs for the former two-rename crash gaps preserve their
existing exact-pair checks and predecessor-state refusal.

`domain.PredecessorStateUnqualified` retains the narrow measured-version guard
for 0.1, beta-3, beta-1-through-9 state readers and beta-1-through-11 completed
process readers. A false result makes no general state-compatibility claim.
Forward recovery of an incompatible predecessor is limited to `recover` at
`rollback_started`, with an intact exact target and predecessor and no staged,
failed or rejected-target entry. The pair is checked again after the owner
fence. Settled rollback retains the original distinction between an authenticated
source app and merely owned failed directory bytes.

Dependency failures retain their exact causes behind closed outer text.
Opaque or malformed errors remain internal; wrapping a refusal beside an I/O
failure cannot downgrade it. Concurrent cancellation keeps both causes. Every
possibly effective namespace or journal call retains uncertainty through later
failures, including inspected refusals. Bounded traversal of joined error causes
conservatively retains uncertainty for oversized or cyclic graphs. No failure
offers another dispatch.

The pure application checks its context around ports and final success. Native
ports must independently enforce the original absolute budget and earlier caller
deadline, including when cancellation delivery lags. They retain synchronous
process and descriptor custody; application context checks cannot prove native
cleanup. Final helper exit-70/exit-79 classification remains composition work.

Static outcomes from the original Python AST cover 4,354 phase/pair rows and
1,024 predecessor-version pairs, with the original source digest checked by Go
tests. Instrumented port tests cover effect/journal order, fence replacement,
one-shot consumption, cancellation and internal/unknown provenance. A separate
composition uses the actual Go input decoder and application owner, including
refused inputs that cannot reach a runtime. These fixtures do not verify native
trees, mutate an installation or establish Darwin, packaged, clean-Mac or OTA
acceptance. The existing `domain/recovery.go` startup assessment remains a
separate observational subset; it is unchanged by this preparation.

## Admitted installation policy

The unselected `app/services/execution` service owns apply and explicit rollback policy over consumer-owned `HelperInstallationRuntime`. Its independent captured-request parser has no effects or admission authority. The same trusted operation owner supplies the runtime only after its actual route, slot, lease, stopped-writer and continuation gates; this application opens no path, process, route or journal. Copies share a one-shot attempt consumed before cancellation or port I/O. Native ports independently retain original absolute deadlines and actual-return custody.

Apply requires the exact owned source/staged pair, no previous/failed/rejected entry, accepted tree observations and the same device before preparing the original journal from confirmed absence. It exchanges only the measured pair, verifies the displaced source, fences the move to previous, writes new_installed and checks the installed target. An opaque target-verification error remains an error. Only a confirmed negative tree match may restore the same predecessor, quarantine the measured failed target, durably record its rejection and write rolled_back. That settled negative update returns the existing target_verification code with no incomplete-scope error; it is not a successful update, helper exit, relaunch or startup proof.

Explicit rollback accepts only verified/completed/launch_requested with an exact owned app/predecessor pair and no staged, failed or rejected entry. The existing predecessor-state predicate refuses the known incompatible historical versions. It fences each destructive namespace transition, preserves the failed target and verifies the restored source before rolled_back. It does not manufacture rejected-target evidence for an otherwise accepted target. Every later failure after a confirmed effect remains uncertain, including a known refusal; joined or opaque errors retain their causes behind closed text and cannot inherit a nested refusal classification. Symbolic policy tests assert ordering, pair custody, refused phases/versions, no-effect preflight, copied/concurrent one-shot behavior and late-result suppression. These are not native installation, process, lease, package or OTA evidence.

## Inherited-role process fixture

`helperchannels.TestProcessCompositionInheritedHandshake` starts a fresh Go test
executable with explicit `os/exec.ExtraFiles`: request fd3, ACK fd4, BORROWED
regular lease fd5, and continuation fd6. This is a declared fixture ABI matching
the launcher role layout, not production role authentication or a selected Go
helper. Stdin and captured stdout/stderr provide test coordination only.

The child uses the real request/channel owners, input parser, protocol service
and JSON codecs. The parent closes its inherited transport ends, seals request
EOF, checks one bounded correlated ACK plus EOF, and supplies continuation. One
case seals a correlated continuation; another withholds EOF past the child's
original deadline, observes nil bytes, then proves a late write and fresh read/ACK
bounds cannot revive the consumed attempts. No installation effect is admitted.

The parent holds a real disposable flock. Parent/child snapshots compare fd5's
identity, flags and unchanged offset (queried without movement), including after
transport cleanup; the parent also checks its contents. A separately opened
description must contend before, during and after child execution, then acquire
only after that same child is reaped and the parent's last alias closes. Snapshots are observations, not a
syscall audit or proof against arbitrary transient mutation. Unsupported flock
filesystems skip this witness without claiming qualification.

`exec.Cmd.Wait` observes the exact child's exit and joins both diagnostic copying
producers. A child terminal line alone is only a pre-return receipt. Each run
retains its private `farol-helperchannels-process-*` directory under the host's
normal temporary directory, with stdout, stderr and a parent terminal receipt,
including failures/skips. Abnormal cleanup may kill only that retained fixture
process handle; killed or unknown execution fails and never counts as drained
product Quit.

These are real process/descriptor transport witnesses only. Request predecessor,
build, process-start and acceptance values remain synthetic. They do not prove
production inherited-role authentication, original application quiescence or
admission, full helper CLI composition, relaunch, install/apply/recover/rollback,
package, OTA or Python retirement. Existing source/native evidence is unchanged.

## Unselected closed-predecessor boot scope

`boot/releasehelperclosed.go` composes the existing request parser, protocol and
JSON codecs, byte-channel owners, physical routes, slot verifier, handoff verifier,
bound native process observer and update lock. There is no CLI selection. Only
closed `apply` and `rollback` requests with explicit `legacy` or `shared`
`installLocation` and their physical slot binding are supported. Missing closed
proof or the optional-location legacy branch refuses before native admission.
This is a custody/protocol checkpoint, not complete helper readiness.

The trusted launch supplies actual, distinct `os.File` owners for request fd3,
ACK fd4 and continuation fd6. Their ownership transfers on call, including
failure. It supplies the already exclusively locked authoritative fd5 as a borrow
and keeps that File and every alias unchanged through actual return. Explicit
role checks inspect only those supplied Files; they cannot authenticate the
producer or prove absence of dup aliases. A misplaced borrowed lease is never
adopted for transport cleanup. The scope never duplicates, seeks, reconfigures,
unlocks or closes fd5. The existing handoff verifier performs its independent
contention probe and idempotent inherited exclusive check; it acquires no fresh
authoritative predecessor lease.

The original absolute deadline is supplied before request work and captured with
any earlier caller deadline before constructors or I/O. `waitSeconds`, copied
wrappers and fresh caller contexts cannot renew it. Native checks independently
observe that absolute end, including when context timer notification lags.
Request bytes are EOF-sealed and parsed once. The protocol holds independent
values for both full builds, operation, process birth, predecessor state/start/quit
digest and lease identity. The physical canonical slot additionally binds location.

One live route borrow retains home, applications, state, update and operation
Files. Before and around the ACK/continuation boundaries, the same native owner
rechecks those routes, the slot, inherited lease custody, actual process absence
and the exact confirmed quit receipt. Live PIDs refuse even with a different
birth token; unknown/error observations never establish absence. It emits one
correlated `closed_predecessor_ready` frame only after those checks. Continuation
is one bounded EOF-sealed frame checked against the original protocol request.
Only after continuation and another closed-custody check does it acquire the
existing update lock. The parent's inherited lease remains caller-owned.

A single internal synchronous callback can borrow the same Files, captured request
and original bound for later composition of the existing journal/execution owners.
Its fence compares the complete request and rechecks the same native admission,
including the update lock. Copies share one nested borrow attempt and sticky
uncertainty. Retained wrappers refuse after scope closure. Failed fences, callback
errors/panics and final cleanup failures retain exact private causes behind closed
public text. Scope closure joins already entered callbacks and native method
returns before once-only owned cleanup, even after cancellation. No descriptor
closure runs detached. If the existing process observer reports unknown cleanup,
that remains unknown under its original retained observer; this boot scope does
not invent a completed Wait or create a replacement cleanup owner. Its cleanup
now explicitly calls that ORIGINAL observer's Join before releasing the update
owner and the surrounding borrowed-route lifetime. Join waits for already entered
native return and stream drain; it starts no replacement probe, signal or retry,
and its uncertainty remains an original error cause. Independent update-close
failure is retained too. The exact fd5 borrow stays inside the synchronous
RawConn.Control callback through that return; no descriptor escapes the callback.

ACK exposure and EOF are transport evidence only. This scope does not perform the
Python branch's application/tree/pair/journal readiness preflight, installation,
recovery, rollback, relaunch or terminal exit classification. Complete pre-ACK
application composition remains a selection gate; this unselected ready frame
must not be wired to an application effect or product readiness until that gate
and the existing desktop protocol are independently accepted.

`releasehelperclosed_test.go` uses private symbolic native/transport seams with
the real parser/codecs. It checks correlation, order, boundary refusal, original
bounds, sticky uncertainty, copied/retained wrappers, joined return, panic and
cause retention. These deterministic tests prove no physical inherited role,
lease, route or process. `releasehelperclosednative_test.go` is a separately gated
Darwin fixture: Root alone allocates it with `FAROL_CLOSED_HELPER_NATIVE=1`. Each
case creates a fresh disposable home, actual predecessor process, inherited
fd3/fd4/fd5/fd6 helper child and physical slot/lease/routes. It retains directories,
stdout/stderr and actual `exec.Cmd.Wait` receipts, including failures. The parent
holds its lease through helper Wait and checks independent contention and flags.
A parent append after Wait checks the shared offset without seeking fd5 or aliases.
Neither fixture establishes production role authentication, original application
Quit, full helper readiness, clean terminal success, Dev/installed acceptance,
package/OTA acceptance or Python retirement.

## Captured readiness and application library

The unselected `execution.NewMilestone` library composes the original apply,
recovery and rollback policies over one independently copied request from the
original parser/protocol owner. `execution.NewCaptured` and
`helperrecovery.NewCaptured` use those captured values without reparsing the wire.
Copies of a milestone share one consumed execution attempt, including missing
readiness, cancellation and concurrent calls. The independently parsing `Bind`
entries retain their existing behavior.

`InspectInstallation` accepts only `HelperInstallationObservation`. Apply requires
confirmed journal absence, an owned exact source/staged pair, no previous, failed
or rejected-target entry, verified trees and one device. Rollback preserves the
original predecessor-state guard and exact settled app/predecessor pair. Closed
rollback accepts only verified/completed; the live branch also observes
launch_requested. Closed phase refusals report the observed phase, while later
pair/tree/journal refusals retain the original refused phase and closed rollback
codes. Independent journal values and complete entry observations are repeated
around tree verification. A malformed, unreadable, mismatched or outcome-unknown
journal fails inspection; no failed read is retried as clean absence.

A readiness value retains private observations without writer, lock, namespace,
ACK, terminal or retry authority. Admitted execution repeats the observations.
Closed rollback additionally compares the original journal revision, phase and
exact pair before the first effect. Offline recovery retains the original
crash-gap reconciliation path; live recovery delegates its preflight to the
original recovery policy.

`HelperRecoveryPolicies` is the installation consumer's port. Trusted composition
must adapt `helperrecovery.ObserveCaptured` and `helperrecovery.NewCaptured` to
`Observe` and `Bind`; pure application services import no sibling service. The
observation-only recovery service cannot reconcile. Missing required policies or
native dependencies refuse; no substitute recovery engine or runtime is created.
Factory inputs are independent copies of the original request.

`infra/native/execution.WithObservation` projects the original native owner's
bounded reader, route fences, original absolute deadline, serialization and actual
return custody into an observation-only interface. It opens and closes no route,
repository or borrowed descriptor and obtains no writer admission. ReadJournal
returns independent values without seeding the installation writer's CAS chain.
ReadPhase and Prepare retain their original admitted revision ownership. A sole
classified return preserves its original code and private cause; multiple
independent failures retain opaque joined provenance. Native observation still
requires an independently valid original reader and custody owner; the library
cannot manufacture pre-ACK admission.

The native execution runtime now implements the relaunch effects: private
capture of the verified shared install image (itself an operation effect, with
failed images retained), self-measurement and relaunch-argument building. Both
self-measurement and argument building are optional `Config` capabilities that
only trusted composition installs; boot does not install them yet. With a
relaunch request and no installed capability, the runtime refuses without marking
completed. Tests cover callback ordering, effect fencing and known versus unknown
failure classification with disposable fixtures, not a physical installed image,
dispatch, Wait or successful launch.

This is independently buildable source foundation. Boot/CLI composition, the
complete pre-ACK readiness gate, transport/ACK and terminal classification,
physical installation and recovery qualification, composed relaunch/capture
capabilities, resource manifests, generated bindings and product selection are withheld. The
Python helper remains selected. Pure application/input tests and race/vet are
policy evidence; native/boot test compilation is compile-only. Neither establishes
native admission, a live filesystem/process, full CI, package, installed, OTA or
release acceptance. Root owns independent review, integration and those gates.

## Existing-only journal observation

`journal.WithObservation` opens the original operation through a borrowed route
File and the consumer's `HelperJournalObservationAdmission`. That admission
rechecks route/slot custody and shares the original gate and retained uncertainty;
it supplies no stopped-writer or update-exclusion proof. The callback receives a
sealed `Observation` with only the original bounded `ReadHelper`. It exposes no
writer constructor, CAS, prepare, repair, descriptor or close capability. Copies
share the original repository lifetime and refuse after synchronous cleanup.

Reads do not create a journal, seed a writer revision or repair malformed state.
The original deadline and before/after admission checks remain in force. Native,
callback and cleanup causes stay behind closed public error text; failed or late
reads retain uncertainty in the original owner. Subsequent effect composition
must independently obtain full writer admission and reobserve that same journal
under its update and instance exclusion. Observation alone is never a readiness,
ACK, effect, retry or ownership grant.

The explicitly gated disposable Darwin fixtures check existing-only reads,
physical route binding, scope expiry, independent values, refusal/uncertainty and
private callback-cause retention. Their admission and lease are symbolic. These
checks do not prove a production predecessor, real lease or full pre-ACK helper
composition, and do not select Go or retire the Python helper.
