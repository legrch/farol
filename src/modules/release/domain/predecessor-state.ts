/**
 * The 0.1 settings reader rejects normal 0.2 writes (including filePolicy).
 * This preview has no qualified state downgrade. Versions here come from the
 * verified app pair; this guard refuses that restoration, not just its launch.
 * It does not attest state compatibility for any other release transition.
 */
export function legacyPredecessorRequiresStateRecovery(
  sourceVersion: string,
  targetVersion: string,
): boolean {
  return sourceVersion.startsWith("0.1.") && !targetVersion.startsWith("0.1.");
}
