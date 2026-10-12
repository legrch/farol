# Root-scoped access, approvals, and watchdog stdin closure

Status: 6 October implementation handoff, superseded in part by later source wiring
and beta.9 installed Computer evidence. It is not Shell, broad approval or release
acceptance.
Base: `1a1c6d8f75a5006716aef938bd4055893999e524`, 6 October 2026.

## Product direction and the actual Codex reference

The owner's current direction is coarse, explicit access to approved roots, with
sandbox enforcement and approvals for additional authority. It replaces the
previous proposed object-level secret-exclusion guarantee. An approved project
may contain `.env`, `.npmrc`, Git metadata and agent configuration. Their names
alone must not create another Farol permission wall in the new mode.

The reference is the open-source Codex **harness/client**, not model weights.
The inspected upstream revision is
`ccde2fc8b7fd08216757d3d3f67362847ab8341b`:

- [Seatbelt compiler](https://github.com/openai/codex/blob/ccde2fc8b7fd08216757d3d3f67362847ab8341b/codex-rs/sandboxing/src/seatbelt.rs)
  keeps native enforcement, filesystem policy and network policy explicit.
- [Tool orchestrator](https://github.com/openai/codex/blob/ccde2fc8b7fd08216757d3d3f67362847ab8341b/codex-rs/core/src/tools/orchestrator.rs)
  separates approval, sandbox selection, attempt and escalation.
- [Approval data](https://github.com/openai/codex/blob/ccde2fc8b7fd08216757d3d3f67362847ab8341b/codex-rs/core/src/tools/approvals.rs)
  distinguishes actions and permission context rather than treating a broad yes
  as proof that a previous command had no effects.

Codex does have protected metadata and configurable path restrictions. The
statement that it has no such checks was incorrect. Farol should adopt the
separation of concerns, not claim byte-for-byte policy parity. In particular,
Farol must not import a retry-on-denial flow without its existing effect-identity
rules. A command may have written one file before another access was denied.

This is original Go/TypeScript implementation in the existing Computer owners,
not a vendored second harness, executor, authority database or process journal.

## What this patch implements

`authority.FilePolicy` has two closed values. The empty value retains the legacy
behavior. `RootScopedFiles` (`approved-roots-v1`) is an explicit new meaning,
selected by trusted composition after owner consent, never by an MCP request.
Unknown values refuse. This opt-in preserves old admitted operations while Lead
implements the normal configuration/generation transition.

`filesystem.NewWithFilePolicy` and `NewMutableWithFilePolicy` use the same policy
for reading/listing/searching and mutation. Root-scoped mode removes built-in
credential-name and ordinary Git-name bans. It preserves explicit descriptor
restrictions, exact-file scope, physical root checks, no-follow traversal, bounded
text reads, compare-and-swap edits and the existing publication guard/transaction.
There is no unsafe general-purpose path opener added to the unsandboxed backend.
The current File API still refuses symlinks/multiply-linked mutation targets as a
structural limitation; this patch does not claim complete shell/File API parity.

`SeatbeltSelection.FilePolicy = RootScopedFiles` together with `RootScopedGit`
compiles the same owner/task-approved roots into one existing Seatbelt profile:

- read/write permissions are intersected, and a read-only invocation narrows all
  roots, including additional Git/toolchain roots;
- additional roots must already be in both sides of the current grant and have
  the required verification/identity. A `.git` pointer, cwd, environment, or argv
  cannot add a root. Unqualified additional scopes refuse rather than widen;
- implicit `.env`/credential/Git filename bans are not emitted. Existing explicit
  exclusions that conflict with this mode refuse until the owner replaces that
  old configuration; a broad HOME grant cannot silently override a nested deny;
- command execution is allowed in the selected roots and for selected pinned
  executables. Runtime/toolchain dependencies outside them need explicit roots;
- network remains denied unless both owner and task have `ApprovedNetwork` and
  `NetworkUse`. The current enum means broad network permission, not a domain
  allowlist or a network approval UI;
- executable integrity checks, pinned-executable write protection, private
  scratch and root-directory unlink protection remain. They protect execution
  identity, not a list of disallowed user filenames;
- the profile meaning contributes to the existing command seal. Captured grants
  are copied, and current generation/authority checks still apply.

The new environment uses explicit host HOME and private TMPDIR, not an inherited
`os.Environ`. It no longer secretly redirects Git global/system configuration to
`/dev/null`, and uses portable `C` locale instead of assuming Darwin supports
`C.UTF-8`. HOME/PATH values do not grant filesystem access. Git hooks, config
includes, interpreter libraries and signing tools still need actual sandbox
access. No native Git/signing parity is claimed by a compiler unit test.

An allowed hardlink may expose data also named outside the root. That is a limit
of path-based access, not object-level confidentiality. Read-only mode does not
solve that distinction. Keep the old failing strict-contract witness unchanged;
qualify the new, explicitly described contract separately. Do not call the old
hardlink test PASS, infer a data boundary from pathname containment, or claim
Full Access/TCC approvals are implemented by these constructors.

## Trusted platform and retained invocation binding

The root-scoped production direction is qualified macOS enforcement plus fresh
measurement of each invocation. The legacy exact-guest `NativeQualification`
continues to protect its original contract. Routine commands must not run
synthetic writes in user folders to establish eligibility, especially when the
owner granted read-only access.

`RootScopedPlatformSupport` is trusted composition data for an exact release,
compiler, macOS build and architecture, mechanism/import bytes, backend, helper
and selected executables. Its public constructor reads actual native facts;
there is no public success callback, inferred support from current hashes or
default support entry. Boot must authenticate the release issuer separately.
The first supported class is local APFS without nested mounts and `NoNetwork`.
The strategy does not itself provide authenticated metadata or activate Shell.

`NewRootScopedSupervisedPreparer` seals the support and selected-command binding
into the existing process intent. Only the original `StartLease` can bind the
qualification to its existing deadline. Before the helper starts and again
before its one command release, the join checks the exact wrapper, platform and
image facts, roots, and original deadline. The same retained executable and
directory measurements are rechecked after helper preparation. Current lease
authority remains mandatory at release. No second executor, reservation owner,
approval store or deadline is introduced.

An explicitly approved writable HOME remains eligible. Owner-owned installed
backend/helper images are pinned and protected just like their system-owned
counterparts; an administrator-owned installation is not required. Additional
`ProtectedImages` are measured and denied writes without adding read, execution
or PATH permissions. The compiler protects their ancestor directories against
unlink/rename within writable scopes while retaining ordinary sibling writes.
APFS Data firmlinks do not have to share a textual mount prefix with `/Users`.
The qualified launch requires the kernel's exact pathname from `F_GETPATH` for
directories and images. Alternative `/System/Volumes/Data/...`, case or Unicode
spellings refuse before dispatch; they are not silently normalized into an
approved scope. Native experiments showed that Data-prefixed root rules did not
grant the expected workspace access on the tested host. Such a refusal is not
evidence of successful sandbox confinement. Mount detection still considers both
APFS spellings so alternate mount-table names cannot hide nested volumes.

An optional `ProtectedBundle` binds an exact canonical application directory and
its device/inode to the same support, selection and reservation. Its entire
subtree is denied writes, including resources that are not executable pins;
ancestor replacement is denied while ordinary sibling writes remain allowed.
This adds no read, execution or PATH permission. The existing measurement owner
retains and rechecks the directory before release. A nil binding preserves the
individually pinned class; production package composition must select the whole
application bundle. Directory identity is not dependency byte attestation:
authenticated package verification must independently bind those bytes. This
source capability does not supply that issuer or enable the production route.

This assurance relies on trusted host pathnames and the qualified OS mechanism.
It is not an atomic filesystem snapshot or protection against a privileged or
same-user host attacker changing files outside the sandbox. Path grants retain
the documented hardlink limits. Known root exit, drained output and helper exit
remain distinct from descendant cleanup and Task completion.

Source tests cover descriptor drift, fixed-deadline binding, sealed metadata,
pre-release rechecks and refusal without replay. The opt-in
`TestNativeRootScopedProtectedImages` additionally checks kernel-enforced image
write/ancestor-rename denial while ordinary synthetic workspace writes succeed.
Neither establishes production boot, packaged bytes, installed Shell or the
complete supported platform matrix. Authenticated release metadata, production
composition and qualification through that complete join remain required.

## Watchdog fix: EPIPE is not a process outcome

The prepared watchdog used to turn any child-stdin error into a fatal transport
error. A command that exits quickly or intentionally closes stdin can produce
EPIPE; killing the group at that point loses its actual exit and stderr evidence.

The patch keeps observing the **same child** on stdin EPIPE. It does not declare
input consumed, invent command success, renew a deadline, dispatch again or
relax other stdin/IPC/output/stop errors. `exit` and `close` remain separate; the
latter continues to wait behind queued output before the existing self-stop.

Six regression cases failed before this change and pass afterward. They cover
exit codes 0/7/91, EPIPE without exit, output backpressure, and a subsequent real
stdin error. The full prepared-watchdog VM suite passes 60 tests. The historical
`stdin-epipe` decoder value remains compatible; legacy watchdog mode is unchanged.

This is a demonstrated source bug, **not proof that it is the root cause of the
Lead's earlier native failures**. A fresh authorized host run is still required.
Reference: [Node child process events](https://nodejs.org/api/child_process.html).

## Integrating through the existing owners

Lead should integrate the watchdog fix independently first. Review the exact
source/test delta, rerun its VM suite, then perform a new bounded native run of
the corrected bytes in the authorized host lane. Do not replay any old unknown
operation, query its historic PID/PGID or erase its evidence.

The current source now persists the owner-selected File policy through the
existing configuration owner and generation transition in
[`product-configuration.ts`](../src/apps/desktop/product-configuration.ts).
The Go Computer composition selects matching legacy or root-scoped read and
mutation owners in [`computerfilepolicy.go`](../boot/computerfilepolicy.go),
assembled by [`nativeruntime.go`](../boot/nativeruntime.go). The selected policy
is carried by trusted Computer authority; it is not accepted from an MCP request.
Existing admitted operations retain their captured policy, and a mode change is
not a retrospective grant or retry permit. These source changes wire File API
policy selection; they do not qualify a live root-scoped grant.

The internal connector Shell factory in `boot/connectorshell.go` now composes
the original admitted lease with the supervised producer. It copies the current
approval/grant under the existing owner, then performs native preparation outside
the owner locks and within that same deadline. It selects the approved physical
workspace, pinned Bash, producer-owned environment, `NoNetwork`, protected app
bundle and exact command/stdin; it rechecks current policy after preparation.
The returned observer is bound to the same sealed root. Selection does not
reserve, dispatch, renew admission or create another operation journal.

Its private `/private/tmp/farol-shell-*` directories are retained on all outcomes;
neither root exit nor context cancellation proves descendant settlement. There
is no recursive or crash-time cleanup. The existing connector ledger bounds
selection attempts per backend lifetime. A qualified cleanup policy remains
separate work. CPU composition tests use synthetic scratch/platform inputs and
a qualifier that always refuses execution.

The host/backend startup boundary can now carry a private Shell declaration on
inherited descriptor 3. The host copies at most 256 KiB and delivers it once;
delivery consumes the original handshake budget. Go accepts only a pipe/socket,
requires bounded EOF within two seconds and closes the original descriptor once.
Strict JSON and exact field spellings bind the payload to the compiled BuildID,
profile, initiating host and child launch. Watchdog bytes must match the selected
source digest, and backend/helper paths must remain inside the selected package
layout. This inherited channel supplies correlation, not release authority.

Native startup selects the factory only with explicit host metadata and mutation
storage. Unsupported native support withholds Shell while preserving the existing
file route. The normal desktop host does not yet supply this optional selection:
authenticated build support, complete package attestation and native external
qualification remain required before product activation.

Remaining qualification and integration:

1. The normal native Shell producer remains withheld. Before exposing it, select
   the same policy from an immutable current owner/task snapshot and qualify each
   root, executable, scratch area, network choice and process boundary. The old
   fixture-only qualifier is not a certificate for arbitrary owner HOME access.
2. Present any scope escalation through the existing owner-facing settings and
   approval machinery, with exact requested roots, read/write/network scope and
   operation identity. Seatbelt is enforcement, not an approval dialog. A denial
   is not automatically distinguishable from all other EPERM failures by stderr.
3. Use the normal Dev lifecycle and actual external caller to qualify Shell/Git,
   cancel/deadline, reconnect, retained results and ordinary hooks before broader
   candidate, release or installation acceptance. Beta.9's one installed file
   read/edit and tunnel-recovery cycle does not close these gates.

Within an accepted scope, routine calls should not require a new prompt. A
broader-root/network request is a request, not permission. Missing approval
refuses before dispatch where detectable. After a partially effective or unknown
run, reconcile the original result; approval alone must never silently rerun it.
Full Access, persistent approval caching and new UI/wire fields are not added by
this source patch. They must use the existing owner and retention semantics,
not another approval manager.

## Verification and honest limits

The side writer is detached and isolated from the Lead's writer, main and Dev.
Its ignored `_output/sandbox-approvals/` retains exact logs. Source checks include
Go race tests for the compiler and pure filesystem/modeled mutations, Computer
and boot build-only validation, vet, Go architecture, TypeScript and the watchdog
VM regressions. Build-only validation runs zero tests and is not native evidence.

At the 6 October checkpoint, three actual host limitations were observed under
the then-installed Farol:

- the pre-existing process package's descriptor-retention test could not enumerate
  `/dev/fd`;
- the fresh watchdog host test could not create its `/private/tmp` fixture and
  stopped before helper/command spawn;
- the new real descriptor-read tests could not create a synthetic `.env` because
  the _outer installed Farol sandbox_ still forbids that name.

Those failures are retained. They were not evaded by changing executor, granting
this task more access, moving the denied native attempt or suppressing assertions.
Separate pure tests are labelled as such and do not replace the native ones.
At that checkpoint, the two new File API descriptor tests still needed their
authorized host run. This is the recorded status of that test run, not a claim
about the later beta.9 qualification run.

No external Shell, root-scoped live grant, Full Access, or native Git commit
through new Shell is claimed. Beta.9's installed file-route/recovery evidence
and release are separate from this 6 October source handoff; it does not establish
those remaining behaviors, full-range review or owner acceptance. The hardlink
alias finding also remains open: beta.9 did not qualify inode-level secrecy.
