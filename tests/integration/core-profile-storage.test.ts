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
  it("adds only Go storage to a retained pre-Go desktop directory", () => {
    const root = fixture();
    // Invented bytes only; no real configuration, credential or transcript.
    const retained = new Map([
      ["configuration.json", "synthetic configuration and read-only grants\n"],
      ["connector-reference.json", "synthetic credential reference\n"],
      ["last-quit.json", "synthetic unconfirmed quit\n"],
      ["installed-updates/retained.json", "synthetic unknown operation\n"],
    ]);
    fs.mkdirSync(path.join(root, "installed-updates"), { mode: 0o700 });
    for (const [name, bytes] of retained)
      fs.writeFileSync(path.join(root, name), bytes, { mode: 0o600 });
    const before = new Map(
      [...retained.keys()].map((name) => [
        name,
        fs.lstatSync(path.join(root, name), { bigint: true }),
      ]),
    );
    const selected = openNativeProfileStorage(root, "computer");
    expect(selected.storeMode).toBe("create");
    for (const [name, bytes] of retained) {
      const after = fs.lstatSync(path.join(root, name), { bigint: true });
      const original = before.get(name)!;
      for (const field of [
        "dev",
        "ino",
        "mode",
        "nlink",
        "size",
        "mtimeNs",
        "ctimeNs",
      ] as const)
        expect(after[field]).toBe(original[field]);
      expect(fs.readFileSync(path.join(root, name), "utf8")).toBe(bytes);
    }
    expect(fs.readdirSync(path.join(root, "installed-updates"))).toEqual([
      "retained.json",
    ]);
    for (const child of ["chat", "task", "computer/mutations"])
      expect(fs.readdirSync(path.join(selected.root, child))).toEqual([]);
    expect(fs.readdirSync(path.join(selected.root, "computer"))).toEqual([
      "mutations",
    ]);
    const marker = JSON.parse(
      fs.readFileSync(path.join(selected.root, "profile.json"), "utf8"),
    );
    expect(marker).toEqual({
      schema: "farol-native-profile/2",
      profileId: selected.profileId,
      computerId: "computer",
    });
    // Selection alone has not opened Go or made any retained desktop record
    // safe to consume. It must not copy grants or settle those records.
  });
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
