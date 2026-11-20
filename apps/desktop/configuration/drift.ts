import type { WorkspaceRootIdentity } from "../../../src/pkg/product-settings/contract";

/**
 * How a saved workspace root compares with the directory now at its path.
 *
 * - `same`: device and inode both match.
 * - `device-renumbered`: same inode, different device. macOS renumbers the
 *   startup Data volume at boot, so this is the ordinary reboot case, but it is
 *   NOT proof of the same folder: a copied disk image mounted at the same path
 *   keeps the inode, and a same-inode directory can appear once a mount over
 *   the path goes away. Only enrolled continuity evidence may rebind it.
 * - `different-object`: the inode differs; this is another directory.
 * - `unmeasured`: nothing to compare (unbound record or no directory now).
 *
 * The classification is an observation. It never authorizes a rebind.
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
