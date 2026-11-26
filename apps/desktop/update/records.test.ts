import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORD_BYTES } from "./record";
import {
  canonicalOwnedDirectory,
  privateDirectory,
  readCleanupMarker,
  readDownloadPending,
  readReadyRecord,
  readRecord,
  readRestoreIntent,
  repairDirectoryIdentity,
  writeRecord,
} from "./records";

// Real temporary directories: the layer is about modes, links and inodes, which
// an in-memory fake cannot tell. Spies wrap the real fs calls so the ordering,
// flags and races can be observed without changing what the calls do.
let root: string;
const uid = process.getuid!();

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "records-")),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.chmod(root, 0o700);
  await fs.rm(root, { recursive: true, force: true });
});

const at = (...names: string[]) => path.join(root, ...names);
const put = async (name: string, text: string, mode = 0o600) => {
  const file = at(name);
  await fs.writeFile(file, text, { mode });
  await fs.chmod(file, mode);
  return file;
};
const rejectsWith = async (promise: Promise<unknown>, message: string) =>
  expect(
    (
      await promise.then(
        () => null,
        (e: Error) => e,
      )
    )?.message,
  ).toBe(message);
const rejectsCode = async (promise: Promise<unknown>, code: string) =>
  expect(
    (
      await promise.then(
        () => null,
        (e: NodeJS.ErrnoException) => e,
      )
    )?.code,
  ).toBe(code);
// A string of exactly `size` bytes that is valid JSON.
const json = (size: number) => `"${"a".repeat(size - 2)}"`;

