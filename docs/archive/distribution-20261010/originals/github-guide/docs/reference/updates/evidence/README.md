# Published release evidence

This documentation snapshot was acquired from the GitHub Releases API on
2026-10-03 for the named
[v0.1.8-owner.beta.1 release](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1).
It supports offline review of the metadata cited by the
[status matrix](../../status.md) and [installation guide](../../../start/installation.md).
It is a historical snapshot, not a live latest-release feed.

## Sources and local copies

| Evidence                                                             | Local copy                               | Original source                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Selected release fields, publication time, notes, and asset metadata | [release-api.json](release-api.json)     | [GitHub release API](https://api.github.com/repos/legrch/farol-releases/releases/tags/v0.1.8-owner.beta.1)              |
| Byte-for-byte published manifest                                     | [farol-release.json](farol-release.json) | [Published manifest](https://github.com/legrch/farol-releases/releases/download/v0.1.8-owner.beta.1/farol-release.json) |
| Byte-for-byte published checksums                                    | [SHA256SUMS.txt](SHA256SUMS.txt)         | [Published checksums](https://github.com/legrch/farol-releases/releases/download/v0.1.8-owner.beta.1/SHA256SUMS.txt)    |

The manifest declares build `10`, source commit
`1eb30bd23df22c9581d277280f8e0699612786b5`, platform `darwin/arm64`, an unsigned
bundle, and no notarization. Its ZIP name, size, and SHA-256 agree with the
release API metadata and published checksum entry.

## Reproduce the metadata checks

From the repository root:

```sh
cd docs/reference/updates/evidence
shasum -a 256 farol-release.json SHA256SUMS.txt
```

The expected file hashes are in the release API snapshot. To independently
refresh the originals, query the release API linked above and use the named
asset URLs. The manifest and checksum copies preserve their published bytes;
the API snapshot contains selected fields and is formatted for readability.

## Evidence limits

These files are publisher metadata. Their matching hashes check the copied
metadata and the stated ZIP identity; this pass did not download, unpack,
install, or launch the ZIP. They do not independently attest its internal
bundle, signing state, runtime behavior, or live provider acceptance. Use the
[package verifier](../verifier.md) for actual downloaded-byte admission and keep
installed acceptance separate from source and fixture checks.

When documentation moves to another published release, capture its own metadata
and checksums, cite the corresponding source commit, and update the status matrix.
Do not silently relabel this snapshot as a newer release.

---

[Update reference](../README.md) · [Documentation](../../../README.md)
