# On-demand Owner Preview

Status: unaccepted source preparation. The derivative assembler, verifier and
smoke harness are implemented; no packaged, native, installed, live-provider or
beta acceptance is established by the pure tests. The assembled source admits
only the fixed `owner-preview` runtime identity with private child homes and
explicit installed-updater exclusion. Actual packaged/native behavior remains
unqualified. Keep the Mac package/native/GUI lane with the integration Lead.

## Owner commands and caller migration

```sh
task preview             # build canonical package, derive, smoke, then run
task preview:build       # build and smoke, without opening the owner profile
task preview:run         # verify and smoke the current generation, then run
task preview:plan        # bounded read of current main; no build or app launch
```

No SHA argument is required. Each command derives HEAD, local `main` and tracking
`origin/main`. It rejects dirty, unmerged or divergent local source, verifies the
single existing `legrch/farol` origin URL, and makes exactly one bounded
`git ls-remote origin refs/heads/main` read. All four commits must agree. An
optional `--expected-main <full SHA>` adds an assertion. There is no checkout,
pull, reset, remote change, publication, dependency install or pin refresh.
A fresh remote read proves the observed main identity, not acceptance of an
unmerged checkpoint. Source and local refs are checked again before publication
of the local pointer and before owner launch.

`npm run preview:owner`, `preview:plan`, `preview:build` and `preview:run` route to
the same helper. Prefer Task's clean-environment, owner-guarded entrypoints. The
existing `npm run preview` deliberately retains its development-only meaning,
so its active callers and [testing guidance](../testing.md) stay valid. An
explicit `npm run preview:development` alias preserves that same command, and
`task preview:development` retains the already admitted `npm run preview` command
beneath the owner guard. Both still launch existing
development build bytes without rebuilding. Frozen historical examples remain
historical. `task run` retains its canonical candidate contract.

Build/run first require actual `desktopEnvironment("owner-preview")` admission,
the exported fixed identity, matching `desktopIdentity`, and private Codex,
config and process-home functions. A declaration or caller boolean cannot enable
Preview. The canonical builder still requires physical authenticated compiler
and dependency paths. A focused-test `node_modules` symlink does not qualify.

## Canonical base and derivative recipe

The only base producer is unchanged `task package`, with the original approved
offline `_output/go-build-inputs.json` passed through `--go-inputs`. Missing or
changed inputs fail; the helper neither invents approvals nor downloads inputs.
Canonical verification runs through unchanged `verify-package.mjs --artifact
<snapshot manifest> --app <snapshot Farol.app>`, using the supported frozen-input
semantics also used by the canonical launch snapshot. The original manifest,
including its strict canonical `artifactPath`, remains byte-for-byte unchanged.
The base application is never launched.

Each retained generation contains:

```text
_output/preview/generations/<64hex>/
  .canonical/                  # private 0700, never an owner launch target
    artifact.json              # original canonical manifest, 0600
    Farol.app/                 # unmodified, authenticated canonical snapshot
  derivative.json              # derivative manifest, 0600
  Farol Preview.app/           # only this app can become current
```

`farol-owner-preview/1` records original source commit/tree, SHA-256 of the exact
base manifest, base app digest, base build ID, fixed Preview identity, exact
`farol-owner-preview-recipe/1`, tree-digest version and full derivative app tree
digest. The generation directory is SHA-256 of the deterministic derivative
manifest serialization. It is never reused or overwritten. Partial assembly
stays under `_output/preview/failed/<64hex>`; completed but failed-smoke
generations stay in `generations`. All previous and failed outputs are retained.
No automatic pruning, installed-app closure or effect settlement is part of
these commands. The foreground canonical package command has no automatic timeout;
an unknown package subprocess outcome retains its writer lock for Lead
reconciliation. A source-equivalent single-instance reopen does not identify the
running immutable generation. The command reports that outcome as
`OWNER_PREVIEW_RUNNING_GENERATION_UNCONFIRMED` without naming the requested
generation as running; quit the existing Preview normally before launching the
intended generation.

The recipe permits precisely these differences from the canonical snapshot:

- Outer `Contents/Info.plist`: only the string values of `CFBundleDisplayName`,
  `CFBundleName`, `CFBundleIdentifier` and `CFBundleIconFile`.
- Existing `Contents/MacOS/Farol Next Preview`: a fixed launcher that rejects
  arguments, starts with `env -i`, and sets the exact `owner-preview` marker.
  Its executable basename and mode stay unchanged.
- Added `Contents/Resources/farol-preview.icns`, and added
  `Contents/Resources/app/farol-preview-mark.svg` and `farol-preview-mark.png`,
  all mode 0644. Root selects the last filename for the Preview dock icon.

Every other file, directory, link target and mode must match. This includes
vendor Electron, Go resources, original production/Dev branding, embedded source
and build identity, original resource manifests and build entries. There is no
global Next/ID rename and no rewrite to impersonate a canonical package.

