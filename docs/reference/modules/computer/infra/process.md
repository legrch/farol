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

The selected workspace's `GitHistoryApproved` enables `UserGitSettings` in the
existing Seatbelt selection. It adds read-only literals for `~/.gitconfig` and
`~/.config/git/{config,ignore,attributes}`, with parent metadata only. It adds no
HOME/directory read grant, write grant or host file lock. Without approval,
`GIT_CONFIG_GLOBAL=/dev/null` and XDG points at the operation's existing scratch;
project configuration and hooks retain their scoped behavior. The approval is
validated again by the compiler and included in the confinement digest. Native
synthetic-HOME tests cover both choices, exact reads, denied writes and denied
neighboring files; they do not qualify an owner's actual Git configuration.

The timeout-attribution checkpoint `65d500985b091edceb7421cfb3bbd830cb736858`
changes `process.go`, which is one of the independently pinned compiler inputs in
`tooling/shell-platform.json`. Its portable Go regressions alone did not requalify
the native platform, so the old pin refused it with `SHELL_SUPPORT_INPUT_CHANGED`.
Platform record `…-metadata-v11` requalifies it: on macOS 27.0.1 build `26A434`
(arm64), the native suite (`go test -tags farol_native_process`) passed against
the exact source, including the watchdog cancellation and transport tests with
`FAROL_TEST_WATCHDOG_NODE` pointing at the approved Node 24.20.0. It excluded only
`TestNativeSeatbeltCredentialAliases`, the documented failing legacy-policy
hardlink gate, which stays unqualified. `process.go` was the only drifted pinned
input. Never refresh a pin from source measurements without such a native run.

Platform record `macos-26A434-arm64-installed-runtime-v16` binds the protected
Computer state deny to the original Shell selection. On macOS 27.0.1 build
`26A434` arm64, the native process suite passed with the documented legacy
credential-alias exclusion; the native root-scoped state test also verified
read, write, execution, APFS aliases and ancestor renames. Separate native
boot tests exercised Shell and Quit/reopen. This does not establish package,
installed, live-provider or descendant-cleanup qualification. The current
system-volume policy also refuses a protected profile on another volume.

Platform record `macos-26A434-arm64-installed-runtime-v17` additionally binds
the installed-runtime ACL checks at source `5f626eee`. On macOS build `26A434`
arm64, the native process suite passed with the same documented credential-alias
exclusion; the ACL matrix, protected-state test, installed Git hook journey,
and fresh Shell Quit/reopen fixture also passed. This is native candidate
evidence, not package, installed, live-provider or descendant-cleanup acceptance.

Platform record `macos-26A434-arm64-installed-runtime-v18` adds the pinned
system `/bin/rm` image. macOS ships it with two hard links; only this fixed
root-owned path admits exactly two links. All other multi-link images remain
refused. Qualification and dispatch still verify content, protected parents,
owner, modes, named inode and the original link count. The native process suite
passed on build `26A434` arm64 with the same documented legacy credential-alias
exclusion. The fresh Shell fixture passed across two ordinary Quit/reopen
lifetimes, removed its own workspace file, and confirmed that a sibling outside
the workspace remained unchanged. These are disposable native witnesses,
not installed application or live-provider acceptance.

Platform record `macos-26A434-arm64-installed-runtime-v19` adds pinned `/usr/bin/dirname`, `/bin/pwd` and `/usr/bin/readlink` for bounded launcher compatibility. On macOS build `26A434` arm64, `/usr/bin/readlink` and `/usr/bin/stat` are two names for one root-owned image; the fixed readlink pathname alone admits exactly two links under the same content, ownership and identity checks. A disposable native compiler fixture observes the previous seven-image policy refuse a Brain-like launcher, and the ten-image policy run both its direct and symlink entrypoints; the stat alias remains refused. Separate native scope tests cover workspace, write and network denial. These witnesses do not establish public MCP, installed or live Sync acceptance.

