# Farol Next Preview

Farol Next Preview is the isolated TypeScript/Electron vertical slice under
`vnext/`. It does not install, activate, register, update, or replace the legacy
Farol product. It also does not use the installed `codex-chatgpt-web` profile.

## What runs

- one Electron shell that starts with no tasks on an ordinary launch;
- one Electron utility process with an OS-allocated loopback HTTP/SSE endpoint,
  task-scoped read capabilities and a separate main-process control capability;
- an explicit `--demo` mode with two independent scripted local-provider sessions,
  two real `WebContentsView` surfaces and one bounded fixture Computer round-trip;
- one mandatory five-step first-run Setup journey, available again from Settings,
  with real ChatGPT, Computer, Codex-host, and bounded Agent verification actions;
- the owner-selected Watch Rail shell with Iris selection/next-action accents,
  shape-and-text task signals, a 216 px sidebar / 72 px rail, and packaged Geist;
- content-free Activity, a content-free support export, and explicit
  provider/runtime failure states.

Ordinary Setup and Settings can open the isolated Next ChatGPT partition, observe and
verify its readiness, select real folders with the native picker, persist Computer
approval and exclusions privately, and exercise descriptor-relative list/read/search
through the product. An explicit access change enables guarded conflict-aware edits
with durable content-free receipts. An independently persisted, off-by-default
`Verified commands` setting enables only fixed no-network Apple Git status at a
freshly verified workspace root; no arbitrary command, argument, environment, or
working path is accepted, and command output is not retained. The Browser flow
previews selected text, image, or document context before one submission, retains
conversation and delivery state, and recovers a completed or outcome-unknown task
after restart without blind resubmission.
The deterministic E2E site remains a fixture; its green report does not claim that the
owner's authenticated ChatGPT account completed a live call.

Setup can also select and attest a Codex executable, run one bounded live App Server
tool turn, and run one narrow native-Agent compatibility assignment. That assignment
creates one genuine child, preserves the complete applicable read-only TaskGrant
through Main -> Agent -> Critic, performs one content-free workspace enforcement
probe through the current Computer policy, observes bounded running before rejoining
the same child, retains the result, and acknowledges parent delivery. This proves the
verification assignment only. General native Agent task admission, the
ChatGPT-to-Computer connector, commands beyond the fixed Git status verifier,
ordinary compaction continuity, network authority, and release readiness remain
open.

The N2 authority core derives a task-bound `TaskGrant`, preserves it through
main -> Agent -> Critic delegation, retains explicit owner narrowing including
do-not-inspect paths, and intersects every Computer action with current Computer
policy. Results retain exact request and operation correlation; only a validated,
correlated refusal is reported as known, while malformed or rebound responses are
outcome-unknown. The Agent app seam persists assignment correlation in a private
atomic store with exclusive first publication and serialized monotonic updates,
rejoins an already-known running child without another spawn, distinguishes a durable
result from a memory-only result, and records exact parent delivery. The selected
native Codex host and product UI now exercise this seam for the bounded compatibility
check described above; broader Agent work remains a separate acceptance boundary.

## Reproduce

Development requires one declared lane: Node `24.20.0` or `26.7.0`, with npm
`11.19.0`. The packaged app uses Electron's bundled runtime and requires none of
those tools from its launcher.

From the repository root:

```bash
npm ci --prefix vnext
task next:ci
task next:test:e2e:dev
npm --prefix vnext run test:e2e:computer
task next:package
task next:test:e2e
npm --prefix vnext run test:e2e:computer:package
```

The canonical owner command is:

```bash
task next:run
```

It opens the ordinary product shell with zero synthetic tasks. The retained fixture
journey is explicit:

```bash
task next:run -- --demo
```

