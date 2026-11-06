# Install Farol on your Mac

[← What Farol does](overview.md) · **Installation** · [Next: connect ChatGPT →](setup.md)

Start here to check what you need, find the public download, and choose the right next step. Installation puts Farol on your Mac; [setup](setup.md) connects a running app to ChatGPT. They are separate steps.

> **Current installation status:** public downloads exist, but a supported first-install procedure and trusted updater setup are still being qualified. The direct installer is temporarily unavailable. If this is your first installation, review the requirements and download information below, then stop before installing until an accepted procedure is available. If Farol already works on your Mac, keep that installation and use its updater.

## 1. Check what you need

| You need                                       | Details                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **An Apple Silicon Mac**                       | The public package targets `darwin/arm64`. Intel Macs, Windows and Linux do not have a qualified package.                                                   |
| **The required ChatGPT features**              | Your ChatGPT account/workspace must offer Developer mode and Tunnel connections. Check availability before starting; account and organization options vary. |
| **A small sample folder**                      | Use non-sensitive files for the first connection. New Farol workspaces start with Read only access.                                                         |
| **A compatible runtime and connection helper** | A clean-Mac macOS/prerequisite matrix and helper distribution still need qualification. Do not infer compatibility from a successful download.              |

Electron includes its Node runtime and the Go backend is packaged; end users do not need a separate Node, npm or Go installation. Ordinary Git and user Git hooks may still depend on Command Line Tools or their own toolchains. The [source development toolchain](../development/setup.md) is for contributors, not an end-user installation prerequisite list.

## 2. Choose your starting point

| Your situation                                          | Next action                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I am installing for the first time**                  | Read the public-download and macOS notes below. Wait for an accepted first-install procedure before proceeding on a fresh Mac.                                                                  |
| **Farol already works on this Mac**                     | Keep it. Open the outer Farol.app and continue to [the visual setup guide](setup.md), or use **Settings → General → Check for updates** for an installation already set up for trusted updates. |
| **I have an older app or an occupied install location** | Preserve the app and its data. Check [installation locations](#installation-paths-and-adoption) before any replacement or move.                                                                 |
| **I want to build Farol from source**                   | Use the [development guide](../development/setup.md). Source builds are a separate workflow.                                                                                                    |

## 3. Find the public download

**[Open the latest public release →](https://github.com/legrch/farol/releases/latest)**

On the release page, expand **Assets**. The Apple Silicon archive is named `Farol-<version>-darwin-arm64.zip`; the same release also provides `farol-release.json` and `SHA256SUMS`. GitHub's **Source code** archives are for developers, not the Mac app.

As checked on **7 November 2026**, GitHub Latest is [v0.5.18](https://github.com/legrch/farol/releases/tag/v0.5.18), whose release notes state that it is unsigned and not notarized. Use the latest-release link above for subsequent downloads. A release's Latest label does not qualify its first-install procedure.

If you inspect a download, save all three assets from the same release in one directory and check the ZIP there:

```sh
shasum -a 256 -c SHA256SUMS
```

The archive should report `OK`. This checks agreement with the published checksum; it does not establish developer identity, notarization, a supported installation or updater eligibility. Keep the matching metadata if you need to report a problem. **Do not proceed with a fresh installation until an accepted procedure is available.**

### Why there is no install command here yet

The direct installer is temporarily unavailable while safe replacement of an occupied application slot is being qualified. It stops before downloading or changing anything. Downloading, unpacking or manually copying the app does not create the trusted installation record needed by the updater.

The [first-install readiness checklist](../reference/install-readiness.md) tracks the remaining work. The [capability status reference](../reference/status.md) contains dated build-specific evidence; its older release inventory is historical, not the current download catalogue.

## 4. Understand the macOS security status

The currently published download is **unsigned and not notarized**. Native assessment of an earlier assessed public artifact rejected it because it had no usable signature; the exact Finder warning was not reproduced. That older observation is not a new assessment of every subsequent release.

If macOS refuses the app, retain the warning and follow the maintainer's accepted distribution path. Removing quarantine or disabling Gatekeeper is not an installation step. A checksum supplies neither a verified developer identity nor Apple's notarization assessment.

<a id="installation-paths-and-adoption"></a>

## 5. Open an existing qualified installation

The documented qualified internal location is **`/Applications/Farol.app`**. Open that outer app from **Applications**. Its nested **Electron Runtime.app** is an internal runtime; do not launch it separately or add it to the Dock. This location is not a fresh-install instruction.

Older alpha installations used `~/Applications/Farol.app`. Moving or copying one over the other does not migrate its installation record. Keep the working app and its data until a qualified replacement or adoption procedure reconciles the exact location and identity. A public ZIP is not a reason to downgrade a newer working installation.

Developers have a separate controlled [source-build](../development/setup.md) and [owner-promotion](../owner-preview.md#optional-local-promotion--owner-action-only) path. End users should not create internal promotion receipts or run build commands.

## 6. Connect ChatGPT and try a file

Once an accepted installation is running, follow **[Connect Farol to ChatGPT →](setup.md)**. The guide walks through sign-in, folder access, the tunnel, the ChatGPT plugin and the connection check, with written instructions, static images and eight optional animations.

Then try **[your first workspace →](first-workspace.md)**: read a sample file before granting more access. Review [best practices](../guides/best-practices.md) when you are ready for edits or commands.

[← Farol home](../../README.md) · [Connection troubleshooting](../guides/troubleshooting.md) · [Update an existing installation](../guides/updates.md)
