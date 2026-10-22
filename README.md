# Farol

<img align="right" src="resources/brand/sunrise-dock/farol-sunrise.png" alt="Farol app icon" width="96">

**Connect ChatGPT to folders you choose on your Mac.**

Find information in local files, understand a project, or make approved edits. Choose what ChatGPT can access and manage those permissions in the Farol desktop app.

[Download](#download-and-installation) · [Get started](docs/start/README.md) · [User guides](docs/guides/README.md) · [Current status](docs/reference/status.md)

## What is Farol?

Farol is a Mac app that connects your chosen folders to ChatGPT. Each approved folder is a **workspace**. After Setup, you can use the connected ChatGPT app in your usual browser. The guided Setup flow requires signing in inside Farol for its connection test.

## What can I do with it?

- **Understand a project:** ask ChatGPT to read and explain files in an approved folder.
- **Find information:** list and search local files through the connected ChatGPT app.
- **Make approved changes:** enable guarded edits for the folders you choose.

Local Shell and ordinary Git, including enforced Python hooks, have also been verified through a qualified internal installation. Those results apply to that exact build and approved toolchain; check [current availability](docs/reference/status.md) before using commands. Tasks, Agent workflows, Git SSH and PDF transfer still require separate acceptance.

## Supported Macs

Farol is a beta for **Apple Silicon Macs**. The current app is **unsigned and not notarized**. You also need a ChatGPT workspace offering Developer mode and Tunnel connections.

The supported macOS versions and clean-machine prerequisites still need first-install acceptance. See [requirements and beta limitations](docs/start/installation.md#requirements-and-limits).

<a id="use-and-installation"></a>

## Download and installation

[**View the latest public release →**](https://github.com/legrch/farol/releases/latest)

Use the latest release page for the current download and its checksums. Public downloads and qualified internal installations can have different capabilities; see [current distribution status](docs/reference/status.md).

> **New installation:** downloading the ZIP is available, but first installation and setup for trusted updates are not yet a supported, tested end-to-end path. Read [First installation](docs/start/installation.md) before opening or copying the app. Existing users should keep their accepted installation and use its updater.

## Connect Farol to ChatGPT

With an accepted installation running:

1. Open **Setup → Start setup**. In **Sign in**, choose **Sign in** or **Open ChatGPT**, return and choose **Check sign-in**, then **Continue** after **✓ Sign-in checked**.
2. In **Workspaces**, use **+ Add workspace** and review its **Access**. Every listed workspace must show **✓ Works**; at least one is required to continue.
3. In **Connect this Mac**, choose **Open OpenAI Tunnels**, follow the tunnel/key instructions, enter **Tunnel ID** and **Key**, and choose **Connect** once. Wait for **✓ Connected**.
4. In **Add to ChatGPT**, choose **Open ChatGPT Apps** and attach the matching tunnel. Choose **Test in ChatGPT** once, then **Start using Farol** after **✓ Everything works**.

**Back** reviews an earlier step without repeating an action. If an action is pending or unknown, observe its original result through [Recovery](docs/guides/recovery.md) before another change.

[Follow the connection guide →](docs/start/first-connection.md) · [Try a sample folder →](docs/start/first-workspace.md)

## Choose folder access

Start with a small folder containing non-sensitive sample files. **+ Add workspace currently saves Read & write access.** For a read-only trial, choose **Read only** in the workspace row's **Access** control and wait for the confirmed save/check before asking ChatGPT to use it. File changes still require approval.

[Folder permissions](docs/guides/folder-access.md) explains checking, changing and removing access. Removing a workspace keeps your files on disk.

## Updates and recovery

Open **Farol.app** from its existing accepted installation location; see [installation paths](docs/start/installation.md#installation-paths-and-adoption). The nested **Electron Runtime.app** is an internal component, not a separate app to launch or keep in the Dock.

For an installation already set up for trusted updates, open **Settings → General**, review **Version**, and choose **Check for updates**, then **Install and Relaunch** when ready. Closing the window leaves Farol running; **Command+Q** quits it.

Follow [Updating Farol](docs/guides/updates.md) or [Recovery](docs/guides/recovery.md). For a recorded update, open **Settings → General → Update recovery…**. If an action has an unknown result, use **Find a page → Home** if Setup is open, then choose **Review unresolved actions** in the sidebar; it appears only while something is unresolved. Inspect the original result before another change. General also offers **Setup status**, **Open Setup**, **Install updates automatically** and **Save support file…**.

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

The [development guide](docs/development/README.md) covers source setup, checks and contributions. After `task package` builds a verified packaged candidate, `task run` opens its isolated launch snapshot; `task dev` is the separate development lane. [Technical references](docs/reference/README.md) and the [Go module indexes](docs/reference/modules/README.md) retain architecture, contracts and historical evidence. The [install-readiness checklist](docs/reference/install-readiness.md) tracks the work needed for a supported first installation.
