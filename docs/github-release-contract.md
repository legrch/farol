# GitHub release discovery contract

This source packet defines the Phase-1 public, binary-only `legrch/farol-releases` update channel. It does not create a release, install an app, or run a native update. The source repository remains private. No GitHub token belongs in the application.

## Producer contract

Publish an accepted release under `v<version>`, with a single `farol-release.json` asset and a single `Farol-<version>-darwin-arm64.zip` asset. Both assets must be fully uploaded before the release is exposed to the intended channel. Changed bytes require a new version. The manifest is strict JSON with these fields:

| Field                                         | Meaning                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `schema`                                      | `farol.github-release/1`                                                                |
| `repository`                                  | `legrch/farol-releases`                                                                 |
| `channel`                                     | `stable` or `owner-beta`                                                                |
| `product`, `bundleId`                         | `Farol Next Preview`, `local.farol.next.preview` (current package identity)             |
| `version`, `buildVersion`                     | SemVer and positive decimal macOS build version                                         |
| `sourceCommit`, `sourceTreeDigest`, `buildId` | Exact source SHA-1, 64-hex source tree digest, and 64-hex build ID                      |
| `artifactSha256`                              | Existing package verifier's digest of the extracted `.app` tree, **not** the ZIP digest |
| `archiveSha256`, `archiveName`, `archiveSize` | Digest, fixed asset name, and exact byte count of the downloadable ZIP                  |
| `platform`, `arch`                            | `darwin`, `arm64`                                                                       |
| `signing`, `notarized`, `sourceDirty`         | `unsigned`, `false`, `false` for this Phase-1 contract                                  |

The current package manifest and build identity are still preview-only. The producer must create this release manifest only from a clean, accepted package and prove the copied source/build/package fields against its package attestation. This packet does not change package/build tooling. The `local.farol.next.preview` bundle identifier and `~/Applications/Farol Next Preview.app` installed slot are the allowed new-generation identities for now; they do not authorize a V0 migration or collision with a V0 install slot. The release manifest's package product is the verifier's current identity, independent of future owner-facing display-name polish.

Stable checks accept only non-draft, non-prerelease SemVer releases. Owner beta checks accept only GitHub prereleases with a version of the form `<major>.<minor>.<patch>-owner.beta.<number>`. The version must be strictly newer than the installed version. Build metadata is deliberately excluded to prevent multiple byte identities under one precedence version. No update is a terminal, quiet result, not an error.

## Consumer API and adapter duties

`parseGithubReleaseManifest(unknown)` is the strict, pure manifest validator. The publisher can call it before upload; acceptance still requires byte and package verification against the accepted candidate.

`discoverGithubUpdate({ version, buildVersion }, channel, ports)` returns `Outcome<UpdateCandidate | null>`. The installed build version comes from the verified installed package's `CFBundleVersion`. It calls `ports.fetchJson` for the fixed GitHub API releases URL (at most 1 MiB) and then the exact manifest asset (at most 16 KiB). It rejects malformed release metadata, ambiguous duplicate assets, wrong repository URLs, missing assets, mismatched tag/channel/version, non-increasing build version, oversize assets, and incomplete publication. The highest eligible newer version is selected. Its `UpdateCandidate` contains the strict manifest and exact archive asset.

`downloadAndVerifyGithubUpdate(candidate, ports)` returns an opaque staged handle plus manifest only after the archive's reported length and SHA-256 and the extracted package identity match. Its download port receives the exact archive URL and the manifest size cap, never an editable workspace URL. It checks the port's reported redirect chain: exactly the pinned HTTPS GitHub release asset followed by HTTPS `release-assets.githubusercontent.com`, with no user info, port, or fragment. The `redirects` array is `[initial URL, final URL]`; a direct no-redirect response uses `[]`. Metadata API responses cannot redirect. The production transport must attest the **actual** request and redirect chain; it must not merely echo these values from untrusted JSON.

The adapter must enforce byte limits during streaming, stage in a private Farol-owned update directory without touching the running bundle, hash the bytes it actually wrote, and return an opaque handle. `verifyPackage(handle)` must rehash the staged archive, extract safely under a disposable staging root, reject path traversal/symlinks outside that root, and invoke the existing package verifier on the extracted `.app`. The returned `PackageIdentity` must come from that verifier, not a copied release manifest. Failed or interrupted staging is quarantined or removed by the adapter; it must never become ready state. Transport failure is classified as `network_failure`, `interrupted`, or `oversize`. Unknown outcomes must not be silently retried. The app functions never install, restart, or mutate live task state.

The native transport is `createGithubUpdateTransport({ privateStateDirectory, verifyPackage, openHttps? })`. Production leaves `openHttps` unset; the optional injectable client exists for offline fixtures. The caller supplies an **existing**, canonical, owner-only (`0700`) private state directory. The adapter creates and validates its `github-updates` child, opens each random ZIP file with exclusive creation and no-follow flags at `0600`, streams under the manifest byte cap, hashes written bytes, syncs and closes, and returns the absolute staged path as an opaque handle. `verifyPackage` accepts only a validated regular file within that directory and delegates extraction and package verification to the supplied port. It does not install or own the helper.

The transport only issues direct HTTPS GETs to the pinned releases API or exact GitHub release asset path. It follows at most one asset redirect to `release-assets.githubusercontent.com`; API redirects, foreign hosts, non-HTTPS URLs, credentials, compressed responses, repeated redirects and unexpected status codes fail closed. The JSON request deadline is 30 seconds; archive requests have a 15-minute deadline. Neither request sends an authorization token or cookie. `TransportFailure` adds `certainty: known | unknown` and a reason to the existing port failure code. `unknown` is reserved for staging cleanup or path-readback uncertainty and must not trigger automatic retry. The current pure app API reduces port failures to its existing error code, so the integration layer must retain the transport's direct failure detail when deciding what to display or reconcile.

The caller owns scheduling, update status, active-operation admission, Later/Restart & Update UI, fixed install slot, helper handoff, rollback, and post-restart reconciliation. It must use existing task/operation state as the authority for safe restart. Existing `tooling/promote-preview.mjs`, `promotion-apply.{mjs,py}`, `promotion-destination.mjs`, `promotion-obligations.mjs`, and `promotion-lease.mjs` are the placement and active-work integration seam; this packet adds no parallel installer. It does not introduce a task truth store, Apple signing prerequisite, or Electron `autoUpdater`.

These tests use mocks and GitHub-shaped fixtures only. They prove parsing, selection and verification policy, assuming honest port implementations. They do not prove a live GitHub release, package verification, installed N-to-N+1 update, helper behavior, or Gatekeeper acceptance.
