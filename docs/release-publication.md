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

## Private qualified draft publication (D31)

The hosted build is source/package evidence. A `v*` push or an explicit
`workflow_dispatch` with `action: prepare` runs the same full `task ci`, clean
`task package`, offline three-asset preparation and `verifyReleaseAssets` gates.
The exact version and channel come from `package.json`: ordinary semantic
versions select `github-stable`; `-owner.beta.N` versions select
`github-owner-beta`. The private draft and final publication must have the
matching GitHub prerelease flag. Publication keeps `make_latest: false` and
changes only the qualified draft; it never changes tags or chooses another
candidate. The source must be an ancestor of accepted `origin/main`.
Tag runs also verify the exact annotated remote version tag. Neither route
publishes automatically or uploads binary artifacts. Do not transfer the hosted
rebuild through Actions artifacts, caches or workflow logs, or fall back to a
public release upload. The existing dependency-download caches remain unchanged.

Actions artifacts in this public repository are downloadable by signed-in
readers, so they cannot hold an unqualified candidate privately. Draft releases
are visible only to users with push access. See GitHub's
[artifact download documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
and [Releases API documentation](https://docs.github.com/en/rest/releases/releases).
The exact locally native-qualified archive is staged in a private draft; a
hosted rebuild at the same source may differ in `builtAt`, `buildId` or app bytes
and is never automatically selected for publication.

### Gated operator sequence

These are operator instructions for Root/Lead after the actual owner gates.
This source change performs no staging, tag push, dispatch or publication.

1. Freeze the exact clean accepted-main source/version. Build locally with
   `task package`, prepare the three assets using the offline producer above,
   and qualify those exact local bytes through CP1/CP2, native/package,
   installed/live and owner gates. Retain all private receipts separately.
   Source review or a manifest digest alone cannot close these gates.
2. After those gates and the actual owner decision, create and push the exact
   annotated `v<package.json version>` tag at that source under Root's release
   authority. Never move, replace, force or reuse a conflicting tag. Observe its
   actual tag-triggered workflow run through successful full CI/package
   completion (`build: success`, `publish: skipped`); a prepare dispatch is not a
   substitute. Retain its exact run ID and current attempt.
3. Stage **only** the three qualified local files with the normal operator
   command below. First reconcile any existing release/draft; there is no
   overwrite, clobber, asset replacement or public-upload fallback. The draft
   must stay unpublished with the version's matching prerelease flag. Preserve its immutable release ID and
   the three uploaded asset IDs, names and sizes. Never include `private/` or
   recursively upload the output directory.

   This example is for an owner-beta candidate. For an ordinary stable version,
   omit `--prerelease` and use an unsigned stable title. Both routes stay private
   drafts until separately qualified and explicitly published.

   ```sh
   gh release create "v<version>" \
     --repo legrch/farol --draft --verify-tag --prerelease --latest=false \
     --title "Farol v<version> (unsigned prerelease)" \
     --notes "Unsigned and not notarized (D16)." \
     "<qualified-output>/Farol-<version>-darwin-arm64.zip" \
     "<qualified-output>/farol-release.json" \
     "<qualified-output>/SHA256SUMS"
   ```

4. Hash the unmodified qualified local `farol-release.json` with SHA256. After
   the tag build succeeds and the staged draft identities are verified, select
   `action: publish` on that exact source, supplying `candidate_run_id`,
   `draft_release_id` and `manifest_sha256` (64 lower-case hex characters).
   The supplied digest is Root's exact-byte assertion after qualification, not
   proof of native or owner qualification. Repository write access and the
   deliberate owner-gated operator action remain the trust root; no new repo,
   setting, secret, permission service or qualification receipt store is added.

### Publisher boundary

Only `publish` has `contents: write`. Its `actions: read` is needed to read the
prior/current run and job metadata, not to download Actions artifacts. Before
download it verifies dispatch SHA/checkout/main ancestry, strict owner-beta
version, exact repository ID/name and workflow ID/path, a distinct earlier
successful **tag** run at the same source and its exact current attempt, and
exactly two completed jobs (`build: success`, `publish: skipped`). Failed,
running, unknown, foreign, publish-only, same-run or prepare-dispatch candidates
refuse. Incomplete job or release listings fail closed.

The exact remote tag must already be annotated, name this version and point
directly to this source commit. The supplied release ID must identify the
unpublished private draft for that tag with the matching `prerelease` flag,
`published_at: null` and exactly three uploaded assets with unique immutable
IDs, expected names and bounded sizes. The separate asset listing must agree.
An existing public release, another same-tag draft, extra/private file, missing
asset or tag mismatch refuses. Authenticated release listing must contain fewer
than 100 entries; larger listings require Lead reconciliation rather than an
assumption about unseen drafts.

The publisher downloads only explicit Asset API IDs on `api.github.com`, never
API-supplied arbitrary asset URLs. Each download permits at most one HTTPS 302
redirect to `release-assets.githubusercontent.com` or `objects.githubusercontent.com`;
URLs with credentials, explicit ports or fragments refuse. Authorization is
never forwarded to the redirected host. Each asset has a 120-second deadline,
byte reads are bounded to metadata size plus one sentinel byte, and output can
never exceed that size or the contract maximum (ZIP 2 GiB, manifest 16 KiB,
checksums 1 KiB). A new physical directory and exclusive no-follow ordinary
files prevent reuse or overwrite. Partial output remains private failed output.

It then binds the supplied manifest SHA256 and calls the existing
`verifyReleaseAssets` for archive size/digest/checksums and source/version. It
re-fetches run/attempt, remote tag object, draft and asset identities before
mutation and refuses any change. It does not rebuild, create a tag/release,
upload/replace assets, delete or edit a published release. Its only final
mutation is `PATCH /repos/legrch/farol/releases/<same-id>` with
`{draft:false, prerelease:<selected channel flag>, make_latest:"false"}`. This is a final read gate,
not an atomic compare-and-swap: Root must keep the selected tag/draft/assets
quiescent while the serialized workflow runs. No separate concurrent writer is
authorized by this sequence.

HTTP denials, timeouts, unknown transport or partial effects are terminal with
stable error codes. Tokens, headers, presigned URLs and full private API bodies
are never logged. Reconcile the original operation; never retry an unknown or
refused publication. Mocked transports and synthetic archive tests establish
local refusal/order/size/redirect behavior only. They do not qualify real GitHub
visibility or publication, hosted CI, native execution or owner acceptance.
