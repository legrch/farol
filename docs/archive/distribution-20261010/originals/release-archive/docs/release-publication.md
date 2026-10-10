# Preparing a release archive

This repository contains an offline producer for a reviewed, clean Farol
owner-beta package. It prepares files for a publication decision; it does not
upload assets, create a GitHub release, install an application, or use a token.
The source repository stays private.

Build the candidate through the existing clean, committed `task package` lane.
From that same checkout, pass the full expected HEAD and a fresh output
directory:

```sh
/usr/bin/python3 -I -S -B tooling/prepare-release-archive.py \
  <full-clean-HEAD-SHA-1> <new-output-directory>
```

The producer derives its repository root from the script location. It accepts
only `_output/package/artifact.json` and
`_output/package/Farol Next Preview.app` from that checkout. It checks the
clean HEAD and source tree digest against the artifact, rejects an existing
destination, checks file types and links, and invokes the committed package
verifier before running any packaged helper. Artifact and regular app files
are read through nonblocking, no-follow descriptors with a pinned regular-file
identity and an exact size bound. Directory and symbolic-link identities are
checked before and after archiving; source and package changes refuse completion.
The archive preserves file modes and symbolic links. The included `artifact.json` changes
only `artifactPath` to `Farol Next Preview.app`; private absolute paths are
refused.

Exactly three files at the output root are intended as public assets:

1. `Farol-<version>-darwin-arm64.zip`
2. `farol-release.json`
3. `SHA256SUMS.txt`

The ZIP contains the accepted app and public `artifact.json`. The manifest
uses the exact ZIP byte count and SHA-256, while `artifactSha256` remains the
package tree digest. `SHA256SUMS.txt` covers the ZIP. All extraction state,
the original artifact with its local path, and physical verification receipts
stay below `<output>/private/` and must never be uploaded. Keep the whole
output directory private until the public assets are deliberately selected.

Before reporting success, the producer invokes the package's bundled trusted
extractor and standalone verifier against the produced ZIP. It compares the
measured package identity with the candidate and derives release identity
fields from that measured result. A refusal leaves the new output directory
for private diagnosis and never overwrites it on a later invocation; choose
another fresh directory after resolving the cause.

The CLI's isolated test fixture substitutes small extractor/verifier programs
to check orchestration and refusal behavior. Disposable substitution cases
exercise symlink/FIFO replacement, file growth and truncation, and changed
directory/link identities under subprocess deadlines. Those tests do not establish a
real package, native updater, installed upgrade, GitHub publication, or
Gatekeeper acceptance. The Lead must qualify the real candidate and complete
full CI and independent review before integration or any publication decision.
The publication and update contracts are in
[`github-release-contract.md`](./github-release-contract.md) and
[`update-package-verifier.md`](./update-package-verifier.md).
