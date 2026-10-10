# Unsigned technical alpha distribution

Distribution packages an already accepted `Farol.app`. Release owns package
verification, first-install effects, baseline registration, update eligibility,
install/swap and recovery. Identity owns the final bundle/profile paths. A DMG,
checksum or successful Finder copy does not register an update baseline.

## Build from exact accepted app bytes

First obtain an app and `artifact.json` produced by `task package` from clean,
committed source and accepted by Lead. Do not rebuild or rename its contents in
this tool. Independently select its exact version, build, channel, bundle ID and
version-2 app tree digest, source commit and source tree digest from that accepted
selection, independently of the supplied descriptor. The builder reuses Release's
exact source-identity comparison; the package-content verifier then binds descriptor
claims to the measured app and embedded manifests before DMG creation. A portable
verified app/descriptor may live outside the current checkout; a path alone is not
acceptance evidence. There is no fixture/bypass CLI flag.

```sh
node tooling/distribution/dmg.mjs \
  --app /absolute/path/Farol.app \
  --artifact /absolute/path/artifact.json \
  --version 0.1.8-owner.beta.1 --build-version 10 \
  --channel github-owner-beta --arch arm64 \
  --bundle-id local.farol.next.preview \
  --app-sha256 ACCEPTED_APP_TREE_SHA256 \
  --source-commit ACCEPTED_SOURCE_COMMIT \
  --source-tree-digest ACCEPTED_SOURCE_TREE_SHA256 \
  --output /absolute/path/new-distribution-directory
```

The example spells the accepted pre-cutover fixture identity. It does not approve
that version for new external installs. The final `io.github.legrch.farol` identity
requires Identity/Release's accepted package verifier before this tool can bind it.
The verifier currently accepts only the pre-cutover package contract and refuses
an unsupported final identity even when the Distribution arguments permit it.

The output directory must not exist and cannot lie inside the app. Native commands
use absolute macOS paths. The builder preserves app bytes, permissions and relative
symlinks, creates a `UDZO`/`HFS+` image containing `Farol.app`, an `Applications`
symlink to `/Applications`, and `Install.txt`, then verifies and mounts the image
read-only with `-nobrowse -noautoopen`. It checks the layout/link and exact mounted
app tree before detaching. It never launches Finder or the app.

Outputs are the version/architecture-named DMG, its `.dmg.json` metadata and
`SHA256SUMS`. Metadata binds app/build/source/channel/platform/architecture and
actual image hash/size without local paths, credentials or a claim of notarization.
This is distribution metadata; `farol-release.json` and updater archive semantics
remain Release-owned. No existing release schema is extended by this tool.

The recipe and accepted content/layout are reproducible. Byte-identical DMGs are
**not claimed**: native HFS+/UDIF creation may vary filesystem timestamps and image
identifiers. Hash the actual image to publish. App tree hashes and image file hashes
are different values. Failed/unknown attach or detach retains the exact private
mount location and fails; do not rerun attach or delete a potentially mounted tree.

## Verify the preparation skeleton

`install-alpha.sh` currently prepares a verified DMG; it does not install or launch
an app. It uses only built-in macOS commands, accepts an exact alpha version/build/
channel/bundle/architecture and a supplied DMG SHA-256, refuses existing system,
user and old preview install slots (including dangling symlinks), checks Apple
silicon hardware even under Rosetta, and downloads one exact HTTPS release asset.
It prohibits a protocol downgrade, uses no automatic retry, verifies the image hash
before mounting, checks mounted bundle/version/build/channel, then detaches. On
success it leaves the image in a new private directory under `~/Downloads`.

Lead must publish the script in that same immutable release and publish its SHA-256.
The one-line command also hashes the downloaded script **before executing it**:

```sh
node tooling/distribution/command.mjs \
  --version 0.1.8-owner.beta.1 --build-version 10 \
  --channel github-owner-beta --arch arm64 \
  --bundle-id local.farol.next.preview \
  --dmg-sha256 PUBLISHED_DMG_SHA256 \
  --installer-sha256 PUBLISHED_SCRIPT_SHA256
```

