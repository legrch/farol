# Install Farol on your Mac

[← What Farol does](overview.md) · **Installation** · [Next: connect ChatGPT →](setup.md)

Start here to check what you need, find the public download, and choose the right next step. Installation puts Farol on your Mac; [setup](setup.md) connects a running app to ChatGPT. They are separate steps.

> **Current installation status:** the direct installer is available for an empty `/Applications/Farol.app` slot. It verifies the release and requires either a fresh profile or a narrowly confirmed completed update profile. An occupied slot, unresolved update evidence, and an unconfirmed existing profile are refused. Clean-Mac prerequisites, unsigned-app behavior, and the complete first-install/update journey still need separate qualification.

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
| **I am installing for the first time**                  | Review the requirements and macOS security notes, then use the bounded install command below on an Apple Silicon Mac with an empty application slot.                                            |
| **Farol already works on this Mac**                     | Keep it. Open the outer Farol.app and continue to [the visual setup guide](setup.md), or use **Settings → General → Check for updates** for an installation already set up for trusted updates. |
| **I have an older app or an occupied install location** | Preserve the app and its data. Check [installation locations](#installation-paths-and-adoption) before any replacement or move.                                                                 |
| **I want to build Farol from source**                   | Use the [development guide](../development/setup.md). Source builds are a separate workflow.                                                                                                    |

## 3. Find the public download

**[Open the latest public release →](https://github.com/legrch/farol/releases/latest)**

On the release page, expand **Assets**. The Apple Silicon archive is named `Farol-<version>-darwin-arm64.zip`; the same release also provides `farol-release.json` and `SHA256SUMS`. GitHub's **Source code** archives are for developers, not the Mac app.

The release page shows the current Latest version. Its label is a catalogue selection, not evidence that installation and connection succeeded on your Mac.

If you inspect a download, save all three assets from the same release in one directory and check the ZIP there:

```sh
shasum -a 256 -c SHA256SUMS
```

The archive should report `OK`. This checks agreement with the published checksum; it does not establish developer identity, notarization, a completed installation or updater eligibility. Keep the matching metadata if you need to report a problem.

### Install into an empty slot

```sh
curl -fsSL https://raw.githubusercontent.com/legrch/farol/main/scripts/install.sh | sh -s -- latest
```

The installer downloads and verifies the selected release, then asks the verified package's native backend to place it into `/Applications/Farol.app` without overwriting another app. It checks for active Farol processes and unresolved installation or update evidence. A retained profile is accepted only when its last update has a matching completed journal, binding and exited helper, and the selected release is the same verified build or a newer stable build. It does not erase the profile or repair unknown operations. If placement reports an unconfirmed result, keep the printed recovery directory and do not repeat the command.

An occupied installation should use **Settings → General → Check for updates**. Downloading, unpacking or manually copying the app does not create the same installation evidence.

The [first-install readiness checklist](../reference/install-readiness.md) tracks the remaining work. The [capability status reference](../reference/status.md) contains dated build-specific evidence; its older release inventory is historical, not the current download catalogue.

## 4. Understand the macOS security status

The currently published download is **unsigned and not notarized**. Native assessment of an earlier assessed public artifact rejected it because it had no usable signature; the exact Finder warning was not reproduced. That older observation is not a new assessment of every subsequent release.

If macOS refuses the app, retain the warning and follow the maintainer's accepted distribution path. Removing quarantine or disabling Gatekeeper is not an installation step. A checksum supplies neither a verified developer identity nor Apple's notarization assessment.

<a id="installation-paths-and-adoption"></a>

## 5. Open an existing qualified installation

The selected location is **`/Applications/Farol.app`**. Open that outer app from **Applications**. Its nested **Electron Runtime.app** is an internal runtime; do not launch it separately or add it to the Dock.

Older alpha installations used `~/Applications/Farol.app`. Moving or copying one over the other does not migrate its installation record. Keep the working app and its data until a qualified replacement or adoption procedure reconciles the exact location and identity. A public ZIP is not a reason to downgrade a newer working installation.

Developers have a separate controlled [source-build](../development/setup.md) and [owner-promotion](../owner-preview.md#optional-local-promotion--owner-action-only) path. End users should not create internal promotion receipts or run build commands.

## 6. Connect ChatGPT and try a file

Once an accepted installation is running, follow **[Connect Farol to ChatGPT →](setup.md)**. The guide walks through sign-in, folder access, the tunnel, the ChatGPT plugin and the connection check, with written instructions, static images and eight optional animations.

Then try **[your first workspace →](first-workspace.md)**: read a sample file before granting more access. Review [best practices](../guides/best-practices.md) when you are ready for edits or commands.

[← Farol home](../../README.md) · [Connection troubleshooting](../guides/troubleshooting.md) · [Update an existing installation](../guides/updates.md)
