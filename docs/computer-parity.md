# Computer capabilities and limits

Computer is the local access boundary used by Farol's MCP connector. The current
implementation has file, instruction, guidance, edit, verification, and shell
routes. Each requires current Computer approval intersected with its task grant.
The published beta still uses the TypeScript/native-helper implementation;
[Go Computer](desktop-core.md#disposable-computer-read-checkpoint) is source
preparation. See [status](status.md) for qualification limits.

## Access model

The user chooses folders, access mode, exclusions, and command mode in Setup or
Settings. A task-derived `TaskGrant` may narrow that approval by owner/session/task,
participant, turn, subtree/exact files, expiry, and mutation ownership. Delegates can
preserve or narrow their parent's grant; they cannot widen it through prompts.

Actions recheck current policy, physical roots, and request correlation before
work and disclosure. Expiry, revocation, a changed root, or malformed correlation
refuses disclosure. A successful folder pick or previous receipt is not permanent
permission for a later action.

## Capability map

| Family                        | Current behavior                                                         | Admission / limit                                                                            |
| ----------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Workspace catalogue/bootstrap | Exact task-accessible IDs and applicable `AGENTS.md` chain               | Read-only; no guessed IDs, outside-task folders, or authority from instruction text          |
| Published guidance            | Search/fetch of embedded product guidance by published ID                | No caller path or private knowledge lookup                                                   |
| List/read/search              | Descriptor-relative bounded file access with classified completeness     | Exclusions and unsafe objects stay denied; list is nonrecursive                              |
| Create/edit/rename/delete     | Guarded effects with exact preconditions and content-free receipts       | Explicit write and mutation ownership; unknown publication is never replayed                 |
| Fixed verification            | Exact Git status/HEAD on a private snapshot                              | Explicit `Verified commands`, current verification, fixed executable/arguments, no network   |
| Workspace shell               | Ordinary commands with incremental stdout/stderr and owned handle        | Explicit `Workspace shell`, verified task workspace, declared write mode, native sandbox     |
| Full shell Git                | Ordinary Git history, hooks, linked metadata, and admitted user settings | Separate `Approve full Git and user settings` for the selected folder and fresh verification |
| Native Codex task tools       | Optional selected-host task route                                        | Separate task grant; folder access alone cannot start a task                                 |

[Getting started](getting-started.md#enable-only-the-access-you-need) explains the
controls. [Workspace context](computer-workspace-context.md) owns instruction and
search coverage; [persistent tasks](persistent-chat-handoff-parity.md) owns task tools.

## Files and guarded effects

The native helper walks approved roots relative to retained descriptors, without
following unsafe path aliases. Reads preserve bounded UTF-8 windows and raw-file
identity. Generic file operations deny `.git`, credential paths, unsafe symlinks,
and disallowed object types. Root/ancestor changes and post-read revocation are
separate checks, not a promise of an atomic filesystem snapshot.

A guarded edit requires the exact source size/digest. Its candidate is staged in a
private directory beside the target, then published with Darwin atomic name exchange;
a create uses a collision-refusing link. The helper checks the displaced identity
and final target. A conflict or uncertain cleanup retains evidence instead of
retrying. Publication and receipt delivery remain separate facts.

Concurrent same-user writes through an already-open descriptor, writes into the
staging directory, or races around undo can exceed these checks. There is no claimed
isolation from hostile same-user or root processes. Retained staging data must not
be deleted to turn an unknown result into success.

Useful source: [native helper](../resources/native/safe_open.py) and
[Computer module](../src/modules/computer/). Native temporary-workspace tests and
MCP fixtures prove their selected boundaries; they do not certify a user's live
connector or full replacement of an older product.

## Fixed Git verification

The fixed verifier uses the reviewed Apple Git chain on a descriptor-assembled
private snapshot, with an inert repository configuration and verified APFS file
clones. It does not execute Git against the live working tree. Repository monitors,
attributes/excludes, submodule recursion, and networking are disabled.

- `git.status` reports tracked files only, ignoring submodules and untracked files.
  Output is parsed from NUL-separated records and rendered structurally.
- `git.head` returns the exact verified HEAD.
- Excluded paths are not cloned, passed to Git, or rendered. Unsupported tracked
  names refuse the complete result.
- Changed index/tracked-file observations during capture refuse the snapshot. These
  multi-pass checks do not lock concurrent writers or establish an atomic repository
  snapshot.
- Output is bounded to 64 KiB; the tracked-path inventory has a separate 32 MiB
  budget. Timeout, overflow, or cancellation stops the owned process group.

Regular repositories and exact linked worktrees are covered, with only resolved
worktree/common metadata roots admitted. External unsafe metadata, object alternates,
non-APFS/cross-volume clone requirements, and excessive snapshots are refused with
classified codes. Metadata admission never exposes its parent to generic file tools.

The fixed verifier and ordinary shell Git have different purposes. The shell runs
standard commands and approved hooks/settings; fixed verification sanitizes its
snapshot and accepts no caller-selected executable, arguments, environment, or cwd.

## Workspace shell and Git settings

Select **Workspace shell**, verify the approved folder again, and start the new
connector. Each command sees one task-granted subtree and a fixed local PATH/private
temporary directory. Native Seatbelt denies networking and sensitive paths.

Without full Git approval, the shell uses a private empty HOME and suppressed global
Git configuration. With the explicit full-Git grant, it receives read access to the
OS account's declared `.gitconfig`/`.config/git` paths and the selected repository's
object history/linked metadata. It does not gain arbitrary home or system-config
access. Includes, hooks, tools, or credential stores outside the admitted paths can
still fail. A metadata approval cannot admit a source root inside the protected
personal `.codex` store.

Full Git can reveal old content excluded from normal current-file reads and sensitive
settings. It is never inferred from folder selection. Access, exclusion, command, or
metadata changes invalidate verification and can revoke the grant.

Use normal `git add`, `git restore --staged`, and `git commit` through the approved
shell when admitted; Farol does not invent a Git command language.
[Ordinary Git fixtures](ordinary-git-environment-fixture.md) explain the local
configuration/hook coverage.

## Shell lifecycle

`computer_shell_start` accepts a stable operation ID, workspace ID, relative cwd,
command, optional stdin, deadline, and write mode. A durable exclusive pre-effect
reservation precedes dispatch. A same-process duplicate returns its handle; after
process loss the ID is consumed and returns `SHELL_OUTCOME_UNKNOWN`, without rerun.
IDs remain unique across tasks/generations for the same Computer identity. At 10,000
retained intents, new starts refuse pending a reviewed retention policy.

`computer_shell_read` pages independent stdout/stderr byte offsets and reports actual
root exit/signal. Output is bounded to 4 MiB. `computer_shell_cancel` asks the owned
watchdog to stop its process group; it returns status rather than command output.
Deadline, authority expiry, or loss of the MCP channel also bounds the group.

`groupCleanup` is `pending`, `confirmed`, or `unverified`, based on terminal
observation and actual group absence. A refused signal is sticky and is not repeatedly
escalated. `detachedCleanup` remains **unverified**: a descendant can call `setsid()`
and leave the group. A root exit or successful signal is not complete tree cleanup.
The sandbox also refuses `/bin/ps`; unrestricted terminal/process parity is not claimed.

Connector stop closes admission, observes MCP lifetimes and group markers, and
refuses a clean-stop claim when cleanup is unresolved. Summary-only execution blocks
new shell starts/output reads while retaining owned cancellation. An admission lease
persists until its required cleanup proof; uncertainty cannot silently release it.

## Selected context and qualification

Browser context preview explains selected text/image/document disclosure. Fixture
composition stages bounded private copies, checks bytes/MIME/digests, exercises the
file-input/upload contract, and submits once. A fixture account is not authenticated
attachment delivery to a user's ChatGPT account.

The relevant [native shell source](../src/modules/computer/infra/native/sandboxed-workspace-shell.ts)
and [Computer MCP E2E scripts](../tests/e2e/) record temporary filesystem/process
proof separately from live connector acceptance. Detached-descendant cleanup, current
account attachments, full owner-workflow parity, and the Go executor cutover remain
separate qualification work. Old tool names or similar schemas do not transfer
acceptance from an older product.

---

[Documentation index](README.md) · [Project overview](../README.md)
