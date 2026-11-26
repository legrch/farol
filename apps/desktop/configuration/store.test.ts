import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";
import { ProductSettingsStore } from "./store";

// Real disposable directories only; the one injected fault at a time is an
// explicit spy on the filesystem call under test. The store is the durable
// `config.json` writer, so these tests pin the on-disk byte format, the file
// and directory modes, the open flags, every refusal code, the order of fsync,
// the hooks and the rename, and the fail-closed "publication unknown" latch.

const UUID = "12345678-1234-4234-8234-123456789abc";
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const MAXIMUM_BYTES = 256 * 1024;

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const settings = (revision = 1): ProductSettings => ({
  ...defaultSettings(() => UUID),
  revision,
});

async function scratch(): Promise<string> {
  // realpath: the recovery reader refuses a root that is reached via a link.
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-store-")),
  );
  roots.push(dir);
  return dir;
}

async function fixture(
  hooks: ConstructorParameters<typeof ProductSettingsStore>[1] = {},
) {
  const parent = await scratch();
  const root = path.join(parent, "state");
  const store = new ProductSettingsStore({ root }, hooks);
  return { parent, root, store, file: path.join(root, "config.json") };
}

// A root that already exists with the modes the recovery reader demands.
async function existing(content?: string, mode = 0o600) {
  const f = await fixture();
  await fs.mkdir(f.root, { mode: 0o700 });
  await fs.chmod(f.root, 0o700);
  if (content !== undefined) {
    await fs.writeFile(f.file, content, { mode });
    await fs.chmod(f.file, mode);
  }
  return f;
}

const entries = async (root: string) => (await fs.readdir(root)).sort();
const statMode = async (target: string) =>
  (await fs.stat(target)).mode & 0o7777;

describe("ProductSettingsStore construction", () => {
  it("refuses a relative state root", () => {
    expect(() => new ProductSettingsStore({ root: "relative/state" })).toThrow(
      "SETTINGS_STATE_ROOT_NOT_ABSOLUTE",
    );
  });
});

describe("ProductSettingsStore.load", () => {
  it("returns null for a missing file and creates a private root", async () => {
    const f = await fixture();
    expect(await f.store.load()).toBeNull();
    expect(await statMode(f.root)).toBe(0o700);
    expect(await entries(f.root)).toEqual([]);
  });

  it("tightens a group- or world-accessible root to 0700", async () => {
    const f = await fixture();
    await fs.mkdir(f.root, { mode: 0o755 });
    await fs.chmod(f.root, 0o755);
    await f.store.load();
    expect(await statMode(f.root)).toBe(0o700);
  });

  it("refuses a root that is a symlink", async () => {
    const f = await fixture();
    const real = path.join(f.parent, "real");
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, f.root);
    await expect(f.store.load()).rejects.toThrow("SETTINGS_UNSAFE");
  });

  it("returns the saved document", async () => {
    const f = await fixture();
    await f.store.save(settings(4));
    expect(await f.store.load()).toEqual(settings(4));
  });

  it("refuses a legacy product-settings.json beside the config", async () => {
    const f = await existing();
    await fs.writeFile(path.join(f.root, "product-settings.json"), "{}", {
      mode: 0o600,
    });
    await expect(f.store.load()).rejects.toThrow("CONFIG_RENAME_REQUIRED");
    expect(await entries(f.root)).toEqual(["product-settings.json"]);
  });

  it("refuses a dangling legacy symlink the same way", async () => {
    const f = await existing();
    await fs.symlink("missing", path.join(f.root, "product-settings.json"));
    await expect(f.store.load()).rejects.toThrow("CONFIG_RENAME_REQUIRED");
  });

  it("refuses a config that is a symlink, even to a private valid file", async () => {
    const f = await existing();
    const real = path.join(f.parent, "real.json");
    await fs.writeFile(real, JSON.stringify(settings()), { mode: 0o600 });
    await fs.symlink(real, f.file);
    await expect(f.store.load()).rejects.toThrow("SETTINGS_UNSAFE");
  });

  it("refuses a config readable by group or others", async () => {
    const f = await existing(JSON.stringify(settings()), 0o644);
    await expect(f.store.load()).rejects.toThrow("SETTINGS_UNSAFE");
  });

  it("refuses a config with another hard link", async () => {
    const f = await existing(JSON.stringify(settings()));
    await fs.link(f.file, path.join(f.parent, "alias.json"));
    await expect(f.store.load()).rejects.toThrow("SETTINGS_UNSAFE");
  });

  it("refuses a config that is not a regular file", async () => {
    const f = await existing();
    await fs.mkdir(f.file, { mode: 0o700 });
    await expect(f.store.load()).rejects.toThrow("SETTINGS_UNSAFE");
  });

  it("refuses an oversized config as corrupt", async () => {
    const f = await existing(" ".repeat(MAXIMUM_BYTES + 1));
    await expect(f.store.load()).rejects.toThrow("SETTINGS_CORRUPT");
  });

  it("refuses malformed JSON and a document that fails the schema", async () => {
    const malformed = await existing("{ not json");
    await expect(malformed.store.load()).rejects.toThrow("SETTINGS_CORRUPT");
    const wrong = await existing(JSON.stringify({ schema: 1 }));
    await expect(wrong.store.load()).rejects.toThrow("SETTINGS_CORRUPT");
  });

  it("opens the config without following links and without inheriting the descriptor", async () => {
    const f = await fixture();
    await f.store.save(settings());
    const open = vi.spyOn(fs, "open");
    await f.store.load();
    const flags = open.mock.calls.map((call) => Number(call[1]));
    expect(flags).toHaveLength(1);
    expect(flags[0]! & NO_FOLLOW).toBe(NO_FOLLOW);
    expect(flags[0]! & CLOSE_ON_EXEC).toBe(CLOSE_ON_EXEC);
  });
});

