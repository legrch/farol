/**
 * The 0.1 settings reader rejects normal 0.2 writes (including filePolicy);
 * beta3 rejects newer Home startup settings and retained release notes.
 * Through beta9, Settings also rejects a connection-only attachment and the
 * Computer authority reader rejects retained no-access approvals/participants.
 * Through beta11, completed Shell results also reject the v6 supervised
 * process format written from beta12. No app+state downgrade is qualified yet.
 * Versions come from the
 * verified app pair; this guard refuses that restoration, not just its launch.
 * It does not attest state compatibility for any other release transition.
 */
export function legacyPredecessorRequiresStateRecovery(
  sourceVersion: string,
  targetVersion: string,
): boolean {
  const previousStateReader = /^0\.2\.0-owner\.beta\.[1-9]$/u;
  const previousProcessReader = /^0\.2\.0-owner\.beta\.(?:[1-9]|10|11)$/u;
  return (
    (sourceVersion.startsWith("0.1.") && !targetVersion.startsWith("0.1.")) ||
    sourceVersion === "0.2.0-owner.beta.3" ||
    (previousStateReader.test(sourceVersion) &&
      !previousStateReader.test(targetVersion)) ||
    (previousProcessReader.test(sourceVersion) &&
      !previousProcessReader.test(targetVersion))
  );
}
