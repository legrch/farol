import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePackagedFileModes } from "../../tooling/package-file-modes.mjs";

const roots = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-package-modes-"));
  roots.push(root);
  const files = [
    ["farol-backend", 0o500, 0o700],
    ["tunnel-client", 0o500, 0o700],
    ["tunnel-client-LICENSE.txt", 0o400, 0o600],
    ["tunnel-client-NOTICE.txt", 0o400, 0o600],
  ];
  for (const [name, mode] of files) {
    const file = path.join(root, name);
    await fs.writeFile(file, `fixture ${name}`, { mode });
    await fs.chmod(file, mode);
  }
  return { root, files };
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe("packaged Farol-owned file modes", () => {
  it("makes only the packaged files owner writable while preserving bytes", async () => {
    const { root, files } = await fixture();
    const before = new Map();
    for (const [name] of files)
      before.set(name, digest(await fs.readFile(path.join(root, name))));
    await normalizePackagedFileModes(root, { hasGoCore: true });
    for (const [name, , expected] of files) {
      const file = path.join(root, name);
      expect((await fs.lstat(file)).mode & 0o777).toBe(expected);
      expect(digest(await fs.readFile(file))).toBe(before.get(name));
    }
  });

  it("refuses a symlink instead of changing its target", async () => {
    const { root } = await fixture();
    const outside = path.join(root, "outside");
    await fs.writeFile(outside, "keep", { mode: 0o400 });
    await fs.chmod(outside, 0o400);
    await fs.unlink(path.join(root, "farol-backend"));
    await fs.symlink(outside, path.join(root, "farol-backend"));
    await expect(
      normalizePackagedFileModes(root, { hasGoCore: true }),
    ).rejects.toThrow();
    expect((await fs.lstat(outside)).mode & 0o777).toBe(0o400);
  });
});
