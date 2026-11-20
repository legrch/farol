import { describe, expect, it } from "vitest";

import {
  classifyWorkspaceRootDrift,
  ownerRebindAllowed,
  startupDataDevice,
  STARTUP_DATA_MOUNT,
} from "./drift";

// Values from the 2026-11-20 incident: the home folder kept inode 335036
// while the startup Data volume moved from device 16777231 to 16777233.
const before = { device: "16777231", inode: "335036" };
const afterReboot = { device: "16777233", inode: "335036" };

describe("workspace root drift", () => {
  it("classifies the reboot renumbering separately from a different folder", () => {
    expect(classifyWorkspaceRootDrift(before, before)).toBe("same");
    expect(classifyWorkspaceRootDrift(before, afterReboot)).toBe(
      "device-renumbered",
    );
    expect(
      classifyWorkspaceRootDrift(before, { device: "16777231", inode: "1" }),
    ).toBe("different-object");
    expect(classifyWorkspaceRootDrift(undefined, afterReboot)).toBe(
      "unmeasured",
    );
    expect(classifyWorkspaceRootDrift(before, null)).toBe("unmeasured");
  });

  it("allows an owner rebind only onto the current startup Data volume", () => {
    expect(ownerRebindAllowed(before, afterReboot, "16777233")).toBe(true);
    // A copied disk image mounted at the same path keeps the inode but has
    // its own device, which is not the startup Data volume.
    expect(
      ownerRebindAllowed(
        before,
        { device: "16777250", inode: "335036" },
        "16777233",
      ),
    ).toBe(false);
    expect(ownerRebindAllowed(before, afterReboot, null)).toBe(false);
    expect(ownerRebindAllowed(before, before, "16777231")).toBe(false);
    expect(
      ownerRebindAllowed(
        before,
        { device: "16777233", inode: "7" },
        "16777233",
      ),
    ).toBe(false);
    expect(ownerRebindAllowed(undefined, afterReboot, "16777233")).toBe(false);
  });

  it("reads the startup Data device from its fixed mount and refuses anything odd", async () => {
    const seen: string[] = [];
    const directory = (dev: bigint) => async (path: string) => {
      seen.push(path);
      return { isDirectory: () => true, dev };
    };
    expect(await startupDataDevice(directory(16777233n))).toBe("16777233");
    expect(seen).toEqual([STARTUP_DATA_MOUNT]);
    expect(await startupDataDevice(directory(0n))).toBeNull();
    expect(
      await startupDataDevice(async () => ({
        isDirectory: () => false,
        dev: 1n,
      })),
    ).toBeNull();
    expect(
      await startupDataDevice(async () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});
