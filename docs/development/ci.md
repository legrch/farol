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

The final Ubuntu `required` job is the stable status check. It rejects failed or
cancelled checks. It accepts skipped heavy checks only when path classification
has established that the change is docs-only. A successful portable source
check is source evidence; it does not establish native qualification, package
acceptance, installation, or live behavior.

## Tagged release flow

`.github/workflows/release.yml` runs only for tags matching `v*`. It verifies
that the tag is exactly `v<package.json version>`, that the source commit is an
ancestor of `origin/main`, and that the remote tag remains unchanged during the
run. Tag runs are serialized and are not cancelled by newer runs.

On `macos-26`, the workflow provisions approved Go inputs, runs `task ci`, then
`task package` from clean
committed bytes. The existing `tooling/prepare-release-archive.py <head>
_output/release/<tag>` tool assembles the release assets. The publication step
uploads only the ZIP archive, `farol-release.json`, and `SHA256SUMS` as a GitHub
prerelease. It does not update a `latest` pointer or overwrite an existing
release. Private evidence under `private/` is never uploaded. The release
remains unsigned and not notarized (D16).

### Trust model

GitHub runs the release workflow as defined at the tagged commit. Its checks can
therefore catch a mistaken tag, but they cannot authenticate the workflow that
runs them: a tag on an unmerged commit could change those checks. A tag event
also exists only after someone with repository write access pushes the tag.
Forks and pull requests cannot create tags here, and pull request workflows get
no write permission or secrets.

The trust root for a release is therefore repository write access. Today only
the owner has it. The `main` ruleset blocks deletion and force-push but not
direct pushes, so write access already allows changing `main` and its
workflows; a tag adds no access beyond that. The ancestry, annotated-tag and
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
separate release publication job receives `contents: write`. The workflow
explicitly exports `GH_TOKEN` only for the publication step; the job-scoped
automatic GitHub token remains governed by GitHub Actions permissions.

## Lead activation and provisional timing

To activate the checks, the Lead pushes the feature branch, opens a pull
request, and observes actual check timings and native attestation. After the
reviewed candidate is merged, the Lead can push an immutable test tag matching
the package version to exercise the tagged release flow. This page records the
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
