/**
 * The 0.1 settings reader rejects normal 0.2 writes (including filePolicy);
 * beta3 rejects newer Home startup settings and retained release notes.
 * Neither predecessor has a qualified state downgrade. Versions come from the
 * verified app pair; this guard refuses that restoration, not just its launch.
 * It does not attest state compatibility for any other release transition.
 */
export function legacyPredecessorRequiresStateRecovery(
  sourceVersion: string,
  targetVersion: string,
): boolean {
  return (
    (sourceVersion.startsWith("0.1.") && !targetVersion.startsWith("0.1.")) ||
    sourceVersion === "0.2.0-owner.beta.3"
  );
}
