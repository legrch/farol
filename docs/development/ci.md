# Pull request checks and tagged releases

This page describes the proposed GitHub Actions checks and release flow. It is
an operating guide; it does not configure branch protection, rulesets, or other
repository settings. Required-check enforcement is an operating policy. The owner explicitly chose
no branch protection or rulesets; activation does not require either setting. There is no workflow triggered by pushes to `main`.

## Pull request checks

`.github/workflows/pr.yml` runs for every pull request. Runs for the same pull
request use concurrency cancellation, so a newer commit cancels superseded
work.

The `changes` job quickly classifies changed paths on Ubuntu. A separate
Ubuntu `checks` job always runs format and documentation checks,
delivery-parity checks, and `scan:secrets`, in parallel with the heavy jobs.
The `portable` job also runs on Ubuntu and executes `task ci:cloud`, covering
toolchain and type checks, lint and formatting, architecture and runtime checks,
documentation, Cloud-selected unit and renderer checks, core Go checks, tooling,
and secret scanning. It may be skipped only when the changed paths match the
strict docs-only allowlist.

The `native` job runs on `macos-26`. It selects the complement of
the `cloudDeferredFiles` and `cloudMixedFiles` inventories with the
native-selection runner in `tooling/ci-native.mjs`, then runs that selection and
`task test:core` on one runner. Mixed files run in full on macOS, so a small
portable overlap avoids brittle inverse test-name filters. This preserves native coverage for the files excluded or partially
selected by the Cloud profile.

The core gate runs every Go package with race detection and at most two test
binaries at once (`go test -p=2 -race ./...`), for both root and transitional
nested modules. This bounds filesystem and process contention independently of
the host CPU count. It changes no test selection, operation timeout, race check
or unavailable/unknown result predicate. A passing isolated test is diagnostic
evidence; only the completed aggregate gate accepts the candidate.

The final Ubuntu `required` job is the stable status check. It rejects failed or
cancelled checks. It accepts skipped heavy checks only when path classification
has established that the change is docs-only. A successful portable source
check is source evidence; it does not establish native qualification, package
acceptance, installation, or live behavior.

## Tagged release flow

`.github/workflows/release.yml` accepts `v*` tag pushes and explicit
`workflow_dispatch` actions `prepare` and `publish`. Tag and prepare runs are
build-only: on `macos-26` they verify the strict owner-beta version/channel,
exact source on accepted `origin/main` ancestry, provision approved Go inputs,
run the unchanged full `task ci`, then clean `task package` and offline
three-asset preparation/verification. A tag push additionally verifies the
annotated remote tag. Runs are serialized without cancellation.

Build-only runs upload no binary artifacts and never auto-publish. Actions
artifacts in the public repository are downloadable by signed-in readers; do
not transfer unqualified binaries through artifacts, caches, workflow logs or
a public-upload fallback. Hosted rebuilt bytes are source/package evidence
only; they are not automatically selected for publication. Existing caches
hold dependency downloads only.

