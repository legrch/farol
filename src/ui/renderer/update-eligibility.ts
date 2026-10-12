import type { WindowSnapshot } from "./contract";
import {
  canRecheckUpdateAdmission,
  type InstalledUpdateView,
} from "../../modules/release/contract/installed-update";

const confirmedBrowserBlocks = new Set([
  "UPDATE_BROWSER_OPEN",
  "UPDATE_BROWSER_BUSY",
  "UPDATE_BROWSER_DRAFT",
  "UPDATE_BROWSER_STATE_UNKNOWN",
]);

/** Only explicit installation confirmation may interrupt browser activity. */
export function isConfirmedBrowserBlock(
  code: string | null | undefined,
): boolean {
  return typeof code === "string" && confirmedBrowserBlocks.has(code);
}

export function confirmedRestartAllowed(update: InstalledUpdateView): boolean {
  return (
    update.phase === "ready" &&
    (update.blockedBy === null || isConfirmedBrowserBlock(update.blockedBy))
  );
}

/** Display preserves every version component, including legacy beta identity. */
export function updateVersionLabel(version: string): string {
  return version.replace(/^(\d+\.\d+\.\d+)-owner\.beta\.(\d+)$/u, "$1 beta $2");
}

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

export function automaticUpdateEnabled(
  update: WindowSnapshot["update"],
): boolean {
  const preference = update.automaticUpdatePreference;
  return (
    preference?.status === "confirmed" &&
    preference.enabled &&
    preference.scope === "download-and-install"
  );
}

export function automaticUpdateAvailable(snapshot: WindowSnapshot): boolean {
  const update = snapshot.update;
  const intent = snapshot.intents["update-automatic-downloads"];
  const quitIntent = snapshot.intents["update-install-on-quit"];
  return (
    snapshot.environment === "preview" &&
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    Boolean(snapshot.buildId) &&
    update.automaticUpdatePreference?.status === "confirmed" &&
    intent?.state !== "pending" &&
    intent?.state !== "unknown" &&
    quitIntent?.state !== "pending" &&
    quitIntent?.state !== "unknown" &&
    snapshot.intents.update?.state !== "pending" &&
    snapshot.intents.update?.state !== "unknown" &&
    update.phase !== "checking" &&
    update.phase !== "downloading" &&
    update.phase !== "applying" &&
    update.phase !== "recovery" &&
    !(update.phase === "failed" && update.code.includes("UNKNOWN")) &&
    !(update.phase === "ready" && update.blockedBy?.includes("UNKNOWN"))
  );
}