Platform record `macos-26A434-arm64-installed-runtime-v22` requalifies the 13
compiler inputs changed by `8d97cf00` to carry classified native refusal reasons
out of the native adapter. On 2026-11-12 at approximately 15:08 UTC, the Lead ran
`go test -count=1 -v -tags farol_native_process -skip 'TestNativeSeatbeltCredentialAliases' ./modules/computer/infra/process/`
outside the sandbox against clean source `8130facf46a82e6ff0cf6427dac39b1db530cc1e`
on macOS 27.0.1 build `26A434` arm64, using the module-cache Go 1.26.2 toolchain
with `GOTOOLCHAIN=local` and `FAROL_TEST_WATCHDOG_NODE` pointing at approved Node
24.20.0. The suite passed: 250 tests PASS and one SKIP (`TestNativeDrainLeafHelper`,
the helper entrypoint skipped by design outside a child invocation). Only the
same documented legacy credential-alias test was excluded. This is native source
evidence, not package, installed, live-provider or descendant-cleanup acceptance.

Platform record `macos-26A434-arm64-installed-runtime-v23` requalifies
`measurement.go` after the review fix that keeps Git/Python runtime resource
recheck failures classified as `runtime_integrity` instead of
`executable_integrity`. The Lead ran the same native command outside the sandbox
on 2026-11-12 against the exact changed bytes later committed as `56597d57`,
on macOS 27.0.1 build `26A434` arm64 with the module-cache Go 1.26.2 toolchain
and approved Node 24.20.0. It passed: 251 tests PASS and one SKIP
(`TestNativeDrainLeafHelper`), with only the documented legacy credential-alias
test excluded. The same acceptance limits apply.

Platform record `macos-26A434-arm64-installed-runtime-v24` records the toolchain
move to Go 1.27.3; the compiler inputs are unchanged from v23. On 2026-11-14 the
Lead ran the same native command outside the sandbox against clean source
`1f29e4c8d048aea8f3c78b13e7aa5e5bdf0dd0cb` on macOS 27.0.1 build `26A434` arm64
with Go 1.27.3, `GOTOOLCHAIN=local` and approved Node 24.20.0. It passed: 251
tests PASS and one SKIP (`TestNativeDrainLeafHelper`), with only the documented
legacy credential-alias test excluded. The same acceptance limits apply.

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
observed pipe EOF establishes complete descendant cleanup. See [current approval boundaries](../../../../../docs/sandbox-approvals.md)
and [Computer parity](../../../../../docs/computer-parity.md) for the selected contract
and the separate native, source and installed evidence.

## Developer Shell direction and current evidence

The developer Shell target is ordinary command composition and project tools
inside the owner's selected environment. Reuse the existing access snapshots,
grants, Go execution, Seatbelt compiler and retained operation lifecycle.
Executable attestation protects trusted runtime images; general development
requires a usable read/execute scope for the selected tools and dependencies.
The finite Git/Python resource selections below retain their qualified behavior
while that broader environment is designed and tested.

This section records the target and the current implementation boundary. It
selects no new runtime roots, permission, process launcher or production default.

