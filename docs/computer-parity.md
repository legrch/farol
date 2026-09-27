# Computer parity and content lifecycle

This inventory compares the actual Legacy Hub tool catalogue in
`src/hub/catalog.mjs` with the selected Farol Next U2 product routes. It is not a
claim that similarly named schemas are equivalent. `REAL_LOCAL` means the native
boundary ran against an actual temporary macOS workspace or installed host;
`FIXTURE_APP` means the assembled Electron product ran with the deterministic
provider/host fixture; `BLOCKED_OWNER` and `NOT_RUN` remain open evidence rows.

## Legacy-to-Next disposition

| Legacy capability                                                                                                 | Farol Next disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Product consumer and evidence                                                                                                                                                 | Status                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `open_workspace`, `request_access`                                                                                | Owner-controlled Setup and Settings select folders, access mode, exclusions, command policy and revocation. A model cannot expand access. Every call is rechecked against both the task grant and the current Computer generation.                                                                                                                                                                                                                                                                                                                                                                       | `product-configuration.test.ts`, `readonly-computer-action.test.ts`, development/sealed product E2E                                                                           | `REAL_LOCAL` + `FIXTURE_APP`                                                                   |
| `read`, `ls`, `glob`, `grep`                                                                                      | Typed `workspace.read`, `workspace.list` and `workspace.search` operations replace free-form file discovery. Next deliberately exposes no caller-supplied glob grammar; list/search cover the selected product discovery flows.                                                                                                                                                                                                                                                                                                                                                                          | Settings verification, Computer MCP, Chat peer and Product Agent/Critic; `native-readonly-workspace.test.ts`, `readonly-computer-mcp.test.ts`, `codex-agent-computer.test.ts` | `REAL_LOCAL` + `FIXTURE_APP`                                                                   |
| `write`, `edit`                                                                                                   | Explicit write approval, exact source digest, descriptor-relative containment, atomic replace, conflict detection, stable operation ID and content-free durable receipt. An uncertain replace acknowledgement is never replayed. Product Agent assignments remain read/verify-only; the general delegated Computer boundary preserves write authority only when mutation ownership was explicitly granted.                                                                                                                                                                                               | Settings mutation flow and mutable Computer MCP; `native-mutable-workspace.test.ts`, `mutable-computer-action.test.ts`, `mutable-computer-mcp.test.ts`                        | `REAL_LOCAL` + `FIXTURE_APP`                                                                   |
| `bash`                                                                                                            | Owner-selected `workspace` command mode exposes `computer_shell_start/read/cancel` through the new Computer MCP. Each call sees one task-granted workspace. The native Seatbelt profile denies network and sensitive paths; complete Git object history requires a separate owner approval for that folder. A per-command watchdog enforces the absolute authority deadline and stops its process group if MCP disappears. Exit/signal and stdout/stderr are read from the live handle; a lost acknowledgement after restart is explicitly unknown and cannot execute again under the same operation ID. | Computer MCP and native sandbox fixtures; `sandboxed-workspace-shell.test.ts`, `secure-mcp-launch-contract.test.ts`, `workspace-shell-mcp.e2e.mjs`                            | `REAL_LOCAL` + built and packaged MCP fixtures; owner connector proof pending                  |
| `guidance_search`, `guidance_fetch`                                                                               | Next has no model-visible guidance consumer on the blocked ChatGPT-to-native Route B. Selected owner context is instead explicit preview plus private retained continuity; that does not pretend to be the Legacy guidance catalogue.                                                                                                                                                                                                                                                                                                                                                                    | Route B native relay foundation is covered by `codex-caller-relay.test.ts` and `caller-relay-mcp.test.ts`.                                                                    | `BLOCKED_OWNER`: approve or reject one-turn model-visible native relay capability; no fallback |
| `codex_task_create`, `codex_task_status`                                                                          | A separate task grant now exposes create/status/exact result for a selected saved Codex project through Computer MCP. It attaches to an explicitly selected existing Codex socket and preserves outcome-unknown without blind retries. Active steering, same-thread continuation, shared native observation and live model results are still open. Product Agent remains a distinct default-off route.                                                                                                                                                                                                   | Persistent handoff journal, desktop task grant, Computer MCP, disposable fake-socket fixtures                                                                                 | Built and packaged fixture only; live shared-runtime proof pending                             |
| `claude_task_create`, `claude_task_status`                                                                        | No Claude handoff is hidden behind Codex Product Agent or Computer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | None                                                                                                                                                                          | `NOT_SELECTED_U2`; explicit parity gap retained                                                |
| `farol_session_search`, `farol_session_read`, `farol_session_tail`                                                | The selected Next product semantics are exact task history, content-free Activity and private context continuity. Next does not expose a raw supplemental transcript-search tool to the model.                                                                                                                                                                                                                                                                                                                                                                                                           | Watch Rail task registry, Activity, private checkpoint store and three-cycle continuity/restart tests                                                                         | Selected product semantics `REAL_LOCAL` + `FIXTURE_APP`; raw transcript tool `NOT_SELECTED_U2` |
| `farol_caller_tools`                                                                                              | Ticket-bound native caller relay validates the exact host catalogue, turn, operation ID and at-most-once invoke. Making it model-visible in the production ChatGPT route is the same Route B owner decision above.                                                                                                                                                                                                                                                                                                                                                                                       | `codex-caller-relay.test.ts`, `caller-relay-mcp.test.ts`                                                                                                                      | Foundation `REAL_LOCAL`; full Route B `BLOCKED_OWNER`                                          |
| `farol_agent_sessions_list`, `farol_agent_history_search`, `farol_agent_session_read`, `farol_agent_session_tail` | Product Agent stores only the current task's bounded objective, lineage, terminal state and delivery evidence. General browsing of historical Codex/Claude transcripts is not exposed or implied.                                                                                                                                                                                                                                                                                                                                                                                                        | Task menu and Activity; `product-agent-store.test.ts`, `agent-persistence.test.ts`, built-app Product Agent flow                                                              | Selected task lifecycle `REAL_LOCAL` + `FIXTURE_APP`; general history tools `NOT_SELECTED_U2`  |

