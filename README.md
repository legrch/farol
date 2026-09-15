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

The deterministic gate includes strict typecheck, architecture fixtures, policy and
integration coverage, Hunt selftest/proof/model, and a build-bound sanitized replay.
The development E2E lane runs those exact clean built files through Electron's
bundled runtime without modifying its signed vendor bundle; it writes evidence to
`artifacts/e2e-dev/`. The separately sealed package lane remains the artifact gate.
Packaging verifies the app identity, embedded source manifest, runtime closure,
helper names and bundle IDs, contained symlinks, type-bound tree digest, plist and
explicit unsigned status. E2E is the sealed lane intended to launch those packaged bytes under a throwaway home
and explicit user-data root, check the real UI and task views, reject malformed and
tampered artifacts, prove default-deny task egress, and exercise an actual
utility-process death.

Launch the exact built development preview through the pinned Electron runtime:

```bash
npm --prefix vnext run preview
```

The reconstructed `.app` is explicitly unsigned. On the current macOS host those
modified unsigned bundle bytes are terminated before the first window, so direct
package launch and the sealed E2E lane are not claimed until a separately authorized
local ad-hoc or release signature exists. Neither lane is notarized, published,
installed-product, independent-recipient, update/rollback, live-provider or release
readiness evidence.

## Evidence

- `dist/package/artifact.json` — exact source and packaged-tree identity;
- `artifacts/e2e-dev/report.json` — exact development-build interaction evidence;
- `artifacts/e2e/report.json` and its recorded PNG set — packaged interaction
  evidence;
- `artifacts/hunt/path.json` — semantic path, model/command-table version, controlled
  schedule, mutation proof and exact build identity.

These directories are ignored because they are reproducible local evidence, not
source inputs.

`sourceTreeDigest` is the SHA-256 of the canonical recursive Git tree listing for
the committed `vnext/` subtree. Packaging also requires every project build input
to match its HEAD blob, rejects special index flags and tracked symlinks, records a
dependency-input ledger, and binds every built entry by SHA-256. The separate
`sourceDirty` flag reports tracked or untracked non-ignored worktree changes.
Task-local instructions, `.DS_Store`, build output, coverage and other ignored host
noise therefore cannot change the identity of the same clean commit.
