# Farol Next architecture

Status: transitional source architecture. The React + TypeScript UI and Go backend
target is accepted; complete product cutover and distribution acceptance are pending.

## Decision

The target has four Go product modules: `computer`, `task`, `chat`, and `release`.
React + TypeScript owns Farol UI; plain TypeScript owns Electron, preload and
browser/DOM mechanics. Go owns backend policy, state, orchestration and native
execution. Modules communicate through consumer-owned ports and published
contracts; HTTP is not an internal module boundary.

The current source combines that target with remaining TypeScript routes under
`src/`. A Go-enabled normal host starts an attested backend and composes Chat and
Computer; the legacy utility process and its loopback endpoint still serve
unmigrated behavior. The following utility-process description applies to that
remaining route. It is not evidence that every capability has moved to Go.
See the [bounded packaged startup/reopen witness](desktop-core.md#normal-startup-and-empty-profile-reopen-candidate)
and the remaining cutover limits there.

`apps/desktop` and the remaining `src/apps/desktop` sources own the Electron
main/preload host adapters. The desktop-owned Computer MCP child entry and its
socket clients live under `apps/desktop/computer-mcp`; the Go launch route uses
the adjacent bridge without constructing a second Computer owner. Its packaged
entry remains `computer-mcp.cjs`. The explicit legacy launch route remains
transitional and is never selected after a failed Go launch.
`src/apps/runtime` owns the separate utility-process entrypoint. The Chat-owned preview
server adapter lives under `modules/chat/infra/server`; it receives Computer and
UI capabilities at composition rather than importing their implementations.
`src/boot/runtime-server.ts` only wires those concrete dependencies.

The production utility process is launched with Electron's `utilityProcess.fork`.
This deliberately uses the runtime shipped inside the exact Electron artifact, so a
tester does not need Homebrew, Python, Node, npm, or Bun. Bun FFI is not used as a
security boundary. The Electron main process owns child lifetime. On macOS, closing
the last window disposes its views and streams but keeps the application and utility
runtime alive; a Dock activation or second launch recreates one window against the
same runtime. Explicit Quit requests bounded runtime shutdown. An unexpected
utility-process exit becomes an explicit failed state while keeping an open shell
available. Startup coverage
kills that exact utility after runtime readiness, during the first task-view load,
and during the second task-view load; every case removes the partial task surfaces
without terminating the shell.

The local package is an unsigned outer Farol Next bundle with a fixed, argument-safe
launcher. It embeds the pinned vendor `Electron.app` byte-for-byte under its own
Frameworks directory and passes the embedded application directory explicitly. The
outer bundle owns the Farol Next product and launch identity; the nested Electron
bundle remains a verified runtime dependency rather than rewritten, stripped, or
newly signed executable code.

## Initial host trust and resource lifetime

The local unsigned preview assumes that the owner launches a trusted installed
outer launcher, Electron runtime and desktop main process. Farol's in-process
checks cannot authenticate those first executing bytes against a prior malicious
replacement of the entire public bundle. The shared Applications parent is a
supported installation location, not an external code-signing trust anchor.

After that trusted startup, the accepted independent image digest and private
resource capture constrain later resources and child launches. Those guards
still reject copied root aliases, displaced private images, wrong ownership and
unconfirmed update/custody outcomes; initial host trust does not waive any of
these checks. Private correlated update relaunch and ordinary public-slot launch
have distinct origins. Developer ID signing, notarization and an externally
qualified first-code admission policy remain separate distribution decisions.
See [the installed resource boundary](installed-update-runtime.md) for the exact
snapshot scope and [release limitations](github-release-contract.md) for the
current unsigned package contract.

## Native surface composition

The Browser task page is a native `WebContentsView`; the Watch Rail, task tabs,
dossier, Computer, Activity, Settings, and modal UI belong to the sandboxed shell
renderer. Electron always composites a child view above renderer HTML. Main therefore
owns a closed `SurfaceSection` / `SidebarMode` / `ShellOverlay` layout contract and
hides the selected task view whenever Setup or a shell overlay is active. It never
accepts renderer-provided bounds. This hide-while-overlay strategy preserves the full
Browser viewport during normal work and guarantees that sidebar, task-menu, quick
switcher, Escape, and focus handling are reachable without weakening preload, IPC,
navigation, permission, partition, or network fences.

The canonical owner launcher copies that package into a private per-invocation
snapshot and verifies the snapshot before execution. Product-controlled package
replacement therefore cannot change the bytes between verification and launch or
while the application is running. The Taskfile starts the guard and verifier from an
allowlisted environment, and the child receives a minimal explicit environment;
arbitrary same-owner mutation of the private snapshot is outside this unsigned local
preview's threat boundary. A snapshot is never reused; the launcher removes it after
an observed application exit, while an ungraceful launcher or host death can leave a
private temporary copy behind.

## Enforced dependency direction

The existing TypeScript modules under `src/` use this dependency direction:

```text
domain -> kernel/domain
app -> own domain + consumer-owned app ports + kernel domain/app
contract -> boundary DTO/schema only
infra/peer -> own app port + neighbour contract
infra -> own layers + generic mechanisms
kernel/infra -> kernel ports + generic mechanisms, never product modules
boot -> all concrete composition
apps -> executable host adapters and entrypoints
```

Only `infra/peer` may cross a module boundary, and only to the neighbour's
`contract`. Contract code cannot import domain aggregates or implementations.
`domain`, `app`, contracts, and the pure kernel cannot import Electron, Node host
modules, DOM, filesystem, network, or ambient timer modules. The architecture gate
parses static imports, re-exports, aliases, literal dynamic imports and CommonJS
`require`, rejects dynamic loaders and non-allowlisted pure-layer packages, rejects
cycles and unclassified production files, and runs both positive and deliberately
invalid fixtures. It also rejects host/vendor imports from composition-only `boot`,
all inner-layer imports of executable `apps`, and module imports of UI.
Independent executable applications cannot import one another. Both desktop
source trees receive the same strict TypeScript, lint and architecture checks.
Shared CSS-pixel layout values live under `src/pkg/shell-layout` so native views,
IPC validation and the renderer use the same geometry without a host dependency.

The accepted Go layout uses `modules/<module>/contracts/<feature>` as a thin
published in-process facade. It may import its own application/domain to delegate
to the owner, and deliberately shared pure kernel vocabulary. Its request/response
DTOs remain independent: no aliases to app/domain/transport types, no exposed
implementation types, and explicit conversions at the boundary. This Go facade
rule does not change the TypeScript DTO-only contract rule above.

Go neighbors still cross module boundaries only through `infra/peer` to the
owning module's published contracts. Contracts cannot import infrastructure,
boot, executable hosts, or neighbor internals. The Go import gate enforces these
edges; source review verifies delegation, independent DTO signatures, absence
of implementation aliases and explicit mappings. The common Desktop transport may depend only on published module
contracts, never app/domain/infra. `boot` owns concrete composition and lifetimes.

## Shared infrastructure decision

`pkg/kernel/infra/system-clock.ts` is shared because the Chat turn service and
Computer authorization service both consume the same `Clock` semantics. Each receives a
separate object through its own composition; there is no shared mutable singleton.
Module failures and cancellation remain separately owned. Generic SSE framing lives
under `pkg/sse`, because it is a transport mechanism rather than kernel policy.

## Isolation and evidence boundary

The preview identity is `local.farol.next.preview`, its product name is
`Farol Next Preview`, and its state lives only under its distinct Electron
`userData` root. Browser views use `persist:farol-next-preview` in an ordinary launch
and E2E runs the same bytes under a throwaway `HOME` plus an explicit
`--user-data-dir`, so that partition resolves only inside the test root. Runtime ports
are allocated by the OS on loopback and protected with per-run bearer values. No
tunnel, provider slot, global MCP registration, launch agent, legacy state path, or
installed browser profile is used.

The explicit demo provider and Computer remain controlled fixtures. Ordinary product
composition is separate: `ChatGptRoute` owns the isolated Next partition and bounded
submission lifecycle, while `NativeReadonlyWorkspace` supplies descriptor-relative
list/read/search, guarded edit operations, and explicitly enabled fixed `git status`
and exact `git head` verifiers under persisted Computer approval. Generic file tools deny
`.git`. The verifier rechecks `verification.run` plus `commands=verification`
against both the task grant and current Computer approval, attests the owner-safe
workspace and signed Apple Git chain, then executes an exact argument vector inside
an Apple Seatbelt profile with network denied, optional locks and repository
file-system monitors disabled, fixed environment, timeout, cancellation, and output
limits. Timeout, output overflow or caller cancellation kills the detached process
group. The caller cannot select an executable, argument, environment, working
subpath, or network policy. Enabling or disabling command authority advances the
Computer generation, invalidates stale verification and native-Agent proof, and
requires a fresh workspace verification. A regular repository and an exact linked
worktree are supported; only the resolved worktree/common metadata roots are
admitted. Arbitrary, symlinked or writable external metadata is refused, and metadata
access never grants the parent directory to generic file tools. The
development and sealed-package E2E routes use a synthetic provider site and temporary
Mac workspace trees, so they prove product composition and containment without
claiming the owner's authenticated provider account was exercised.

A guarded edit is published at one atomic exchange of names (`renameatx_np` with
`RENAME_SWAP`) between a candidate staged in a private `.farol-stage-…` directory
beside the target and the target itself; a create is one `link` that fails if the
name exists. Only the candidate is ever published. The exchange counts only when the
object it displaced is the checked original, verified through a descriptor
afterwards; any other displaced version is exchanged back, unless a newer save has
already replaced the candidate, which then stays at the target. Until an undo the
candidate is visible at the target, so it is deleted after an undo only if it came
back byte for byte unchanged. Success means that publication, nothing kept, and a
final observation, made after the helper's last filesystem operation on the
workspace, that the target still names the published file; a later save wins and is
never touched. Files are deleted only inside the staging directory and only when
their inode was verified immediately before; anything else is kept there for the
owner and the edit reports a conflict or an unknown outcome that is never retried.
The directory itself is removed only with `rmdir`, which never removes one that holds
anything, and a helper that is killed leaves it behind. Disclosed residuals: a writer
that keeps the original, or the briefly published candidate, open and writes through
that descriptor after it was checked; a save landing between the last check before an
undo and the undo, which puts the older version back at the target and keeps the
newer one in staging; and a process that deliberately writes inside the staging
directory, which can substitute what is published or deleted. No isolation from
same-user or root processes is claimed.

The N2 authority core is implemented as a runtime-derived task-applicable `TaskGrant`
/ `ExecutionAuthority`. Permitted delegation from a main Turn through Agent and
Critic preserves that authority for ordinary relevant discovery inside its approved
workspace, without treating the assignment packet's initial filenames as the
security boundary. Explicit owner narrowing, including do-not-inspect paths, is
carried into the native read-only deny list. A delegate still cannot exceed the
TaskGrant, underlying Computer approval, native host-task authority, or an explicit
narrower owner instruction. Prompt text is never authority. A selected and attested
Codex App Server can run both the setup lineage assignment and one owner-written
Product Agent objective for an admitted live task. The root spawns one correlated
child, the child uses only inherited typed Computer read/search or fixed verification
operations, the root waits and reports exact authority evidence, and the product
rejoins the same child before durable result acknowledgement. The setup probe
exercises an allowed focus plus denied foreign scope and configured exclusions; it
returns no workspace names or contents to the child. Product Agent remains without
mutation ownership or network authority.
The read-only Computer response contract binds the full operation semantics, not
only task/call/path identity; malformed or rebound responses remain terminal
outcome-unknown rather than being mislabeled as a known refusal. The Agent app seam
persists assignment/child correlation in a private atomic store with exclusive first
publication and process-serialized monotonic updates, rejoins only the same known
running child after restart, and records result retention separately from an exact
parent-delivery acknowledgement. The in-memory host remains for exhaustive negative
tests, and the product runtime selects the seam through both the bounded native Codex
lineage check and task-menu Product Agent. Neither grants arbitrary commands, network
access, generic handoff, nor proof of authenticated provider work.

The SSE stream is bounded and delivery-aware. Capacity pressure may discard only
events already acknowledged by the receiving client. If the unacknowledged window
is full, that task fails closed with `EVENT_STREAM_CAPACITY_EXCEEDED`; its stream is
closed and late subscribers receive a conflict response. No other task or the
runtime process is stopped by that local failure.

The tracked machine-readable ownership table is `resources.json` and the build copies
it to `Contents/Resources/app/resource-manifest.json`. Tunnel, global MCP/provider
registration, native Computer/Agent ownership, updater, and login-item identities
remain explicitly absent rather than reserving global resources.
