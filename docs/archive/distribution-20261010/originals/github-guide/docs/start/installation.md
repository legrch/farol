# Install and open Farol

Open the published macOS Apple Silicon owner beta and keep its download evidence.
For an existing installation, use the [update guide](../guides/updates.md).

> [!IMPORTANT]
> The documented release is [0.1.8-owner.beta.1](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1).
> It is unsigned and not notarized. Keep your previous accepted app while evaluating
> it; [current status](../reference/status.md) records the qualification limits.

## Requirements

- An Apple Silicon Mac. The package and runtime checks target `darwin/arm64`.
- A ChatGPT account/workspace that supports the tunnel/app setup shown in Farol.
  Embedded ChatGPT login is optional for Computer access.
- The reviewed Apple Python/developer tool chain for Computer and update helpers.
  Follow a missing or unverified-tool diagnostic; an arbitrary replacement helper
  does not pass executable attestation.

The packaged app carries Electron. Opening it does not require Node, npm, Go, or a
source checkout. [Running from source](../development/setup.md) is a separate path.

## Download and open

1. Open the [release page](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1).
   Download the ZIP, `farol-release.json`, and `SHA256SUMS.txt` from that release.
2. In the download directory, verify both listed files:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   ```

   Both should report `OK`. This compares the download with the published hashes;
   the app still remains unsigned.

3. Extract the ZIP. Keep its accompanying `artifact.json` with the candidate.
4. Quit any other running Farol beta before opening this copy. Beta copies share
   the product profile, and a different running build is refused.
5. Open `Farol.app` in Finder. If macOS asks, use its normal approval for downloaded
   software. Farol does not change Gatekeeper or quarantine settings.

**Check:** Farol opens with its sidebar and Setup available. The ordinary first
launch does not create synthetic tasks. If startup fails, follow
[troubleshooting](../guides/troubleshooting.md).

## Understand this installation

Binary downloads live in `legrch/farol-releases`, separately from the source
repository. This release has no DMG, stable channel, or signed installer.

The managed updater additionally requires the fixed
`$HOME/Applications/Farol.app` slot and an accepted installation receipt. Copying a
ZIP's app does not create that receipt. The beta has no standalone download
installer that writes it. See [installation baseline](../development/packaging.md#establish-an-installed-baseline)
for the current source promotion workflow; an existing occupied slot needs its
own reconciliation.

An older `Farol Next Preview.app` requires the separate
[closed preview migration](../maintenance/preview-cutover.md).

## Next

[Connect ChatGPT](first-connection.md), then [read your first workspace](first-workspace.md).

---

[Start](README.md) · [Documentation](../README.md)
