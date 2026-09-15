# Farol Next Preview

Farol Next Preview is the isolated TypeScript/Electron vertical slice under
`vnext/`. It does not install, activate, register, update, or replace the legacy
Farol product. It also does not use the installed `codex-chatgpt-web` profile.

## What runs

- one Electron shell with two real `WebContentsView` task surfaces;
- one Electron utility process with an OS-allocated loopback HTTP/SSE endpoint,
  task-scoped read capabilities and a separate main-process control capability;
- two independent scripted local-provider sessions;
- one bounded `fixture.inspect` Computer round-trip that returns to the exact
  owner/session/task/Turn/generation/call;
- one mandatory five-step first-run Setup journey, available again from Settings,
  which reports every preview-only or unavailable integration explicitly;
- content-free Activity and explicit provider/runtime failure states.

The provider and Computer executor are labelled local fixtures. Native filesystem
access, a live provider, MCP/host registration and native Agent creation are not
implemented or claimed. Agent app/domain one-child semantics are covered with an
in-memory host double, not a native child.

## Reproduce

Development requires one declared lane: Node `24.20.0` or `26.7.0`, with npm
`11.19.0`. The packaged app uses Electron's bundled runtime and requires none of
those tools from its launcher.

From the repository root:

```bash
npm ci --prefix vnext
task next:ci
task next:test:e2e:dev
task next:package
task next:test:e2e
```

The canonical owner command is:

```bash
task next:run
```

It launches only the existing verified packaged candidate. It never builds, installs,
updates, or activates either product, and it refuses a missing, dirty, stale, or
digest-invalid package with the exact rebuild action. `task next:preview` is the
separate development lane; it builds development bytes and is not artifact evidence.
See [`docs/owner-preview.md`](docs/owner-preview.md) for controls and lifecycle.

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
default-deny task egress, and exercises actual utility-process death.

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

After `task next:package`, the canonical command above verifies source identity and the
bundle digest before launching this exact executable from the repository root:

```bash
./vnext/dist/package/Farol\ Next\ Preview.app/Contents/MacOS/Farol\ Next\ Preview
```

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
window bounds, initial focus state, and the scenarios proved while hidden.

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
