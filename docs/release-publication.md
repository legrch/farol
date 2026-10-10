# Preparing public OTA assets

`tooling/prepare-release-archive.py` prepares an offline owner-beta release from
this checkout's exact, clean package. It performs no upload, source push,
application launch, installation, profile read, or credential access. The source
repository remains private. A successful preparation is evidence for Lead's
publication decision; it does not authorize publication or establish installed
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
layout. Product and bundle identity remain `Farol Next Preview` and
`local.farol.next.preview` for compatibility. This command does not change package
versions, build versions, or retained historical releases.

The preparation gates are:

1. Require the full expected HEAD, clean index/worktree, ordinary index flags,
   and the artifact's exact `git-ls-tree-v1` source digest. Hash the physical
   tracked files with no-follow, nonblocking, size-pinned reads, compare their
   Git blob identities, and check executable modes even when Git ignores modes.
   Then call current `sourceIdentity(root, ".")` and
   `assertExactSourceIdentity`; repeat these source gates after the roundtrip.
2. Invoke the checkout's `tooling/verify-package.mjs` before executing any
   packaged helper. This verifier owns the complete package, build/input ledger,
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
   Run the candidate's bundled `update-package.mjs` with its verified Electron
   executable in `ELECTRON_RUN_AS_NODE=1` mode against the restored app. The restored
   app is never launched. Require every measured source/build/package identity,
   build version, channel and unsigned claim to match the canonical candidate.
6. Recheck the source, candidate and archive identities before making the three
   public assets available at the output root. Derive release identity from the
   physical verifier result, not only from candidate claims.

Exactly these three output-root files are intended for deliberate publication:

- `Farol-<version>-darwin-arm64.zip`
- `farol-release.json`
- `SHA256SUMS`

The manifest uses strict `farol.github-release/1`, `repository: "legrch/farol"`,
`channel: "owner-beta"`, the exact ZIP size and digest, and the measured package
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
substitute extractor, Electron and package verifier programs. They cover current
schema/repository/layout, before/after source gates, physical mismatches, core
proof refusal, private leakage, resource limits, unsafe links, and bounded
no-follow substitution reads. The emitted manifest is checked with the actual
`parseGithubReleaseManifest` consumer. The substitutes do not prove a Go compiler
build, an attested production extractor, a real Electron/vendor runtime, native
package acceptance, installed upgrade, GitHub publication or Gatekeeper behavior.
Lead owns real packaging, aggregate checks and real candidate roundtrip evidence
from exact clean committed bytes.

See [`github-release-contract.md`](./github-release-contract.md) and
[`update-package-verifier.md`](./update-package-verifier.md) for the owning
publication and consumer contracts.
