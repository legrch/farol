// A source verifier and its packaged verifier must be tested against the
// exact source snapshot that produced the artifact, not a later checkout.
export function assertUpdatePackageSource(artifact, source) {
  if (
    !artifact ||
    !source ||
    artifact.sourceDirty !== false ||
    source.dirty !== false ||
    !/^[a-f0-9]{40}$/u.test(artifact.sourceCommit ?? "") ||
    !/^[a-f0-9]{64}$/u.test(artifact.sourceTreeDigest ?? "") ||
    artifact.sourceCommit !== source.commit ||
    artifact.sourceTreeDigest !== source.treeDigest
  ) {
    throw new Error("UPDATE_PACKAGE_SOURCE_MISMATCH");
  }
}