`NOT_SELECTED_U2` is not a compatibility claim. Those rows must remain visible in
any later Legacy-replacement decision.

## Daily-driver Computer command mode

The owner must select **Workspace shell** in Computer settings and verify the
approved folder again before starting the new connector. This is separate from
the default-off Model and Product Agent. The same approved root may be
read-only or writable; the shell call declares `write` and the authority
service checks both that mode and mutation ownership. Each call exposes only
the selected task-granted subtree. Without full Git approval the process
receives a private empty home. With full Git approval for the exact selected
root it receives the user's HOME path and read access only to the owner-owned
`~/.gitconfig` (or its exact owner-owned target inside HOME) and
`~/.config/git`; write access to HOME is not granted. All commands receive a
private temp directory, fixed local PATH, no inherited credentials, and a
Seatbelt profile with `deny network*`. System Git configuration and
interactive Git prompts stay disabled. Git includes and hooks outside the
approved roots or these user Git paths remain inaccessible.

Shell Git can read complete object history, including old versions of files
excluded from normal workspace reads. Accordingly `.git` and linked-worktree
metadata remain denied until the owner explicitly chooses **Approve full Git
and user settings** for that verified folder and verifies it again. Settings discloses
that this includes `.git/config`, refs, objects, hooks, linked metadata and the
standard user Git configuration paths, which may contain credentials. A changed
access mode, exclusion, command mode, or linked
metadata revokes this approval. After approval, Git is the ordinary CLI,
including hooks. There is no Farol Git stage/commit command language. Excluded
current paths remain denied to ordinary shell reads; this is a distinct broad
grant. The owner approved the bounded disclosure for an individually selected
workspace; the live owner-connector selection and acceptance remain pending.
Synthetic native Git fixtures do not settle that live proof. The user's actual
configuration may reference further files, programs or credential stores that
remain outside this approval; those are a visible command failure, not an
unsandboxed fallback or proof of complete host-terminal parity. A worktree
inside the user's protected `.codex` store remains denied even when its
repository metadata has been approved; a normal linked worktree outside that
store is covered by the existing explicit metadata grant.

Shell launch requires a current owner verification for each selected workspace:
its access-check generation, folder identity and build evidence must match the
current Computer settings. A command-mode or Git-grant change invalidates that
evidence. Unverified folders can retain ordinary read/list access, but their
shell starts refuse. The connector advertises shell only when at least one
workspace has a current verification.

Native process inspection is currently narrower than an unrestricted terminal:
`lsof -p $$ -Fn` on the command's own shell passes with metadata-only `/dev`
access. `/bin/ps` is a setuid binary and its execution is denied by this
Seatbelt profile. Broader process enumeration and cleanup of deliberately
detached descendants remain NOT_QUALIFIED; the product must show the real
command failure rather than imply a full `ps` capability.

