# Farol

A macOS desktop companion for ChatGPT and the local workspaces you choose to share.

Farol connects ChatGPT to approved folders on your Mac through a Computer MCP
bridge. Read and search files, explicitly approve edits or sandboxed commands, and
manage the connection from a desktop app with Browser, Computer, Activity, and
Settings views.

**[Get Farol](docs/installation.md)** · **[First connection](docs/getting-started.md)** ·
**[Developer guide](docs/standalone-build.md)** · **[Documentation](docs/README.md)**

> [!IMPORTANT]
> Farol is an **owner beta for macOS Apple Silicon**. The published package is
> unsigned and not notarized. Live workflow qualification is incomplete. The Go
> backend and React UI are an incremental migration; the published beta still uses
> the TypeScript/Electron implementation. See [current status](docs/status.md).

## What you can use

- **ChatGPT and your folders.** Connect a separately configured ChatGPT app to
  Farol, select folders, and verify the connection. Embedded ChatGPT sign-in is
  optional for Computer access.
- **Controlled local work.** Start with read-only files and instructions. Enable
  guarded edits, fixed Git verification, or a sandboxed workspace shell explicitly.
  Shell networking is denied; full Git and user settings need separate approval.
- **A desktop workspace.** Keep conversations in tabs, review Computer access, and
  inspect content-free Activity and support diagnostics.
- **Explicit recovery.** Saved configuration and operation receipts distinguish a
  completed action, a refusal, and an unknown outcome. An uncertain send or command
  is never blindly repeated.

Native Codex task integration has additional host and workspace requirements.
Saved-chat automation and Claude handoff have experimental or fixture-only
boundaries. **The Farol model-provider route and Product Agent are disabled.**
These are described in the [capability status](docs/status.md), rather than offered
as ordinary setup steps.

## Get Farol

The documented release snapshot is
[0.1.8-owner.beta.1](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1),
published on 2 October 2026. Binary downloads live in the separate
[Farol releases repository](https://github.com/legrch/farol-releases/releases).

The [installation guide](docs/installation.md) covers downloads, checksums, the
current helper requirements, local installation receipts, and updates. Keep your
previous accepted version while evaluating the beta.

## Run from source

On macOS Apple Silicon, install [Go Task](https://taskfile.dev/), then provide Node
**24.20.0 or 26.7.0** with npm **11.19.0**. From a clone:

```sh
git clone https://github.com/legrch/farol.git
cd farol
task dev
```

`task dev` selects a supported toolchain, prepares locked dependencies, builds the
working tree, and opens **Farol Dev**. It has its own profile and connector; it can
run alongside an installed Farol. Dirty source is allowed and labelled Development.
Stop the processes it started with `Control+C`.

For deterministic checks, also provide Go **1.26.2**, Gitleaks, and the reviewed
Apple developer tools. Follow the [developer guide](docs/standalone-build.md) for
setup and `task ci:fast`. A clean packaged candidate uses `task package` followed
by `task run`; the [candidate guide](docs/owner-preview.md) explains that workflow.

## Architecture

The running desktop uses Electron, a sandboxed TypeScript UI, native browser
views, and an Electron utility process. Computer and update helpers currently
include Python. The accepted target is **React + TypeScript for Farol UI,
TypeScript for desktop/browser adapters, and Go for the backend**.

| Source                                     | Responsibility                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `src/`                                     | Active TypeScript UI, desktop/runtime adapters, and transitional modules        |
| `apps/desktop/bridge/`                     | Additive TypeScript client for the Go Core pipe protocol                        |
| `modules/computer/`, `boot/`, `cmd/farol/` | Go Computer foundation and backend composition; not the active desktop executor |
| `api/desktop/v1/`, `transport/desktop/`    | Canonical wire schema and Go transport                                          |
| `resources/`, `tooling/`, `tests/`         | Packaged resources, reproducible builds, and verification                       |

See [architecture](docs/architecture.md) for the current runtime, module boundaries,
and migration target, and [Desktop/Core](docs/desktop-core.md) for the Go checkpoint.

## Find your next step

| I want to…                              | Start here                                                             |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Install the beta and understand updates | [Installation and updates](docs/installation.md)                       |
| Connect ChatGPT and approve a folder    | [Getting started](docs/getting-started.md)                             |
| Understand file, shell, and Git access  | [Computer reference](docs/computer-parity.md)                          |
| Build, test, or contribute              | [Development](docs/standalone-build.md) and [testing](docs/testing.md) |
| Understand current and planned behavior | [Status](docs/status.md) and [architecture](docs/architecture.md)      |

All documentation stays in this repository. The [documentation index](docs/README.md)
links the detailed guides and contracts.