describe("canonicalOwnedDirectory", () => {
  it("accepts an owned private directory", async () => {
    await canonicalOwnedDirectory(root, true);
    await canonicalOwnedDirectory(root, false);
  });

  it("surfaces a missing directory as the filesystem error", async () => {
    await rejectsCode(canonicalOwnedDirectory(at("none"), true), "ENOENT");
  });

  it("refuses a symbolic link to a directory", async () => {
    await fs.mkdir(at("real"), { mode: 0o700 });
    await fs.symlink(at("real"), at("link"));
    await rejectsWith(
      canonicalOwnedDirectory(at("link"), true),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });

  it("refuses a regular file", async () => {
    const file = await put("file", "x");
    await rejectsWith(
      canonicalOwnedDirectory(file, false),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });

  it("refuses an alias reached through a redirected parent", async () => {
    await fs.mkdir(at("real/inner"), { recursive: true, mode: 0o700 });
    await fs.symlink(at("real"), at("alias"));
    await rejectsWith(
      canonicalOwnedDirectory(at("alias/inner"), true),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });

  it("requires no group or other access in private mode", async () => {
    await fs.mkdir(at("d"), { mode: 0o700 });
    for (const mode of [0o750, 0o705, 0o710, 0o770]) {
      await fs.chmod(at("d"), mode);
      await rejectsWith(
        canonicalOwnedDirectory(at("d"), true),
        "UPDATE_PRIVATE_STATE_INVALID",
      );
    }
    await fs.chmod(at("d"), 0o700);
    await canonicalOwnedDirectory(at("d"), true);
  });

  it("only refuses group and other write outside private mode", async () => {
    await fs.mkdir(at("d"), { mode: 0o700 });
    await fs.chmod(at("d"), 0o755);
    await canonicalOwnedDirectory(at("d"), false);
    for (const mode of [0o775, 0o757, 0o777]) {
      await fs.chmod(at("d"), mode);
      await rejectsWith(
        canonicalOwnedDirectory(at("d"), false),
        "UPDATE_PRIVATE_STATE_INVALID",
      );
    }
  });

  // /Applications exists only on macOS; the portable Linux gate has no such
  // directory, so lstat would fail with ENOENT before any owner check.
  it.skipIf(uid === 0 || process.platform !== "darwin")(
    "does not exempt /Applications from the owner check in private mode",
    async () => {
      await rejectsWith(
        canonicalOwnedDirectory("/Applications", true),
        "UPDATE_PRIVATE_STATE_INVALID",
      );
    },
  );

  it("refuses a directory owned by someone else", async () => {
    const real = await fs.lstat(root);
    vi.spyOn(fs, "lstat").mockResolvedValue({
      ...real,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: uid + 1,
    } as never);
    await rejectsWith(
      canonicalOwnedDirectory(root, false),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });
});

describe("repairDirectoryIdentity", () => {
  const inode = async (directory: string) => {
    const stat = await fs.lstat(directory);
    return [stat.dev, stat.ino] as [number, number];
  };

  it("accepts the recorded device and inode pair", async () => {
    await repairDirectoryIdentity(root, await inode(root), true);
  });

  it("refuses a replaced directory", async () => {
    const [dev, ino] = await inode(root);
    await rejectsWith(
      repairDirectoryIdentity(root, [dev, ino + 1], true),
      "UPDATE_REPAIR_PHYSICAL_PAIR_CHANGED",
    );
    await rejectsWith(
      repairDirectoryIdentity(root, [dev + 1, ino], true),
      "UPDATE_REPAIR_PHYSICAL_PAIR_CHANGED",
    );
  });

  it("applies the directory mode check before comparing identity", async () => {
    await fs.mkdir(at("d"), { mode: 0o700 });
    const expected = await inode(at("d"));
    await fs.chmod(at("d"), 0o750);
    await rejectsWith(
      repairDirectoryIdentity(at("d"), expected, true),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
    await repairDirectoryIdentity(at("d"), expected, false);
  });

  it("refuses a symbolic link even when the target matches", async () => {
    await fs.mkdir(at("real"), { mode: 0o700 });
    await fs.symlink(at("real"), at("link"));
    await rejectsWith(
      repairDirectoryIdentity(at("link"), await inode(at("real")), true),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });

  it("opens the directory without following links", async () => {
    const open = vi.spyOn(fs, "open");
    await repairDirectoryIdentity(root, await inode(root), true);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      root,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  });
});

describe("privateDirectory", () => {
  it("creates a missing directory with mode 0700", async () => {
    await privateDirectory(at("state"));
    const stat = await fs.lstat(at("state"));
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("is idempotent for an existing private directory", async () => {
    await privateDirectory(at("state"));
    await put("state/keep", "x");
    await privateDirectory(at("state"));
    expect(await fs.readFile(at("state/keep"), "utf8")).toBe("x");
  });

  it("refuses an existing directory that is not private", async () => {
    await fs.mkdir(at("state"), { mode: 0o700 });
    await fs.chmod(at("state"), 0o750);
    await rejectsWith(
      privateDirectory(at("state")),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });

  it("refuses an existing symbolic link", async () => {
    await fs.mkdir(at("real"), { mode: 0o700 });
    await fs.symlink(at("real"), at("state"));
    await rejectsWith(
      privateDirectory(at("state")),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });

  it("refuses to create under a writable parent, creating nothing", async () => {
    await fs.chmod(root, 0o777);
    await rejectsWith(
      privateDirectory(at("state")),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
    await fs.chmod(root, 0o700);
    await rejectsCode(fs.lstat(at("state")), "ENOENT");
  });

  it("refuses to create under a redirected parent", async () => {
    await fs.mkdir(at("real"), { mode: 0o700 });
    await fs.symlink(at("real"), at("alias"));
    await rejectsWith(
      privateDirectory(at("alias/state")),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
    await rejectsCode(fs.lstat(at("real/state")), "ENOENT");
  });

  it("does not create missing parents", async () => {
    await rejectsCode(privateDirectory(at("a/b")), "ENOENT");
  });

  it("creates with mode 0700 and no recursion", async () => {
    const mkdir = vi.spyOn(fs, "mkdir");
    await privateDirectory(at("state"));
    expect(mkdir).toHaveBeenCalledExactlyOnceWith(at("state"), {
      mode: 0o700,
    });
  });

  it("rethrows a creation failure other than the directory existing", async () => {
    vi.spyOn(fs, "mkdir").mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );
    await rejectsCode(privateDirectory(at("state")), "EACCES");
  });
});

describe("readRecord", () => {
  it("reads a parsed record", async () => {
    const file = await put("r.json", '{"a":[1,2,{"b":null}]}\n');
    expect(await readRecord(file)).toEqual({ a: [1, 2, { b: null }] });
  });

  it("is null for a missing file", async () => {
    expect(await readRecord(at("none.json"))).toBeNull();
  });

  it("surfaces a missing parent as null, but any other fault as an error", async () => {
    expect(await readRecord(at("none/r.json"))).toBeNull();
    const file = await put("plain", "x");
    await rejectsCode(readRecord(path.join(file, "r.json")), "ENOTDIR");
  });

  it("returns null for a present file holding JSON null", async () => {
    const file = await put("r.json", "null\n");
    expect(await readRecord(file)).toBeNull();
  });

  it("reports the sha256 and a private copy of the exact bytes", async () => {
    const text = '{ "spaced" : 1 }\n';
    const file = await put("r.json", text);
    const digest = vi.fn();
    const bytes = vi.fn();
    await readRecord(file, true, digest, MAX_RECORD_BYTES, bytes);
    expect(digest).toHaveBeenCalledExactlyOnceWith(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(bytes).toHaveBeenCalledOnce();
    expect(bytes.mock.calls[0]![0].toString("utf8")).toBe(text);
  });

  it("does not report anything for a missing file", async () => {
    const digest = vi.fn();
    const bytes = vi.fn();
    await readRecord(at("none"), true, digest, MAX_RECORD_BYTES, bytes);
    expect(digest).not.toHaveBeenCalled();
    expect(bytes).not.toHaveBeenCalled();
  });

  it("accepts a record of exactly the maximum size and refuses one byte more", async () => {
    const exact = await put("exact.json", json(MAX_RECORD_BYTES));
    expect(await readRecord(exact)).toBe("a".repeat(MAX_RECORD_BYTES - 2));
    const over = await put("over.json", json(MAX_RECORD_BYTES + 1));
    await rejectsWith(readRecord(over), "UPDATE_RECORD_INVALID");
  });

  it("honors a caller maximum in place of the record bound", async () => {
    const file = await put("r.json", json(100));
    expect(await readRecord(file, true, undefined, 100)).toBeTypeOf("string");
    await rejectsWith(
      readRecord(file, true, undefined, 99),
      "UPDATE_RECORD_INVALID",
    );
    const big = await put("big.json", json(MAX_RECORD_BYTES + 10));
    expect(
      await readRecord(big, true, undefined, MAX_RECORD_BYTES + 10),
    ).toBeTypeOf("string");
  });

  it("refuses a symbolic link, even to a valid private record", async () => {
    const real = await put("real.json", "1\n");
    await fs.symlink(real, at("link.json"));
    await rejectsWith(readRecord(at("link.json")), "UPDATE_RECORD_INVALID");
  });

  it("refuses a directory and a dangling link", async () => {
    await fs.mkdir(at("d.json"), { mode: 0o700 });
    await rejectsWith(readRecord(at("d.json")), "UPDATE_RECORD_INVALID");
    await fs.symlink(at("gone"), at("dangling.json"));
    await rejectsWith(readRecord(at("dangling.json")), "UPDATE_RECORD_INVALID");
  });

  it("refuses a file with more than one hard link", async () => {
    const file = await put("r.json", "1\n");
    await fs.link(file, at("second.json"));
    await rejectsWith(readRecord(file), "UPDATE_RECORD_INVALID");
  });

  it("requires a private mode by default", async () => {
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      const file = await put("r.json", "1\n", mode);
      await rejectsWith(readRecord(file), "UPDATE_RECORD_INVALID");
      await rejectsWith(readRecord(file, true), "UPDATE_RECORD_INVALID");
    }
  });

  it("only refuses group and other write when not private", async () => {
    const readable = await put("r.json", "1\n", 0o644);
    expect(await readRecord(readable, false)).toBe(1);
    for (const mode of [0o664, 0o646, 0o666]) {
      const file = await put("w.json", "1\n", mode);
      await rejectsWith(readRecord(file, false), "UPDATE_RECORD_INVALID");
    }
  });

  it("refuses a file owned by someone else", async () => {
    const file = await put("r.json", "1\n");
    const real = await fs.lstat(file);
    vi.spyOn(fs, "lstat").mockResolvedValue({
      ...real,
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: uid + 1,
    } as never);
    await rejectsWith(readRecord(file), "UPDATE_RECORD_INVALID");
  });

  it("throws on malformed JSON and on an empty file", async () => {
    await expect(readRecord(await put("bad.json", "{"))).rejects.toThrow(
      SyntaxError,
    );
    await expect(readRecord(await put("empty.json", ""))).rejects.toThrow(
      SyntaxError,
    );
  });

  it("opens read-only, without following links and without blocking", async () => {
    const file = await put("r.json", "1\n");
    const open = vi.spyOn(fs, "open");
    await readRecord(file);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  });

  it("refuses a link swapped in after the check instead of following it", async () => {
    const file = await put("r.json", "1\n");
    const other = await put("other.json", "2\n");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.unlink(file);
      await fs.symlink(other, file);
      return open(...(args as Parameters<typeof fs.open>));
    });
    await rejectsCode(readRecord(file), "ELOOP");
  });

  it("refuses a file replaced between the check and the open", async () => {
    const file = await put("r.json", "1\n");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.rm(file);
      await put("r.json", "2\n");
      return open(...(args as Parameters<typeof fs.open>));
    });
    await rejectsWith(readRecord(file), "UPDATE_RECORD_CHANGED");
  });

  it("refuses a record that grows while it is read", async () => {
    const file = await put("r.json", "1\n");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...(args as Parameters<typeof fs.open>));
      await fs.appendFile(file, " \n");
      return handle;
    });
    await rejectsWith(readRecord(file), "UPDATE_RECORD_CHANGED");
  });

  it("refuses a name that no longer matches the bytes it read", async () => {
    const file = await put("r.json", "1\n");
    const real = fs.lstat.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fs.lstat>
    ) => {
      const stat = await real(...args);
      return ++calls === 2 ? { ...stat, ino: Number(stat.ino) + 1 } : stat;
    }) as never);
    await rejectsWith(readRecord(file), "UPDATE_RECORD_CHANGED");
    expect(calls).toBe(2);
  });

  it("closes the descriptor when the read is refused", async () => {
    const file = await put("r.json", "{");
    const close = vi.fn();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...(args as Parameters<typeof fs.open>));
      const real = handle.close.bind(handle);
      handle.close = async () => {
        close();
        return real();
      };
      return handle;
    });
    await expect(readRecord(file)).rejects.toThrow(SyntaxError);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("writeRecord", () => {
  // Wraps the real calls to log every effect in the order it happens.
  function trace() {
    const events: string[] = [];
    const real = {
      open: fs.open.bind(fs),
      rename: fs.rename.bind(fs),
    };
    const opens: { path: string; flags: unknown; mode: unknown }[] = [];
    vi.spyOn(fs, "open").mockImplementation((async (
      p: string,
      flags: unknown,
      mode?: unknown,
    ) => {
      const kind = String(p) === root ? "dir" : "tmp";
      opens.push({ path: String(p), flags, mode });
      events.push(`open:${kind}`);
      const handle = await real.open(p, flags as never, mode as never);
      for (const name of ["writeFile", "sync", "close"] as const) {
        const method = (
          handle[name] as (...a: unknown[]) => Promise<void>
        ).bind(handle);
        (handle as unknown as Record<string, unknown>)[name] = async (
          ...a: unknown[]
        ) => {
          events.push(`${name}:${kind}`);
          return method(...a);
        };
      }
      return handle;
    }) as never);
    vi.spyOn(fs, "rename").mockImplementation((async (
      from: string,
      to: string,
    ) => {
      events.push("rename");
      return real.rename(from, to);
    }) as never);
    return { events, opens };
  }

  it("writes compact JSON and a newline with mode 0600", async () => {
    const file = at("r.json");
    await writeRecord(file, { b: [1, null], a: "é" });
    expect(await fs.readFile(file, "utf8")).toBe('{"b":[1,null],"a":"é"}\n');
    expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file and replaces an existing record", async () => {
    const file = await put("r.json", "1\n");
    await writeRecord(file, 2);
    expect(await fs.readFile(file, "utf8")).toBe("2\n");
    expect(await fs.readdir(root)).toEqual(["r.json"]);
  });

  it("produces what readRecord reads back", async () => {
    const file = at("r.json");
    await writeRecord(file, { k: "v" });
    expect(await readRecord(file)).toEqual({ k: "v" });
  });

  // process.umask() cannot be set inside vitest worker threads (the portable
  // gate runs there). A umask can only clear bits, so creating the temporary
  // record with an explicit 0600 is what keeps it 0600 under any umask.
  it("creates the record with an explicit 0600 mode, so no umask can widen it", async () => {
    const open = vi.spyOn(fs, "open");
    const file = at("r.json");
    await writeRecord(file, 1);
    const create = open.mock.calls.find(([, flags]) => flags === "wx");
    expect(create?.[2]).toBe(0o600);
    expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
  });

  it("syncs the file, renames, then syncs the directory, in that order", async () => {
    const { events } = trace();
    await writeRecord(at("r.json"), 1);
    expect(events).toEqual([
      "open:tmp",
      "writeFile:tmp",
      "sync:tmp",
      "close:tmp",
      "rename",
      "open:dir",
      "sync:dir",
      "close:dir",
    ]);
  });

  it("opens the temporary exclusively and the directory without following links", async () => {
    const { opens } = trace();
    const file = at("r.json");
    await writeRecord(file, 1);
    expect(opens).toHaveLength(2);
    expect(opens[0]!.path).toMatch(
      new RegExp(`^${file.replace(/\./gu, "\\.")}\\.[a-f0-9]{24}$`, "u"),
    );
    expect(opens[0]!.flags).toBe("wx");
    expect(opens[0]!.mode).toBe(0o600);
    expect(opens[1]!.path).toBe(root);
    expect(opens[1]!.flags).toBe(
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  });

  it("uses a fresh temporary name for every write", async () => {
    const { opens } = trace();
    await writeRecord(at("r.json"), 1);
    await writeRecord(at("r.json"), 2);
    expect(opens[0]!.path).not.toBe(opens[2]!.path);
  });

  it("announces every effect before it happens", async () => {
    const { events } = trace();
    const log = vi.fn((): void => {
      events.push("effect");
    });
    await writeRecord(at("r.json"), 1, log);
    expect(events).toEqual([
      "effect",
      "open:tmp",
      "effect",
      "writeFile:tmp",
      "effect",
      "sync:tmp",
      "close:tmp",
      "effect",
      "rename",
      "effect",
      "open:dir",
      "effect",
      "sync:dir",
      "effect",
      "close:dir",
    ]);
  });

  it("refuses an oversized record before any effect", async () => {
    const effect = vi.fn();
    await rejectsWith(
      writeRecord(at("r.json"), "a".repeat(MAX_RECORD_BYTES), effect),
      "UPDATE_RECORD_OVERSIZED",
    );
    expect(effect).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("measures the bound in bytes of the serialized record including the newline", async () => {
    const fits = "a".repeat(MAX_RECORD_BYTES - 3);
    await writeRecord(at("fits.json"), fits);
    expect((await fs.lstat(at("fits.json"))).size).toBe(MAX_RECORD_BYTES);
    await rejectsWith(
      writeRecord(at("over.json"), "a".repeat(MAX_RECORD_BYTES - 2)),
      "UPDATE_RECORD_OVERSIZED",
    );
    // Multi-byte characters count as bytes, not as characters.
    await rejectsWith(
      writeRecord(at("wide.json"), "é".repeat(MAX_RECORD_BYTES / 2)),
      "UPDATE_RECORD_OVERSIZED",
    );
  });

  it("keeps the previous record when stopped before the rename", async () => {
    const file = await put("r.json", "old\n");
    let calls = 0;
    const stop = () => {
      // 1 before open, 2 before write, 3 before sync, 4 before rename.
      if (++calls === 4) throw new Error("STOP");
    };
    await rejectsWith(writeRecord(file, "new", stop), "STOP");
    expect(await fs.readFile(file, "utf8")).toBe("old\n");
  });

  it("has already replaced the record when stopped after the rename", async () => {
    const file = await put("r.json", "old\n");
    let calls = 0;
    const stop = () => {
      if (++calls === 5) throw new Error("STOP");
    };
    await rejectsWith(writeRecord(file, "new", stop), "STOP");
    expect(await fs.readFile(file, "utf8")).toBe('"new"\n');
  });

  it("closes the temporary descriptor when the write fails", async () => {
    const close = vi.fn();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce((async (...args: unknown[]) => {
      const handle = await open(...(args as Parameters<typeof fs.open>));
      handle.writeFile = async () => {
        throw new Error("DISK");
      };
      const real = handle.close.bind(handle);
      handle.close = async () => {
        close();
        return real();
      };
      return handle;
    }) as never);
    const file = await put("r.json", "old\n");
    await rejectsWith(writeRecord(file, "new"), "DISK");
    expect(close).toHaveBeenCalledOnce();
    expect(await fs.readFile(file, "utf8")).toBe("old\n");
  });

  it("surfaces a missing directory without creating it", async () => {
    await rejectsCode(writeRecord(at("none/r.json"), 1), "ENOENT");
    await rejectsCode(fs.lstat(at("none")), "ENOENT");
  });

  it("fails rather than reuse an existing temporary name", async () => {
    const file = at("r.json");
    vi.spyOn(fs, "open").mockRejectedValueOnce(
      Object.assign(new Error("EEXIST"), { code: "EEXIST" }),
    );
    await rejectsCode(writeRecord(file, 1), "EEXIST");
    await rejectsCode(fs.lstat(file), "ENOENT");
  });
});

describe("readRestoreIntent", () => {
  const absent = async (file: string) => {
    try {
      await fs.lstat(file);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };

  it("reads only a verified absence as no restore pending", async () => {
    expect(await readRestoreIntent(at("none.json"), readRecord, absent)).toBe(
      null,
    );
  });

  it("refuses a present record holding JSON null as invalid, not absent", async () => {
    const file = await put("restore-pending.json", "null\n");
    await rejectsWith(
      readRestoreIntent(file, readRecord, absent),
      "UPDATE_RECORD_INVALID",
    );
  });

  it.each([
    ["JSON null", "null\n"],
    ["a non-intent object", "{}\n"],
    ["a wrong-schema object", '{"schema":"other"}\n'],
    ["truncated JSON", '{"schema":"farol.update-restore-'],
    ["an empty file", ""],
  ])(
    "classifies a present %s as UPDATE_RECORD_INVALID",
    async (_name, text) => {
      const file = await put("restore-pending.json", text);
      await rejectsWith(
        readRestoreIntent(file, readRecord, absent),
        "UPDATE_RECORD_INVALID",
      );
    },
  );

  it("classifies a restore record that cannot be read safely as invalid", async () => {
    const file = await put("restore-pending.json", "null\n", 0o644);
    await rejectsWith(
      readRestoreIntent(file, readRecord, absent),
      "UPDATE_RECORD_INVALID",
    );
  });
});

describe("readCleanupMarker", () => {
  const absent = async (file: string) => {
    try {
      await fs.lstat(file);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };

  it("reads only a verified absence as no cleanup pending", async () => {
    expect(await readCleanupMarker(at("none.json"), readRecord, absent)).toBe(
      null,
    );
  });

  it("returns the content of a present marker unjudged", async () => {
    const file = await put(
      "package-cleanup-pending.json",
      '{"schema":"other","anything":1}\n',
    );
    expect(await readCleanupMarker(file, readRecord, absent)).toEqual({
      schema: "other",
      anything: 1,
    });
  });

  it.each([
    ["JSON null", "null\n"],
    ["truncated JSON", '{"schema":"farol.update-package-clean'],
    ["an empty file", ""],
  ])(
    "classifies a present %s as UPDATE_RECORD_INVALID",
    async (_name, text) => {
      const file = await put("package-cleanup-pending.json", text);
      await rejectsWith(
        readCleanupMarker(file, readRecord, absent),
        "UPDATE_RECORD_INVALID",
      );
    },
  );

  it("classifies a marker that cannot be read safely as invalid", async () => {
    const file = await put(
      "package-cleanup-pending.json",
      '{"schema":"x"}\n',
      0o644,
    );
    await rejectsWith(
      readCleanupMarker(file, readRecord, absent),
      "UPDATE_RECORD_INVALID",
    );
  });

  it("keeps a code the reader already classified", async () => {
    await rejectsWith(
      readCleanupMarker(
        at("x.json"),
        async () => {
          throw new Error("UPDATE_RECORD_CHANGED");
        },
        absent,
      ),
      "UPDATE_RECORD_CHANGED",
    );
  });
});

describe.each([
  ["readDownloadPending", readDownloadPending, "download-pending.json"],
  ["readReadyRecord", readReadyRecord, "ready.json"],
] as const)("%s", (_reader, readPresent, name) => {
  const absent = async (file: string) => {
    try {
      await fs.lstat(file);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };

  it("reads only a verified absence as no record", async () => {
    expect(await readPresent(at("none.json"), readRecord, absent)).toBe(null);
  });

  it("returns the content of a present record unjudged", async () => {
    const file = await put(name, '{"schema":"other","anything":1}\n');
    expect(await readPresent(file, readRecord, absent)).toEqual({
      schema: "other",
      anything: 1,
    });
  });

  it.each([
    ["JSON null", "null\n"],
    ["truncated JSON", '{"schema":"farol.update-'],
    ["an empty file", ""],
  ])(
    "classifies a present %s as UPDATE_RECORD_INVALID",
    async (_case, text) => {
      const file = await put(name, text);
      await rejectsWith(
        readPresent(file, readRecord, absent),
        "UPDATE_RECORD_INVALID",
      );
    },
  );

  it("classifies a record that cannot be read safely as invalid", async () => {
    const file = await put(name, '{"schema":"x"}\n', 0o644);
    await rejectsWith(
      readPresent(file, readRecord, absent),
      "UPDATE_RECORD_INVALID",
    );
  });

  it("keeps a code the reader already classified", async () => {
    await rejectsWith(
      readPresent(
        at("x.json"),
        async () => {
          throw new Error("UPDATE_RECORD_CHANGED");
        },
        absent,
      ),
      "UPDATE_RECORD_CHANGED",
    );
  });
});
