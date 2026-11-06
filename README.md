# Farol

<img align="right" src="resources/brand/sunrise-dock/farol-sunrise.png" alt="Farol app icon" width="96">

**Connect ChatGPT to folders you choose on your Mac.**

Find information in local files, understand a project, and make requested edits within the access you grant. Choose the folders in Farol, then use the connected plugin in ChatGPT.

[What Farol does](docs/start/overview.md) · [Installation](#download-and-installation) · [Setup guide](docs/start/first-connection.md) · [Best practices](docs/guides/best-practices.md)

![ChatGPT requests a specific edit through an OpenAI Tunnel and Farol inside a selected Read & write workspace](docs/media/workflow/output/Farol-read-and-edit-light.gif)

[Static illustration](docs/media/workflow/output/Farol-read-and-edit-light.png) · [How it works](docs/start/overview.md) · [Step-by-step setup](docs/media/onboarding/walkthrough.md)

_Synthetic workflow illustration, not a screen recording or a live acceptance test. New workspaces start Read only; this edit example uses an explicit Read & write grant. Requested file contents and tool results can be returned to ChatGPT._

## What is Farol?

Farol is a Mac app that makes selected local folders available to ChatGPT. Each folder grant is a **workspace**. You can list, search and read its files; enable **Read & write** when you need guarded edits. **Commands** is a separate grant shared across approved workspaces.

<a id="privacy-and-security"></a>

Requested file contents and tool results can be returned to ChatGPT. Read-only access limits changes, not disclosure. Start with a small, non-sensitive folder.

<a id="what-can-i-do-with-it"></a>

[How it works and what it can do →](docs/start/overview.md) · [Privacy and security](docs/guides/privacy.md)

<a id="use-and-installation"></a>

<a id="supported-macs"></a>

## Download and installation

Farol is a beta for **Apple Silicon Macs**. The public download is **unsigned and not notarized**, and first installation with trusted updater setup is still being qualified. A downloaded ZIP or a successful launch does not establish a supported first-install path.

[**View public releases →**](https://github.com/legrch/farol/releases) · [Read installation requirements and limits](docs/start/installation.md)

If you already have an accepted working installation, keep it and use its updater. Do not replace it merely to follow this guide. ChatGPT workspace support for Developer mode and Tunnel connections is also required; account availability can vary.

## Connect Farol to ChatGPT

With an accepted installation running:

1. **Sign in** to your own ChatGPT account inside Farol and confirm the check.
2. **Workspaces:** add a sample folder, keep **Read only**, and wait for **✓ Works** on every listed workspace.
3. **Connect this Mac:** create or select the intended tunnel, use a **Restricted** key with **Tunnels Read + Use**, and choose **Connect** once.
4. **Add to ChatGPT:** attach the same tunnel, review the plugin permissions, then run **Test in ChatGPT** once. Continue after the matching check succeeds.

[**Follow the text connection guide →**](docs/start/first-connection.md) · [Watch the eight step-by-step animations](docs/media/onboarding/walkthrough.md) · [Try one sample workspace](docs/start/first-workspace.md)

The animations are light-theme UI recreations with synthetic values. Each has written steps and a static alternative. They illustrate setup from a running installation, not installation acceptance. For a pending or unknown action, inspect the original result through [Recovery](docs/guides/recovery.md) before trying again.

<a id="choose-folder-access"></a>

## Use Farol with clear boundaries

Keep folder access, command access and ChatGPT's tool-confirmation setting separate. The permission review explains **Always ask**, **Allow read-only tools**, the **Allow low-risk tools** default, and the optional **Allow all tools** setting with elevated risk. It does not change your settings or promise that every tool will run.

[Best practices and permission choices →](docs/guides/best-practices.md) · [Workspace access](docs/guides/folder-access.md)

<a id="updates-and-recovery"></a>
<a id="need-help"></a>

## Updates and help

Open the outer **Farol.app** from its [accepted installation location](docs/start/installation.md#installation-paths-and-adoption), not its nested Electron Runtime.app. For an installation already set up for trusted updates, use **Settings → General → Check for updates**. Closing the window leaves Farol running; **Command+Q** quits it.

[Update Farol](docs/guides/updates.md) · [Troubleshoot a connection](docs/guides/troubleshooting.md) · [Recover interrupted work](docs/guides/recovery.md) · [Uninstall safely](docs/guides/uninstall.md)

<a id="develop-from-source"></a>
<a id="declared-go-backend-inputs"></a>
<a id="source-architecture"></a>
<a id="status-and-scope"></a>

## Development and contributing

[Current status](docs/reference/status.md) distinguishes public downloads, qualified internal installations and source candidates. Local Shell/Git evidence applies to specific builds and toolchains; Tasks, Agent workflows, Git SSH and PDF transfer still require separate acceptance.

[Development guide](docs/development/README.md) · [Technical references](docs/reference/README.md) · [Go module indexes](docs/reference/modules/README.md) · [First-install readiness](docs/reference/install-readiness.md) · [Animation source and rebuild instructions](docs/media/onboarding/README.md)