`computer_shell_start` takes a stable operation ID, approved workspace ID,
relative cwd, command, optional initial stdin, deadline, and write mode. It
returns an owned handle. `computer_shell_read` pages stdout/stderr by byte
offset, includes exact base64 bytes, and reports real exit code or signal.
`computer_shell_cancel` asks the command's watchdog to send TERM then KILL to
its process group. Its reply contains status only, without stdout or stderr;
the output remains available through `read` after any summary fence lowers.
The watchdog checks the original absolute authority expiry before spawning,
enforces the command deadline and stops its group
when its MCP control channel disappears. The handle does not become terminal
when the watchdog merely sends a signal: `groupCleanup` remains `pending` until
the watchdog exits and its group is observed absent, or becomes `unverified`
if that cannot be proved (`SHELL_GROUP_CLEANUP_UNVERIFIED`). `exitCode` and
`exitSignal` describe the root command.
`detachedCleanup` remains `unverified` even when the group is gone: a child can
call `setsid()`, leave the group, and outlive cancellation. The native
`fork`/`setsid` regression proves this gap without pretending the group check
is full tree cleanup. Output over 4 MiB terminates the command. On SIGINT or
SIGTERM, Computer MCP closes admission, waits up to four seconds for
pending starts and owned process groups to settle, and exits nonzero if group
cleanup is unverified. A start that was durably reserved before shutdown but
not dispatched remains outcome-unknown and cannot be replayed under its ID.
This still does not establish cleanup of detached descendants.

A private fsynced pre-effect reservation means a duplicate operation ID after
MCP process loss returns
`SHELL_OUTCOME_UNKNOWN`; it does not re-run the command. A same-process
duplicate returns the original handle. Completed output retention is bounded;
an expired handle never causes a command to be re-run.
Operation IDs are unique across the same Computer identity, including
connector restarts and generation changes. A reused ID in a different task
also returns `SHELL_OUTCOME_UNKNOWN`; callers must allocate a new ID for a new
effect. At 10,000 retained intents, new commands fail closed until a reviewed
retention/migration policy exists.

A summary-only execution fence denies new shell starts and output reads. Owned
cancel remains available so a running command can be stopped. Computer effects
hold a shared macOS admission lock; summary raise takes the exclusive lock and
refuses while an owned shell marker is unresolved. A dispatched command passes
its lease to the watchdog, and the marker is cleared only after its process
group is observed absent. A lost or unverified group leaves the marker in place
and later admission fails closed. This serialization still does not contain or
prove cleanup of a descendant that deliberately leaves the process group.

Connector stop first writes a private durable stopping barrier for its launch
generation. Every Computer MCP instance holds a kernel lifetime lease from
before stdio serving through verified transport and shell-group drain. New
instances refuse a stopped or revoked launch digest; existing instances close
admission and drain when they observe the barrier. Desktop records the
connector as stopped, or permits a Computer authority change after an already
exited tunnel client, only when no MCP lease, unacknowledged instance marker or
unresolved shell-group marker remains. A crash keeps the instance marker and
leaves stop unverified. A later connector
generation gets a new prepared digest; old digests stay revoked. This proves
the known MCP and process-group boundary, not arbitrary detached descendants.

This source checkpoint does not yet preserve output or live process identity
across a Computer MCP process restart. Reconnection to the same MCP process
retains the handle; replacing that process stops the owned process group and
leaves the command outcome unknown. The process-group boundary covers ordinary
descendants but does not prove cleanup of a child that deliberately leaves its
process group. Those rows remain open in the daily-driver qualification matrix. The native
Seatbelt tests run against disposable roots in a host context that allows
Seatbelt application; the restricted Codex execution sandbox refuses nested
`sandbox_apply` before the product command starts. No unsandboxed fallback is
used.

Persistent private ChatGPT conversation creation and its native-Handoff relationship are
tracked in [Persistent handoff parity](persistent-chat-handoff-parity.md). This is a
planned item for the existing Next writer, not an implemented U2 route or a Legacy
replacement claim.

## Fixed command contract

Both profiles use the reviewed Apple Git chain and an exact argument vector:

- `git.status`: `status --porcelain --branch -z --untracked-files=no --ignore-submodules=all`,
  plus one `:(exclude,top,literal)<prefix>` pathspec per excluded prefix; Farol parses the
  NUL-separated records structurally and renders them itself as `--short`-style lines
  (`## <branch>`, then `XY <path>` or `XY <original> -> <path>`) with raw UTF-8 paths and
  no C-quoting;
- `git.head`: `rev-parse --verify --quiet HEAD`.

Git never reads the approved folder itself (N02). Each command runs, with the snapshot
as its working directory, over a private snapshot that Farol's descriptor-bound helper
assembles under its own runtime directory: repository metadata with `.git/config`
(and any `config.worktree`) reduced to an inert `[core]` subset plus the structural
`extensions.objectFormat`, `extensions.refStorage` and `extensions.worktreeConfig`
keys, the index copied, and -- for `git.status` -- the tracked files attached as APFS
clones made from verified descriptors. A clone is a point-in-time copy on its own
inode: a later write to the owner's file through any descriptor is invisible in the
snapshot, the owner's link count stays one, and nothing written through the snapshot
reaches the owner's bytes. The snapshot is removed after the command.

