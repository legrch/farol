# Computer parity and content lifecycle

This inventory compares the actual Legacy Hub tool catalogue in
`src/hub/catalog.mjs` with the selected Farol Next U2 product routes. It is not a
claim that similarly named schemas are equivalent. `REAL_LOCAL` means the native
boundary ran against an actual temporary macOS workspace or installed host;
`FIXTURE_APP` means the assembled Electron product ran with the deterministic
provider/host fixture; `BLOCKED_OWNER` and `NOT_RUN` remain open evidence rows.

## Current Go Dev evidence

The current desktop selects the protected Go connector for catalogue, bootstrap,
list, read, search and one-shot verification. The same Go owner supplies write,
edit and retained-result observation. On 6 October, ordinary Dev `0a651651`
served real external catalogue/bootstrap/read/search and attachment verification
with the retained ordinary profile. Dev `426f36d6` previously served synthetic
file create → read → exact-digest edit → stale-digest conflict → readback through
the external connection. Normal Quit and later builds retained that edited file,
folder configuration and connection without recreating the profile or repeating
the mutation. These are ordinary Dev/external witnesses, not installed or
canonical-package acceptance. Exact request/build/profile receipts
are preserved locally under `_output/evidence/startup-recovery-20261004/`.

The same running Dev also passed a later external read of its repository checkout
inside `.codex`, then create → exact-digest edit → readback of a synthetic file in
that checkout. The enclosing HOME grant was sufficient; no extra child-folder
approval was added. Each mutation used one distinct operation ID and returned a
durable completion receipt. This qualifies that file route, not `.claude`, shell,
Git or provider-session behavior. Bootstrap correctly reports an unavailable
ancestor `AGENTS.md` when it is a symlink and leaves `complete: false`; ordinary
checkout files remain readable. No symlink target or credential was read to
override that guard. The exact bounded operation evidence is retained in
`external-dev-0a651651-agent-store.json`.

The Go route does not advertise shell/Git or coding-task tools. Its process
reservation, anchored measurement, held control, watchdog and retained observation
remain separate implementation/qualification slices. The actual native Seatbelt
alias test denied direct protected paths, symlinks and outside-root reads but
allowed a hardlink alias to synthetic protected bytes. That failed stronger
confinement claim remains open; it has not been waived or fixed by source-only
tests. HOME/scratch semantics, ordinary linked-worktree Git and descendant cleanup
also remain gates. The historical shell table below describes the earlier
TypeScript route and does not qualify Go shell.

Actual external `computer_mutation_read` is now qualified separately from its
source registration. Dev `67d8af51` observed the original completed edit after a
normal Quit and source/build change on the same profile, with its original
operation/call identity and durable publication intact. It did not repeat the
mutation. Ordinary Dev `5376fac6` later reconnected on that same profile and
passed a fresh external catalogue and attachment check. This confirms the
current caller surface and retained file outcome; it does not establish Go
process retention, installed recovery or full Computer parity.

The Go MCP adapter retains the published `computer_workspace_search`,
`computer_workspace_write` and `computer_workspace_edit` names. Its public
`expectedSha256` spelling remains unchanged: write requires an explicit `null`
for create-only or an exact hash for replacement; edit requires an exact hash.
The adapter translates these values once to the internal Go wire. Missing or
misspelled preconditions are refused before mutation dispatch. Go's bounded
256 KiB content/edit-text limit remains explicit; preserving tool names does not
extend that limit or restore the legacy executor.

Connector mutations use the existing Go mutation engine and
journal. Its separate v3 record keeps a stable profile operation key and immutable
original host/execution/call correlation; connector generation is an exact uint64
decimal string. Existing task v1 and Settings v2 bytes are unchanged. A selected
write lease covers admission, native publication and initial disclosure. Retained
metadata can be read with current connector read authority after that write lease
expires, without admitting or executing a mutation. Original unknown and
memory-only outcomes cannot be upgraded by reading apparently complete disk data.
The root join shares Settings' bounded operation ledger and retirement gate.
Closing or replacing a connector does not remove uncertain attempts. The wire
response separates current request correlation from the original retained
operation. Write/edit require a caller-selected operation ID; observation reads
that ID without dispatching it. MCP advertises this slice only when the exact Go
handshake provides all three routes. The normal external Dev file journey above now supplements these source and
fixture checks. Installed mutation and full Computer parity remain unqualified.
An earlier duplicate-write probe was refused before execution and is not a passing
external no-duplicate witness; lower-layer duplicate guards retain their own scope.

## Legacy-to-Next disposition

