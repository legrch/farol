# Root-scoped access, approvals, and watchdog stdin closure

Status: implementation handoff, not an activated external Shell or release acceptance.
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

For the policy slice, the remaining integration is explicit, not already done:

1. Persist the owner-selected policy meaning through the existing configuration
   owner and generation transition. Existing admitted operations retain their
   captured policy; a mode change is not a retrospective grant or retry permit.
2. At `boot/nativeruntime.go` (base lines 130/153), select **both** File API
   constructors from that same accepted policy. Do not globally switch defaults
   or accept `FilePolicy` from an untrusted tool body.
3. Select the same mode in the existing native shell producer, using an immutable
   current owner/task snapshot. Qualify every selected root, executable, scratch,
   network choice and process boundary before exposing the MCP tool. The old
   fixture-only qualifier is not a certificate for arbitrary owner HOME access.
4. Present scope escalation through the existing owner-facing settings/approval
   machinery: exact requested roots/read-write/network and operation identity.
   Seatbelt itself is enforcement, not an approval dialog. A denial is not
   automatically distinguishable from all other EPERM failures by stderr text.
5. After assembly, use the normal Dev lifecycle and actual external caller to
   qualify Shell/Git, cancel/deadline, reconnect, retained results and ordinary
   hooks. Only then proceed with candidate/release/installation acceptance.

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

Three actual host limitations were observed under the currently installed Farol:

- the pre-existing process package's descriptor-retention test could not enumerate
  `/dev/fd`;
- the fresh watchdog host test could not create its `/private/tmp` fixture and
  stopped before helper/command spawn;
- the new real descriptor-read tests could not create a synthetic `.env` because
  the _outer installed Farol sandbox_ still forbids that name.

Those failures are retained. They were not evaded by changing executor, granting
this task more access, moving the denied native attempt or suppressing assertions.
Separate pure tests are labelled as such and do not replace the native ones.
The two new File API descriptor tests still need their authorized host run.

No external Shell, root-scoped live grant, Full Access, native Git commit through
new Shell, installed application, release, full-range review or owner acceptance
is claimed. The value delivered here is test-backed implementation and a concrete
integration seam, not another already-working-product assertion.
