# Develop Farol from source

This is the developer path. Downloading an app and establishing its trusted update baseline are separate [installation gates](../reference/install-readiness.md). Read [AGENTS.md](../../AGENTS.md) before changing this repository.

## Toolchain and ordinary Dev

The checkout contains the source, resources, tests and build tooling. Use macOS
ARM64, Node **24.20.0 or 26.7.0**, npm **11.19.0**, Go **1.26.2**, the `task` CLI
and Apple Command Line Tools. The complete source gate also requires `gitleaks`.
Build tooling verifies pinned compiler, SDK, dependency and native-helper bytes;
installing a similarly named toolchain does not satisfy those checks.

With the declared Node/npm pair on `PATH`, from the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/esbuild/install.js
node node_modules/electron/install.js
npm run check:toolchain
task dev
```

`task dev` uses the ordinary saved Farol Dev profile and requires the Go backend.
Place the separately approved local [Go input declaration](#declared-go-backend-inputs)
at `_output/go-build-inputs.json` (ignored by Git), or select an explicit absolute
file with `task dev -- --go-inputs=/absolute/path.json`. Missing, invalid or
unauthenticated inputs refuse the build; Dev does not silently start without Go.
The existing Go builder requires clean committed source. It verifies the SDK,
modules and source instead of downloading or trusting an arbitrary local `go`.
An ordinary `task dev` stops the previous Dev from this exact checkout/profile
before replacing dependencies or rebuilding shared outputs. It checks the private
run marker, executable, account, boot and precise native lifetime, allows 30 seconds
to stop, then forces that process once if necessary. Other profiles and installed
Farol are not stopped. A refused or uncertain lookup/signal blocks the build.
**Ctrl+C** stops what the launcher started and escalates automatically if it hangs.
Neither process disappearance nor forced stop means application work was drained:
retained UNKNOWN and interrupted-profile recovery guards still apply.
Dev is not a package candidate.
`task dev -- --check` validates and builds without launching or changing profiles;
`--fresh-review-profile` is a separate disposable review journey.

| Existing command        | Purpose                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `task test:unit`        | Unit/component selection across TypeScript, React and Go.                                                                      |
| `task test:integration` | Module, adapter, process and native tests, excluding the unit selection.                                                       |
| `task test:fast`        | Unit/component plus four explicitly selected browser-free integration files.                                                   |
| `task test:core`        | Generated wire/import checks, root and transitional nested Go race/vet checks, bridge tests and strict TypeScript compilation. |
| `task ci:fast`          | Complete deterministic source gate, including core, coverage, Hunt, output layout and secret scanning.                         |
| `task package`          | Build and verify a candidate from exact clean committed bytes.                                                                 |
| `task run`              | Verify the existing candidate against source and open its private launch snapshot.                                             |
| `task test:e2e`         | Separate packaged Electron checks with explicit display/focus requirements.                                                    |

The three scoped commands accept `-- --list` to show exact files, packages and
prerequisites without running tests. Their npm aliases use the same selector.
Selection follows reviewed behavior, including corrections to legacy folder names.
They require the declared Node and Go toolchains and installed dependencies; they
do not download tools or build a candidate. Full `task test` and `task qualify:live`
are still target contracts, not implemented aggregates. Existing `task test:e2e`
keeps its packaged Electron meaning. See the [testing policy](../../docs/testing.md).

The [repository checkpoint policy](../../AGENTS.md) permits targeted verification,
self-review and `git diff --check`, followed by an owned-only checkpoint commit.
Freeze a coherent integration candidate before `task ci:fast` and its risk-selected
independent review. Hunt requires clean committed source. A checkpoint preserves
work; it is not product acceptance. See [standalone build guidance](../../docs/standalone-build.md).

Hunt now uses the same Go-required `tooling/dev.mjs --check` producer and verifies
the source, input ledger, complete entry set and core artifact before recording
evidence. Consequently, `task ci:fast` also needs the separately approved inputs
at `_output/go-build-inputs.json`. The [tagged CI workflow](ci.md) provisions that declaration only after its
independent SDK approval is committed; a hosted run remains unqualified until
all native and package gates pass. Missing inputs refuse the build rather than emit core-less output.
Local checks, native acceptance and package acceptance remain separate evidence.

### Declared Go backend inputs

The existing candidate command accepts an explicit local input declaration:

```sh
task package -- --go-inputs="$HOME/farol-build/go-inputs.json"
```

This is a source-supported build entrypoint, **not a production-qualified recipe**.
It requires clean committed source and a separately prepared declaration. The
JSON file must have schema `farol-go-build-inputs/1` and these fields:

- `toolchain`: canonical absolute SDK `root`, independently approved full-SDK
  `treeSha256`, `version: "go1.26.2"`, `goos: "darwin"`, and `goarch: "arm64"`
  for the current desktop target. A freshly measured digest is not approval.
- `moduleInputs`: explicit entries for `golang.org/x/sys` `v0.35.0` and
  `golang.org/x/text` `v0.28.0`, each with `modulePath`, `version`, `zipPath`,
  `modPath`, `contentRoot` and optional `zipHashPath`. Supply canonical absolute
  local paths; authentication uses committed `go.sum` and fails on missing inputs.

See the [input parser](../../tooling/go-build-inputs.mjs) and
[backend builder](../../tooling/go-backend-build.mjs) for exact validation. The builder
embeds the backend declaration into the Electron host and emits build schema `4`;
packaging uses schema `7`. The low-level builder can still emit legacy schema `3`
without Go inputs, but the 0.2 candidate packager refuses that output before
package effects. The current desktop external Computer route requires the
backend and refuses its absence. For this integration line, supply the same
declared inputs to `task dev -- --go-inputs=<absolute-json-path>` or `task package`.
Both build paths still compile the separate Go archive helper; neither establishes
installed Go Computer acceptance.

`task package` remains the sole candidate producer. Its Go-enabled artifact needs
normal Electron/native/package qualification before use as an accepted product.
Direct execution inside `_output/package` is unsupported. Package creation,
installation, update/rollback and live provider qualification are separate steps.

[Development](README.md) · [Documentation](../README.md)