The verifier independently re-verifies the hidden base, renders expected Preview
assets from the SHA-pinned SVG using fixed local `rsvg-convert` and `iconutil`
build tools, reconstructs the allowed plist/launcher changes, and compares the
complete tree inventory. It then recomputes both tree digests and rechecks source.
Self-reported asset or output hashes alone cannot admit changed bytes. Native
raster/icon determinism and actual macOS tool availability are still NOT RUN;
asset reconstruction fails closed on unavailable or nonmatching output. The
fixed SVG extends the existing Farol mark with a clear PREVIEW badge. It does
not regenerate production or Dev assets or alter `BRAND_RESOURCES`.

After successful verification and smoke, `_output/preview/Farol Preview.app` is
atomically replaced as a relative symlink with the sole permitted target shape
`generations/<64hex>/Farol Preview.app`. A regular app, broken link, external link
or hidden-base target is refused. Run resolves and pins that exact generation,
re-verifies it immediately before execution, and launches its persistent bytes.
No OS temporary application snapshot is used.

## Packaged smoke and runtime integration seam

The build/run gate invokes
[`owner-preview-smoke.e2e.mjs`](../../tests/e2e/owner-preview-smoke.e2e.mjs).
It independently verifies the generation, creates a **new** disposable private
profile using the existing production E2E root marker/proof, and drives the
unchanged packaged Electron with the derivative's exact `Resources/app`. This
permits the existing private E2E proof without weakening the owner launcher's
clean environment or admitting arbitrary owner flags. It does not launch the
hidden canonical app. The fixed wrapper is verified byte-for-byte; execution
through that wrapper on the persistent owner profile remains on-demand.

The harness observes packaged source/build identity, display/app identity,
userData/sessionData/home, distinct Preview session storage, hidden/unfocused
windows, no configured connector/tunnel/credentials/tasks, and an unavailable
installed updater. It uses a loopback offline page and aborts/rejects other
browser requests. It stores the actual renderer appearance preference, requests
ordinary `app.quit()`, requires exit 0 and a fresh drained quit receipt, then
reopens the same disposable profile and verifies the saved preference is loaded
and presented. It checks only exact observed owned PIDs and the app's quit drain;
it never scans or kills unrelated processes. This is representative startup and
persistence evidence, not live-provider or general descendant qualification.

Startup admits only physical, owner-controlled app-data ancestors and a
physically separate Preview profile with owner-only access. It creates a missing
fixed profile leaf with mode 0700 before Electron selects storage; an existing
aliased, shared-readable or unsafe profile is refused without repair or migration.

Receipts under `_output/preview/smoke/<generation>/<attempt UUID>.json` bind exact
source, base/build, derivative and actual observations. They begin as UNKNOWN,
become PASS only after both clean cycles, re-verification and exact owned-process
absence, and have no caller PASS flag. All disposable profiles and receipts remain
retained, including successful attempts; no cleanup-to-checkpoint crash window can
erase unresolved profile evidence. Failures/UNKNOWN prevent further smoke of that
generation and require Lead
reconciliation. A known owned app may receive one normal Quit cleanup request;
a refused/unknown Quit is never retried or escalated by the harness. The pinned
Playwright Electron launcher can force-terminate its own disposable process group
if initialization fails before returning a handle. That dependency behavior is
not proof of a drained Quit: the attempt remains UNKNOWN with its profile and
receipt retained. No failed smoke publishes the current pointer or opens the
persistent owner profile.

The assembled runtime preserves the existing E2E proof and admits the
fixed environment/partitions in startup and renderer contracts, selects private
child homes/config and `farol-preview-mark.png`, and returns before installed
updater construction. Synthetic/acceptance/recovery seams remain Dev-only. The source runtime gate checks the parser/identity/home functions; actual
packaged behavior must still pass the smoke. The helper does not edit those
contracts, Go Recovery, the installed profile, a tunnel or an updater helper.

## Verification and remaining gates

Allowed source-only checks for this packet:

```sh
node --test tests/tooling/owner-preview.test.mjs tests/tooling/owner-preview-artifact.test.mjs
node --check tooling/owner-preview.mjs
node --check tooling/owner-preview-contract.mjs
node --check tooling/verify-owner-preview.mjs
node --check tooling/owner-preview-assets.mjs
node --check tests/e2e/owner-preview-smoke.e2e.mjs
npm run docs:check
git diff --check
```

The tree fixtures use synthetic app bytes and synthetic PNG/ICNS headers. They
prove allowlist/tamper detection only. They do not prove canonical authentication,
native rendering, packaged startup, profile isolation, provider access or a
usable Preview. Root owns native asset generation, integrated type/static checks,
full CI, canonical package, exact-artifact smoke, independent review, integration
and final acceptance. The first persistent owner run remains manual/on-demand.
Installation, activation, signing, release, beta readiness and production/profile
or tunnel access remain separate boundaries.