| Legacy capability                                                                                                 | Farol Next disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Product consumer and evidence                                                                                                                          | Status                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `open_workspace`, `request_access`                                                                                | Owner-controlled Setup/Settings grant folders and authority. `computer_workspace_bootstrap` returns the selected task root, approved physical identity and applicable root/nested AGENTS chain; unavailable instructions remain explicit. No model can expand access.                                                                                                                                                                                                                                                                                                                                    | `workspace-bootstrap-mcp.test.ts`, `readonly-computer-action.test.ts`, packaged read-only MCP fixture                                                  | Local native-helper/public-MCP fixtures; live new-connector qualification remains separate                     |
| `read`, `ls`, `glob`, `grep`                                                                                      | Bounded read/list/text-search preserve explicit completeness limits. Recursive filename/include discovery uses ordinary approved shell, e.g. `rg --files --glob`, with actual ignore coverage and exit status. List/search alone are not full recursive filename parity.                                                                                                                                                                                                                                                                                                                                 | Native read-only tests, Computer MCP and workspace shell fixtures; [context contract](computer-workspace-context.md)                                   | Local/package evidence; owner workflow and detached-process limitations remain separate                        |
| `write`, `edit`                                                                                                   | Explicit write approval, exact source digest, descriptor-relative containment, atomic replace, conflict detection, stable operation ID and content-free durable receipt. An uncertain replace acknowledgement is never replayed. Product Agent assignments remain read/verify-only; the general delegated Computer boundary preserves write authority only when mutation ownership was explicitly granted.                                                                                                                                                                                               | Settings mutation flow and mutable Computer MCP; `native-mutable-workspace.test.ts`, `mutable-computer-action.test.ts`, `mutable-computer-mcp.test.ts` | `REAL_LOCAL` + `FIXTURE_APP`                                                                                   |
| `bash`                                                                                                            | Owner-selected `workspace` command mode exposes `computer_shell_start/read/cancel` through the new Computer MCP. Each call sees one task-granted workspace. The native Seatbelt profile denies network and sensitive paths; complete Git object history requires a separate owner approval for that folder. A per-command watchdog enforces the absolute authority deadline and stops its process group if MCP disappears. Exit/signal and stdout/stderr are read from the live handle; a lost acknowledgement after restart is explicitly unknown and cannot execute again under the same operation ID. | Computer MCP and native sandbox fixtures; `sandboxed-workspace-shell.test.ts`, `secure-mcp-launch-contract.test.ts`, `workspace-shell-mcp.e2e.mjs`     | `REAL_LOCAL` + built and packaged MCP fixtures; owner connector proof pending                                  |
| `guidance_search`, `guidance_fetch`                                                                               | `computer_guidance_search/fetch` use a product-owned manifest embedded in the attested build. Fetch resolves published IDs only, every reference is manifest-listed, and malformed/missing catalogues are explicitly unavailable. Private owner Brain rules are not bundled.                                                                                                                                                                                                                                                                                                                             | `published-guidance.test.ts`, `workspace-bootstrap-mcp.test.ts`, packaged read-only MCP fixture                                                        | Source/local/package qualification; live connector schema refresh remains separate                             |
| `codex_task_create`, `codex_task_status`, `codex_task_result`, `codex_task_observe`, `codex_task_adopt`           | A separate task grant exposes create/status/exact result and read-only inspection of one owner-selected native thread in the exact saved project and physical workspace. Adoption persists a read-only handle to one verified turn; it cannot start, resume, fork, steer or continue work. Active steering and same-thread continuation remain source-only and disabled until live host qualification; durable owner-task control is not yet implemented.                                                                                                                                                | Persistent handoff journal, desktop task grant, Computer MCP, disposable fake-socket fixtures                                                          | Built/packaged fixture; live shared-runtime and owner-task proof pending                                       |
| `claude_task_create`, `claude_task_status`                                                                        | Existing Computer MCP + sealed fixture-only grant, physical canonical/writer binding, tasks.harnesses.claude-code, durable one-shot dispatch and bounded recorded-terminal result. No Codex fallback; live native Claude and shared visibility remain unqualified.                                                                                                                                                                                                                                                                                                                                       | Claude source/process/journal/MCP fixtures; [candidate contract](claude-handoff-candidate.md)                                                          | Fixture-only route implemented; no production Desktop grant, live auth/network or native session qualification |
| `farol_session_search`, `farol_session_read`, `farol_session_tail`                                                | The selected Next product semantics are exact task history, content-free Activity and private context continuity. Next does not expose a raw supplemental transcript-search tool to the model.                                                                                                                                                                                                                                                                                                                                                                                                           | Watch Rail task registry, Activity, private checkpoint store and three-cycle continuity/restart tests                                                  | Selected product semantics `REAL_LOCAL` + `FIXTURE_APP`; raw transcript tool `NOT_SELECTED_U2`                 |
| `farol_caller_tools`                                                                                              | Ticket-bound native caller relay validates the exact host catalogue, turn, operation ID and at-most-once invoke. Making it model-visible in the production ChatGPT route is the same Route B owner decision above.                                                                                                                                                                                                                                                                                                                                                                                       | `codex-caller-relay.test.ts`, `caller-relay-mcp.test.ts`                                                                                               | Foundation `REAL_LOCAL`; full Route B `BLOCKED_OWNER`                                                          |
| `farol_agent_sessions_list`, `farol_agent_history_search`, `farol_agent_session_read`, `farol_agent_session_tail` | Product Agent stores only the current task's bounded objective, lineage, terminal state and delivery evidence. General browsing of historical Codex/Claude transcripts is not exposed or implied.                                                                                                                                                                                                                                                                                                                                                                                                        | Task menu and Activity; `product-agent-store.test.ts`, `agent-persistence.test.ts`, built-app Product Agent flow                                       | Selected task lifecycle `REAL_LOCAL` + `FIXTURE_APP`; general history tools `NOT_SELECTED_U2`                  |

