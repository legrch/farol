import { lstat } from "node:fs/promises";

import type { WorkspaceRootIdentity } from "../../../src/pkg/product-settings/contract";

/**
 * How a saved workspace root compares with the directory now at its path.
 *
 * - `same`: device and inode both match.
 * - `device-renumbered`: same inode, different device. macOS renumbers the
 *   startup Data volume at boot, so this is the ordinary reboot case, but it is
 *   NOT proof of the same folder on its own: a copied disk image mounted at the
 *   same path keeps the inode and gets a new device.
 * - `different-object`: the inode differs; this is another directory.
 * - `unmeasured`: nothing to compare (unbound record or no directory now).
 */
export type WorkspaceRootDrift =
  "same" | "device-renumbered" | "different-object" | "unmeasured";

export function classifyWorkspaceRootDrift(
  bound: WorkspaceRootIdentity | undefined,
  measured: WorkspaceRootIdentity | null,
): WorkspaceRootDrift {
  if (!bound || !measured) return "unmeasured";
  if (bound.inode !== measured.inode) return "different-object";
  return bound.device === measured.device ? "same" : "device-renumbered";
}

/**
 * The startup Data volume is mounted by macOS at this fixed path. A folder on
 * it reports the same device as this mount point. A disk image or external
 * volume mounted over a workspace path reports its own, different device.
 */
export const STARTUP_DATA_MOUNT = "/System/Volumes/Data";

export async function startupDataDevice(
  measure: (
    path: string,
  ) => Promise<{ isDirectory(): boolean; dev: bigint }> = (path) =>
    lstat(path, { bigint: true }),
): Promise<string | null> {
  try {
    const measured = await measure(STARTUP_DATA_MOUNT);
    return measured.isDirectory() && measured.dev > 0n
      ? String(measured.dev)
      : null;
  } catch {
    return null;
  }
}

/**
 * Owner Verify may move a binding to a new device number only when the inode is
 * unchanged AND the folder now lives on the current startup Data volume. Every
 * other mismatch keeps WORKSPACE_ROOT_CHANGED and needs the folder picker.
 */
export function ownerRebindAllowed(
  bound: WorkspaceRootIdentity | undefined,
  measured: WorkspaceRootIdentity | null,
  startupData: string | null,
): boolean {
  return (
    classifyWorkspaceRootDrift(bound, measured) === "device-renumbered" &&
    startupData !== null &&
    measured!.device === startupData
  );
}
