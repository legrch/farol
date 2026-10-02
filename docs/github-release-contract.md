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

Owner-beta packages use `github-owner-beta` and a monotonic macOS build version. The producer creates this release manifest only from a clean, accepted package and proves the copied source/build/package fields against its package attestation. Current schema-6 packages contain `Farol.app` and use the fixed `~/Applications/Farol.app` slot after the explicit [closed product cutover](product-cutover.md). The hidden `local.farol.next.preview` bundle identifier and NEW profile remain unchanged. Historical schema-5 releases keep their original `Farol Next Preview.app` layout and immutable bytes. The old installed consumer cannot consume schema 6; the historical closed-repair apply route accepts only schema 5. Neither an archive rename nor a rewritten receipt establishes a new baseline. The release manifest's package product remains the verifier's hidden compatibility identity, distinct from its visible Farol name.

Stable checks accept only non-draft, non-prerelease SemVer releases. Owner beta checks accept only GitHub prereleases with a version of the form `<major>.<minor>.<patch>-owner.beta.<number>`. The version must be strictly newer than the installed version. Build metadata is deliberately excluded to prevent multiple byte identities under one precedence version. No update is a terminal, quiet result, not an error.

## Consumer API and adapter duties

`parseGithubReleaseManifest(unknown)` is the strict, pure manifest validator. The publisher can call it before upload; acceptance still requires byte and package verification against the accepted candidate.

`packageMatchesRelease(actual, manifest)` is the pure identity check for both first download and restart recovery of a retained staged archive. The verifier supplies `actual.buildVersion` measured from the extracted app's `CFBundleVersion`, plus its embedded `updateChannel`. Manifest `channel: owner-beta` requires package `updateChannel: github-owner-beta`; manifest `stable` requires `github-stable`. A current `local-preview-only` package does not satisfy either release channel. The check also binds product, bundle ID, semantic version, source/build IDs, artifact digest, and unsigned metadata.

`discoverGithubUpdate({ version, buildVersion }, channel, ports)` returns `Outcome<UpdateCandidate | null>`. The installed build version comes from the verified installed package's `CFBundleVersion`. It calls `ports.fetchJson` for the fixed GitHub API releases URL (at most 1 MiB) and then the exact manifest asset (at most 16 KiB). It rejects malformed release metadata, ambiguous duplicate assets, wrong repository URLs, missing assets, mismatched tag/channel/version, non-increasing build version, oversize assets, and incomplete publication. The highest eligible newer version is selected only when the bounded catalogue is complete. Phase 1 admits fewer than 100 published entries; a full 100-entry page returns `release_catalogue_incomplete` before fetching a manifest, even if that page contains a candidate. It never presents a partial catalogue as up to date. Pagination is not implemented in this phase. Its `UpdateCandidate` contains the strict manifest and exact archive asset.

`downloadAndVerifyGithubUpdate(candidate, ports)` returns an opaque staged handle, manifest, verified identity, `stagedAppPath`, and `stagingRoot` only after the archive's reported length and SHA-256 and the extracted package identity match. It calls `ports.verifyPackage(handle, manifest)` with the exact selected manifest. Its download port receives the exact archive URL and the manifest size cap, never an editable workspace URL. It checks the port's reported redirect chain: exactly the pinned HTTPS GitHub release asset followed by HTTPS `release-assets.githubusercontent.com`, with no user info, port, or fragment. The `redirects` array is `[initial URL, final URL]`; a direct no-redirect response uses `[]`. Metadata API responses cannot redirect. The production transport must attest the **actual** request and redirect chain; it must not merely echo these values from untrusted JSON.

The adapter must enforce byte limits during streaming, stage in a private Farol-owned update directory without touching the running bundle, hash the bytes it actually wrote, and return an opaque handle. `verifyPackage(handle)` must rehash the staged archive, extract safely under a disposable staging root, reject path traversal/symlinks outside that root, and invoke the existing package verifier on the extracted `.app`. The returned `PackageIdentity` must come from that verifier, not a copied release manifest. Failed or interrupted staging is quarantined or removed by the adapter; it must never become ready state. Transport failure is classified as `network_failure`, `interrupted`, or `oversize`. Unknown outcomes must not be silently retried. The app functions never install, restart, or mutate live task state.

