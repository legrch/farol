# Farol Preview

Farol is a standalone TypeScript/Electron product. All source, tooling, tests,
and resources live at the repository root. It does not install, activate, register, update, or replace the legacy
Farol product. It also does not use the installed `codex-chatgpt-web` profile.

The source has two explicit local identities. `task dev` from the repository root
launches **Farol Dev** (`local.farol.dev`) with persistent private state, dedicated
browser/runtime partitions and an app-owned `CODEX_HOME`; rebuilding does not clear
its sign-in or Settings. `task package` and `task run` keep the existing
**Farol Next Preview** identity (`local.farol.next.preview`). Neither lane copies
cookies, keys, profiles or personal Codex configuration from another identity.

The permanent model protocol is independent of these development identities:
`model_provider = "farol"`, `model = "chatgpt"`. `farol/chatgpt` is display
notation only. The default alias, future version pins, resolution lifetime and
migration boundaries are defined in [Model routing](docs/model-routing.md).

### Dev names and profile compatibility

The visible app and ChatGPT app name is **Farol Dev**. The marker `dev`, app ID
`local.farol.dev`, runtime `farol-dev-runtime`, and `persist:farol-dev-*` partitions
are stable machine identifiers; they are not derived from the display label.

New profiles use `Application Support/Farol Dev`. A legacy-only `Farol DEV`
directory on a case-sensitive volume remains in place and is reused. When both
spellings resolve to the same device/inode, the preferred spelling addresses that
same directory without moving or copying it. Two distinct profiles fail closed
with `DEV_PROFILE_DIRECTORY_AMBIGUOUS` instead of being merged or reset. Profile
selection reads directory metadata only; it does not migrate cookies or credentials.

The browser requires the actual exact `Farol Dev` app selection. An existing
external app still named `Farol DEV` is not silently treated as the new label;
rename and verify the intended external app separately, then reselect it. Display
renaming never authorizes another tunnel, broader access, or a message retry.

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
`Verified commands` setting enables only fixed no-network Apple Git status and exact
HEAD verification at a freshly verified workspace root; no arbitrary command,
argument, environment, or working path is accepted, command cancellation kills the
detached process group, and command output is not retained. The Browser flow
previews selected text, image, or document context before one submission, retains
conversation and delivery state, and recovers a completed or outcome-unknown task
after restart without blind resubmission.
The deterministic E2E site remains a fixture; its green report does not claim that the
owner's authenticated ChatGPT account completed a live call.

The source includes Codex executable attestation and a bounded native-Agent
lineage-check seam. Product Agent remains default-off: start and rejoin refuse
with `AGENT_NOT_READY` before creating input, assignment or host work. Local
fixtures exercise child lineage, read/verify TaskGrant propagation, same-child
rejoin and result retention; they do not qualify a live Product Agent. Enabling
that route and its positive qualification require a separate owner decision.

Context continuity keeps the same retained conversation when available, uses a
summary-only provider turn with no tools, stores a private bounded checkpoint before
handoff, waits for exact host completion, advances one epoch and resumes after
restart. Three ordinary compaction cycles and the exact installed host protocol have
separate evidence. The model summary never renews authority or proves side effects.
The model-visible ChatGPT-to-native caller route, arbitrary commands, network
authority, authenticated attachment delivery, and release readiness remain separate
acceptance rows. See [`docs/computer-parity.md`](docs/computer-parity.md) for the
complete Legacy disposition and evidence boundary.

The N2 authority core derives a task-bound `TaskGrant`, preserves it through
main -> Agent -> Critic delegation, retains explicit owner narrowing including
do-not-inspect paths, and intersects every Computer action with current Computer
policy. Results retain exact request and operation correlation; only a validated,
correlated refusal is reported as known, while malformed or rebound responses are
outcome-unknown. The Agent app seam persists assignment correlation in a private
atomic store with exclusive first publication and monotonic updates,
rejoins an already-known running child without another spawn, distinguishes a durable
result from a memory-only result, and records exact parent delivery. Cancellation
publishes one private, no-replace intent before the host interruption. A crash,
lost acknowledgement or failed terminal save never permits another cancellation
request. Terminal receipts and parent-delivery acknowledgements use separate
no-replace publications, so a stale process cannot overwrite a completed result
after an earlier state check. A later durable terminal receipt can be read; without one, replay stays
outcome-unknown and does not overwrite the in-flight owner's record. Repositories
without this intent capability refuse cancellation. These recovery checks use
disposable stores and synthetic hosts, including an exclusive claim from two
independent Node processes; the default-off product is unchanged.

## Reproduce

Development requires one declared lane: Node `24.20.0` or `26.7.0`, with npm
`11.19.0`. The packaged app uses Electron's bundled runtime and requires none of
those tools from its launcher.

From the repository root:

```bash
npm ci
task dev
task ci
task test:e2e:dev
npm run test:e2e:computer
task package
task test:e2e
npm run test:e2e:computer:package
```

