# Farol

<img align="right" src="resources/brand/sunrise-dock/farol-sunrise.png" alt="Farol app icon" width="96">

**Connect ChatGPT to folders you choose on your Mac.**

Find information in local files, understand a project, or make approved edits. Choose what ChatGPT can access and manage those permissions in the Farol desktop app.

[Download](#download-and-installation) · [Get started](docs/start/README.md) · [User guides](docs/guides/README.md) · [Current status](docs/reference/status.md)

## What is Farol?

Farol is a Mac app that connects your chosen folders to ChatGPT. Each approved folder is a **workspace**. You can use ChatGPT in your usual browser; signing in inside Farol is optional.

## What can I do with it?

- **Understand a project:** ask ChatGPT to read and explain files in an approved folder.
- **Find information:** list and search local files through the connected ChatGPT app.
- **Make approved changes:** enable guarded edits for the folders you choose.

File access is the current user journey. Shell/Git, Tasks, Agent workflows and PDF transfer have separate [availability and acceptance limits](docs/reference/status.md).

## Supported Macs

Farol is a beta for **Apple Silicon Macs**. The current app is **unsigned and not notarized**. You also need a ChatGPT workspace offering Developer mode and Tunnel connections.

The supported macOS versions and clean-machine prerequisites still need first-install acceptance. See [requirements and beta limitations](docs/start/installation.md#requirements-and-limits).

<a id="use-and-installation"></a>

## Download and installation

[**View the latest public release →**](https://github.com/legrch/farol/releases/latest)

The latest public release checked on **14 October 2026** is [v0.2.3](https://github.com/legrch/farol/releases/tag/v0.2.3), with an Apple Silicon ZIP and checksums.

> **New installation:** downloading the ZIP is available, but first installation and setup for trusted updates are not yet a supported, tested end-to-end path. Read [First installation](docs/start/installation.md) before opening or copying the app. Existing users should keep their accepted installation and use its updater.

## Connect Farol to ChatGPT

With an accepted installation running:

1. Open **Setup → Connection**. Follow the guide to create or select a tunnel for your ChatGPT workspace and save its restricted runtime key in Farol.
2. Add or select the ChatGPT app attached to that tunnel. Choose a folder in **Workspaces** if you want file access.
3. Complete **Check** to confirm that ChatGPT can reach this Mac.

[Follow the connection guide →](docs/start/first-connection.md) · [Try a sample folder →](docs/start/first-workspace.md)

## Choose folder access

Start with a small folder containing non-sensitive sample files. **Add workspace… currently saves Read & write access.** For a read-only trial, change **Workspace access** to **Read-only** and save before asking ChatGPT to use it. File changes still require approval.

[Folder permissions](docs/guides/folder-access.md) explains checking, changing and removing access. Removing a workspace keeps your files on disk.

## Updates and recovery

For an installation already set up for trusted updates, choose **Check for Updates…** from Farol's menu, then **Install and Relaunch** when ready. Closing the window leaves Farol running; **Command+Q** quits it.

Follow [Updating Farol](docs/guides/updates.md) or [Recovery](docs/guides/recovery.md). If an action has an unknown result, inspect that result before repeating it.

## Privacy and security

Requested files and tool results are returned to ChatGPT, so approve only the folders you intend to share. Read and write access are explicit, and command access is separate. Keep the runtime key private.

Read [Privacy and security](docs/guides/privacy.md) for local storage, diagnostics and the unsigned-beta limits.

## Need help?

Use [Connection troubleshooting](docs/guides/troubleshooting.md) for helper, tunnel or folder errors; [Recovery](docs/guides/recovery.md) for interrupted setup; and [Safe uninstall](docs/guides/uninstall.md) to disconnect and remove the app.

<a id="develop-from-source"></a>
<a id="declared-go-backend-inputs"></a>
<a id="source-architecture"></a>
<a id="status-and-scope"></a>

## Development and contributing

The [development guide](docs/development/README.md) covers source setup, checks and contributions. After `task package` builds a verified packaged candidate, `task run` opens its isolated launch snapshot; `task dev` is the separate development lane. [Technical references](docs/reference/README.md) retain architecture and historical evidence. The [install-readiness checklist](docs/reference/install-readiness.md) tracks the work needed for a supported first installation.
