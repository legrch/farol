# First installation

**First installation from a public download is not yet a qualified supported workflow.** Farol has downloadable beta packages, but the mechanism that establishes a trusted installed app and update baseline remains product work. A manual copy or successful launch does not establish that baseline.

If you already have an accepted installation, keep it and use [First connection](first-connection.md) or [Updating Farol](../guides/updates.md). An occupied app slot must be preserved and reconciled before another installation.

## Requirements and limits

- An Apple Silicon Mac; the current package target is `darwin/arm64`.
- A ChatGPT account/workspace offering Developer mode and Tunnel connections for the setup described by Farol.
- A compatible connection helper and the native tools required by the exact package. Their clean-machine distribution and supported macOS matrix are not yet qualified; a helper-discovery failure is a product prerequisite issue.

There is no qualified Intel, Windows or Linux package. The packaged app contains Electron; it does not require the user to install Node, npm or Go. Those are [source development](../development/setup.md) dependencies. Remaining native-helper and developer-tool requirements still need a clean-machine acceptance test.

## Inspect the public download

On **14 October 2026**, the newest public release checked was [v0.2.3](https://github.com/legrch/farol/releases/tag/v0.2.3), published on 12 October. Its assets are:

| Asset                          | Purpose                                      |
| ------------------------------ | -------------------------------------------- |
| `Farol-0.2.3-darwin-arm64.zip` | App archive                                  |
| `farol-release.json`           | Release metadata used by the update contract |
| `SHA256SUMS`                   | Published ZIP checksum                       |

You can download those files from that exact release and check the ZIP in its download directory:

```sh
shasum -a 256 -c SHA256SUMS
```

The archive should report `OK`. This checks agreement with the published checksum. It does not prove Apple signing, notarization, a trusted first-install baseline or successful installation. Keep the metadata with the download if you need to report a problem. Stop here on a fresh machine until an accepted first-install path is provided.

## macOS security status

The current package is **unsigned and not notarized**. macOS may block or warn about downloaded software. A checksum does not provide a verified developer identity or Apple's notarization assessment. General instructions to remove quarantine, disable Gatekeeper or turn off other macOS protections are not part of this guide. If macOS refuses the app, preserve the warning and ask the maintainer for the accepted distribution path.

## Installation paths and adoption

The existing alpha updater targets `~/Applications/Farol.app` with accepted install/update evidence. `/Applications/Farol.app` is a proposed production destination in the [adoption contract](../../modules/release/adoption.md); the contract does not provide a working installer or authorize moving an existing app. Do not create a second copy to resolve a path or update error.

Developers have a separate, controlled source-build and owner-promotion path. [Source setup](../development/setup.md) and [owner promotion](../owner-preview.md#optional-local-promotion--owner-action-only) describe that path and its non-overwriting limits. It is not an external-recipient ZIP installer.

## Before calling installation supported

The Lead must close [the first-install and adoption checklist](../reference/install-readiness.md), including native slot checks, durable baseline adoption, macOS prerequisites and a fresh-recipient installed journey. Downloading this ZIP or following source build instructions does not close those gates.

[Start](README.md) · [Documentation](../README.md)