The bootstrap input binds release identity, the DMG file hash and the script
file hash. It does not accept or measure an app tree digest. Producer-side DMG
validation binds the accepted app tree to image bytes; Release first-install
verification remains responsible for measuring and accepting the installed app.
`PREPARED` is not app-tree verification or update admission.

No example checksum is executable or inferred from `latest`. Review the generated
line and script before publishing. It targets
`https://github.com/legrch/farol-releases/releases/download/v<VERSION>/` and does
not fetch a mutable branch script. SHA-256 proves consistency relative to the
trusted publication; it does not independently authenticate the publisher.

## First-install seam and release gates

The agreed ownership boundary is narrow; the executable binding remains pending.
Distribution invokes an accepted Release command, never implements app copy/swap
or writes installation/update journals. The proposed input must bind a stable
operation ID, exact accepted package descriptor, measured tree/build/source identity,
destination and profile derived by Release/Identity. Receipt shape is Release-owned.
Outcomes distinguish installed, refused before effects and outcome unknown; observe
the same operation instead of retrying it. Refusal is not authority for an alternate
executor. An unavailable binding remains explicitly unavailable.

Manual drag install needs Release-owned first-launch verification and durable
baseline publication before update admission. Release must measure the installed
physical tree against the accepted descriptor and bind build/source/channel/profile/
installed path. Labels or a self-reported digest are insufficient. A missing,
mismatched, unreadable or interrupted baseline must block update; it cannot be
replaced with a synthetic promotion or update receipt.

At the accepted base, the updater expects its private promotion receipt and fixed
`~/Applications/Farol.app` slot. The conventional DMG link targets `/Applications`.
The cutover target is `/Applications/Farol.app`, with a distinct Dev identity and
slot. Release must observe and explicitly adopt an existing `~/Applications/Farol.app`
through its accepted migration/adoption contract; Distribution never overwrites it.
The executable adoption/first-launch baseline remains unavailable. This tooling does
not widen the current updater's slot or eligibility contract. The downloadable
skeleton deliberately ends at `PREPARED`.

Use [Recipient qualification and final bind](recipient-qualification.md) for the
exact producer commands, existing-install matrix and remaining Release/Identity
inputs. A control byte in a CLI value is refused before download or checksum parsing.

Before calling an external alpha ready, bind the final accepted app and verify:

1. The published DMG/script hashes, metadata and exact tag/channel match downloaded
   bytes; unsupported architecture and pre-existing install paths refuse safely.
2. Download via a real browser in a fresh disposable macOS account/VM or an actual
   recipient machine, mount, copy, eject, and complete normal first launch. Retain
   quarantine and record macOS version, hardware and the actual Gatekeeper outcome.
3. Release emits its authentic baseline for the measured drag-installed app, and a
   real N to N+1 update preserves configuration and has tested recovery/rollback.
4. Normal built-in app use works with no source, global Python/Node/Go, Homebrew or
   Xcode. Measure Codex/Claude/Git prerequisites separately from the base app.

A sanitized `PATH`, fresh `HOME`, synthetic app, native mount/copy test or old
accepted package is not a fresh-account qualification. The old fixture still has
Python native helpers; wrapping it in a DMG does not remove that dependency.

## Checks and integration

```sh
node node_modules/vitest/vitest.mjs run tests/distribution
node tests/distribution/dmg.native.mjs
/bin/sh -n tooling/distribution/install-alpha.sh
task ci:fast
git diff --check
```

The policy suite includes real POSIX/shasum/plutil execution with explicit
HTTPS/hardware/mount doubles. The native suite uses tiny synthetic app bytes,
real `hdiutil`, a disposable copy and exact teardown, without a Farol launch or
installed-state mutation. Exact accepted app packaging is a separate buildDmg run.
Native image tests are intentionally not part of every `ci:fast` run.

New paths are `tooling/distribution/`, `tests/distribution/` and
`docs/distribution/`. Lead can add the explicit native command to the existing
Taskfile if desired; this stream does not edit shared build/config/resource files.
There is no second updater, new package build path or mandatory delivery database.
