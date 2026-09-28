import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnerPreviewIdle,
  readOwnedStartupMarker,
} from "../e2e/native-preview-admission.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-native-admission-"),
  );
  roots.push(value);
  return value;
}

describe("native owner Preview admission", () => {
  it("accepts an absent marker without creating state", async () => {
    const base = await root();
    const missing = path.join(base, "missing");
    await expect(assertOwnerPreviewIdle(missing)).resolves.toEqual({
      stateRoot: missing,
      marker: "absent",
    });
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["regular", "symlink", "directory"])(
    "refuses an existing %s marker without changing it",
    async (kind) => {
      const base = await root();
      const marker = path.join(base, "running.json");
      if (kind === "regular")
        await fs.writeFile(marker, "private marker bytes");
      if (kind === "symlink")
        await fs.symlink(path.join(base, "not-readable-target"), marker);
      if (kind === "directory") await fs.mkdir(marker);
      const before = await fs.lstat(marker);
      await expect(assertOwnerPreviewIdle(base)).rejects.toThrow(
        "NATIVE_OWNER_PREVIEW_NOT_CONFIRMED_IDLE",
      );
      const after = await fs.lstat(marker);
      expect([after.dev, after.ino, after.size, after.mtimeMs]).toEqual([
        before.dev,
        before.ino,
        before.size,
        before.mtimeMs,
      ]);
    },
  );
  it("refuses an unavailable metadata observation", async () => {
    await expect(
      assertOwnerPreviewIdle("/fixture", async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).rejects.toThrow("NATIVE_OWNER_PREVIEW_STATE_UNREADABLE");
  });
});

describe("owned native startup witness", () => {
  const marker = {
    schema: 1,
    pid: process.pid,
    startedAt: "2026-09-29T00:00:00.000Z",
    bootTime: null,
    processStart: null,
  };
  async function state() {
    const base = await root();
    const owned = path.join(base, "user-data/farol-next-state");
    await fs.mkdir(owned, { recursive: true });
    await fs.writeFile(
      path.join(owned, "running.json"),
      JSON.stringify(marker),
      { mode: 0o600 },
    );
    return { base, owned, file: path.join(owned, "running.json") };
  }
  it("correlates the actual private marker with the launched process", async () => {
    const { base, owned } = await state();
    await expect(
      readOwnedStartupMarker(owned, base, process.pid),
    ).resolves.toEqual(marker);
  });
  it("rejects an outside state root and a different process", async () => {
    const { base, owned } = await state();
    const other = await root();
    await expect(
      readOwnedStartupMarker(owned, other, process.pid),
    ).rejects.toThrow("NATIVE_STARTUP_STATE_NOT_OWNED");
    await expect(
      readOwnedStartupMarker(owned, base, process.pid + 1),
    ).rejects.toThrow("NATIVE_STARTUP_MARKER_WRONG_PROCESS");
  });
  it.each(["symlink", "directory", "oversized"])(
    "rejects a %s marker without consuming it as a stream",
    async (kind) => {
      const { base, owned, file } = await state();
      await fs.unlink(file);
      if (kind === "symlink")
        await fs.symlink(path.join(base, "missing-target"), file);
      if (kind === "directory") await fs.mkdir(file);
      if (kind === "oversized") await fs.writeFile(file, "x".repeat(4097));
      await expect(
        readOwnedStartupMarker(owned, base, process.pid),
      ).rejects.toThrow("NATIVE_STARTUP_MARKER_TYPE_OR_SIZE");
    },
  );
});
