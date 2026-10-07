import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainEmptyArchive } from "../../src/apps/desktop/retained-empty-archive";

// Controlled fs port only: exercises preservation across the observation /
// eligibility interval. This does not prove real native filesystem behavior.
const files = vi.hoisted(
  () =>
    new Map<
      string,
      {
        ino: bigint;
        mode: bigint;
        content?: Buffer;
        time: bigint;
        links: bigint;
      }
    >(),
);
const afterRead = vi.hoisted(() => ({
  effect: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", () => {
  const info = (file: string) => {
    const entry = files.get(file);
    if (!entry) throw Object.assign(Error("missing"), { code: "ENOENT" });
    const directory = entry.content === undefined;
    return {
      dev: 1n,
      ino: entry.ino,
      mode: entry.mode,
      uid: BigInt(process.geteuid!()),
      gid: 20n,
      nlink: entry.links,
      size: BigInt(entry.content?.length ?? 0),
      mtimeNs: entry.time,
      ctimeNs: entry.time,
      isDirectory: () => directory,
      isFile: () => !directory && (entry.mode & 0o170000n) === 0o100000n,
    };
  };
  return {
    default: {
      lstat: vi.fn(async (file: string) => info(file)),
      readdir: vi.fn(async (directory: string) =>
        [...files.keys()]
          .filter(
            (x) =>
              x.startsWith(directory + "/") &&
              !x.slice(directory.length + 1).includes("/"),
          )
          .map((x) => x.slice(directory.length + 1)),
      ),
      open: vi.fn(async (file: string) => ({
        stat: async () => info(file),
        read: async (buffer: Buffer) => {
          const content = files.get(file)!.content!;
          content.copy(buffer);
          afterRead.effect?.();
          return { bytesRead: content.length };
        },
        close: async () => {},
      })),
    },
  };
});

const root = "/synthetic-archive";
const record = `${root}/chat-handoff-0001.commit`;
const add = (name: string, content?: string, ino = BigInt(files.size + 1)) => {
  files.set(`${root}${name ? "/" + name : ""}`, {
    ino,
    mode: content === undefined ? 0o40700n : 0o100600n,
    ...(content === undefined ? {} : { content: Buffer.from(content) }),
    time: 1n,
    links: 1n,
  });
};
beforeEach(() => {
  files.clear();
  afterRead.effect = undefined;
  add("");
  add("chat-handoff-0001.commit", "original");
  add("chat-results");
  add("chat-results/chat-results.claim", "");
});

describe("retained empty archive byte and physical pin", () => {
  it("keeps unchanged observed bytes and physical objects through repeated checks", async () => {
    const pin = await retainEmptyArchive(root);
    await pin.verify();
    await pin.verify();
  });
  it.each(["bytes", "inode", "mode", "hardlink", "timestamp", "type"])(
    "refuses changed %s after Go observation",
    async (kind) => {
      const pin = await retainEmptyArchive(root);
      const entry = files.get(record)!;
      if (kind === "bytes") entry.content = Buffer.from("changed!");
      if (kind === "inode") entry.ino++;
      if (kind === "mode") entry.mode = 0o100644n;
      if (kind === "hardlink") entry.links = 2n;
      if (kind === "timestamp") entry.time++;
      if (kind === "type") entry.mode = 0o120600n;
      await expect(pin.verify()).rejects.toThrow(
        "EMPTY_CHAT_RECOVERY_ARCHIVE_CHANGED",
      );
    },
  );
  it("refuses change/restoration with the original bytes but a changed timestamp", async () => {
    const pin = await retainEmptyArchive(root);
    files.get(record)!.time += 2n;
    await expect(pin.verify()).rejects.toThrow();
  });
  it("refuses loss, unexpected membership and nested result changes", async () => {
    const pin = await retainEmptyArchive(root);
    add("unexpected", "private");
    await expect(pin.verify()).rejects.toThrow();
    files.delete(`${root}/unexpected`);
    files.get(`${root}/chat-results/chat-results.claim`)!.ino++;
    await expect(pin.verify()).rejects.toThrow();
    files.delete(record);
    await expect(pin.verify()).rejects.toThrow();
  });
  it("refuses a concurrent change during the initial read", async () => {
    afterRead.effect = () => {
      files.get(record)!.time++;
    };
    await expect(retainEmptyArchive(root)).rejects.toThrow();
  });
  it("accounts only for four exact host artifacts with expected inode and bytes", async () => {
    const pin = await retainEmptyArchive(root);
    for (const name of [
      "known-completion-attempt.json",
      "maintenance-completed.json",
      "failed-running.json",
      "maintenance-intent.json",
    ]) {
      add(name, "retained", 100n + BigInt(files.size));
      const added = files.get(`${root}/${name}`)!;
      await pin.include(name, {
        bytes: Buffer.from("retained"),
        device: 1,
        inode: Number(added.ino),
      });
      await pin.verify();
      await expect(
        pin.include(name, {
          bytes: Buffer.from("retained"),
          device: 1,
          inode: Number(added.ino),
        }),
      ).rejects.toThrow();
    }
  });
  it("adding a host artifact cannot authorize changed original records", async () => {
    const pin = await retainEmptyArchive(root);
    add("maintenance-completed.json", "receipt", 55n);
    files.get(record)!.content = Buffer.from("changed!");
    await expect(
      pin.include("maintenance-completed.json", {
        bytes: Buffer.from("receipt"),
        device: 1,
        inode: 55,
      }),
    ).rejects.toThrow();
  });
  it("refuses an unexpected artifact, wrong readback, or extra directory", async () => {
    const pin = await retainEmptyArchive(root);
    await expect(
      pin.include("arbitrary", { bytes: Buffer.alloc(0), device: 1, inode: 1 }),
    ).rejects.toThrow();
    add("maintenance-completed.json", "receipt", 55n);
    await expect(
      pin.include("maintenance-completed.json", {
        bytes: Buffer.from("wrong"),
        device: 1,
        inode: 55,
      }),
    ).rejects.toThrow();
    files.delete(`${root}/maintenance-completed.json`);
    add("chat-results/nested");
    await expect(pin.verify()).rejects.toThrow();
  });
  it("bounds a single file before allocating its read buffer", async () => {
    files.get(record)!.content = Buffer.alloc(1048577);
    await expect(retainEmptyArchive(root)).rejects.toThrow();
  });
});
