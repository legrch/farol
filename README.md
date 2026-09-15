# Farol Next Preview

Farol Next Preview is the isolated TypeScript/Electron vertical slice under
`vnext/`. It does not install, activate, register, update, or replace the legacy
Farol product. It also does not use the installed `codex-chatgpt-web` profile.

## What runs

- one Electron shell with two real `WebContentsView` task surfaces;
- one Electron utility process with an OS-allocated loopback HTTP/SSE endpoint and
  a per-run bearer;
- two independent scripted local-provider sessions;
- one bounded `fixture.inspect` Computer round-trip that returns to the exact
  owner/session/task/Turn/generation/call;
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
task next:package
task next:test:e2e
```

The deterministic gate includes strict typecheck, architecture fixtures, policy and
integration coverage, Hunt selftest/proof/model, and a build-bound sanitized replay.
Packaging verifies the app identity, embedded source manifest, runtime closure,
helper names and bundle IDs, type-bound tree digest, plist and ad-hoc signature. E2E
launches those packaged bytes under a throwaway home and explicit user-data root,
checks the real UI and task views, rejects malformed and tampered artifacts, proves
default-deny task egress, and exercises an actual utility-process death.

Launch the resulting local preview directly:

```bash
./vnext/dist/package/Farol\ Next\ Preview.app/Contents/MacOS/Farol\ Next\ Preview
```

This is an ad-hoc-signed, local-preview-only artifact. It is not notarized, published,
installed-product, independent-recipient, update/rollback, live-provider or release
readiness evidence.

## Evidence

- `dist/package/artifact.json` — exact source and packaged-tree identity;
- `artifacts/e2e/report.json` and its six PNGs — packaged interaction evidence;
- `artifacts/hunt/path.json` — semantic path, model/command-table version, controlled
  schedule, mutation proof and exact build identity.

These directories are ignored because they are reproducible local evidence, not
source inputs.
