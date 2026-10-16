import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";

// Real disposable filesystem and original Settings schema. No Go process,
// Electron, authority, provider, migration or installed profile is exercised.
const roots: string[] = [];
async function fixture(seed = true) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-recovery-settings-")),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  const store = new ProductSettingsStore({ root });
  if (seed) await new ProductConfigurationService(store).initialize();
  return { root, store, file: path.join(root, "config.json") };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
const fields = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
] as const;
async function fingerprint(file: string) {
  const stat = await fs.lstat(file, { bigint: true });
  return {
    bytes: await fs.readFile(file),
    metadata: fields.map((field) => stat[field]),
  };
}

describe("existing-only Settings input for recovery", () => {
  it("reads saved Settings while preserving configuration and interrupted-session evidence", async () => {
    const f = await fixture();
    const expected = await f.store.load();
    const marker = path.join(f.root, "running.json");
    await fs.writeFile(
      marker,
      "synthetic interrupted predecessor; UNKNOWN remains UNKNOWN\n",
      { mode: 0o600 },
    );
    const before = await fingerprint(f.file);
    const retained = await fingerprint(marker);
    const noMkdir = vi.spyOn(fs, "mkdir");
    const noChmod = vi.spyOn(fs, "chmod");
    const noWrite = vi.spyOn(fs, "writeFile");
    const noRename = vi.spyOn(fs, "rename");
    expect(await f.store.loadExisting()).toEqual(expected);
    expect(await fingerprint(f.file)).toEqual(before);
    expect(await fingerprint(marker)).toEqual(retained);
    for (const call of [noMkdir, noChmod, noWrite, noRename])
      expect(call).not.toHaveBeenCalled();
  });
  it("returns absence without provisioning defaults", async () => {
    const f = await fixture(false);
    expect(await f.store.loadExisting()).toBeNull();
    expect(await fs.readdir(f.root)).toEqual([]);
    const missing = new ProductSettingsStore({
      root: path.join(f.root, "absent"),
    });
    await expect(missing.loadExisting()).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("refuses an unsafe root without changing its permissions", async () => {
    const f = await fixture();
    await fs.chmod(f.root, 0o755);
    await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
    expect((await fs.lstat(f.root)).mode & 0o777).toBe(0o755);
  });
  it.each(["symlink", "hardlink", "permissions"])(
    "refuses %s configuration without repairing it",
    async (kind) => {
      const f = await fixture();
      const other = path.join(f.root, "retained.json");
      if (kind === "symlink") {
        await fs.rename(f.file, other);
        await fs.symlink(other, f.file);
      } else if (kind === "hardlink") await fs.link(f.file, other);
      else await fs.chmod(f.file, 0o644);
      const before = await fs.lstat(f.file, { bigint: true });
      await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
      const after = await fs.lstat(f.file, { bigint: true });
      for (const field of fields) expect(after[field]).toBe(before[field]);
    },
  );
  it("retains a legacy-named configuration and refuses migration", async () => {
    const f = await fixture();
    const legacy = path.join(f.root, "product-settings.json");
    await fs.rename(f.file, legacy);
    const before = await fingerprint(legacy);
    await expect(f.store.loadExisting()).rejects.toThrow(
      "CONFIG_RENAME_REQUIRED",
    );
    expect(await fingerprint(legacy)).toEqual(before);
    expect(await fs.readdir(f.root)).toEqual(["product-settings.json"]);
  });
  it.each(["schema", "oversize", "utf8"])(
    "retains corrupt %s input without defaults or writes",
    async (kind) => {
      const f = await fixture();
      const original = await fs.readFile(f.file);
      const bytes =
        kind === "schema"
          ? Buffer.from('{"schema":"unknown"}')
          : kind === "oversize"
            ? Buffer.alloc(256 * 1024 + 1, 0x20)
            : Buffer.concat([
                original.subarray(0, original.length - 1),
                Buffer.from([0xff]),
              ]);
      await fs.writeFile(f.file, bytes);
      const before = await fingerprint(f.file);
      await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_CORRUPT");
      expect(await fingerprint(f.file)).toEqual(before);
    },
  );
  it.each(["replace", "modify"])(
    "withholds Settings when the document changes during read: %s",
    async (kind) => {
      const f = await fixture();
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        Object.defineProperty(handle, "read", {
          value: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => {
            const result = await originalRead(buffer, offset, length, position);
            if (kind === "replace") {
              const replacement = path.join(f.root, "replacement.json");
              await fs.writeFile(replacement, "synthetic changed source", {
                mode: 0o600,
              });
              await fs.rename(replacement, f.file);
            } else await fs.appendFile(f.file, " ");
            return result;
          },
        });
        return handle;
      });
      await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
    },
  );
});
