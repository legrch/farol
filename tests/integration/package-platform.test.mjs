import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageInfoPlist } from "../../tooling/package-platform.mjs";
import { plistValue } from "../../tooling/runtime-contract.mjs";

// Synthetic vendor metadata and native PlistBuddy only. These fixtures do not
// authenticate Electron, package an app, or qualify a clean Mac or Go/shell OS.
const roots = [];
const failure = "PACKAGE_RUNTIME_MINIMUM_SYSTEM_VERSION_INVALID";
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(floor) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-package-platform-"),
  );
  roots.push(root);
  const runtimePlist = path.join(root, "vendor.plist");
  await fs.writeFile(
    runtimePlist,
    '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
  );
  if (floor !== undefined) {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      "Add :LSMinimumSystemVersion string",
      runtimePlist,
    ]);
    // JSON-quoted PlistBuddy argument keeps malicious XML as a string value.
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :LSMinimumSystemVersion ${JSON.stringify(floor)}`,
      runtimePlist,
    ]);
  }
  return { root, runtimePlist, bundleVersion: "0.2.0", buildVersion: "17" };
}

describe("package macOS runtime floor", () => {
  it.each(["13.0", "14.2.1", "15.10"])(
    "advertises the vendor floor %s in a native-readable outer plist",
    async (floor) => {
      const input = await fixture(floor);
      expect(plistValue(input.runtimePlist, "LSMinimumSystemVersion")).toBe(
        floor,
      );
      const outerPlist = path.join(input.root, "outer.plist");
      await fs.writeFile(outerPlist, packageInfoPlist(input));
      execFileSync("/usr/bin/plutil", ["-lint", outerPlist]);
      expect(plistValue(outerPlist, "LSMinimumSystemVersion")).toBe(floor);
      expect(plistValue(outerPlist, "CFBundleIdentifier")).toBe(
        "local.farol.next.preview",
      );
      expect(plistValue(outerPlist, "CFBundleExecutable")).toBe(
        "Farol Next Preview",
      );
      expect(plistValue(outerPlist, "CFBundleShortVersionString")).toBe(
        "0.2.0",
      );
      expect(plistValue(outerPlist, "CFBundleVersion")).toBe("17");
    },
  );

  it("replaces a previously advertised lower floor with the vendor floor", async () => {
    const input = await fixture("13.0");
    const outerPlist = path.join(input.root, "outer.plist");
    await fs.copyFile(input.runtimePlist, outerPlist);
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      "Set :LSMinimumSystemVersion 12.0",
      outerPlist,
    ]);
    expect(plistValue(outerPlist, "LSMinimumSystemVersion")).toBe("12.0");
    await fs.writeFile(outerPlist, packageInfoPlist(input));
    expect(plistValue(outerPlist, "LSMinimumSystemVersion")).toBe("13.0");
  });

  it("fails closed when the vendor floor is missing", async () => {
    const input = await fixture(undefined);
    expect(() => packageInfoPlist(input)).toThrow(failure);
  });

  it("fails closed when the vendor plist is malformed", async () => {
    const input = await fixture("13.0");
    await fs.writeFile(input.runtimePlist, "not a plist");
    expect(() => packageInfoPlist(input)).toThrow(failure);
  });

  it.each([
    "",
    "13",
    "13.0.0.1",
    "013.0",
    "13.00",
    "13.0.01",
    "0.0",
    "-13.0",
    "13.x",
    "13.0-beta",
    "13.0</string><key>Injected</key><string>yes",
    "<script>13.0</script>",
  ])("rejects a noncanonical or injectable floor %j", async (floor) => {
    const input = await fixture(floor);
    expect(() => packageInfoPlist(input)).toThrow(failure);
  });
});
