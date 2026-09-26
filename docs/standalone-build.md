# Standalone build and verification

The repository is self-contained. It does not require a sibling V0 checkout,
private Brain files, an installed Farol, a signed-in browser, or a live provider
to run its deterministic checks. The supported package target remains macOS
ARM64; the source split does not introduce a new runtime or state identity.

Use Node 24.20.0 or 26.7.0 with npm 11.19.0. The Node installation must contain its
matching npm CLI under `lib/node_modules/npm/bin/npm-cli.js`; the dependency
provenance test refuses an incomplete toolchain installation. Select that
installation on PATH before installing or checking dependencies.

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/esbuild/install.js
node node_modules/electron/install.js
npm run check:toolchain
task ci:fast
```

The two explicit setup scripts belong to the locked compiler and Electron
packages. Compiler and embedded-runtime digests remain enforced. Do not replace
the reviewed digest files to make a mismatched local install pass.

`task ci:fast` runs typecheck, lint, formatting, architecture, the complete
coverage suite, Hunt and source/history secret scanning. Hunt builds the product
and requires a clean committed tree. During implementation, run the targeted
tests and coverage first, inspect the complete diff, and make a coherent checkpoint
commit before the final clean-tree gate. A checkpoint is not final acceptance.

```sh
task package
npm run verify:package
```

Packaging starts with an empty environment and isolated Python guard. Its fixed
system/Homebrew PATH must resolve a declared Node version. It accepts only exact
committed inputs, authenticated compiler/dependencies, the reviewed Electron
runtime, and matching resource/receipt contracts. The artifact is a local
unsigned `dist/package/Farol Next Preview.app`; creating it does not install or
activate anything. `task run` is a separate owner action.

The owner guard preserves the frozen V0 installation boundary using standalone
path declarations. Tests use disposable homes. Its synthetic mutation tests
prove detection and declared-churn exceptions; the guard is not a write sandbox.
The tunnel-client version and digests required by tests are frozen separately in
`tooling/external-dependencies.json`, without importing the V0 runtime registry.

Native packaged checks remain separate:

```sh
task test:e2e -- --skip-native-focus
npm run test:e2e:computer:package
```

The first command requires an eligible secondary display. For an explicitly
owner-authorized unattended run only, `--allow-primary-display` permits inactive
presentation on the built-in primary display; retain `--skip-native-focus`.
Skipped focus rows are not native focus acceptance. Native fixtures are not
live-provider or daily-driver acceptance. Keep each run's report and cleanup
result, including failures and blocked rows.

The GitHub workflow is manual-only, has `contents: read`, retains complete history,
and does not persist checkout credentials or publish artifacts. It uses the
[documented macOS ARM64 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Its hosted execution remains unqualified until the owner creates the destination
repository and explicitly runs it. Enabling automatic CI or releases is a separate
cutover decision.

Enable the local push gate in each new clone with:

```sh
git config core.hooksPath .githooks
```

The gate scans all local Git history and all tracked/nonignored source files,
including untracked additions. Ignored generated dependency/cache/output trees
are not source. Public visibility still requires separate image, history,
privacy, and license review; a clean secret scan is not that clearance.
