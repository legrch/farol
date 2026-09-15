import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";

describe("packaged tree identity", () => {
  it("binds entry type as well as path, mode, and payload", async () => {
    const fileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-digest-file-"),
    );
    const linkRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-digest-link-"),
    );
    try {
      const file = path.join(fileRoot, "entry");
      await fs.writeFile(file, "target");
      await fs.chmod(file, 0o755);
      await fs.writeFile(path.join(linkRoot, "target"), "target");
      await fs.symlink("target", path.join(linkRoot, "entry"));

      expect(await treeDigest(fileRoot)).not.toBe(await treeDigest(linkRoot));
    } finally {
      await fs.rm(fileRoot, { recursive: true, force: true });
      await fs.rm(linkRoot, { recursive: true, force: true });
    }
  });

  it("rejects absolute and escaping symlinks in a packaged tree", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-digest-escape-"),
    );
    try {
      await fs.mkdir(path.join(root, "nested"));
      await fs.symlink("../../../outside", path.join(root, "nested/escape"));
      await expect(treeDigest(root)).rejects.toThrow(
        "ARTIFACT_SYMLINK_ESCAPES_ROOT",
      );
      await fs.rm(path.join(root, "nested/escape"));
      await fs.symlink("/tmp/outside", path.join(root, "nested/absolute"));
      await expect(treeDigest(root)).rejects.toThrow(
        "ARTIFACT_SYMLINK_ESCAPES_ROOT",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