The canonical owner command is:

```bash
task run
```

That command opens the packaged Preview. The exact Farol Dev onboarding command is:

```bash
task dev
```

It opens the ordinary product shell with zero synthetic tasks. The retained fixture
journey is explicit:

```bash
task run -- --demo
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
`task preview` is the separate development lane; it builds development bytes and
is not artifact evidence. See [`docs/owner-preview.md`](docs/owner-preview.md) for
controls and lifecycle.

The deterministic gate includes strict typecheck, architecture fixtures, policy and
integration coverage, Hunt selftest/proof/model, and a build-bound sanitized replay.
The development E2E lane runs those exact clean built files through Electron's
bundled runtime without modifying its signed vendor bundle; it writes evidence to
`_output/evidence/e2e-dev/`. The separately sealed package lane remains the artifact gate.
Packaging verifies the app identity, embedded source manifest, runtime closure,
the immutable nested Electron runtime and helper identities, contained symlinks,
type-bound tree digest, plist, fixed launcher and explicit unsigned status. The
tree digest is `farol.next.tree-digest/v2` (self-delimiting records, shared with
the promotion helper); a schema 4 manifest carries the ambiguous version 1 digest
and is refused as `PACKAGE_TREE_DIGEST_LEGACY` until the candidate is repackaged. E2E
launches those packaged bytes under a throwaway home and explicit user-data root,
checks the real UI and task views, rejects malformed and tampered artifacts, proves
default-deny task egress, makes a second launch wait across an intentionally delayed
primary startup, and exercises actual utility-process death.

Both E2E lanes follow the non-interference contract in `docs/testing.md`. One
native-visible interaction run is positioned before first show and shown without
taking focus. Fault and recovery runs stay hidden while their renderers continue
to paint for DOM and screenshot evidence. The default selector requires a
non-primary display. An explicitly authorized owner-away run may use
`--built-in-display-only --allow-primary-display` to keep every test-owned
window on the MacBook display, even when an external monitor is connected.
The required viewport never shrinks. Native focus is exercised only under a
separate current grant, and owned windows close immediately after their proof.
If native focus is not authorized for the current run, append
`-- --skip-native-focus`; the other evidence still runs, while the report remains
`BLOCKED` and names the mandatory focus rows as owner-authorized work rather than
silently skipping or passing them.

Launch the exact built development preview through the pinned Electron runtime:

```bash
npm run preview
```

Pass `-- --demo` only when deliberately exercising the development fixture.

After `task package`, use only the canonical command above. Running the executable
inside `_output/package` directly bypasses source, manifest, resource, and digest
verification and is unsupported.

The outer `.app` and its fixed launcher are explicitly unsigned. The launcher uses
an unmodified, digest-bound copy of the pinned vendor Electron bundle, so creating
this local artifact does not remove or add a code signature. This is local preview
evidence only: it is not notarized, published, installed-product,
independent-recipient, update/rollback, live-provider or release-readiness evidence.

## Evidence

- `_output/package/artifact.json` — exact source and packaged-tree identity;
- packaged `Contents/Resources/app/resource-manifest.json` — app, process, state,
  transport, receipt, and intentionally absent integration ownership;
- `_output/evidence/e2e-dev/` — exact development-build interaction evidence;
- `_output/evidence/e2e/` with its recorded PNG set — packaged interaction evidence;
- `_output/evidence/hunt/` — `path.json` with the semantic path, model/command-table
  version, controlled schedule, mutation proof and exact build identity, next to
  the raw Vitest report it summarizes.

Every lane keeps each run in its own immutable `attempts/<attemptId>/` directory:
`started.json` before any work, the run's own `report.json`/`path.json` and
screenshots, and `terminal.json` with the outcome, first failure, raw and
normalized cases and the SHA-256 of every byproduct. A later run records a dead
owner's unfinished attempt as `interrupted.json` and never deletes or rewrites an
earlier run. `latest.json` in the lane root is only a pointer to the newest
attempt.

The E2E reports also record the visible run's selected-display class, work area,
window bounds, initial focus state, and the scenarios proved while hidden. Native
Agent rows identify lineage, TaskGrant workspace enforcement, bounded same-child
rejoin, durable result delivery, and content-free persisted evidence separately.

These directories are ignored because they are reproducible local evidence, not
source inputs.

`sourceTreeDigest` is the SHA-256 of the canonical recursive Git tree listing for
the complete committed repository tree. Packaging also requires every project build input
to match its HEAD blob, rejects special index flags and tracked symlinks, records a
dependency-input ledger, and binds every built entry by SHA-256. The separate
`sourceDirty` flag reports tracked or untracked non-ignored worktree changes.
The portable `AGENTS.md` is tracked and contributes to this identity. `.DS_Store`,
build output, coverage and other explicitly ignored host noise do not change the
identity of the same clean commit.
