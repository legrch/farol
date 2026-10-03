import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNativeProfileStorage } from "../../apps/desktop/bridge/profile-storage.ts";

// Real disposable private filesystem only. These tests launch no Go backend,
// browser or provider and do not establish journal retirement/reopen permission.
const roots: string[] = [];
function fixture() {
  if (process.platform !== "darwin")
    throw new Error("DARWIN_PROFILE_TEST_REQUIRED");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "farol-profile-storage-")),
  );
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
describe("native profile storage selection", () => {
  it("creates once and reuses the same identity without recreating journals", () => {
    const root = fixture();
    const first = openNativeProfileStorage(root, "computer");
    expect(first.storeMode).toBe("create");
    fs.writeFileSync(path.join(first.root, "computer", "sentinel"), "retained");
    const next = openNativeProfileStorage(root, "computer");
    expect(next).toEqual({ ...first, storeMode: "open" });
    expect(
      fs.readFileSync(path.join(first.root, "computer", "sentinel"), "utf8"),
    ).toBe("retained");
  });
  it("never adopts another computer's retained profile", () => {
    const root = fixture();
    const first = openNativeProfileStorage(root, "original");
    expect(() => openNativeProfileStorage(root, "other")).toThrow(
      "native_profile_storage_invalid",
    );
    expect(openNativeProfileStorage(root, "original").profileId).toBe(
      first.profileId,
    );
  });
  it("refuses partial initialization without silently completing it", () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, "go-core"), { mode: 0o700 });
    expect(() => openNativeProfileStorage(root, "computer")).toThrow();
    expect(fs.readdirSync(path.join(root, "go-core"))).toEqual([]);
  });
  it("refuses redirected root and leaves the target untouched", () => {
    const root = fixture();
    const other = fixture();
    fs.symlinkSync(other, path.join(root, "go-core"));
    expect(() => openNativeProfileStorage(root, "computer")).toThrow(
      "native_profile_storage_invalid",
    );
    expect(fs.readdirSync(other)).toEqual([]);
  });
  it("refuses a non-private parent before creating anything", () => {
    const root = fixture();
    fs.chmodSync(root, 0o755);
    expect(() => openNativeProfileStorage(root, "computer")).toThrow(
      "native_profile_storage_invalid",
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it.each(["symlink", "hardlink", "oversized", "unknown-field"])(
    "refuses %s marker without changing retained state",
    (kind) => {
      const root = fixture();
      const first = openNativeProfileStorage(root, "computer");
      const marker = path.join(first.root, "profile.json");
      if (kind === "oversized") fs.writeFileSync(marker, " ".repeat(4097));
      else if (kind === "unknown-field") {
        const value = JSON.parse(fs.readFileSync(marker, "utf8"));
        fs.writeFileSync(marker, JSON.stringify({ ...value, approval: true }));
      } else {
        const other = path.join(first.root, "original.json");
        fs.renameSync(marker, other);
        if (kind === "symlink") fs.symlinkSync(other, marker);
        else fs.linkSync(other, marker);
      }
      expect(() => openNativeProfileStorage(root, "computer")).toThrow();
      expect(fs.existsSync(first.root)).toBe(true);
    },
  );
});