The native transport is `createGithubUpdateTransport({ privateStateDirectory, verifyPackage, openHttps? })`. Production leaves `openHttps` unset; the optional injectable client exists for offline fixtures. Pass `createUpdatePackageVerifier(...).verifyPackage` as the verifier callback: it receives `(handle, manifest)` and returns `{ identity, stagedAppPath, stagingRoot }`. The caller supplies an **existing**, canonical, owner-only (`0700`) private state directory. The adapter creates and validates its `github-updates` child, opens each random ZIP file with exclusive creation and no-follow flags at `0600`, streams under the manifest byte cap, hashes written bytes, syncs and closes, and returns the absolute staged path as an opaque handle. The transport's `verifyPackage(handle, manifest)` accepts only a validated regular file within that directory and delegates extraction and package verification to the supplied callback. It does not install or own the helper.

The transport only issues direct HTTPS GETs to the pinned releases API or exact GitHub release asset path. It follows at most one asset redirect to `release-assets.githubusercontent.com`; API redirects, foreign hosts, non-HTTPS URLs, credentials, compressed responses, repeated redirects and unexpected status codes fail closed. The JSON request deadline is 30 seconds; archive requests have a 15-minute deadline. Neither request sends an authorization token or cookie. `TransportFailure` adds `certainty: known | unknown` and a reason to the existing port failure code. `unknown` is reserved for staging cleanup or path-readback uncertainty and must not trigger automatic retry. The current pure app API reduces port failures to its existing error code, so the integration layer must retain the transport's direct failure detail when deciding what to display or reconcile.

The caller owns scheduling, update status, active-operation admission, Later/Restart & Update UI, fixed install slot, helper handoff, rollback, and post-restart reconciliation. It must use existing task/operation state as the authority for safe restart. Existing `tooling/promote-preview.mjs`, `promotion-apply.{mjs,py}`, `promotion-destination.mjs`, `promotion-obligations.mjs`, and `promotion-lease.mjs` are the placement and active-work integration seam; this packet adds no parallel installer. It does not introduce a task truth store, Apple signing prerequisite, or Electron `autoUpdater`.

These tests use mocks and GitHub-shaped fixtures only. They prove parsing, selection and verification policy, assuming honest port implementations. They do not prove a live GitHub release, package verification, installed N-to-N+1 update, helper behavior, or Gatekeeper acceptance.

## Installed composition

Only the canonical `~/Applications/Farol.app` slot with its existing
NEW user-data identity enables update checks. A temporary `task run` copy cannot
replace that slot. Startup checks and six-hour rechecks use the public GitHub API
without credentials; manual Check for Updates uses the same path. A current
version stays quiet. A downloaded package becomes Ready only after checksum,
package identity and durable staging checks. Later keeps the package and does
not interrupt work.

Restart & Update claims the existing authority, task-mutation and kernel
promotion gates and reads the existing promotion obligations. The initial
composition reserves local work, drains a configured idle connector and observes
open embedded ChatGPT documents through the fresh idle admission described in
[Installed updater lifecycle](installed-update-runtime.md). Active or uncertain
browser work and unreconciled shared task routes still refuse restart.
A known pre-dispatch refusal offers Check again. An uncertain download, ready
record, or helper handoff stays blocked across restart and never dispatches a
replacement operation automatically.

The fixed-slot helper acknowledges its exact operation before normal Quit. It
waits for that process and its confirmed drain, verifies the predecessor and
new package, preserves `previous.app`, switches the bundle, and relaunches. The
new process measures its installed tree and predecessor against the same journal
before recording success. Configuration is kept in the existing NEW user-data
root. Neither this protocol nor unsigned distribution disables Gatekeeper.

Publication must use an immutable new tag and a draft release until all assets
are uploaded. The archive contains only the accepted application and its public
package attestation; remove the producer's absolute `artifactPath` from the
published attestation. Private source, test logs, Brain material, user profiles
and credentials never belong in the public release repository. Offline tests
and source gates do not qualify a real installed GitHub upgrade.

Interrupted downloads have an operation-owned staging directory and a durable
producer PID/start witness before the first request. On a later launch, an intent
without a ready record can be cancelled only after the original producer is
observed ended and that exact staging directory is reconciled. Its interrupted
result is recorded before the intent is cleared; previous accepted packages and
rollback records are not removed. A live or unobservable producer, replaced
staging directory, uncertain cleanup, legacy intent without a witness, or an
unconfirmed native verification after the HTTP phase remains fenced. No download or helper is replayed by that reconciliation.
