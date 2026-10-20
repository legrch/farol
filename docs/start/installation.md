# First installation

Download Farol from the [latest public release](https://github.com/legrch/farol/releases/latest). Read its release notes and [current distribution status](../reference/status.md) before installing: public downloads and qualified internal builds can have different capabilities.

**First installation from a public download is still being qualified.** A manual copy or successful launch does not establish the trusted installation record needed by the updater. The [readiness checklist](../reference/install-readiness.md) tracks that remaining work.

If you already have a working accepted installation, keep it and use [First connection](first-connection.md) or [Updating Farol](../guides/updates.md). Preserve an occupied app location until its identity and update state have been checked.

## Requirements and limits

- An Apple Silicon Mac; the package target is `darwin/arm64`.
- A ChatGPT account/workspace offering Developer mode and Tunnel connections for the setup described by Farol.
- A compatible connection helper and the native tools required by the exact package. Their clean-machine distribution and supported macOS matrix still need qualification.

There is no qualified Intel, Windows or Linux package. Electron includes its Node runtime; end users do not need a separate Node, npm or Go installation. Updates and file search run through the bundled Go backend; ordinary Git and user Git hooks may still depend on Command Line Tools or their own toolchains. These are unresolved distribution prerequisites, not a request to install the [source development toolchain](../development/setup.md).

## Inspect the download

Use the assets attached to the same latest release: the Apple Silicon ZIP, `farol-release.json` and `SHA256SUMS`. Check the ZIP in its download directory:

```sh
shasum -a 256 -c SHA256SUMS
```

The archive should report `OK`. This checks agreement with the published checksum. Apple signing, notarization, installation and updater eligibility have separate checks. Keep the metadata with the download if you need to report a problem. An accepted first-install procedure must be available before proceeding on a fresh Mac.

## macOS security status

The currently published download is **unsigned and not notarized**. Native assessment of the downloaded app rejected it because it had no usable signature; the exact warning shown by Finder was not reproduced. A checksum supplies neither a verified developer identity nor Apple's notarization assessment.

If macOS refuses the app, retain the warning and follow the maintainer's accepted distribution path. Removing quarantine or disabling Gatekeeper is not an installation step. [Current status](../reference/status.md) records the exact assessed artifact and remaining signing work.

<a id="installation-paths-and-adoption"></a>

## Open an existing qualified installation

The current qualified internal installation is **`/Applications/Farol.app`**. Open that outer app from **Applications**. Its nested **Electron Runtime.app** is an internal runtime; do not launch it separately or add it to the Dock.

Older alpha installations used `~/Applications/Farol.app`. Moving or copying one over the other does not migrate its installation record. Keep the working app and its data until a qualified replacement or adoption procedure reconciles the exact location and identity. A public ZIP is not a reason to downgrade a newer working installation.

Developers have a separate controlled [source-build](../development/setup.md) and [owner-promotion](../owner-preview.md#optional-local-promotion--owner-action-only) path. It is not the recipient installation procedure, and end users should not create internal promotion receipts or run build commands.

[Start](README.md) · [Documentation](../README.md)
