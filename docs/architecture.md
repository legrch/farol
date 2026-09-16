# Farol Next architecture

Status: accepted for the isolated local preview.

## Decision

Farol Next is a strict-TypeScript modular monolith with four product modules:
`computer`, `chat`, `agent`, and `release`. Electron owns the desktop/browser
surface. One utility process owns the local runtime and loopback SSE endpoint.
Source modules communicate in process through consumer-owned ports and published
contracts; HTTP is not an internal module boundary.

`src/apps/desktop` owns the Electron main/preload host adapters and
`src/apps/runtime` owns the utility-process entrypoint. The Chat-owned preview
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

The local provider and the Computer capability selected by the product preview are
controlled fixtures. They prove the module/IPC/SSE/tool loop, not ChatGPT readiness,
native Codex ownership or Farol Agent admission. The separate `computer-mcp`
entrypoint and its development/sealed-package E2E prove descriptor-relative
read-only containment on temporary Mac workspace trees; that boundary is not yet
registered with a host or selected by the product runtime.

The N2 authority core is implemented as a runtime-derived task-applicable `TaskGrant`
/ `ExecutionAuthority`. Permitted delegation from a main Turn through Agent and
Critic preserves that authority for ordinary relevant discovery inside its approved
workspace, without treating the assignment packet's initial filenames as the
security boundary. Explicit owner narrowing, including do-not-inspect paths, is
carried into the native read-only deny list. A delegate still cannot exceed the
TaskGrant, underlying Computer approval, native host-task authority, or an explicit
narrower owner instruction. Prompt text is never authority. Native Agent admission
and permitted verification-command execution remain separate unproved boundaries.

The SSE stream is bounded and delivery-aware. Capacity pressure may discard only
events already acknowledged by the receiving client. If the unacknowledged window
is full, that task fails closed with `EVENT_STREAM_CAPACITY_EXCEEDED`; its stream is
closed and late subscribers receive a conflict response. No other task or the
runtime process is stopped by that local failure.

The tracked machine-readable ownership table is `resources.json` and the build copies
it to `Contents/Resources/app/resource-manifest.json`. Tunnel, global MCP/provider
registration, native Computer/Agent ownership, updater, and login-item identities
remain explicitly absent rather than reserving global resources.
