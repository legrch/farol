# Preparing public OTA assets

`tooling/prepare-release-archive.py` prepares an offline stable or owner-beta
release from this checkout's exact, clean package. It performs no upload, source push,
application launch, installation, profile read, or credential access. The source
repository is published separately under the owner-approved source policy.
A successful preparation is evidence for Lead's publication decision; it does not authorize publication or establish installed
OTA acceptance.

Lead first builds and qualifies the candidate through `task package` from clean,
committed bytes. Run the producer from that same checkout, with the full expected
HEAD and a new output directory whose existing parent has a physical, canonical
path:

```sh
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/python3 -I -S -B tooling/prepare-release-archive.py \
  <full-clean-HEAD-SHA-1> <new-output-directory>
```

The producer derives its root from its own location. Its only package inputs are
`_output/package/artifact.json` and `_output/package/Farol.app`. Current production
requires schema 7 and the embedded Go core; schema 5 and schema 6 remain historical
verification/recovery boundaries, not alternative producer inputs. The owning
`package-layout.mjs` contract must also confirm the schema-7 core and `Farol.app`
layout. Product and bundle identity remain `Farol` and
`io.github.legrch.farol` for compatibility. This command does not change package
versions, build versions, or retained historical releases.

The preparation gates are:

1. Require the full expected HEAD, clean index/worktree, ordinary index flags,
   and the artifact's exact `git-ls-tree-v1` source digest. Hash the physical
   tracked files with no-follow, nonblocking, size-pinned reads, compare their
   Git blob identities, and check executable modes even when Git ignores modes.
   Then call current `sourceIdentity(root, ".")` and
   `assertExactSourceIdentity`; repeat these source gates after the roundtrip.
2. Invoke the checkout's `tooling/verify-package.mjs` before executing the
   independently pinned native extractor. This verifier owns the complete package, build/input ledger,
   runtime, resource, signing, and embedded Go checks. The producer also binds the
   schema-4 embedded manifest and core declaration to this release's source/build
   identity and exact `darwin/arm64` target, verifies the declaration hash and the
   physical executable's size, SHA-256 and Mach-O header, and repeats that bounded
   core projection after extraction.
3. Pin all candidate files, directories and relative symlinks; reject hardlinks,
   special files, escaping or unresolved links, incompatible paths, and casefold/
   Unicode-normalization collisions. Bound the archive to 2 GiB, the expanded
   contents including metadata to 1 GiB, the entry count including metadata to
   100,000, path depth to 128, link payloads to 4 KiB and the central directory to
   16 MiB. Preserve file modes and safe relative links.
4. Write a private ZIP with only `Farol.app/` and `artifact.json`. The artifact
   has an exact field allowlist, closed runtime fields and public
   `artifactPath: "Farol.app"`. Absolute private paths in metadata, private
   profile/state entries, checkout source directories, source maps, and raw source
   files in app-owned resources refuse preparation. After full source/vendor
   verification, streaming checks on Farol-owned resources and native components
   reject the exact checkout path and recognizable user-home and temporary profile
   paths, including across chunk boundaries. The authenticated, unmodified
   Electron vendor tree is exempt from byte-pattern scanning because its public
   compiler paths can match these patterns; whole-tree entry checks still apply.
   Fixed system sandbox literals are allowed. These checks complement the
   package's exact resource/input contracts;
   they are not a general-purpose classifier for arbitrary secret text.
5. Read the archive's exact size and SHA-256 through a pinned descriptor. Copy
   the package's `update-archive.py` from pinned bytes only after comparing its hash
   with current `native-archive-build.mjs`. Despite its compatibility filename,
   it is an attested native Go executable: invoke the private copy **directly**,
   without Python. Require exact extraction paths and unchanged public metadata.
   Run the independently checked checkout's `tooling/verify-package-standalone.mjs`
   with the declared host Node against the restored app. Candidate-owned manifest
   hashes establish internal consistency, not permission to execute its JavaScript.
   Neither the packaged verifier nor Electron nor the restored app is executed.
   Require every measured source/build/package identity,
   build version, channel and unsigned claim to match the canonical candidate.
   Verifier stdout/stderr are capped while the original child writes, with a
   180-second deadline; an oversized or timed-out invocation is terminated once
   and its original terminal is awaited. No temporary capture file can grow
   without a bound.
6. Recheck the source, candidate and archive identities before making the three
   public assets available at the output root. Derive release identity from the
   physical verifier result, not only from candidate claims.

Exactly these three output-root files are intended for deliberate publication:

- `Farol-<version>-darwin-arm64.zip`
- `farol-release.json`
- `SHA256SUMS`

The manifest uses strict `farol.github-release/1`, `repository: "legrch/farol"`,
`channel: "stable"` for ordinary semantic versions or `"owner-beta"` for the
retained beta format, the exact ZIP size and digest, and the measured package
identity. `artifactSha256` is the extracted app tree digest, distinct from the ZIP
SHA-256. `SHA256SUMS` covers the ZIP. The historical `legrch/farol-releases` feed is
not a producer option or fallback.

Keep the entire output directory private. `<output>/private/` contains the
restored app, pinned extractor copy, original artifact with its local path,
source-before/source-after observations, source verifier output, core projection,
and extraction/physical verification records. Uploading the directory recursively
would disclose private evidence: select only the three named public files after
Lead's acceptance and explicit publication decision. CLI stdout/stderr are also
private diagnostic output, not release assets.

