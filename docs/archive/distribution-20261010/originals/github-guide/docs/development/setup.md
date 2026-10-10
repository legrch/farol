# Set up a development worktree

Prepare the locked dependencies and open Farol Dev from the files you are editing.
The supported package target is macOS Apple Silicon.

## Toolchain

| Tool                  | Required version or role                                        |
| --------------------- | --------------------------------------------------------------- |
| Node                  | `24.20.0` or `26.7.0`                                           |
| npm                   | `11.19.0`                                                       |
| Go                    | `1.26.2`, declared in [go.mod](../../go.mod), for the Core gate |
| Go Task               | Runs [Taskfile.yml](../../Taskfile.yml) entrypoints             |
| Gitleaks              | Source/history secret scanning                                  |
| Apple developer tools | Reviewed Python/Git shims and native attestation inputs         |

Select the matching Node/npm installation on `PATH`. It must include its npm CLI
under `lib/node_modules/npm/bin/npm-cli.js`. Runtime/compiler hashes and reviewed
native-tool contracts remain enforced; version text alone does not admit other bytes.
See [dependency provenance](dependencies.md) for the exact ownership.

## Prepare the worktree

Read [AGENTS.md](../../AGENTS.md), select the accepted source base, and use an
available isolated writer. Keep dependencies local to that worktree.

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/esbuild/install.js
node node_modules/electron/install.js
npm run check:toolchain
```

The two explicit setup scripts belong to locked dependencies. Do not rewrite digest
contracts to admit a mismatched executable.

**Check:** the toolchain check names a supported Node/npm pair. Dependency preparation
alone is not compiler, package, or native-host acceptance.

## Run Farol Dev

```sh
task dev
```

The command selects a supported toolchain, checks/prepares locked dependencies,
builds the working tree, and opens **Farol Dev** in this terminal. Dirty changes are
allowed and labelled Development. `Control+C` stops only the processes it started.

**Check:** the app identifies its development build. Its profile, browser partitions,
connector, and instance state are separate from the installed product. See
[profiles](../reference/profiles.md) for their exact identities.

`task dev -- --acceptance-profile` selects a further isolated acceptance profile.
It does not prove installed-product behavior.

## Lower-level launch

Build before launching when using the lower-level entrypoints:

```sh
npm run build
npm run preview
```

`task preview` delegates to `npm run preview` and does not rebuild. Explicit `--demo`
creates scripted tasks and is not live provider evidence.

## Output layout

| Path                       | Contents                                                        |
| -------------------------- | --------------------------------------------------------------- |
| `_output/build/app/`       | Development bundles and build identity                          |
| `_output/package/`         | `Farol.app` and package attestation                             |
| `_output/coverage/`        | Vitest coverage                                                 |
| `_output/evidence/<lane>/` | Immutable attempts, reports, screenshots, and terminal receipts |
| `_output/logs/`            | Non-receipt logs                                                |
| `_output/tmp/`             | Repository scratch                                              |

`_output/` is ignored. Test homes/profiles use OS temporary storage. Historical
`dist/`, `coverage/`, and `artifacts/` remain ignored for old local bytes.

## Next

[Make a scoped change](contributing.md), then follow [testing](testing.md).
For clean committed candidates, use [packaging](packaging.md).

---

[Development](README.md) · [Documentation](../README.md)
