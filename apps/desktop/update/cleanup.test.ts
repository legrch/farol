import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { settleCleanupMarker } from "./cleanup";

let home: string;
let root: string;
let file: string;
beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-cleanup-")),
  );
  root = path.join(home, "installed-updates");
  await fs.mkdir(root, { mode: 0o700 });
  file = path.join(root, "package-cleanup-pending.json");
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});
const marker = (extra: Record<string, unknown> = {}) => ({
  schema: "farol.update-package-cleanup/1",
  handle: path.join(root, "github-updates/archive.zip"),
  ...extra,
});
async function settle(
  content: unknown,
  extractionsGone = true,
  reread: () => Promise<unknown> = async () => content,
  captured: "root" | "none" | { dev: bigint; ino: bigint } = "root",
) {
  await fs.writeFile(file, JSON.stringify(content), { mode: 0o600 });
  const stat = await fs.lstat(root, { bigint: true });
  const cleared = await settleCleanupMarker({
    root,
    file,
    marker: content,
    extractionsGone,
    rootIdentity:
      captured === "root"
        ? { dev: stat.dev, ino: stat.ino }
        : captured === "none"
          ? null
          : captured,
    read: reread,
  });
  return {
    cleared,
    present: await fs.lstat(file).then(
      () => true,
      () => false,
    ),
  };
}

describe("cleanup marker settlement", () => {
  it("clears a well formed handle marker once every extraction is gone", async () => {
    expect(await settle(marker())).toEqual({ cleared: true, present: false });
  });
  it("accepts a handle inside a download directory and a dotted directory name", async () => {
    for (const handle of [
      path.join(root, `download-${"a".repeat(32)}/github-updates/x.zip`),
      path.join(root, "..hidden/x.zip"),
    ])
      expect((await settle(marker({ handle }))).cleared).toBe(true);
  });
  it("keeps the fence while an extraction remains or its outcome is unknown", async () => {
    expect(await settle(marker(), false)).toEqual({
      cleared: false,
      present: true,
    });
  });
  it.each([
    ["outside the root", () => path.join(home, "other/archive.zip")],
    ["the root itself", () => root],
    ["a sibling sharing the root's prefix", () => `${root}-evil/archive.zip`],
    ["a climb out of the root", () => `${root}/../other/archive.zip`],
    ["a redundant segment", () => `${root}//github-updates/archive.zip`],
    ["a relative path", () => "github-updates/archive.zip"],
  ])("keeps the fence for a handle that is %s", async (_name, handle) => {
    expect(await settle(marker({ handle: handle() }))).toEqual({
      cleared: false,
      present: true,
    });
  });
  it.each([
    ["a NUL in the handle", () => marker({ handle: `${root}/a\u0000b.zip` })],
    ["a newline in the handle", () => marker({ handle: `${root}/a\nb.zip` })],
    [
      "a NUL in the operation root",
      () => marker({ operationRoot: `${root}/${"e".repeat(32)}\u0000` }),
    ],
  ])("keeps the fence for a marker with %s", async (_name, content) => {
    expect(await settle(content())).toEqual({ cleared: false, present: true });
  });
  it.each([
    ["an unknown field", () => marker({ extra: 1 })],
    ["another schema", () => marker({ schema: "farol.other/1" })],
    ["a missing handle", () => ({ schema: "farol.update-package-cleanup/1" })],
    ["an empty handle", () => marker({ handle: "" })],
    ["an array", () => []],
    ["a string", () => "pending"],
  ])("keeps the fence for a marker with %s", async (_name, content) => {
    expect(await settle(content())).toEqual({ cleared: false, present: true });
  });
  describe("with an operation root", () => {
    const operation = () => path.join(root, "a".repeat(32));
    it("clears it when no prepared copy remains", async () => {
      await fs.mkdir(operation());
      expect(await settle(marker({ operationRoot: operation() }))).toEqual({
        cleared: true,
        present: false,
      });
    });
    it("clears it when the operation root itself is gone", async () => {
      expect(
        (await settle(marker({ operationRoot: operation() }))).cleared,
      ).toBe(true);
    });
    it("keeps the fence while a prepared copy remains", async () => {
      await fs.mkdir(path.join(operation(), "staged.app"), { recursive: true });
      expect(await settle(marker({ operationRoot: operation() }))).toEqual({
        cleared: false,
        present: true,
      });
      expect(
        await fs.lstat(path.join(operation(), "staged.app")),
      ).toBeDefined();
    });
    it("keeps the fence while a prepared copy remains, even as a symlink", async () => {
      await fs.mkdir(operation());
      await fs.symlink(home, path.join(operation(), "staged.app"));
      expect(
        (await settle(marker({ operationRoot: operation() }))).cleared,
      ).toBe(false);
    });
    it.each([
      ["outside the root", () => path.join(home, "a".repeat(32))],
      ["not a direct child", () => path.join(root, "x", "a".repeat(32))],
      ["not an operation name", () => path.join(root, "operation")],
      [
        "a download directory",
        () => path.join(root, `download-${"a".repeat(32)}`),
      ],
    ])(
      "keeps the fence for an operation root that is %s",
      async (_name, value) => {
        expect((await settle(marker({ operationRoot: value() }))).cleared).toBe(
          false,
        );
      },
    );
  });
  it("does not clear a marker that changed after it was judged", async () => {
    expect(
      await settle(marker(), true, async () => marker({ handle: root + "/y" })),
    ).toEqual({ cleared: false, present: true });
  });
  describe("the root the outcome was about", () => {
    it("keeps the fence when the reclaim captured no root", async () => {
      expect(await settle(marker(), true, undefined, "none")).toEqual({
        cleared: false,
        present: true,
      });
    });
    it("keeps the fence when the root is no longer the captured directory", async () => {
      const stat = await fs.lstat(root, { bigint: true });
      expect(
        await settle(marker(), true, undefined, {
          dev: stat.dev,
          ino: stat.ino + 1n,
        }),
      ).toEqual({ cleared: false, present: true });
    });
    it("keeps the fence when the root became a symlink after the pass", async () => {
      const content = marker();
      await fs.writeFile(file, JSON.stringify(content), { mode: 0o600 });
      const stat = await fs.lstat(root, { bigint: true });
      const moved = `${root}.moved`;
      const cleared = await settleCleanupMarker({
        root,
        file,
        marker: content,
        extractionsGone: true,
        rootIdentity: { dev: stat.dev, ino: stat.ino },
        read: async () => {
          // Between the last read of the marker and the unlink.
          await fs.rename(root, moved);
          await fs.symlink(moved, root);
          return content;
        },
      });
      expect(cleared).toBe(false);
      expect(
        await fs.lstat(path.join(moved, "package-cleanup-pending.json")),
      ).toBeDefined();
    });
  });
});