Gate refusals retain unfinished bytes under `private/` and expose no public
manifest. The producer never overwrites or reuses an existing output directory.
A timeout, refusal, or unknown helper outcome is terminal for that invocation;
there is no automatic retry or fallback. Preserve failed evidence. Investigating a
failure does not authorize replay of an outcome-unknown or refused live effect.
Treat any incomplete filesystem finalization as private failed output.

The co-located integration tests use actual source/candidate/layout contracts in
an isolated Git repository, synthetic Go declarations and Mach-O headers, and
substitute extractor and checkout package verifier programs. They cover current
schema/repository/layout, before/after source gates, physical mismatches, core
proof refusal, private leakage, resource limits, unsafe links, bounded capture,
refusal to dispatch candidate-owned JavaScript/Electron, and bounded no-follow
substitution reads. The emitted manifest is checked with the actual
`parseGithubReleaseManifest` consumer. The substitutes do not prove a Go compiler
build, an attested production extractor, a real Electron/vendor runtime, native
package acceptance, installed upgrade, GitHub publication or Gatekeeper behavior.
Lead owns real packaging, aggregate checks and real candidate roundtrip evidence
from exact clean committed bytes.

See [`github-release-contract.md`](./github-release-contract.md) and
[`update-package-verifier.md`](./update-package-verifier.md) for the owning
publication and consumer contracts.

## Qualified two-phase Actions publication (D31)

The release workflow has two separate phases. A `v*` tag push or a
`workflow_dispatch` with `action: prepare` runs the full existing `task ci`,
`task package`, offline archive preparation and `verifyReleaseAssets` gates.
The selected ref must contain an exact owner-beta version in `package.json`,
with `farolRelease.updateChannel: github-owner-beta`, and its exact commit must
be an ancestor of accepted `origin/main`. A tag event additionally verifies the
existing exact annotated remote version tag. A prepare dispatch creates no tag
or release. Tag runs also only prepare; they never automatically publish.

Preparation uploads only the three explicitly named public files listed above,
never the producer's private directory or diagnostic evidence. The immutable
artifact name is `farol-public-<run-id>-<run-attempt>-<full-source-SHA>`; retention
is seven days. Preserve the exact run and artifact identity. An expired, deleted,
replaced or missing artifact cannot be published through this handoff.

Lead downloads that exact artifact for qualification and records the SHA256 of
its **unmodified** `farol-release.json`. Source review, CP1/CP2, native/package,
installed/live and owner qualification must cover the downloaded exact asset.
Receipts for a different local build do not qualify it: `builtAt`, `buildId` and
application bytes can differ even at the same source commit. Lead retains those
private receipts separately; they are never public assets.

Only after those gates, a repository writer/Lead may select `action: publish`
on the same source SHA, supplying `candidate_run_id` and `manifest_sha256` (64
lower-case hexadecimal characters). The selected ref's `github.sha`, checkout
HEAD, candidate run and manifest source must all match, and that source must
still be on accepted main ancestry. The manifest digest binds the bytes Lead
selected; it is **not proof of human/native acceptance**. Repository write
access and Lead's deliberate publication after CP1/CP2 are the existing trust
root. No new approval service, provider setting, environment or secret is needed.

Before download and again immediately before publication, the publisher checks
GitHub metadata for this exact repository ID/name and workflow ID/path, a
distinct earlier completed successful run and its current attempt, a successful
`build` job and skipped `publish` job, and exactly one unexpired run-bound
artifact with matching source/repository/run identity. Only a tag push for the
exact version or a build-only prepare dispatch qualifies. Failed, running,
unknown, foreign, publish-only, same-run and stale-source candidates refuse.
Missing/extra jobs or artifact metadata also refuse; incomplete pagination is
not treated as a complete set. The download selects the validated artifact ID
from the specified run, then rechecks that ID to detect replacement.

The publisher does **not rebuild**. It first checks the supplied manifest digest,
requires exactly the three ordinary public files with no `private/` exception,
and invokes the existing `verifyReleaseAssets` for source/version, archive size,
archive SHA256 and checksum verification. It refuses an existing release,
including drafts or partial uploads. The authenticated release listing must be
complete (fewer than 100 entries); larger or malformed listings fail closed for
Lead reconciliation rather than assuming no draft exists. An existing tag must be annotated and name
this exact version and source commit; otherwise publication refuses. If absent,
it creates a new annotated exact version tag and a new unsigned prerelease with
exactly the three verified assets, `--verify-tag`, `--prerelease` and
`--latest=false`. There is no overwrite, force replacement or asset-update path.
Only the publisher has `contents: write`; preparation has read permissions.

A created tag may cause another build-only run when the event source permits
it; that new build cannot auto-publish or qualify different bytes. GitHub's
ordinary token event suppression may prevent that redundant run. Any timeout,
API refusal or unknown tag/release/upload outcome is terminal: preserve state
for Lead reconciliation and do not automatically retry. Tag creation and release
upload are separate remote effects, not a transaction; a partial result never
establishes publication success. The mocked regression tests prove local gate
ordering and refusal before effect calls with synthetic assets; they do not
qualify hosted Actions, real publication, native execution or owner acceptance.