What the two results mean, exactly:

- Both describe the approved folder **at the instant of the snapshot**. `git.status`
  takes two snapshots -- metadata only, to ask Git which paths are tracked, then
  metadata plus exactly those paths -- and the second is refused with
  `WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT` unless its index is byte-identical to the
  first's, so the pair is one instant or no answer. The index pin does not cover the
  working tree, which a write changes without touching `.git/index`: the tracked files
  are necessarily attached one at a time, so every one of them is re-checked once the
  list is complete and the command is refused with `WORKSPACE_CHANGED_DURING_SNAPSHOT`
  if any changed while it was being taken. The reported status is therefore the state
  at one instant because any change to a tracked file during the capture refuses the
  command; a mixed tree is never reported.
- `git.status` covers **tracked files only**: untracked files are never examined and
  submodules are ignored (`--ignore-submodules=all`; gitlink index entries are never
  carried). A tracked file missing from the working tree, or present as a directory or
  other non-file, is left out of the snapshot and therefore reported by Git as deleted
  or type-changed -- a true statement about the owner's tree.
- Paths under the workspace's excluded prefixes are absent from the snapshot, excluded
  from Git's own view by pathspec, and filtered out of the rendered result again
  (matching NFC-normalised and case-folded, as the helper matches), whatever characters
  they carry. A path Git admits but this route will not carry or render (a backslash,
  a newline) refuses the whole command with `WORKSPACE_TRACKED_PATH_UNSUPPORTED`.

Seatbelt grants the sandboxed Git read access to the snapshot, the reviewed Git binary
and system libraries only, write access to exactly the snapshot's `index` and
`index.lock` (under `.git`, or `.gitmeta/worktree` for a linked worktree), and `deny
network*`; repository monitors, attribute and exclude files and submodule recursion
are disabled by fixed `-c` arguments. The tracked-path listing has its own 32 MiB
budget (`WORKSPACE_TRACKED_LIST_TOO_LARGE`); status and HEAD output stay bounded at
64 KiB. The detached process group is killed on the ten-second deadline, output
overflow or MCP cancellation. Cancellation is checked before metadata resolution,
after each attestation boundary and immediately after spawn; it returns
`WORKSPACE_COMMAND_CANCELLED`, never a generic failure.

| Workspace shape                                      | Disposition                                                     | Evidence                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Regular repository                                   | Supported                                                       | real native status and HEAD tests                                             |
| Exact linked worktree                                | Supported with only its resolved worktree/common metadata roots | real native linked-worktree test plus parent canary denial                    |
| sha256 object format, reftable ref storage           | Supported (structural extensions carried through)               | `native-verification-command.test.ts` extension cases                         |
| `objects/info/alternates` present                    | Refused before the file is read                                 | `WORKSPACE_GIT_ALTERNATES_UNSUPPORTED` regression                             |
| Snapshot too large, cross-volume, or non-APFS volume | Refused with a distinct code                                    | `WORKSPACE_SNAPSHOT_TOO_LARGE` / `_CROSS_VOLUME` / `_CLONE_UNSUPPORTED` tests |
| Non-Git workspace                                    | Known refusal                                                   | `WORKSPACE_NOT_GIT_REPOSITORY` regression                                     |
| Arbitrary external, symlinked or writable metadata   | Refused                                                         | native metadata refusal regressions                                           |
| Research denied-path metadata experiment             | Not rerouted after the explicit host refusal                    | `NOT_RUN`                                                                     |

Generic file operations continue to deny `.git`; command metadata access does not
authorize reading the metadata parent through Computer. Credential-path denies are
preserved for every command profile. Read/write containment, ancestor-swap races,
mutation conflicts, current-generation checks and content-free receipts remain
separate native boundaries.

## Attachments and selected context

The assembled deterministic Browser route stages private copies, verifies exact
bytes, SHA-256 identity, supported MIME type and size, uploads image and document
files through the page's real file-input contract, observes completed chips, submits
once and removes staging data. Partial upload, missing reference, symlink,
unsupported type, size overflow and cleanup failure are explicit. The context preview
shows the owner-selected names/types/count and disclosure explanation, not file bytes
or hidden local paths; workspace exclusions still apply to Computer and delegated
Agent/Critic access.

This is `FIXTURE_APP` provider evidence. It proves the product composition and byte
contract, not that an authenticated owner account received the files. A real provider
attachment row remains separately budgeted and must never be inferred from the
fixture report.