Root/Lead separately qualifies the exact locally prepared ZIP,
`farol-release.json` and `SHA256SUMS` through CP1/CP2, native/package,
installed/live and actual owner gates. Only then, under Root's release authority,
the operator creates the exact annotated accepted-main version tag, waits for
its actual successful full tag build, and stages only those qualified local
files with `gh release create --draft --verify-tag --prerelease --latest=false`.
That example selects owner-beta. Stable versions omit `--prerelease`; the
committed package version/channel and private draft flag must agree.
Draft releases are private to push-access users. Preserve the draft release ID,
uploaded asset IDs/names/sizes and the local manifest SHA256; private evidence
stays local. The complete gated command sequence and GitHub visibility sources
are in [release publication](../release-publication.md#private-qualified-draft-publication-d31).
This guide performs no staging or external action.

A separate explicit `action: publish` dispatch at the same source takes
`candidate_run_id`, `draft_release_id` and `manifest_sha256`. Only a distinct
prior successful tag run with `build: success`, `publish: skipped`, matching
repository/workflow/source/current attempt qualifies; prepare dispatches do not.
The supplied manifest digest is an exact-byte assertion after qualification,
not proof of that qualification. The publisher verifies checkout/dispatch SHA,
main ancestry, exact annotated remote tag, unpublished draft ID with the version's matching prerelease flag and
exactly three uploaded asset IDs/names/sizes, including complete matching asset
and release listings. Existing public releases, other same-tag drafts, extra or
private files, missing assets and tag mismatches refuse.

It downloads private assets by explicit API IDs only, permits one HTTPS redirect
to the two documented GitHub-owned asset hosts without forwarding Authorization,
bounds byte reads to metadata size plus one and contract maxima with finite
deadlines, and creates exclusive no-follow files in a new physical directory.
It binds the supplied manifest digest and reuses `verifyReleaseAssets` for
archive/checksum/source verification. Before mutation it re-fetches and checks
the same run/attempt, remote tag, draft and asset identities. It never rebuilds,
creates tags/releases, uploads/replaces assets, deletes or edits an already
published release. Its only final mutation is PATCH of that same still-draft
release with `{draft:false, prerelease:<selected channel flag>, make_latest:"false"}`. Root keeps
the selected draft/assets/tag quiescent during this final read gate; the API
provides no atomic compare-and-swap here.

The release remains unsigned and not notarized (D16). Denied/unknown HTTP,
timeouts and partial effects remain terminal: retain private evidence and
reconcile, with no retry or overwrite. No token, response headers, presigned
URL or full private API body is logged. Mocked regression tests prove local
contract behavior only, not actual staging/publication or release readiness.

### Trust model

GitHub runs the release workflow as defined at the tagged commit. Its checks can
therefore catch a mistaken tag, but they cannot authenticate the workflow that
runs them: a tag on an unmerged commit could change those checks. A tag event
also exists only after someone with repository write access pushes the tag.
Forks and pull requests cannot create tags here, and pull request workflows get
no write permission or secrets.

The trust root for a release is therefore repository write access. Today only
the owner has it. The owner currently selects no branch protection or rulesets; write access
already permits changing `main` and its workflows. A tag adds no access beyond
that. The ancestry, annotated-tag and
remote-identity checks keep an honest release consistent with reviewed `main`.

Pull request checks are evidence for the reviewer, not a merge authority. The
docs-only skip is decided by `tooling/ci-paths.mjs` as committed on the base
branch, so a pull request cannot rewrite the classifier to skip its own heavy
jobs; any change outside documentation Markdown, including `.github/` and CI
tooling, runs everything. A pull request can still change its own workflow
file, so a change under `.github/` or to CI tooling is reviewed as a change to
the gate itself before merge.

Granting write access to anyone else changes this boundary. Before that, add a
tag ruleset that restricts creating, updating and deleting `v*` tags to the
owner, or move publication behind a protected environment that requires
approval.

The existing producer requires a separately approved Go SDK declaration. The
release preflight refuses with `CI_GO_SDK_APPROVAL_REQUIRED` when
`config/ci-go-sdk.json` is missing and with `CI_GO_SDK_APPROVAL_INVALID` when it
does not name `farol-ci-go-sdk/1`, `go1.26.2`, `darwin`, `arm64` and a 64-hex
`treeSha256`.

CI does not use `actions/setup-go`: its toolcache SDK is repackaged and
measures differently. The shared setup action downloads the official go.dev
archive for the runner, checks the sha256 that go.dev publishes, and extracts
it unchanged. The native archive builder trusts exactly two compilers, each an
exact go binary and SDK tree pair: the owner's Homebrew Go and that pristine
official extraction. Both compile the byte-identical archive pinned in
`NATIVE_ARCHIVE_SHA256`.

The committed approval pins the tree digest of the official
`go1.26.2.darwin-arm64.tar.gz`. Its archive digest matches the one go.dev
publishes, and the tree digest was measured over the verified extraction of that
archive, the same SDK pin the local release chain uses. The `approval` block
records that provenance. Change the version only together with a new approval
taken the same way.

`tooling/ci-go-inputs.mjs` compares the installed SDK with that approved digest
and resolves the two pinned module inputs; the unchanged producer authenticates
module bytes against `go.sum`. A freshly measured SDK digest does not constitute
approval, and a hosted SDK that differs fails with `CI_GO_SDK_DIGEST_MISMATCH`.
The declared Go inputs are ignored build outputs, never public release assets.

All GitHub Actions are pinned to commit SHAs. npm, Go, and Electron downloads
use caches. Repository contents permission is read-only by default; only the
separate release publication job receives `contents: write`. The publisher retains `actions: read` solely for run/job metadata checks.
The workflow explicitly exports `GH_TOKEN` only for the publication step; the job-scoped
automatic GitHub token remains governed by GitHub Actions permissions.

## Lead activation and provisional timing

To activate the checks, the Lead pushes the feature branch, opens a pull
request, and observes actual check timings and native attestation. After the
reviewed candidate is merged, the Lead can exercise build-only preparation. Only after the actual native and owner
gates may Root create the immutable annotated version tag and stage the exact
qualified local files as a private draft, then deliberately dispatch publication
after its tag build succeeds. This page records the
process; it does not perform a push or publish a release.

These durations are planning estimates, not measurements or qualified service
targets:

| Work             | Provisional duration |
| ---------------- | -------------------- |
| Docs-only checks | 2–4 minutes          |
| Portable checks  | 8–14 minutes         |
| Native checks    | 8–14 minutes         |
| Tagged release   | 25–45 minutes        |

Cache misses, npm/Go downloads, runner queueing and native compiler work can
increase these times. One macOS job runs per source PR and one per release;
PR cancellation reduces stale work. GitHub account capacity still bounds the
number of concurrent macOS jobs. Tag concurrency does not cancel a running
release; GitHub may replace older pending runs in the same concurrency group,
so observe each intended tag run rather than treating a pushed tag as success.
Do not move a published tag or use a rerun to overwrite release assets.

The typical pull request goal is at most 15 minutes, and remains unqualified
until observed. Native or resource prerequisites can block a run; do not bypass
them to meet the estimate.
