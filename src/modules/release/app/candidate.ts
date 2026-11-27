type Identified = Readonly<{
  handle: string;
  manifest: Readonly<{
    version: string;
    buildId: string;
    archiveSha256: string;
    artifactSha256: string;
  }>;
}>;

/** A staged archive that is not the discovered candidate needs reconciliation. */
export function candidateChanged(
  update: Identified,
  expected: Readonly<{ version: string; buildId: string }>,
): boolean {
  return (
    update.manifest.version !== expected.version ||
    update.manifest.buildId !== expected.buildId
  );
}

/** A local import that repeats the original selected nothing new. */
export function localCandidateRepeats(
  prepared: Identified,
  original: Identified,
): boolean {
  return (
    prepared.manifest.buildId === original.manifest.buildId ||
    prepared.handle === original.handle ||
    prepared.manifest.archiveSha256 === original.manifest.archiveSha256 ||
    prepared.manifest.artifactSha256 === original.manifest.artifactSha256
  );
}