| Concern                            | Current implementation                                                                                                                                                   | Required before general Shell selection                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Filesystem scope                   | `rootscoped.go` intersects the same owner and task snapshots. Read-only invocation narrows every selected root; overlapping exclusions or conflicting access refuse.     | Preserve physical root identity, revocation, read/write modes and explicit additional-root approval. A working directory, Git pointer or environment variable grants no access.                                          |
| Execution and runtime dependencies | `confinement.go` permits selected images and effective approved roots. `PATH` comes from selected executable directories; CLT/Python dependency closures remain finite.  | Design runtime read/execute roots and trusted `PATH` selection through existing grants. Discover host toolchains during qualification; retain protected image/bundle writes, mount rules and private scratch boundaries. |
| Git                                | Root-scoped Git uses ordinary configuration, includes, hooks and explicitly approved metadata roots. The selected CLT closure supports its documented fixtures.          | Run standard Git and real hooks with their dependencies. Resolve linked `git-dir`/`common-dir` through scoped metadata access. Preserve unrelated staging and genuine hook failures.                                     |
| Network                            | `NoNetwork` is separate from `ApprovedNetwork`; the latter requires both snapshots and the network capability. Its current semantics are broad.                          | Keep no network by default, including in hooks. Qualify separately granted network/loopback access and describe its actual breadth; a local commit does not authorize a push or download.                                |
| Privacy and runtime integrity      | Protected images, bundle, exclusions and mount checks constrain the selected policy. Path-based rules have the documented alias/hardlink limits.                         | Exercise credential, foreign-root, alias and mounted-volume controls with synthetic canaries. Define system and user-writable runtime-root risks without assuming object-level secrecy from a path grant.                |
| Process lifetime                   | Existing owners bind one attempt, original bounds, retained output and exact child observations. Root exit, pipe drain, group and descendant cleanup are separate facts. | Qualify long commands, hooks with background children, cancellation and reconnect. Retain unresolved effects and cleanup facts; an unknown result supplies no replay authority.                                          |
| Refusal reporting                  | Access decisions, policy construction and native execution are distinct boundaries.                                                                                      | Establish the actual refusal layer: admission, sandbox startup/enforcement, filesystem permission, command/hook failure or unknown transport outcome. Preserve closed diagnostics and original operation identity.       |

Use standard shell and Git interfaces with the existing approval and operation
owners. Keep hook execution unchanged, and fail closed if sandbox startup or
admission fails. A new Git command API, separate hook permission store or
unconfined fallback would change this contract.

Native qualification must cover a disposable developer workspace with:

- Bash composition, a project-local script, actual Go and Node tools,
  Python 3.12 standard-library imports and `gitleaks`, using the qualifying
  host's discovered dependency paths;
- standard stage/unstage/commit with enabled Python/tool-dependent `pre-commit`
  and `commit-msg` hooks, real hook rejection, linked metadata, two roots with
  different modes, and preserved foreign staging;
- explicit refusal controls for ungranted files, credentials, metadata,
  network/loopback, aliases, mount changes and revoked authority, with baseline
  canary access and actual effects recorded separately;
- a retained long-running command and owned-child observations, separating
  root wait, output EOF, group/descendant facts and any partial effects after
  cancellation or deadline.

Existing compiler, pinned-runtime and native fixture results remain bound to
their own selections and source identities. They supply no general toolchain,
packaged Dev, installed or live connector acceptance for this target. The next
implementation must settle runtime-root, privacy, metadata, network and lifetime
decisions before an opt-in policy selection; current qualified fixes and P0
recovery remain in force.

## Selected Command Line Tools Git data

The trusted `GitRuntimeResources` declaration adds only the selected CLT Git's
finite system configuration and template files. The checked-in closure contains
17 files and three directory listings. The authenticated build checks their
hashes and protected root-owned parents; native selection additionally checks
APFS mount boundaries, identities, permissions, directory listings and continuity.
Preparation retains the original data descriptors and rechecks them before launch.

The Seatbelt profile grants literal reads, denies data execution and writes,
and preserves protected resource ancestors. Kernel mount checks apply on every
resource access. This is neither a general Command Line Tools directory grant nor
an extra workspace. It adds no network, Keychain or executable authority. Normal
Git configuration, templates and project hooks are used without system-config,
template-directory, signing or hook overrides.

`TestNativeCLTGitRuntimeResources` uses the actual declared CLT data with a
disposable HOME/project and exercises init, add, commit, log, a project hook and
linked worktree commits under Seatbelt. It also verifies retained descriptors.
That native fixture does not prove the packaged support binding, an external MCP
journey, arbitrary descendant cleanup or networked Git. Those acceptance layers
remain separate.

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
the existing `NewSupervisedPreparer`.
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

