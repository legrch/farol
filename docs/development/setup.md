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

To keep ordinary Dev off your working display:

```sh
task dev -- --display=secondary
```

This selects the built-in secondary when an external monitor is primary. When
the built-in display is primary, it prefers a non-primary Sidecar/iPad display.
Otherwise it selects another non-primary display.
The window fits the selected work area in Electron DIP coordinates, is positioned
before its first show, and shows without activation. When no secondary display
is available, Dev opens on the primary automatically. Recovery and authentication
windows use the same fallback. `--allow-primary-display` remains accepted for old
commands but is no longer required. Plain `task dev` keeps its normal placement.
Do not combine ordinary and visible-test display options.

To start a clean first-run profile without changing the saved daily Dev profile:

```sh
task dev:clean
task dev:clean -- --display=secondary
```

For a reusable test profile, launch from the canonical checkout:

```sh
cd ~/code/farol
task dev:test
```

`task dev:test` uses the existing `--acceptance-profile` mode. Its fixed storage
is `~/Library/Application Support/Farol Dev Acceptance/Farol Dev`. It reuses that
profile on later launches, with the normal real ChatGPT session and no E2E
substitutions. Complete Google/OAuth/MFA yourself in this profile once; the
launcher never imports credentials or cookies from daily Dev or clean reviews.
Enter its test tunnel/key only in the application. Use a distinct Dev tunnel
when another runtime uses the existing tunnel.

Quit the current Dev normally before switching launch modes or rebuilding. The
launcher preserves interrupted-state and UNKNOWN admission checks; the test task
does not reset, repair or reopen a consumed clean-review profile. After a normal
Quit, run `task dev:test` again to inspect retained sign-in/settings. The ordinary
`task dev` still selects the daily profile. `task dev:clean` always creates an
empty first-run profile. All three tasks accept `-- --display=secondary` and
`-- --check` (the latter builds without launching or provisioning a profile).

For a headless File/Shell/MCP smoke test, run `task dev:test:tools` after quitting
Dev normally. It builds the exact Dev image through the same guards, then runs
the existing native Go/MCP witness with source/build pins and disposable state.
It does not open Electron, use either saved profile, copy authentication, connect
a live tunnel, or send to ChatGPT. No second tunnel is required. Its File/Shell
results do not prove browser, live attachment, login, or installed behavior.
Use `task e2e:setup -- --repeat-after-finish` for the separate hidden Electron
fixture of a new connection test after Finish; its provider/tunnel are synthetic.

Each `task dev:clean` launch creates a new isolated profile. It keeps the same Dev
build and launch behavior, and accepts the ordinary `--display=secondary`
placement option. The lower-level `--fresh-review-profile` flag remains available
on `task dev` for cases that need to choose the profile explicitly.

`task dev` uses the ordinary saved Farol Dev profile and requires the Go backend.
Place the separately approved local [Go input declaration](#declared-go-backend-inputs)
at `_output/go-build-inputs.json` (ignored by Git), or select an explicit absolute
file with `task dev -- --go-inputs=/absolute/path.json`. Missing, invalid or
unauthenticated inputs refuse the build; Dev does not silently start without Go.
The existing Go builder requires clean committed source. It verifies the SDK,
modules and source instead of downloading or trusting an arbitrary local `go`.
An ordinary `task dev` or `task dev:test` first checks its exact selected profile,
private run marker, account, boot and native process lifetime. When the same
profile is running from the current sealed Dev image, it opens that window
through the acknowledged singleton without installing dependencies, rebuilding
or stopping the original process. The secondary-only opener exits if that
process disappears; it cannot start a replacement primary. A different profile,
changed source/image or uncertain identity blocks shared writes and asks for a
normal Quit. No tunnel selection or profile settings are changed by reopening.
The physical profile in argv must match the native process and selected storage;
process titles alone are insufficient. Legacy low-level process cleanup remains
separate from this normal launch path.
**Ctrl+C** stops what the launcher started and escalates automatically if it hangs.
Neither process disappearance nor forced stop means application work was drained:
retained UNKNOWN and interrupted-profile recovery guards still apply.
Dev is not a package candidate.

Ordinary Dev includes the Go Shell route. Electron itself and the actual main,
MCP, preload and renderer resources execute inside the same protected Dev image.
For the canonical Dev launcher, `_output/build/app` is build input only.
The launcher prepares a fixed
`_output/dev-core/Contents/Resources/app` resource tree and an unmodified pinned
vendor runtime beside it. The running desktop retains its separate Dev display
bundle and profile. The Go host applies the same resource, runtime, protected-root
and Shell support checks used for a package; workspace scope, Commands and task
grants still apply to every command. Unexpected changes to the prepared tree
refuse launch rather than being repaired or disabling Shell. A replacement first
atomically retires the previous complete image, publishes and verifies the new
one, and only then discards the retired image: it is renamed into a private
`_output/.dev-core-trash-*` wrapper on the same volume, re-identified by inode
(a substituted tree is moved back and refused) and removed, links as links. No
retired image is kept. One `task dev` per checkout holds
`_output/.dev-lifecycle.lock` (a kernel flock) from the process proof until the
new Dev is spawned; a second one fails with `DEV_LIFECYCLE_BUSY`. Under that lock
and after the proof, leftovers of an interrupted transition are reaped once the
current image is settled. This protects against crashes and cooperating agents,
not against another process of the same account. The temporary Go stop helper
and compiler output are removed by their creators; see
[output retention](output-retention.md). Workspace File writes and edits
also exclude the actual backend image by kernel directory identity, independently
of Commands. Legacy raw preview launches keep File tools but cannot qualify Shell
against a separate image; `npm run preview:development` uses the canonical Dev
launcher. No package install, credential import or profile reset is involved.

`task dev -- --check` validates and builds without launching or changing profiles;
`--fresh-review-profile` opens a new, retained disposable first-run Dev profile
with ordinary window sizing. Combine it with `--display=secondary` for the
owner-away display selected above;
it fits the work area rather than requiring the fixed visible-test viewport.
It never reuses the daily profile or enables E2E substitutions. Each invocation
mints a new profile; the launcher does not retry or reopen a previous review.

Dev launches an authenticated Electron copy at
`_output/dev-core/Contents/Frameworks/Farol Dev.app`. Only this copy gets the `Farol Dev` bundle
name, `local.farol.dev` bundle identifier and existing sunrise Dev icon for Dock,
Cmd-Tab and the app menu. The desktop retains its explicit Dev paths, partitions,
`app.setName`, About panel and `Farol Dev · Development` window title.
The locked npm Electron bytes, packaged Farol and Owner Preview are unchanged.
After its Dev edits, the copy is ad-hoc signed with `/usr/bin/codesign --force
--deep --sign - --timestamp=none`, then checked with `--verify --deep --strict`
and inspected for the signed identifier `local.farol.dev`. Signing, verification
or identifier failures refuse to launch. The copy is reused only while its input
and output tree digests match; its signature and identifier are checked again
before each launch. Changed vendor bytes or Dev resources require a new copy
after a successful build, only after the launcher confirms that processes sharing
the checkout's outputs are absent. This signing is confined to the Dev copy.

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
- `moduleInputs`: explicit entries for `github.com/google/go-cmp` `v0.6.0`,
  `github.com/m-mizutani/gt` `v0.1.0`, `github.com/m-mizutani/masq` `v0.2.3`,
  `golang.org/x/sys` `v0.35.0`, and `golang.org/x/text` `v0.28.0`, each with `modulePath`, `version`, `zipPath`,
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
