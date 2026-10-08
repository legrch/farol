import {
  canRecheckUpdateAdmission,
  type InstalledUpdateView,
} from "../../modules/release/contract/installed-update";

/** Presentation only; the release owner still rechecks every command. */
export function updateCheckAllowed(update: InstalledUpdateView): boolean {
  return (
    update.phase === "idle" ||
    update.phase === "available" ||
    (update.phase === "failed" && !update.recoveryRequired) ||
    (update.phase === "ready" &&
      update.blockedBy !== null &&
      canRecheckUpdateAdmission(update.blockedBy))
  );
}
