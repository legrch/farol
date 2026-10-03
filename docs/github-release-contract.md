# GitHub release contract

**State:** implemented release discovery/verification policy. Published owner betas
live in the public binary-only **`legrch/farol-releases`** repository. See
[status](status.md) for the verified release and [installation](installation.md) for
the user path. The source repository's Releases tab is not this update feed.

## Producer assets and identity

An accepted version uses an immutable `v<version>` tag and these required assets:

- `farol-release.json`
- `Farol-<version>-darwin-arm64.zip`

Published owner betas also provide `SHA256SUMS.txt`. Upload all required assets while
the release is a draft, then expose that complete version to its channel. Changed
bytes need a new version; do not rewrite an already-published archive/manifest.

| Manifest field                                | Contract                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `schema`                                      | `farol.github-release/1`                                                 |
| `repository`                                  | `legrch/farol-releases`                                                  |
| `channel`                                     | `owner-beta` or `stable`                                                 |
| `product`, `bundleId`                         | Compatibility identity: `Farol Next Preview`, `local.farol.next.preview` |
| `version`, `buildVersion`                     | SemVer and positive decimal macOS build version                          |
| `sourceCommit`, `sourceTreeDigest`, `buildId` | Exact source SHA-1, SHA-256 tree identity, SHA-256 build identity        |
| `artifactSha256`                              | Extracted app tree digest; distinct from ZIP checksum                    |
| `archiveSha256`, `archiveName`, `archiveSize` | Exact downloadable archive bytes/name/length                             |
| `platform`, `arch`                            | `darwin`, `arm64`                                                        |
| `signing`, `notarized`, `sourceDirty`         | Current beta policy: `unsigned`, `false`, `false`                        |

The producer derives these claims from a clean accepted package and verifies them
against its attestation. Current schema 6 archives contain `Farol.app` with adjacent
`artifact.json`; the visible name differs from the retained compatibility identity.
Remove the producer's absolute `artifactPath` from public attestation. Release assets
contain accepted app/package metadata, not source worktrees, test logs, user profiles,
credentials, or private coordination material.

Historical schema 5 archives keep their original `Farol Next Preview.app` bytes.
The old installed consumer cannot accept schema 6. [Closed cutover](product-cutover.md)
establishes a branded baseline; changing an archive/bundle name cannot do that.

## Channel selection

Owner-beta checks accept GitHub prereleases with exact
`<major>.<minor>.<patch>-owner.beta.<number>` versions and a package channel of
`github-owner-beta`. Stable policy accepts non-draft, non-prerelease SemVer and
`github-stable`. Stable support in the parser is not a published stable release.
Build metadata is excluded so one precedence version cannot describe several byte
identities. Both semantic version and installed build-version checks must advance.

No eligible update is a quiet terminal result. A partial catalogue cannot establish
that the app is up to date. The current implementation admits fewer than 100 entries;
a full 100-entry page returns `release_catalogue_incomplete` before manifest fetch.
Pagination is not implemented for this release feed phase.

## Pure application functions

[github-release.ts](../src/modules/release/app/github-release.ts) owns:

- `parseGithubReleaseManifest`: strict boundary validation.
- `packageMatchesRelease`: measured package/version/build/channel identity binding.
- `discoverGithubUpdate`: bounded complete catalogue, exact assets/URLs, highest
  eligible newer candidate.
- `downloadAndVerifyGithubUpdate`: archive length/checksum and extracted package
  verification before returning a staged handle/app path.

The GitHub metadata response is capped at 1 MiB and a manifest at 16 KiB. Malformed
metadata, ambiguous duplicate assets, wrong URLs/repository/tag/channel, missing
assets, non-increasing build versions, and incomplete publication refuse selection.
The actual extracted identity comes from the verifier, never a copy of manifest fields.

These functions do not install, stop work, restart the app, or own helper recovery.
[Installed updater](installed-update-runtime.md) composes those responsibilities.

## HTTPS and staging adapter

[The native transport](../src/modules/release/infra/native/github-update-transport.ts)
uses fixed HTTPS GET destinations, without authorization tokens or cookies. Metadata
API responses cannot redirect. An archive may use the exact pinned asset URL and at
most one HTTPS redirect to `release-assets.githubusercontent.com`; foreign hosts,
userinfo, explicit ports/fragments, compressed responses, repeated redirects, or
unexpected status fail closed.

The adapter records the actual request/redirect chain. Echoing untrusted metadata is
not transport evidence. It enforces streamed byte/deadline limits, exclusively stages
regular archive files under a canonical owner-private directory, hashes bytes it
actually wrote, syncs them, and returns an opaque handle. JSON requests have a
30-second deadline; archives have fifteen minutes. Injectable HTTPS exists for offline
fixtures, not a production URL override.

Package verification reopens the handle without following links, rehashes/extracts
safely, and checks the entire app. A failed/interrupted stage never becomes Ready.
Known network/interruption/oversize failures remain classified. Unknown path/cleanup
state is retained by integration and does not authorize an automatic retry.

## Qualification

[Release contract tests](../tests/unit/github-release-contract.test.ts) and transport
fixtures cover parsing, selection, bounds, redirect/staging policy, and identity
binding. They do not prove a public download, current Gatekeeper acceptance, installed
upgrade, helper relaunch, configuration preservation, or rollback. Published release
metadata proves publication/identity claims for that version; each live installed
journey still needs its own exact-build evidence.

---

[Documentation index](README.md) · [Project overview](../README.md)
