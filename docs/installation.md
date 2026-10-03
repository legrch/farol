# Installation and updates

Farol currently ships as an **owner beta for macOS Apple Silicon**. The verified
release is [0.1.8-owner.beta.1](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1).
It is unsigned and not notarized. Full live workflow and installed-update
qualification remain incomplete; keep the previous accepted app available.

## Requirements

- An Apple Silicon Mac. This repository's package and runtime checks target
  `darwin/arm64`; Intel macOS, Windows, and Linux packages are not qualified.
- A ChatGPT workspace that supports the tunnel/app setup shown in Farol. Embedded
  sign-in is optional for Computer, but the external ChatGPT connection still needs
  its own supported account/workspace configuration.
- The beta's Computer and update operations use the reviewed Apple Python/developer
  tool chain. Those helpers are not yet replaced by Go. Follow an explicit missing
  or unverified-tool diagnostic; a random replacement executable will not pass
  attestation.

The app carries its Electron runtime. Opening the packaged app does not require
Node, npm, Go, or a source checkout. Development and receipt-producing local
promotion have additional [toolchain requirements](standalone-build.md).

## Download and evaluate the beta

1. Open the [release page](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1).
   Download `Farol-0.1.8-owner.beta.1-darwin-arm64.zip`, `farol-release.json`, and
   `SHA256SUMS.txt` from the same release.
2. Verify the downloaded files in their directory:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   ```

   Both listed files should report `OK`. These hashes compare the download with
   the published checksums; the package remains unsigned.

3. Extract the ZIP and keep the accompanying `artifact.json`. Close any running
   Farol beta before opening another copy: beta copies share the same product
   profile, and a different running build is refused.
4. Open `Farol.app` from Finder. Use the normal macOS approval for downloaded
   software if required. The beta does not change Gatekeeper or quarantine
   settings. Start with [Getting started](getting-started.md).

Downloads are published in **`legrch/farol-releases`**, separately from source.
There is no DMG, signed installer, or stable channel in this release snapshot.

## Establish an updater-managed installation

The updater requires the canonical slot **`$HOME/Applications/Farol.app`** and
measured accepted-package evidence. A plain copied app has no promotion receipt
and can report an unavailable installation baseline. The current beta has no
standalone receipt-writing download installer.

The supported source workflow creates that baseline from a clean verified candidate:

```sh
task ci:fast
task package
task promote
```

Inspect the promotion plan, then explicitly apply it:

```sh
task promote -- --apply
```

Promotion verifies the candidate, checks active-work obligations, installs only
into an empty fixed slot, and writes its installation receipt. It derives the home
from the OS account; changing the shell's `HOME` cannot redirect installation.
An occupied slot is a refusal. Preserve and reconcile the existing installation
rather than deleting it to satisfy the check.

Older `Farol Next Preview.app` installations need the separate
[closed preview cutover](product-cutover.md). Changing a basename does not migrate
an old updater or create a receipt.

## Update an existing accepted installation

1. Choose **Check for Updates** in Farol. Eligible installed builds also check at
   startup and every six hours.
2. Wait for the download and verification. **Ready** means archive checksums,
   extracted package identity, and durable staging passed.
3. Choose **Later** to keep working, or close browser documents and settle current
   work before **Restart & Update**.
4. The app reserves work admission, drains its owned connector, and waits for the
   exact helper readiness acknowledgment before normal Quit. The helper preserves
   the predecessor, atomically replaces the bundle, and requests relaunch.
5. Read the new app's update state. A launch request alone does not prove that the
   new installation completed startup or reconnected to ChatGPT.

Saved folders, configuration, and browser state remain in the existing product
profile. Reconnect/attachment verification is a separate operation; updates do not
send a ChatGPT verification message automatically.

## Recovery and rollback

A settled update can offer **Restart & Restore Previous Version**. A proven
interrupted pair can offer **Restart & Finish Recovery** after the original helper
has been observed ended. The app verifies the exact journal and both bundles before
these actions. An unreadable journal, unknown helper, or changed bytes keeps work
blocked.

Preserve the error and operation evidence. Do not repeat an unknown apply, invent a
new operation ID, delete update journals, or replace the saved predecessor.
[Candidate troubleshooting](owner-preview.md) covers common startup/connection
errors; the [updater lifecycle](installed-update-runtime.md) and
[helper contract](installed-update-helper.md) explain the implementation.

---

[Documentation index](README.md) · [Project overview](../README.md)
