<a name="farol-preview"></a>

# Farol

Give ChatGPT a controlled connection to local projects on your Mac.

Farol is a macOS desktop companion that connects ChatGPT to folders you approve
through a Computer MCP bridge. Read and search files, explicitly approve edits or
sandboxed commands, and manage the connection from Browser, Computer, Activity,
and Settings views.

**[Get started](docs/start/README.md)** · **[Download](docs/start/installation.md)** ·
**[Develop Farol](docs/development/README.md)** · **[Documentation](docs/README.md)**

> [!IMPORTANT]
> Farol is an **unsigned, unnotarized owner beta for macOS Apple Silicon**. The
> published app still uses TypeScript/Electron. Go and React are an incremental
> migration, and full live workflow qualification remains incomplete. Read
> [current status](docs/reference/status.md) before choosing an experimental route.

## Work with the folders you choose

- **Connect your ChatGPT workspace.** Configure its tunnel/app and verify the exact
  connection. Embedded Browser sign-in is optional for Computer access.
- **Start read-only.** Read files, search text, and load applicable workspace
  instructions within your approved scope.
- **Approve broader work explicitly.** Guarded file edits, fixed Git checks,
  sandboxed shell commands, and full Git access have separate requirements.
- **Keep uncertainty visible.** Activity and operation evidence distinguish
  completion, refusal, and unknown outcomes. Unknown work is not blindly repeated.

Model and Product Agent are disabled. Native Codex tasks, automated saved chats,
and Claude handoff have additional gated or fixture-only boundaries described in
[the capability matrix](docs/reference/status.md#capability-boundaries).

## Your first session

1. [Download and open the beta](docs/start/installation.md).
2. [Connect ChatGPT and check the attachment](docs/start/first-connection.md).
3. [Read a known file in your first workspace](docs/start/first-workspace.md).

The documented release is
[0.1.8-owner.beta.1](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1),
published on 2 October 2026. Downloads and update assets live in the separate
[Farol releases repository](https://github.com/legrch/farol-releases/releases).
The installation guide explains checksums, helper requirements, and the current
updater-baseline limitation.

<a name="dev-names-and-profile-compatibility"></a>

<a name="reproduce"></a>

## Run from source

On macOS Apple Silicon, provide Go Task, Node **24.20.0 or 26.7.0**, and npm
**11.19.0**, then:

```sh
git clone https://github.com/legrch/farol.git
cd farol
task dev
```

`task dev` selects the supported toolchain, prepares locked dependencies, builds
the working tree, and opens **Farol Dev** with its own profile and connector.
Dirty source is labelled Development. `Control+C` stops the processes it started.

Follow [development setup](docs/development/setup.md) and
[testing](docs/development/testing.md) for the additional Go/native tools and full
source gate. Build a verified packaged candidate with `task package`, then open it
with `task run` from an isolated launch snapshot. See
[packaging](docs/development/packaging.md) for that exact-byte workflow.

<a name="what-runs"></a>

<a name="evidence"></a>

## Explore the documentation

| I want to…                                           | Start here                                  |
| ---------------------------------------------------- | ------------------------------------------- |
| Learn Farol through one complete session             | [Start](docs/start/README.md)               |
| Change access, update, or resolve a problem          | [Practical guides](docs/guides/README.md)   |
| Build, test, or contribute                           | [Development](docs/development/README.md)   |
| Understand processes, permissions, and migration     | [Architecture](docs/architecture/README.md) |
| Look up a setting, shortcut, capability, or contract | [Reference](docs/reference/README.md)       |
| Maintain an older preview installation               | [Maintenance](docs/maintenance/README.md)   |

The running desktop has a TypeScript UI, native browser views, an Electron utility
runtime, and Python helpers. The accepted target is React/TypeScript UI,
TypeScript desktop/browser adapters, and Go backend modules. The
[architecture path](docs/architecture/README.md) explains both without treating a
planned component as an enabled route.

The [documentation index](docs/README.md) shows the complete repository structure
and reader paths. Every section is ordinary GitHub Markdown with its own README.
