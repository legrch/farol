import path from "node:path";

export function candidatePaths(root) {
  const resolvedRoot = path.resolve(root);
  return {
    artifactFile: path.join(resolvedRoot, "_output/package/artifact.json"),
    appPath: path.join(resolvedRoot, "_output/package/Farol Next Preview.app"),
  };
}

export function assertCanonicalArtifactPath(
  root,
  artifact,
  code = "PACKAGE_ARTIFACT_PATH_INVALID",
) {
  const claimed = artifact?.artifactPath;
  if (
    typeof claimed !== "string" ||
    !path.isAbsolute(claimed) ||
    path.resolve(claimed) !== candidatePaths(root).appPath
  ) {
    throw new Error(code);
  }
}

export function assertExactSourceIdentity(
  current,
  artifact,
  code = "CANDIDATE_SOURCE_NOT_EXACT",
) {
  if (
    current?.dirty !== false ||
    artifact?.sourceDirty !== false ||
    current?.commit !== artifact?.sourceCommit ||
    current?.treeDigest !== artifact?.sourceTreeDigest
  ) {
    throw new Error(code);
  }
}
