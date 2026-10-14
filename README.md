# Farol

Farol connects ChatGPT to folders you choose on your Mac. Ask questions about a project, find information in local files, or make approved file changes while keeping control of folder access in a desktop app.

[Start here](docs/start/README.md) · [User guides](docs/guides/README.md) · [Current status](docs/reference/status.md) · [Development](docs/development/README.md)

## What is Farol?

Farol is a Mac app that gives a connected ChatGPT app access to selected local folders, called **workspaces**. Farol runs on your Mac; ChatGPT reaches it through a Secure MCP Tunnel that you configure for your ChatGPT workspace. You decide which folders are available and what access they allow.

You can use ChatGPT in your usual browser. Signing in to ChatGPT inside Farol is optional for this connection.

## What can I do with it?

- Let ChatGPT list, search and read files within approved workspaces.
- Permit guarded file changes for a workspace when you choose **Read & write**, with approval still required for changes.
- Review connection checks, folder access and operation results in Farol.
- Update an existing installation that already has a verified update baseline.

File access has installed beta evidence. The public [v0.2.3 release notes](https://github.com/legrch/farol/releases/tag/v0.2.3) describe packaged Shell/Git preparation fixes and native tests; they do not establish an accepted external Shell/Git journey. Tasks, Agent workflows, Git SSH and PDF/binary transfer are not advertised as shipped capabilities. See [capability status](docs/reference/status.md) and [File and Shell operations](docs/guides/file-and-shell.md).

## Supported Macs and beta limitations

Farol is an **unsigned, non-notarized beta for Apple Silicon Macs**. Intel Macs, Windows and Linux are not supported by the current package. A minimum macOS version and a clean-machine prerequisite matrix have not yet been qualified for public first installation.

You need a ChatGPT account and workspace that actually offer Developer mode and Tunnel connections. Availability depends on your account; a Farol download does not establish that access. Keep this Mac running and connected for local tools to be reachable. Hardware sleep and broad network recovery remain acceptance work.

## Download and installation status

The latest public release checked on **14 October 2026** is [v0.2.3](https://github.com/legrch/farol/releases/tag/v0.2.3). Its assets are an Apple Silicon ZIP, `farol-release.json` and `SHA256SUMS`. Newer installed builds or source candidates are separate from that public release.

**First installation from the ZIP, including adoption into the updater, is not yet a qualified supported workflow.** Download availability does not mean you can drag the app into Applications and obtain a working update baseline. Read [First installation](docs/start/installation.md) before proceeding. Developers can use the separate [source setup](docs/development/setup.md).

## Connect Farol to ChatGPT

Once you have an accepted running installation, open **Setup**. Review **Overview → Sign in → Connection → Workspaces → Check**. Create or select the tunnel for your intended ChatGPT workspace, save its restricted runtime key in Farol, and attach that tunnel as a ChatGPT app.

Follow [First connection](docs/start/first-connection.md) and [ChatGPT app connection](docs/guides/chatgpt-connection.md). A local connection is only one part of setup: the matching check from ChatGPT must also succeed. Moving through Setup does not grant access or repeat a check.

## Grant folder access safely

Use a small folder with non-sensitive sample files for your first trial. **Add workspace… currently saves Read & write access**, so review **Saved access** and change **Workspace access** to **Read-only** before asking ChatGPT to use a folder you only want it to read. File changes still require approval; command access is separate.

[Your first workspace](docs/start/first-workspace.md) walks through a read-only exercise. [Folder access](docs/guides/folder-access.md) explains changing and removing grants. Removing a workspace revokes access and keeps your files on disk.

## Updates and recovery

For an installation with an accepted update baseline, open **Check for Updates…** from Farol's menu. Review the version and release notes; **Install and Relaunch** restarts the app. See [Updating Farol](docs/guides/updates.md).

Closing a window leaves Farol running; **Command+Q** quits it. If a setup, edit or update result is **Outcome unknown**, the action may already have taken effect. Inspect the original result before another action. [Recovery](docs/guides/recovery.md) explains how to resume setup without erasing the evidence needed to recover safely.

## Privacy and security

Approving a folder allows requested data from that folder to be returned to ChatGPT. This is not an entirely offline workflow. Choose folders and access levels accordingly; Git history and command access can expose more than ordinary file reads.

The runtime key is stored in a private local file; the current implementation does not claim Keychain storage. Activity and the support export are designed to omit prompts, answers, file contents and credentials. The app remains unsigned and not notarized. Read [Privacy and security](docs/guides/privacy.md) for the boundaries and limits.

## Troubleshooting

Start with [Common connection failures](docs/guides/troubleshooting.md) for a missing helper, unavailable tunnel, incomplete attachment check or refused folder access. Use [Recovery](docs/guides/recovery.md) for an interrupted setup and [Safe uninstall](docs/guides/uninstall.md) to disconnect and remove the app.

<a id="develop-from-source"></a>
<a id="declared-go-backend-inputs"></a>

## Development and contributing

Use the [development guide](docs/development/README.md) for toolchains, declared Go inputs, checks, packaging and contributions. Source, package, installed and live-provider acceptance are separate gates. The Lead owns integration and release decisions.

<a id="source-architecture"></a>
<a id="status-and-scope"></a>
<a id="use-and-installation"></a>

Architecture, detailed acceptance narratives and the previous README remain in the [technical references](docs/reference/README.md). The [first-install checklist](docs/reference/install-readiness.md) tracks the product work required before a general installation guide can be published.