describe("ProductSettingsStore.loadExisting", () => {
  it("refuses a missing root and creates nothing", async () => {
    const f = await fixture();
    await expect(f.store.loadExisting()).rejects.toThrow();
    await expect(fs.lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null for a missing file in a private root", async () => {
    const f = await existing();
    expect(await f.store.loadExisting()).toBeNull();
    expect(await entries(f.root)).toEqual([]);
  });

  it("returns the saved document", async () => {
    const f = await existing(JSON.stringify(settings(7)));
    expect(await f.store.loadExisting()).toEqual(settings(7));
  });

  it("does not repair a root with loose permissions", async () => {
    const f = await existing(JSON.stringify(settings()));
    await fs.chmod(f.root, 0o755);
    await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
    expect(await statMode(f.root)).toBe(0o755);
  });

  it("refuses a root reached through a link", async () => {
    const f = await existing(JSON.stringify(settings()));
    const link = path.join(f.parent, "via-link");
    await fs.symlink(f.root, link);
    const viaLink = new ProductSettingsStore({ root: link });
    await expect(viaLink.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
  });

  it("refuses a legacy product-settings.json", async () => {
    const f = await existing(JSON.stringify(settings()));
    await fs.writeFile(path.join(f.root, "product-settings.json"), "{}");
    await expect(f.store.loadExisting()).rejects.toThrow(
      "CONFIG_RENAME_REQUIRED",
    );
  });

  it("refuses a symlinked config", async () => {
    const f = await existing();
    const real = path.join(f.parent, "real.json");
    await fs.writeFile(real, JSON.stringify(settings()), { mode: 0o600 });
    await fs.symlink(real, f.file);
    await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
  });

  it("refuses a config that is not exactly 0600 with one link", async () => {
    const loose = await existing(JSON.stringify(settings()), 0o644);
    await expect(loose.store.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
    const linked = await existing(JSON.stringify(settings()));
    await fs.link(linked.file, path.join(linked.parent, "alias.json"));
    await expect(linked.store.loadExisting()).rejects.toThrow(
      "SETTINGS_UNSAFE",
    );
  });

  it("refuses a directory in place of the config", async () => {
    const f = await existing();
    await fs.mkdir(f.file, { mode: 0o700 });
    await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
  });

  it("refuses an oversized config as corrupt without reading it", async () => {
    const f = await existing(" ".repeat(MAXIMUM_BYTES + 1));
    await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_CORRUPT");
  });

  it("refuses malformed JSON, invalid UTF-8 and a schema mismatch", async () => {
    const malformed = await existing("{ not json");
    await expect(malformed.store.loadExisting()).rejects.toThrow(
      "SETTINGS_CORRUPT",
    );
    const binary = await existing("");
    await fs.writeFile(binary.file, Buffer.from([0xff, 0xfe, 0xfd]), {
      mode: 0o600,
    });
    await expect(binary.store.loadExisting()).rejects.toThrow(
      "SETTINGS_CORRUPT",
    );
    const wrong = await existing(JSON.stringify({ schema: 1 }));
    await expect(wrong.store.loadExisting()).rejects.toThrow(
      "SETTINGS_CORRUPT",
    );
  });

  it("opens the config without blocking, following links or inheriting the descriptor", async () => {
    const f = await existing(JSON.stringify(settings()));
    const open = vi.spyOn(fs, "open");
    await f.store.loadExisting();
    const flags = open.mock.calls.map((call) => Number(call[1]));
    expect(flags).toHaveLength(1);
    for (const bit of [NO_FOLLOW, CLOSE_ON_EXEC, fsConstants.O_NONBLOCK])
      expect(flags[0]! & bit).toBe(bit);
  });

  it("refuses when the file changes while it is read", async () => {
    const f = await existing(JSON.stringify(settings()));
    const realLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(((
      target: string,
      options?: unknown,
    ) => {
      // The named-file lstat is the one with bigint stats of the config.
      if (target === f.file && options) {
        return fs
          .writeFile(f.file, JSON.stringify(settings(2)) + " ", {
            mode: 0o600,
          })
          .then(() => realLstat(target, options as never));
      }
      return realLstat(target, options as never);
    }) as typeof fs.lstat);
    await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_UNSAFE");
  });
});

describe("ProductSettingsStore.save", () => {
  it("writes the exact pretty JSON bytes at mode 0600 and leaves no temporary file", async () => {
    const f = await fixture();
    await f.store.save(settings(3));
    expect(await fs.readFile(f.file, "utf8")).toBe(
      `${JSON.stringify(settings(3), null, 2)}\n`,
    );
    expect(await statMode(f.file)).toBe(0o600);
    expect(await entries(f.root)).toEqual(["config.json"]);
  });

  it("replaces an existing private config", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    await f.store.save(settings(2));
    expect((await f.store.load())?.revision).toBe(2);
    expect(await entries(f.root)).toEqual(["config.json"]);
  });

  it("refuses a document that fails the schema before touching disk", async () => {
    const f = await fixture();
    await expect(
      f.store.save({ schema: 1 } as unknown as ProductSettings),
    ).rejects.toThrow();
    // Validation precedes everything else: not even the root is created.
    await expect(fs.lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a document over the size limit", async () => {
    const f = await fixture();
    const big = {
      ...settings(),
      tasks: { filler: "x".repeat(MAXIMUM_BYTES) },
    } as ProductSettings;
    await expect(f.store.save(big)).rejects.toThrow("SETTINGS_TOO_LARGE");
    expect(await entries(f.root)).toEqual([]);
  });

  it("refuses to run beside a legacy settings file and writes nothing", async () => {
    const f = await existing();
    await fs.writeFile(path.join(f.root, "product-settings.json"), "{}");
    await expect(f.store.save(settings())).rejects.toThrow(
      "CONFIG_RENAME_REQUIRED",
    );
    expect(await entries(f.root)).toEqual(["product-settings.json"]);
  });

  it("refuses to replace a symlink or a loosely permitted config", async () => {
    const linked = await existing();
    const real = path.join(linked.parent, "real.json");
    await fs.writeFile(real, "keep", { mode: 0o600 });
    await fs.symlink(real, linked.file);
    await expect(linked.store.save(settings())).rejects.toThrow(
      "SETTINGS_UNSAFE",
    );
    expect(await fs.readFile(real, "utf8")).toBe("keep");
    const loose = await existing("keep", 0o644);
    await expect(loose.store.save(settings())).rejects.toThrow(
      "SETTINGS_UNSAFE",
    );
    expect(await fs.readFile(loose.file, "utf8")).toBe("keep");
  });

  it("abandons the write and removes the temporary file when beforeCommit throws", async () => {
    const f = await fixture({
      beforeCommit: async () => {
        throw new Error("COMMIT_HOOK");
      },
    });
    await expect(f.store.save(settings())).rejects.toThrow("COMMIT_HOOK");
    expect(await entries(f.root)).toEqual([]);
  });

  it("leaves the target untouched when the per-write fence refuses", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    await expect(
      f.store.save(settings(2), {
        beforeWrite: async () => {
          throw new Error("FENCE");
        },
      }),
    ).rejects.toThrow("FENCE");
    expect((await f.store.load())?.revision).toBe(1);
    expect(await entries(f.root)).toEqual(["config.json"]);
  });

  it("leaves the target untouched when the last synchronous check refuses", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    await expect(
      f.store.save(settings(2), {
        assertBeforePublication: () => {
          throw new Error("LAST_CHECK");
        },
      }),
    ).rejects.toThrow("LAST_CHECK");
    expect((await f.store.load())?.revision).toBe(1);
    expect(await entries(f.root)).toEqual(["config.json"]);
  });

  it("runs fsync, the commit hook, both fences, rename, chmod and directory fsync in that order", async () => {
    const events: string[] = [];
    const f = await fixture({
      beforeCommit: async () => {
        events.push("beforeCommit");
      },
    });
    await fs.mkdir(f.root, { mode: 0o700 });
    const probe = await fs.open(path.join(f.root, ".probe"), "w");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      sync: () => Promise<void>;
    };
    await probe.close();
    await fs.rm(path.join(f.root, ".probe"));
    const realSync = handlePrototype.sync;
    vi.spyOn(handlePrototype, "sync").mockImplementation(async function (
      this: unknown,
    ) {
      events.push("sync");
      return realSync.call(this);
    });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      // The bytes are complete and durable before they are published.
      expect(await fs.readFile(from, "utf8")).toBe(
        `${JSON.stringify(settings(), null, 2)}\n`,
      );
      events.push("rename");
      return realRename(from, to);
    });
    const realChmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
      if (String(target) === f.file) events.push("chmod");
      return realChmod(target, mode);
    });
    await f.store.save(settings(), {
      beforeWrite: async () => {
        events.push("beforeWrite");
      },
      assertBeforePublication: () => {
        events.push("assertBeforePublication");
      },
    });
    expect(events).toEqual([
      "sync",
      "beforeCommit",
      "beforeWrite",
      "assertBeforePublication",
      "rename",
      "chmod",
      "sync",
    ]);
  });

  it("opens every file and the directory without following links or inheriting the descriptor", async () => {
    const f = await fixture();
    const open = vi.spyOn(fs, "open");
    await f.store.save(settings());
    const calls = open.mock.calls.map((call) => ({
      target: String(call[0]),
      flags: Number(call[1]),
      mode: call[2],
    }));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.flags & NO_FOLLOW).toBe(NO_FOLLOW);
      expect(call.flags & CLOSE_ON_EXEC).toBe(CLOSE_ON_EXEC);
    }
    const [temporary, directory] = calls;
    expect(path.dirname(temporary!.target)).toBe(f.root);
    expect(path.basename(temporary!.target)).toMatch(
      /^\.config\.json\..+\.tmp$/,
    );
    expect(temporary!.mode).toBe(0o600);
    for (const bit of [
      fsConstants.O_WRONLY,
      fsConstants.O_CREAT,
      fsConstants.O_EXCL,
    ])
      expect(temporary!.flags & bit).toBe(bit);
    expect(directory!.target).toBe(f.root);
    expect(directory!.flags & (fsConstants.O_DIRECTORY ?? 0)).toBe(
      fsConstants.O_DIRECTORY ?? 0,
    );
  });

  it("removes the temporary file when the rename fails", async () => {
    const f = await fixture();
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("RENAME_FAILED"));
    await expect(f.store.save(settings())).rejects.toThrow("RENAME_FAILED");
    expect(await entries(f.root)).toEqual([]);
  });
});

