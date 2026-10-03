# Update package verification

**State:** producer/installed shared content verification in the current source.
[Release policy](github-release-contract.md) selects a candidate;
[installed lifecycle](installed-update-runtime.md) owns safe application of it.

## Shared verifier, different admission

The producer CLI and installed adapter share
[verify-package-content.mjs](../tooling/verify-package-content.mjs). Producer admission
also binds checkout version/source resources and the canonical candidate path.
Installed admission takes exact version/build/channel from the accepted release
manifest and measures bytes beneath its private extraction root.

The published attestation's original producer path cannot be trusted as an extracted
location. For schema 6, `artifact.json` sits beside `Farol.app`. Historical schema 5
uses `Farol Next Preview.app` and cannot be redirected into the branded installed
updater by renaming. [Closed cutover](product-cutover.md) owns that transition.

## Trusted executable and inputs

The packager bundles the standalone verifier and imports into one trusted resource.
The native adapter receives that `verifierPath`, the pinned
[archive extractor](../resources/native/update_archive.py), an owner-private staging
parent, and the opaque-handle-to-archive resolver. It runs the trusted installed
Electron executable in Node mode; it never executes the extracted candidate for
verification.

`createUpdatePackageVerifier().verifyPackage(handle, manifest)` performs:

1. Open the issued regular archive through `O_NOFOLLOW`; rehash actual bytes and
   verify exact length.
2. Bound archive metadata/entries/depth/expanded bytes before extraction and reject
   unsafe paths, unsupported ZIP layouts, and escaping symlinks.
3. Extract beneath a new disposable private root.
4. Measure the complete tree digest, embedded source/build identity, bundle/version,
   build version, channel, signing state, and pinned runtime.
5. Return measured `PackageIdentity`, accepted app path, and staging root only after
   all checks pass.

The current archive boundary accepts single-volume non-ZIP64 input, at most 16 MiB
central-directory metadata and 1 GiB expanded content, within package tree bounds.
These limits are input admission, not a reason to truncate an accepted package.

## Lifetime and physical files

The adapter retains an in-memory handle binding. On restart it must reverify the
private handle; a saved extracted path is not package authority. Rejected extraction
is removed; the caller owns disposal of an accepted extraction after use.

Electron's patched ASAR filesystem cannot reinterpret update bytes. Trusted verifier
subprocesses use Node mode with ASAR disabled, while main copy/removal ports use
`original-fs`. Cleanup uncertainty retains an update obligation and fence.

## Verification limits

[Native adapter](../src/modules/release/infra/native/update-package-verifier.ts),
synthetic ZIP tests, and package staging/ASAR regressions establish their selected
contracts. Synthetic claims do not authenticate a real release. Run real package
identity checks and separately record the installed upgrade, relaunch, reconnect,
and rollback journey before claiming that workflow passed.

---

[Documentation index](README.md) · [Project overview](../README.md)
