# Development and standalone builds

The repository contains source, resources, tooling, and tests. Deterministic checks
do not require another Farol checkout, an installed app, browser login, or a live
provider. The current package target is macOS Apple Silicon.

Read [AGENTS.md](../AGENTS.md) before changing source. Develop in an isolated writer
when the primary checkout is occupied, preserve unrelated changes, and commit only
the paths you own.

## Toolchain

| Tool                  | Required version or role                                        |
| --------------------- | --------------------------------------------------------------- |
| Node                  | `24.20.0` or `26.7.0`                                           |
| npm                   | `11.19.0`                                                       |
| Go                    | `1.26.2`, as declared in [go.mod](../go.mod), for the Core gate |
| Go Task               | Runs [Taskfile.yml](../Taskfile.yml) entrypoints                |
| Gitleaks              | Source/history secret scan                                      |
| Apple developer tools | Reviewed Python/Git shims and native attestation inputs         |

Select the matching Node/npm installation on `PATH`. It must include its npm CLI
under `lib/node_modules/npm/bin/npm-cli.js`; an incomplete installation fails
provenance checks. Native helper tests depend on the reviewed Command Line Tools
chain. Do not rewrite digest contracts to admit another executable.

## Prepare a fresh clone or worktree

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/esbuild/install.js
node node_modules/electron/install.js
npm run check:toolchain
```

The two explicit setup scripts belong to locked dependencies. Runtime/compiler
hash checks remain enforced. Use worktree-local dependencies rather than borrowing a
mutable installation from another writer.

## Develop

```sh
task dev
```

This is the normal development entrypoint. It selects a supported toolchain,
checks/prepares locked dependencies, builds current files, and opens **Farol Dev**
in this terminal. Dirty changes are allowed and labelled Development. `Control+C`
stops only the processes it started. Dev has separate profile, browser partitions,
connector, and instance state from the installed product.

`task dev -- --acceptance-profile` selects a further isolated acceptance profile.
It is not an installed-product proof. Do not copy credentials or browser profiles
between environments.

For a lower-level development launch, first build, then launch:

```sh
npm run build
npm run preview
```

`task preview` currently delegates to `npm run preview`; it **does not rebuild**.
Use `task dev` for the ordinary build-and-run workflow. Explicit `--demo` creates
scripted fixture tasks and is not a live provider session.

## Verify changes

Run focused tests and formatting while editing. The complete source gate is:

```sh
task ci:fast
git diff --check
```

`ci:fast` includes toolchain checks, strict TypeScript compilation, lint, formatting,
architecture fixtures, full coverage, build-bound Hunt evidence, the Go Core gate,
output-layout checks, and source/history secret scanning. [Testing](testing.md)
describes the evidence boundaries and native lanes.

Hunt builds exact committed inputs and requires a clean tree. During development,
verify the coherent change with focused checks, inspect/stage its owned diff, and
commit a checkpoint before the final clean-tree gate. A checkpoint does not claim
that the complete gate passed. Required failures remain visible in the handoff.

`task test:core` checks generated-wire drift, Go imports, root Go race tests/vet,
any transitional nested Go module present, real process protocol tests, and strict
compilation of the desktop bridge. It is also included in `task ci`.

## Build and launch a candidate

From clean committed bytes:

```sh
task package
npm run verify:package
task run
```

`task package` is the only candidate-producing entrypoint. It starts from an empty
environment through the isolated owner guard, binds exact source/build/dependency
inputs, embeds the pinned Electron runtime, and verifies the final package.
`npm run package` deliberately refuses direct packaging.

`task run` verifies that candidate, copies it into a private launch snapshot, verifies
the final path, and launches only those bytes. It does not build or install.
See [candidate launch](owner-preview.md) and [installation](installation.md) for
promotion, fixed-slot receipts, and updates.

## Output layout

| Path                       | Contents                                                        |
| -------------------------- | --------------------------------------------------------------- |
| `_output/build/app/`       | Development bundles and build identity                          |
| `_output/package/`         | `Farol.app` and package attestation                             |
| `_output/coverage/`        | Vitest coverage                                                 |
| `_output/evidence/<lane>/` | Immutable attempts, reports, screenshots, and terminal receipts |
| `_output/logs/`            | Non-receipt logs                                                |
| `_output/tmp/`             | Repository scratch                                              |

`_output/` is ignored. Isolated test homes/profiles use OS temporary storage.
Historical `dist/`, `coverage/`, and `artifacts/` paths remain ignored for old local
bytes; current tooling writes new output under `_output/`.

## CI and local hooks

The [GitHub source workflow](../.github/workflows/standalone-ci.yml) is manual-only,
uses read-only repository permissions, and runs the exact dispatched SHA. It does
not publish a package or release. A workflow file is not evidence that a run passed.

Enable the existing local push gate in a new clone:

```sh
git config core.hooksPath .githooks
```

The scan covers local Git history and tracked/nonignored source, including new
files. Ignored dependencies and generated output are not source inputs. Packaging,
installation, live provider qualification, and release publication remain separate
steps.

---

[Documentation index](README.md) · [Project overview](../README.md)