describe("ProductSettingsStore.saveConditional", () => {
  it("commits exactly the next revision and returns the read-back document", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    const result = await f.store.saveConditional(settings(1), settings(2));
    expect(result).toEqual({ status: "committed", settings: settings(2) });
    expect(await fs.readFile(f.file, "utf8")).toBe(
      `${JSON.stringify(settings(2), null, 2)}\n`,
    );
  });

  it("does not write when the next revision is not the successor", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    expect(await f.store.saveConditional(settings(1), settings(3))).toEqual({
      status: "not_written",
    });
    expect(await f.store.saveConditional(settings(1), settings(1))).toEqual({
      status: "not_written",
    });
    expect((await f.store.load())?.revision).toBe(1);
  });

  it("does not write when either document fails the schema", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    const bad = { schema: 1 } as unknown as ProductSettings;
    expect(await f.store.saveConditional(bad, settings(2))).toEqual({
      status: "not_written",
    });
    expect(await f.store.saveConditional(settings(1), bad)).toEqual({
      status: "not_written",
    });
  });

  it("does not write when the stored document is not the expected one", async () => {
    const f = await fixture();
    await f.store.save(settings(5));
    expect(await f.store.saveConditional(settings(1), settings(2))).toEqual({
      status: "not_written",
    });
    expect((await f.store.load())?.revision).toBe(5);
  });

  it("does not write when nothing is stored yet", async () => {
    const f = await fixture();
    expect(await f.store.saveConditional(settings(1), settings(2))).toEqual({
      status: "not_written",
    });
    expect(await entries(f.root)).toEqual([]);
  });

  it("does not write, and does not latch, when a fence refuses before publication", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    const refused = await f.store.saveConditional(settings(1), settings(2), {
      beforeWrite: async () => {
        throw new Error("FENCE");
      },
    });
    expect(refused).toEqual({ status: "not_written" });
    expect((await f.store.load())?.revision).toBe(1);
    const retry = await f.store.saveConditional(settings(1), settings(2));
    expect(retry.status).toBe("committed");
  });

  it("re-checks the stored document just before publication", async () => {
    // Another writer replaces the document after the first comparison, while
    // the temporary file is being committed. Nothing is published.
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({
      beforeCommit: async () => {
        await fs.writeFile(f.file, JSON.stringify(settings(9)), {
          mode: 0o600,
        });
      },
    });
    await fs.mkdir(f.root, { mode: 0o700 });
    await fs.writeFile(f.file, JSON.stringify(settings(1)), { mode: 0o600 });
    expect(await f.store.saveConditional(settings(1), settings(2))).toEqual({
      status: "not_written",
    });
    expect((await f.store.load())?.revision).toBe(9);
    expect(await entries(f.root)).toEqual(["config.json"]);
  });

  it("latches unknown when the rename fails after publication was attempted", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("RENAME_FAILED"));
    expect(await f.store.saveConditional(settings(1), settings(2))).toEqual({
      status: "unknown",
    });
    expect((await f.store.load())?.revision).toBe(1);
  });

  it("latches unknown when the read-back does not match", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await realRename(from, to);
      await fs.writeFile(
        f.file,
        JSON.stringify({ ...settings(2), tasks: { other: true } }),
        { mode: 0o600 },
      );
    });
    expect(await f.store.saveConditional(settings(1), settings(2))).toEqual({
      status: "unknown",
    });
  });

  it("makes every later write fail closed once the latch is set", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("RENAME_FAILED"));
    await f.store.saveConditional(settings(1), settings(2));
    vi.restoreAllMocks();
    const open = vi.spyOn(fs, "open");
    const rename = vi.spyOn(fs, "rename");
    await expect(f.store.save(settings(2))).rejects.toThrow(
      "SETTINGS_WRITE_OUTCOME_UNKNOWN",
    );
    expect(await f.store.saveConditional(settings(1), settings(2))).toEqual({
      status: "unknown",
    });
    // Neither refusal touched the disk.
    expect(open).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    // Reads stay available; the stored bytes are still revision 1.
    expect((await f.store.load())?.revision).toBe(1);
  });

  it("does not latch on a plain failed save", async () => {
    const f = await fixture();
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("RENAME_FAILED"));
    await expect(f.store.save(settings(1))).rejects.toThrow("RENAME_FAILED");
    await f.store.save(settings(1));
    expect((await f.store.load())?.revision).toBe(1);
  });

  it("fenceConditionalWrites latches the same state from outside", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    f.store.fenceConditionalWrites();
    await expect(f.store.save(settings(2))).rejects.toThrow(
      "SETTINGS_WRITE_OUTCOME_UNKNOWN",
    );
    expect(await f.store.saveConditional(settings(1), settings(2))).toEqual({
      status: "unknown",
    });
    expect((await f.store.load())?.revision).toBe(1);
  });

  it("latches when the fence is raised between the check and publication", async () => {
    const f = await fixture();
    await f.store.save(settings(1));
    const result = await f.store.saveConditional(settings(1), settings(2), {
      beforeWrite: async () => {
        f.store.fenceConditionalWrites();
      },
    });
    // The latch is checked after the fence and before the rename: nothing was
    // attempted, so the store reports not_written, yet every later write refuses.
    expect(result).toEqual({ status: "not_written" });
    expect((await f.store.load())?.revision).toBe(1);
    await expect(f.store.save(settings(2))).rejects.toThrow(
      "SETTINGS_WRITE_OUTCOME_UNKNOWN",
    );
  });
});
