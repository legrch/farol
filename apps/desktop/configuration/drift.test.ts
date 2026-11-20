import { describe, expect, it } from "vitest";

import { classifyWorkspaceRootDrift } from "./drift";

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
});
