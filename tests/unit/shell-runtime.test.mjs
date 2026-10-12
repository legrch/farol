import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { attestShellRuntime } from "../../apps/desktop/bridge/shell-runtime.ts";

const roots = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});
async function fixture() {
  // Synthetic filesystem only: no executable, profile, issuer or child.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "farol-runtime-fixture-")),
  );
  roots.push(root);
  const app = path.join(root, "Farol.app");
  const runtime = path.join(app, "Contents/Frameworks/Electron Runtime.app");
  const executable = path.join(runtime, "Contents/MacOS/Electron");
  const resource = path.join(runtime, "Contents/Resources/data");
  await fs.mkdir(path.dirname(executable), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.dirname(resource), { recursive: true, mode: 0o755 });
  await fs.writeFile(executable, "synthetic helper bytes", { mode: 0o700 });
  await fs.writeFile(resource, "synthetic resource bytes", { mode: 0o600 });
  await fs.symlink("Contents/Resources", path.join(runtime, "Resources"));
  const { declaration } = JSON.parse(
    await fs.readFile(
      new URL("../fixtures/shell-launch.json", import.meta.url),
      "utf8",
    ),
  );
  declaration.watchdog.sha256 = createHash("sha256")
    .update("synthetic helper bytes")
    .digest("hex");
  declaration.runtime.treeSHA256 = await treeDigest(runtime);
  return { root, app, runtime, executable, resource, declaration };
}
const run = (f) =>
  attestShellRuntime(f.app, f.declaration, performance.now() + 10_000);
const refused = { state: "refused", code: "shell_runtime_unqualified" };

describe("Shell nested runtime qualification", () => {
  it("matches the existing package v2 digest and returns the original immutable app identity", async () => {
    const f = await fixture();
    const result = await run(f);
    const stat = await fs.lstat(f.app, { bigint: true });
    expect(result).toEqual({
      path: f.app,
      device: String(stat.dev),
      inode: String(stat.ino),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    ["changed bytes", async (f) => fs.writeFile(f.resource, "changed")],
    [
      "extra file",
      async (f) => fs.writeFile(path.join(f.runtime, "extra"), "extra"),
    ],
    ["missing file", async (f) => fs.unlink(f.resource)],
    ["writable file", async (f) => fs.chmod(f.resource, 0o666)],
    [
      "writable directory",
      async (f) => fs.chmod(path.dirname(f.resource), 0o777),
    ],
    ["non-executable helper", async (f) => fs.chmod(f.executable, 0o400)],
    [
      "external hardlink",
      async (f) => fs.link(f.resource, path.join(f.root, "alias")),
    ],
    [
      "oversize file",
      async (f) => fs.truncate(f.resource, 512 * 1024 * 1024 + 1),
    ],
    [
      "external symlink",
      async (f) => {
        await fs.unlink(path.join(f.runtime, "Resources"));
        await fs.symlink("../../../../", path.join(f.runtime, "Resources"));
      },
    ],
    [
      "dangling symlink",
      async (f) => fs.symlink("missing", path.join(f.runtime, "dangling")),
    ],
    [
      "redirected runtime",
      async (f) => {
        await fs.rename(f.runtime, path.join(f.root, "external-runtime"));
        await fs.symlink(path.join(f.root, "external-runtime"), f.runtime);
      },
    ],
  ])("refuses %s before returning a selection", async (_name, change) => {
    const f = await fixture();
    await change(f);
    await expect(run(f)).rejects.toMatchObject(refused);
  });
  it("rejects hardlinks even when the package digest itself is unchanged", async () => {
    const f = await fixture();
    await fs.link(f.resource, path.join(f.root, "alias"));
    expect(await treeDigest(f.runtime)).toBe(f.declaration.runtime.treeSHA256);
    await expect(run(f)).rejects.toMatchObject(refused);
  });
  it("checks the helper hash independently of the whole runtime expectation", async () => {
    const f = await fixture();
    f.declaration.watchdog.sha256 = "9".repeat(64);
    await expect(run(f)).rejects.toMatchObject(refused);
  });
  it("detects a previously hashed file changed during later traversal", async () => {
    const f = await fixture();
    const original = fs.lstat.bind(fs);
    let changed = false;
    vi.spyOn(fs, "lstat").mockImplementation(async (file, options) => {
      if (file === f.resource && !changed) {
        changed = true;
        await fs.writeFile(f.executable, "changed after helper hash");
      }
      return original(file, options);
    });
    await expect(run(f)).rejects.toMatchObject(refused);
    expect(changed).toBe(true);
    expect(await fs.readFile(f.executable, "utf8")).toBe(
      "changed after helper hash",
    );
  });
  it("refuses alias app roots and invalid original deadlines", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "Alias.app");
    await fs.symlink(f.app, alias);
    await expect(
      attestShellRuntime(alias, f.declaration, performance.now() + 10_000),
    ).rejects.toMatchObject(refused);
    for (const deadline of [NaN, Infinity, -1, performance.now() + 31_000]) {
      await expect(
        attestShellRuntime(f.app, f.declaration, deadline),
      ).rejects.toMatchObject(refused);
    }
  });
  it("consumes the original deadline while hashing rather than renewing it", async () => {
    const f = await fixture();
    const original = fs.lstat.bind(fs);
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now);
    vi.spyOn(fs, "lstat").mockImplementation(async (file, options) => {
      if (file === f.resource)
        vi.mocked(performance.now).mockReturnValue(now + 101);
      return original(file, options);
    });
    await expect(
      attestShellRuntime(f.app, f.declaration, now + 100),
    ).rejects.toMatchObject(refused);
  });
});