The verified packaged candidate workflow copies the existing package into a private
isolated launch snapshot, verifies that final launch path, and launches only those
verified bytes. It never builds, installs, updates, or activates either product, and
it refuses a missing, dirty, stale, or digest-invalid package with the exact rebuild
action. A second owner launch reopens the running app only after a nonce-bound
acknowledgement proves that its source commit and tree digest match the exact
candidate; a different or unverifiable running build is rejected. The packaged
process emits one mandatory bounded launch result only after either the primary
startup is complete or the existing primary has answered. The owner launcher waits
for closed output streams and fails on a missing, malformed, or duplicate result even
when the child exits with status zero.
`task next:preview` is the separate development lane; it builds development bytes and
is not artifact evidence. See [`docs/owner-preview.md`](docs/owner-preview.md) for
controls and lifecycle.

The deterministic gate includes strict typecheck, architecture fixtures, policy and
integration coverage, Hunt selftest/proof/model, and a build-bound sanitized replay.
The development E2E lane runs those exact clean built files through Electron's
bundled runtime without modifying its signed vendor bundle; it writes evidence to
`artifacts/e2e-dev/`. The separately sealed package lane remains the artifact gate.
Packaging verifies the app identity, embedded source manifest, runtime closure,
the immutable nested Electron runtime and helper identities, contained symlinks,
type-bound tree digest, plist, fixed launcher and explicit unsigned status. E2E
launches those packaged bytes under a throwaway home and explicit user-data root,
checks the real UI and task views, rejects malformed and tampered artifacts, proves
default-deny task egress, makes a second launch wait across an intentionally delayed
primary startup, and exercises actual utility-process death.

Both E2E lanes follow the non-interference contract in `docs/testing.md`. One
native-visible interaction run is positioned on the non-primary built-in display
before first show and shown without taking focus. Fault and recovery runs stay hidden
while their renderers continue to paint for DOM and screenshot evidence. A machine
with no secondary display uses an explicit primary-display fallback recorded in the
JSON report; it never silently relies on Electron's default placement. Only the final
native focus-transfer assertion activates that secondary-display window, and teardown
follows immediately.

Launch the exact built development preview through the pinned Electron runtime:

```bash
npm --prefix vnext run preview
```

Pass `-- --demo` only when deliberately exercising the development fixture.

After `task next:package`, use only the canonical command above. Running the executable
inside `dist/package` directly bypasses source, manifest, resource, and digest
verification and is unsupported.

The outer `.app` and its fixed launcher are explicitly unsigned. The launcher uses
an unmodified, digest-bound copy of the pinned vendor Electron bundle, so creating
this local artifact does not remove or add a code signature. This is local preview
evidence only: it is not notarized, published, installed-product,
independent-recipient, update/rollback, live-provider or release-readiness evidence.

## Evidence

- `dist/package/artifact.json` — exact source and packaged-tree identity;
- packaged `Contents/Resources/app/resource-manifest.json` — app, process, state,
  transport, receipt, and intentionally absent integration ownership;
- `artifacts/e2e-dev/report.json` — exact development-build interaction evidence;
- `artifacts/e2e/report.json` and its recorded PNG set — packaged interaction
  evidence;
- `artifacts/hunt/path.json` — semantic path, model/command-table version, controlled
  schedule, mutation proof and exact build identity.

The E2E reports also record the visible run's selected-display class, work area,
window bounds, initial focus state, and the scenarios proved while hidden. Native
Agent rows identify lineage, TaskGrant workspace enforcement, bounded same-child
rejoin, durable result delivery, and content-free persisted evidence separately.

These directories are ignored because they are reproducible local evidence, not
source inputs.

`sourceTreeDigest` is the SHA-256 of the canonical recursive Git tree listing for
the committed `vnext/` subtree. Packaging also requires every project build input
to match its HEAD blob, rejects special index flags and tracked symlinks, records a
dependency-input ledger, and binds every built entry by SHA-256. The separate
`sourceDirty` flag reports tracked or untracked non-ignored worktree changes.
The portable `vnext/AGENTS.md` is tracked and contributes to this identity. `.DS_Store`,
build output, coverage and other explicitly ignored host noise do not change the
identity of the same clean commit.
