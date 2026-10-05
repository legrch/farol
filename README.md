# Farol

Farol connects ChatGPT to folders you choose on your Mac. Its desktop browser,
Computer access controls and operation status keep workspace access explicit.
**Farol Dev** uses a separate profile and connection from the installed app.

[Using Farol](docs/owner-preview.md#setup-inside-the-app) ·
[Development](#develop-from-source) · [Architecture](#source-architecture) ·
[Documentation](docs/README.md)

## Status and scope

Farol is an **owner beta for macOS on Apple Silicon**. This page describes the current source
integration tree. Accepted `main`
is `8c09f4c7fd9fc82f23a30ad42e701d041189aeea`; integrating source does not
update the installed product.

| State                            | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published baseline               | [0.1.11-owner.beta.1](https://github.com/legrch/farol-releases/releases/tag/v0.1.11-owner.beta.1), build `13`, source `8c09f4c7fd9fc82f23a30ad42e701d041189aeea`. Publication and download are recorded in the 5 October access-hotfix handoff; installation remains a separate gate; the beta is unsigned and not notarized.                                                                                                                                                                                 |
| Accepted main                    | K0/K1 Go foundation plus the separately accepted access hotfix. It does not establish the shipping React/Go cutover.                                                                                                                                                                                                                                                                                                                                                                                          |
| Source checkpoint described here | Package `bef6d56` passed actual React edit → one Go native edit/retained journal → unacknowledged Quit → same-profile reopen → exact Observe → Go-owned delivery ACK. Independent file/journal checks found no second effect; provider Sends stayed zero. Go now owns Settings pending, offer and ACK policy. TypeScript retains typed configuration storage, legacy observation, root measurement and Git discovery. This unsigned `0.1.10-owner.beta.1`, build `12` candidate is not installed or released. |
| UI target                        | React + TypeScript shell is composed. Plain TypeScript retains Electron/browser mechanics. Native Home, Settings, Appearance and configured-profile reopening have been exercised.                                                                                                                                                                                                                                                                                                                            |

The Go cutover is incomplete. The `56ed3941` normal-entrypoint Dev candidate passed
a controlled React/Go two-turn Chat journey from the ordinary first-message form,
without a selected file or Computer grant, clean Quit, and a same-profile/build
restart. Home's Saved Chat answers view then discovered and read both original
results through the current Go owner. Useful output preceded completion; explicit
result ACK and Go settlement/release preceded Follow. The independent provider
counter remained at exactly two accepted Sends across both app lifetimes. Exact
repeated inspect/start commands returned retained results; a changed first prompt
was refused without another Send. Both children quit cleanly. This is synthetic native evidence, not live-provider,
installed, cross-build recovery or full cutover qualification. Earlier failed
profiles remain quarantined. See
the [controlled Chat witness](docs/desktop-core.md#controlled-normal-desktop-chat).

Separately, the owner reported installation of the access hotfix
`0.1.10-owner.beta.1`, build `12`, from source `569bd4d` on 4 October.
Its update completion/recovery remains unresolved; a running target does not prove
a completed update. That installed TypeScript runtime is separate from the local
React/Go candidate described here. See the exact scope and limitations of the
[packaged Go delivery witness](docs/desktop-core.md#go-owned-settings-delivery).

## Use and installation

The published TypeScript Computer route supports approved workspace instructions, guidance,
list/search/read and explicitly enabled guarded file changes. Workspace shell
and full Git/history require separate approval and verification. Shell network
access remains denied; full Git can expose older excluded content and approved
user Git settings. Activity and support export retain content-free diagnostics.
The Farol Model route and Product Agent remain disabled.

The current Go integration source selects the same backend through a private
socket for external MCP catalogue, bootstrap, list, read and connector verification.
Go owns the verification attempt and retained observation. Search, mutations,
shell and coding tasks are not yet exposed by this new external route. Explicit
legacy launch fixtures remain separate; a failed Go launch never falls back to
them. Normal Dev, external ChatGPT and package acceptance of this switch remain
open. See the [connector contract](modules/computer/connector.md).

The published beta includes a ZIP, release manifest and checksum file. **First
installation by an external recipient from that ZIP is not currently documented
and qualified as a supported end-to-end workflow.** The first-recipient install
and adoption mechanism remains product implementation work. A manual app copy
does not establish an accepted updater baseline.

The documented owner workflow is:

1. Prepare [source development](#develop-from-source). From accepted clean
   committed source, build a verified packaged candidate with `task package`.

   Then `task run` verifies it again and opens an isolated launch snapshot without
   installing it.

2. Follow [local promotion](docs/owner-preview.md#optional-local-promotion--owner-action-only):
   inspect `task promote`, then explicitly choose its documented apply action only
   when the destination and receipt are absent. This creates
   `$HOME/Applications/Farol.app` and its verified installation receipt. Preserve
   an occupied slot through the [closed cutover](docs/product-cutover.md).
3. Open **Farol** and use **Setup** to choose folders, configure the tunnel and
   select the exact connected ChatGPT app. Embedded sign-in is optional for
   Computer-only use. The embedded connection check sends one message only when
   selected; the external manual check is a separate option.

This owner workflow does not qualify external ZIP installation. An established
installed baseline uses **Check for Updates…** and the
[documented update lifecycle](docs/installed-update-runtime.md). Closing the window
leaves Farol running; **Command+Q** quits it. See the [user guide](docs/owner-preview.md)
for access controls and recovery. Unknown outcomes are not permission to retry.

## Develop from source

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

`task dev` builds current files, including uncommitted edits, and runs the isolated
Farol Dev profile. **Ctrl+C** stops what it started. It does not select the optional
Go backend recipe below or turn a development build into a package candidate.

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
keeps its packaged Electron meaning. See the [testing policy](docs/testing.md).

The [repository checkpoint policy](AGENTS.md) permits targeted verification,
self-review and `git diff --check`, followed by an owned-only checkpoint commit.
Freeze a coherent integration candidate before `task ci:fast` and its risk-selected
independent review. Hunt requires clean committed source. A checkpoint preserves
work; it is not product acceptance. See [standalone build guidance](docs/standalone-build.md).

### Optional declared Go backend build

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

See the [input parser](tooling/go-build-inputs.mjs) and
[backend builder](tooling/go-backend-build.mjs) for exact validation. The builder
embeds the backend declaration into the Electron host and emits build schema `4`;
packaging uses schema `7`. Without `--go-inputs`, the build retains the TypeScript
Computer selection and package schema `6`. Both paths still compile the separate
Go archive helper; neither establishes installed Go Computer acceptance.

`task package` remains the sole candidate producer. Its Go-enabled artifact needs
normal Electron/native/package qualification before use as an accepted product.
Direct execution inside `_output/package` is unsupported. Package creation,
installation, update/rollback and live provider qualification are separate steps.

## Source architecture

The Farol-owned shell is React + TypeScript. Electron and browser mechanics remain
plain TypeScript. The optional Go host is wired through trusted profile and artifact
checks:

```mermaid
flowchart LR
    UI[React / TypeScript shell] --> Host[Electron host]
    Host --> TS[Existing TypeScript routes]
    Host -. Go-enabled build .-> Bridge[Attested Desktop bridge]
    Bridge --> Core[Go boot and native runtime]
    Core --> Admission[Chat admission and lifecycle journal]
    Core --> Computer[Computer authority and workspace reads]
```

The external connector has its own bounded Go execution owner and uses the
existing Computer authority Store in the same backend. It requires no fabricated
Chat or coding-task membership. `chat.turn` separately supplies admission for
Chat-owned Computer work. The native Chat owner
also composes a typed browser exchange, bounded result retention and conversation
methods. Controlled-peer tests through the normal Go CLI cover useful streaming,
the first Home-to-conversation binding, same-conversation follow-up and a lost
acknowledgement without another Send.
The normal host composes the browser pump and physical adapter. The controlled
native witness above exercises their real DOM path and React delivery. Production
control translations and output profiles remain unqualified; ordinary production
Chat and the external model route are unavailable. A tool-output continuation does
not establish support for a new user turn through the Responses adapter.

The selected Task facade also maps create, observe, exact dispatch status/result,
same-thread continuation, exact-session resume and retained progress into the
common framed protocol. Controlled in-memory boundaries exercise the real Task
service, Codex transport and Claude Host/Computer service chain, including useful
output before terminal, historical results and lost-ACK no-repeat behavior.
The Claude execution lease is selected only after Task admission. `NativeRuntime`
does not yet register these Task routes: trusted selection, native qualification
and real Codex/Claude journeys remain separate acceptance work.

| Location                                                                                 | Ownership at this checkpoint                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`src/`](src/)                                                                           | React shell under `src/ui/renderer/`, Electron/browser adapters, transitional services and composition.                                                                                    |
| [`apps/desktop/`](apps/desktop/)                                                         | Attested Go host, authority publication and generated Go/TypeScript wire bridge.                                                                                                           |
| [`boot/`](boot/), [`cmd/farol/`](cmd/farol/), [`transport/desktop/`](transport/desktop/) | Go composition, entrypoint, native profile lifetime and framed protocol.                                                                                                                   |
| [`modules/computer/`](modules/computer/)                                                 | Authority, filesystem and process services. Native ingress selects catalogue/bootstrap/list/read; external verification uses the same Go owner. Other capabilities need their own cutover. |
| [`modules/chat/`](modules/chat/)                                                         | Turn, queue, admission, browser exchange and bounded retained results; controlled normal desktop Chat and authorized saved-answer reads across a clean same-build restart.                 |
| [`modules/task/`](modules/task/)                                                         | Coding-task lifecycle and provider adapters; shipping task-route qualification remains separate.                                                                                           |
| [`modules/release/`](modules/release/)                                                   | Update/recovery, journal and identity/adoption preparation; the existing updater is still active.                                                                                          |

Domain and application code use values and consumer-owned ports. Neighbors cross
published contracts through `infra/peer`; Go contracts map independent DTOs and
delegate to their own module. Root `boot/` composes Go and `src/boot/` composes the
remaining TypeScript. Core does not become a second authority or journal owner.
The exact local `c1d67c0` package passed the bounded normal-main startup/reopen
journey in [Desktop/Core evidence](docs/desktop-core.md#normal-startup-and-empty-profile-reopen-candidate).
Component and source checks alone do not establish packaged or installed behavior.

The [documentation index](docs/README.md) links module contracts, migration limits,
installation and verification. Unsigned distribution, remaining Python helpers,
first-recipient installation and normal Go product qualification remain open.