The opt-in `approved-roots-v1` compiler is documented in [Root-scoped access and approvals](../../../../../docs/sandbox-approvals.md). It preserves the existing process/lease/journal owners; the compiler alone grants no execution authority. Current conditional product wiring is described above. The strict credential-alias gate below remains historical evidence for the legacy policy, not a qualification of the new root-scoped contract.

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
probe, provider call, command dispatch or operation reissue. This package has no
positive native qualification producer: the held-role synthetic conformance
attempt was removed with that role (see
[Held-role native primitives](#held-role-native-primitives-removed)).

Native preflight measures the approved root, canonical cwd, an operation-private
0700 scratch directory with exact owner/device/inode, and every selected
executable plus `/usr/bin/sandbox-exec`. Measured executable descriptors stay open
through the single start attempt. These measurements do not prove continuous
kernel/pathname identity or effective policy enforcement. The qualified mechanism
and native witnesses remain activation prerequisites owned by normal composition.

Direct and supervised producers share the same measurement implementation. It
retains the executable descriptors through the single start attempt; measurement
failure cannot reach the start. Separate disposable Darwin tests cover changed
roots, scratch modes/identity, symlink/hardlink and executable-pin refusals, plus
actual descriptor retention and closure after partial measurement. Those tests
execute no command.

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
that gap. This compiler checkpoint supplies no positive native qualification.

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

## Held-role native primitives (removed)

The held-role primitives were removed on 2026-11-13. Nothing in production ever
constructed them: the anchor role (`NewAnchor`, `Anchor.Run`, its kqueue guest
observer and self-group stop), the anchored parent adapter (`NewAnchoredPreparer`
with its `AnchorBootstrap`/`AnchorLink` ports and `Preparer.RetainedHandle`), the
held guest (`RunHeldGuest`, the `HeldBootstrap.StartHeld` and `HeldGate` ports),
and the one-shot synthetic conformance attempt that only the held guest consumed
(`NewQualificationAttempt`, `NativeQualification`, `NativeFixture` and its Darwin
probes). The process exit no longer carries a cohort flag, because that parent
adapter was its only producer; the direct and supervised producers still report
descendant cleanup as unverified.

The root adapter that implemented `HeldGate` over the framed desktop wire, its
`computer.process.held.ready`/`computer.process.held.release` operations and the
`ComputerHeldIdentity`/`ComputerHeldBarrier` schema types were removed first, and
with them the transport's held-only request-ID helpers and terminal-rejection
mode. Reintroducing the role needs a new wire and native design, not a revert.

### Independent output EOF checkpoint

The focused CPU regression first reproduced the direct producer's incorrect
`ExitError => drained` classification. Memory-stream tests now cover both EOFs,
last bytes accompanying EOF, binary retention, missing/reused/shared witnesses,
forced-close/read/collector errors and short writes. Direct leaf wait/drain still
leaves group and descendant cleanup unverified. These are CPU evidence, not
native process, kqueue, confinement or production qualification.

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

Root-owned activation, effective confinement, a qualified descendant settlement
mechanism, descendant/unknown cases, independent review, aggregate
checks, package/installed/live and release gates remain open. `connector.processes`
remains unset; no shared contract, authority, boot/schema or desktop change is
included here.

### Watchdog owned-group cleanup

The production watchdog keeps its own PGID anchored while it sends TERM and,
after at most 500 ms within the original deadline, KILL. An ordinary root exit
with inherited pipes still open selects that same stop after the exit report;
no command is restarted. A refused signal remains fenced. After the exact
helper Wait and complete, unfenced root/output report, the native owner makes
read-only `kill(-pgid, 0)` observations for at most 250 ms within the original
deadline. Only ESRCH sets `GroupCleanup=confirmed`. A live/reused group, permission
error, failed Wait or lost output stays unverified. No post-reap effect signal is
sent to the numeric PGID. `DescendantCleanup` remains unverified for processes
escaping with `setsid`; group confirmation does not manufacture a cohort witness.

The current collector may settle a durably published exit with this group
witness, and ordinary fresh admission accepts that unchanged canonical terminal.
The earlier preserved recovery/inspection predicates retain their original
requirements. Disposable native watchdog tests cover exit 0, inherited background
pipes, ordinary same-group child/grandchild cleanup and one Cancel; they are
separate from package, installed and provider acceptance.