`NOT_SELECTED_U2` is not a compatibility claim. Those rows must remain visible in
any later Legacy-replacement decision.

## Historical TypeScript workspace-shell command mode

This section records the earlier executor's contract and qualification limits.
The active Go Dev connector does not expose these shell tools. Do not follow
these settings as instructions for enabling an unqualified Go process route.

The owner must select **Workspace shell** in Computer settings and verify the
approved folder again before starting the new connector. This is separate from
the default-off Model and Product Agent. The same approved root may be
read-only or writable; the shell call declares `write` and the authority
service checks both that mode and mutation ownership. Each call exposes only
the selected task-granted subtree. Without full Git approval the process
receives a private empty home. With full Git approval for the exact selected
root its shell receives the OS account HOME path from the sealed launch contract
and read access only to the owner-owned
`~/.gitconfig` (or its exact owner-owned target inside HOME) and
`~/.config/git`; the connector process keeps its separate private HOME, and
write access to the account HOME is not granted. All commands receive a
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
unsandboxed fallback or proof of complete host-terminal parity. Worktrees
inside `.codex` or `.claude` follow ordinary owner/task workspace grants and
explicit exclusions, as described in [Agent store access](agent-store-access.md).
Their directory names do not veto an approved scope. Repository and linked
worktree metadata still require the existing separate Git approval.

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

## Native deadline scenario evidence

Deadline-before-spawn and deadline-after-observed-running are separate scenarios.
A watchdog that rejects an already expired absolute authority reports no command
exit code/signal, emits no ready event and leaves the command canary untouched.
Tests of a running command first observe its stdout marker and live state, then
require the real SIGTERM, terminal handle and confirmed owned-group cleanup after
command timeout or authority expiry. Test admission windows allow setup to finish;
production deadlines and cleanup remain unchanged. A passing isolated repeat does
not erase a failed full gate or prove its original timing cause. These fixtures
still do not qualify detached descendants or the owner's live connector.

## Owned watchdog signal refusal checkpoint

A failed process-group signal is sticky for that owned command. The watchdog
reports refusal, schedules no escalation after a refused TERM, and never repeats
an attempted KILL from a later close callback. It continues observing the actual
root command; successful signal submission alone is not a terminal outcome. After
that command closes, its reserved controller exit status preserves the refusal
when IPC acknowledgement is unavailable. The parent retains unverified cleanup
without another signal or group probe after known refusal. Final controller close
and disconnected IPC precede parent cleanup effects and terminal classification;
exit alone cannot release a lease with pending receipts. Every group probe and
final classification rechecks refusal, so a late receipt cannot become confirmed
on a later ESRCH. An observed ESRCH on
the parent's one lost-watchdog cleanup attempt is distinct from permission denial.
The original root exit code/signal, when actually reported, remains separate from
the controller's refusal status. Scratch and admission remain fail closed.

The focused evidence executes the actual watchdog source in a VM with synthetic
IPC, child, timers and signal functions, then the real shell service against a
synthetic watchdog and disposable filesystem. A separate owned Node IPC fixture
self-terminates, observes its actual exit84 and verifies both final receipts before
public close with disconnected IPC. It uses no shell, OS signal, sandbox-exec,
owner state or provider and has no kill/relaunch fallback. This does not repair a native EPERM,
qualify native permissions, prove full detached-descendant cleanup or qualify the
NEW connector. The full mandatory gate remains blocked; earlier source/package
receipts do not apply to these new bytes.
