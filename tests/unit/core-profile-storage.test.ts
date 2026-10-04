import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openNativeProfileStorage } from "../../apps/desktop/bridge/profile-storage.ts";

// CPU-only provisioning double: no real files, fsync, descriptors or native
// profile are used. This does not attest crash durability or installed startup.
const fixture = vi.hoisted(() => {
  type Node = {
    kind: "directory" | "file" | "symlink";
    dev: bigint;
    ino: bigint;
    uid: bigint;
    mode: bigint;
    content: string;
  };
  const nodes = new Map<string, Node>();
  const held = new Map<number, Node>();
  const mkdirs: string[] = [];
  const opened: number[] = [];
  const closed: number[] = [];
  const writes: string[] = [];
  const faults = new Map<string, string>();
  let nextInode = 20n;
  let nextFd = 10;
  const error = (code: string): Error =>
    Object.assign(new Error("synthetic storage boundary"), { code });
  const directory = (path: string): void => {
    nodes.set(path, {
      kind: "directory",
      dev: 7n,
      ino: nextInode++,
      uid: 501n,
      mode: 0o40700n,
      content: "",
    });
  };
  const node = (path: string): Node => {
    const n = nodes.get(path);
    if (!n) throw error("ENOENT");
    return n;
  };
  const stat = (n: Node | undefined, options: unknown): object => {
    if (!n || (options as { bigint?: unknown }).bigint !== true)
      throw error("EBADF");
    return {
      dev: n.dev,
      ino: n.ino,
      uid: n.uid,
      mode: n.mode,
      nlink: 1n,
      size: BigInt(Buffer.byteLength(n.content)),
      mtimeNs: 1n,
      ctimeNs: 1n,
      isDirectory: () => n.kind === "directory",
      isSymbolicLink: () => n.kind === "symlink",
      isFile: () => n.kind === "file",
    };
  };
  const fs = {
    constants: {
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_CREAT: 2,
      O_EXCL: 4,
      O_NOFOLLOW: 8,
      O_NONBLOCK: 16,
    },
    lstatSync: (path: string, options: unknown): object =>
      stat(node(path), options),
    fstatSync: (fd: number, options: unknown): object =>
      stat(held.get(fd), options),
    realpathSync: (path: string): string => {
      node(path);
      return path;
    },
    mkdirSync: (path: string, options: { mode: number }): void => {
      mkdirs.push(path);
      if (options.mode !== 0o700) throw error("EINVAL");
      const fault = faults.get(path);
      if (fault) throw error(fault);
      if (nodes.has(path)) throw error("EEXIST");
      directory(path);
    },
    openSync: (path: string, flags: number, mode?: number): number => {
      if (flags & 2) {
        if (nodes.has(path) || mode !== 0o600) throw error("EEXIST");
        nodes.set(path, {
          kind: "file",
          dev: 7n,
          ino: nextInode++,
          uid: 501n,
          mode: 0o100600n,
          content: "",
        });
      }
      const fd = nextFd++;
      held.set(fd, node(path));
      opened.push(fd);
      return fd;
    },
    writeFileSync: (fd: number, content: string): void => {
      const n = held.get(fd);
      if (!n) throw error("EBADF");
      n.content = content;
      writes.push(content);
    },
    readSync: (
      fd: number,
      output: Buffer,
      offset: number,
      length: number,
      position: number,
    ): number => {
      const n = held.get(fd);
      if (!n) throw error("EBADF");
      return Buffer.from(n.content).copy(
        output,
        offset,
        position,
        position + length,
      );
    },
    fsyncSync: (fd: number): void => {
      if (!held.has(fd)) throw error("EBADF");
    },
    closeSync: (fd: number): void => {
      closed.push(fd);
      held.delete(fd);
    },
  };
  const reset = (): void => {
    nodes.clear();
    held.clear();
    faults.clear();
    mkdirs.length = 0;
    opened.length = 0;
    closed.length = 0;
    writes.length = 0;
    nextInode = 20n;
    nextFd = 10;
    directory("/fixture/state");
  };
  const existing = (): void => {
    for (const path of [
      "/fixture/state/go-core",
      "/fixture/state/go-core/computer",
      "/fixture/state/go-core/chat",
      "/fixture/state/go-core/task",
    ])
      directory(path);
    nodes.set("/fixture/state/go-core/profile.json", {
      kind: "file",
      dev: 7n,
      ino: nextInode++,
      uid: 501n,
      mode: 0o100600n,
      content:
        JSON.stringify({
          schema: "farol-native-profile/1",
          profileId: "existing-profile",
          computerId: "computer",
        }) + "\n",
    });
  };
  return {
    fs,
    nodes,
    node,
    mkdirs,
    opened,
    closed,
    writes,
    faults,
    reset,
    existing,
  };
});
vi.mock("node:fs", () => ({ default: fixture.fs }));
vi.mock("node:crypto", () => ({ randomUUID: () => "new-profile" }));
beforeEach(() => {
  fixture.reset();
  vi.spyOn(process, "getuid").mockReturnValue(501);
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("creates the version 2 mutation child only in known first provisioning", () => {
  const out = openNativeProfileStorage("/fixture/state", "computer");
  expect(out).toEqual({
    profileId: "new-profile",
    root: "/fixture/state/go-core",
    storeMode: "create",
    settingsMutations: true,
  });
  expect(fixture.mkdirs).toEqual([
    "/fixture/state/go-core",
    "/fixture/state/go-core/computer",
    "/fixture/state/go-core/computer/mutations",
    "/fixture/state/go-core/chat",
    "/fixture/state/go-core/task",
  ]);
  expect(fixture.node(out.root + "/task").mode).toBe(0o40700n);
  expect(JSON.parse(fixture.writes[0]!)).toEqual({
    schema: "farol-native-profile/2",
    profileId: "new-profile",
    computerId: "computer",
  });
  expect(fixture.closed).toEqual(fixture.opened);
  expect(Object.isFrozen(out)).toBe(true);
});

it("opens an existing exact profile without provisioning children or changing its identity", () => {
  fixture.existing();
  expect(openNativeProfileStorage("/fixture/state", "computer")).toEqual({
    profileId: "existing-profile",
    root: "/fixture/state/go-core",
    storeMode: "open",
    settingsMutations: false,
  });
  expect(fixture.mkdirs).toEqual(["/fixture/state/go-core"]);
  expect(fixture.writes).toEqual([]);
  expect(fixture.closed).toEqual(fixture.opened);
});

it("refuses an existing missing Task child without repair or marker mutation", () => {
  fixture.existing();
  fixture.nodes.delete("/fixture/state/go-core/task");
  expect(() =>
    openNativeProfileStorage("/fixture/state", "computer"),
  ).toThrow();
  expect(fixture.mkdirs).toEqual(["/fixture/state/go-core"]);
  expect(fixture.nodes.has("/fixture/state/go-core/task")).toBe(false);
  expect(fixture.writes).toEqual([]);
  expect(fixture.closed).toEqual(fixture.opened);
});

it.each(["permissions", "owner", "symlink"])(
  "refuses existing Task %s without child mutation",
  (kind) => {
    fixture.existing();
    const node = fixture.node("/fixture/state/go-core/task");
    if (kind === "permissions") node.mode = 0o40750n;
    else if (kind === "owner") node.uid = 502n;
    else node.kind = "symlink";
    expect(() =>
      openNativeProfileStorage("/fixture/state", "computer"),
    ).toThrow("native_profile_storage_invalid");
    expect(fixture.mkdirs).toEqual(["/fixture/state/go-core"]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.closed).toEqual(fixture.opened);
  },
);

it("retains partial first provisioning and refuses a later open without completing Task creation", () => {
  const taskPath = "/fixture/state/go-core/task";
  fixture.faults.set(taskPath, "EACCES");
  expect(() =>
    openNativeProfileStorage("/fixture/state", "computer"),
  ).toThrow();
  expect(fixture.writes).toEqual([]);
  expect(fixture.nodes.has(taskPath)).toBe(false);
  const attempts = fixture.mkdirs.filter((p) => p === taskPath).length;
  fixture.faults.clear();
  expect(() =>
    openNativeProfileStorage("/fixture/state", "computer"),
  ).toThrow();
  expect(fixture.mkdirs.filter((p) => p === taskPath)).toHaveLength(attempts);
  expect(fixture.nodes.has(taskPath)).toBe(false);
  expect(fixture.writes).toEqual([]);
});

it("opens the exact version 2 layout without reprovisioning the journal", () => {
  const first = openNativeProfileStorage("/fixture/state", "computer");
  fixture.mkdirs.length = 0;
  fixture.writes.length = 0;
  expect(openNativeProfileStorage("/fixture/state", "computer")).toEqual({
    ...first,
    storeMode: "open",
  });
  expect(fixture.mkdirs).toEqual(["/fixture/state/go-core"]);
  expect(fixture.writes).toEqual([]);
});

it.each(["missing", "permissions", "owner", "symlink"])(
  "refuses version 2 mutation storage %s without repair or downgrade",
  (kind) => {
    openNativeProfileStorage("/fixture/state", "computer");
    const target = "/fixture/state/go-core/computer/mutations";
    if (kind === "missing") fixture.nodes.delete(target);
    else if (kind === "permissions") fixture.node(target).mode = 0o40750n;
    else if (kind === "owner") fixture.node(target).uid = 502n;
    else fixture.node(target).kind = "symlink";
    fixture.mkdirs.length = 0;
    fixture.writes.length = 0;
    expect(() =>
      openNativeProfileStorage("/fixture/state", "computer"),
    ).toThrow();
    expect(fixture.mkdirs).toEqual(["/fixture/state/go-core"]);
    expect(fixture.writes).toEqual([]);
  },
);

it("does not infer a version 1 mutation route from an ambient directory", () => {
  fixture.existing();
  fixture.fs.mkdirSync("/fixture/state/go-core/computer/mutations", {
    mode: 0o700,
  });
  fixture.mkdirs.length = 0;
  expect(
    openNativeProfileStorage("/fixture/state", "computer").settingsMutations,
  ).toBe(false);
  expect(fixture.mkdirs).toEqual(["/fixture/state/go-core"]);
  expect(fixture.writes).toEqual([]);
});
