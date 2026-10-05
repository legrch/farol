import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectorLaunchBasename,
  loadConnectorLaunch,
  type ConnectorLaunch,
} from "../../apps/desktop/bridge/connector-launch.ts";

// Disposable native filesystem evidence for the TS loader only. All identities,
// challenge and token are synthetic; no profile, Go publisher, socket, connector
// child, app or provider is used. Fixtures exist only inside test callbacks.
// /usr/bin/mkfifo creates only the exact test-owned FIFO when this suite runs.
const unavailable = "COMPUTER_MCP_GO_LAUNCH_UNAVAILABLE";
type Root = {
  path: string;
  stat: fs.BigIntStats;
  entries: Map<string, fs.BigIntStats>;
};
const roots: Root[] = [];
const stat = (file: string) => fs.lstatSync(file, { bigint: true });
const same = (a: fs.BigIntStats, b: fs.BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  (a.mode & 0o170000n) === (b.mode & 0o170000n);

function checkRoot(root: Root): void {
  if (
    !same(root.stat, stat(root.path)) ||
    fs.realpathSync(root.path) !== root.path
  )
    throw new Error(`FIXTURE_ROOT_UNCERTAIN:${root.path}`);
}
function newRoot(): Root {
  if (typeof process.getuid !== "function")
    throw new Error("FIXTURE_REQUIRES_POSIX_UID");
  const directory = fs.mkdtempSync("/private/tmp/farol-mcp-loader-");
  const root: Root = {
    path: directory,
    stat: stat(directory),
    entries: new Map(),
  };
  roots.push(root);
  fs.chmodSync(directory, 0o700);
  checkRoot(root);
  expect(root.stat.uid).toBe(BigInt(process.getuid()));
  expect(stat(directory).mode & 0o7777n).toBe(0o700n);
  return root;
}
function remember(root: Root, name: string): string {
  const file = path.join(root.path, name);
  root.entries.set(name, stat(file));
  return file;
}
function write(root: Root, name: string, bytes: Buffer): string {
  checkRoot(root);
  const file = path.join(root.path, name);
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  remember(root, name);
  fs.chmodSync(file, 0o600);
  return file;
}
function move(root: Root, from: string, to: string): void {
  checkRoot(root);
  const source = path.join(root.path, from),
    destination = path.join(root.path, to);
  const expected = root.entries.get(from);
  if (
    !expected ||
    !same(expected, stat(source)) ||
    fs.lstatSync(destination, { throwIfNoEntry: false }) !== undefined
  )
    throw new Error("FIXTURE_MOVE_UNCERTAIN");
  fs.renameSync(source, destination);
  root.entries.delete(from);
  root.entries.set(to, expected);
}
afterEach(() => {
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const root of roots.splice(0).reverse()) {
    try {
      checkRoot(root);
      const names = fs.readdirSync(root.path);
      // Check all children before any removal. Unknown/replaced resources retain
      // the root and are reported, never recursively deleted or retried.
      for (const name of names) {
        const expected = root.entries.get(name);
        if (!expected || !same(expected, stat(path.join(root.path, name))))
          throw new Error(
            `FIXTURE_ENTRY_UNCERTAIN:${path.join(root.path, name)}`,
          );
      }
      for (const name of names) {
        checkRoot(root);
        const file = path.join(root.path, name);
        if (!same(root.entries.get(name)!, stat(file)))
          throw new Error(`FIXTURE_ENTRY_UNCERTAIN:${file}`);
        fs.unlinkSync(file);
      }
      checkRoot(root);
      fs.rmdirSync(root.path); // Unexpected new entries fail closed.
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "FIXTURE_CLEANUP_UNCERTAIN_RESOURCES_RETAINED",
    );
});

function fixture(transform: (bytes: Buffer) => Buffer = (bytes) => bytes) {
  const root = newRoot();
  const launch: ConnectorLaunch = {
    schema: "farol-go-connector/1",
    lifecycleRoot: path.join(root.path, "synthetic-authority"),
    challengeSha256: "a".repeat(64),
    opened: {
      endpoint: {
        binding: {
          buildId: "synthetic-build",
          profileId: "synthetic-profile",
          backendGeneration: "synthetic-backend",
          runtimeId: "synthetic-runtime",
          connectorGeneration: "9007199254740993",
        },
        socketPath: path.join(root.path, "computer.sock"),
        token: "b".repeat(64),
      },
      execution: {
        ownerId: "synthetic-owner",
        sessionId: "synthetic-session",
        taskId: "synthetic-task",
        taskEpoch: "9007199254740995",
        participantId: "synthetic-participant",
        turnId: "synthetic-turn",
        generation: "9007199254740997",
      },
      admissionOperationId: "synthetic-admission",
    },
  };
  const bytes = transform(Buffer.from(JSON.stringify(launch), "utf8"));
  return {
    root,
    launch,
    bytes,
    file: write(root, connectorLaunchBasename, bytes),
  };
}
function fifo(root: Root): void {
  checkRoot(root);
  const file = path.join(root.path, connectorLaunchBasename);
  execFileSync("/usr/bin/mkfifo", ["-m", "600", file], {
    timeout: 5000,
    stdio: "pipe",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  remember(root, connectorLaunchBasename);
  fs.chmodSync(file, 0o600);
  expect(stat(file).isFIFO()).toBe(true);
}
function closed(fd: number | undefined): void {
  expect(fd).toBeTypeOf("number");
  expect(() => fs.fstatSync(fd!)).toThrow(
    expect.objectContaining({ code: "EBADF" }),
  );
}

describe("Go connector launch TS loader on disposable native files", () => {
  it("reads a 0600 owner file and hashes exact bytes, including whitespace", () => {
    const f = fixture((bytes) =>
      Buffer.concat([Buffer.from(" \n"), bytes, Buffer.from("\n")]),
    );
    const before = stat(f.file),
      loaded = loadConnectorLaunch(f.file);
    expect(before.isFile()).toBe(true);
    expect(before.nlink).toBe(1n);
    expect(before.uid).toBe(BigInt(process.getuid!()));
    expect(before.mode & 0o7777n).toBe(0o600n);
    expect(loaded.launch).toEqual(f.launch);
    expect(loaded.sha256).toBe(
      createHash("sha256").update(f.bytes).digest("hex"),
    );
    expect(loaded.sha256).not.toBe(
      createHash("sha256").update(JSON.stringify(f.launch)).digest("hex"),
    );
    expect(Object.isFrozen(loaded.launch.opened.endpoint.binding)).toBe(true);
    expect(same(before, stat(f.file))).toBe(true);
    expect(stat(f.file).mtimeNs).toBe(before.mtimeNs);
    expect(stat(f.file).ctimeNs).toBe(before.ctimeNs);
    expect(fs.readFileSync(f.file)).toEqual(f.bytes);
    expect(fs.readdirSync(f.root.path)).toEqual([connectorLaunchBasename]);
  });

  it("accepts 16384 bytes but rejects 16385 before opening", () => {
    const f = fixture((bytes) =>
      Buffer.concat([bytes, Buffer.alloc(16384 - bytes.length, 0x20)]),
    );
    expect(loadConnectorLaunch(f.file).sha256).toBe(
      createHash("sha256").update(f.bytes).digest("hex"),
    );
    fs.appendFileSync(f.file, " ");
    const open = vi.spyOn(fs, "openSync");
    expect(() => loadConnectorLaunch(f.file)).toThrow(unavailable);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["trailing", "duplicate", "UTF8"] as const)(
    "rejects %s bytes from a real file",
    (kind) => {
      const f = fixture((bytes) => {
        if (kind === "trailing")
          return Buffer.concat([bytes, Buffer.from("{}")]);
        if (kind === "duplicate")
          return Buffer.from(
            '{"schema":"farol-go-connector/1",' + bytes.toString().slice(1),
          );
        const start = bytes.indexOf(Buffer.from("synthetic-build"));
        expect(start).toBeGreaterThan(0);
        return Buffer.concat([
          bytes.subarray(0, start),
          Buffer.from([0xff]),
          bytes.subarray(start),
        ]);
      });
      expect(() => loadConnectorLaunch(f.file)).toThrow(unavailable);
    },
  );

  it.each(["file", "root"] as const)(
    "rejects unsafe %s mode before opening",
    (kind) => {
      const f = fixture();
      fs.chmodSync(
        kind === "file" ? f.file : f.root.path,
        kind === "file" ? 0o644 : 0o755,
      );
      const open = vi.spyOn(fs, "openSync");
      expect(() => loadConnectorLaunch(f.file)).toThrow(unavailable);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each(["symlink", "hardlink", "FIFO"] as const)(
    "rejects a real %s before opening",
    (kind) => {
      const f = fixture();
      move(f.root, connectorLaunchBasename, "retained.json");
      const retained = path.join(f.root.path, "retained.json");
      if (kind === "FIFO") fifo(f.root);
      else {
        if (kind === "symlink") fs.symlinkSync(retained, f.file);
        else fs.linkSync(retained, f.file);
        remember(f.root, connectorLaunchBasename);
        expect(
          kind === "symlink"
            ? stat(f.file).isSymbolicLink()
            : stat(f.file).nlink === 2n,
        ).toBe(true);
      }
      const open = vi.spyOn(fs, "openSync");
      expect(() => loadConnectorLaunch(f.file)).toThrow(unavailable);
      expect(open).not.toHaveBeenCalled();
      expect(fs.readFileSync(retained)).toEqual(f.bytes);
    },
  );

  it("rejects a FIFO substituted just before a real O_NONBLOCK open and closes its fd", () => {
    const f = fixture(),
      nativeOpen = fs.openSync.bind(fs);
    let swapped = false,
      fd: number | undefined;
    const read = vi.spyOn(fs, "readSync");
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (file === f.file && !swapped) {
        // Fail before the syscall if O_NONBLOCK regresses; never hang on a FIFO.
        expect(flags).toBe(
          fs.constants.O_RDONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
        );
        swapped = true;
        move(f.root, connectorLaunchBasename, "retained.json");
        fifo(f.root);
        fd = nativeOpen(file, flags, mode);
        return fd;
      }
      return nativeOpen(file, flags, mode);
    });
    expect(() => loadConnectorLaunch(f.file)).toThrow(unavailable);
    expect(swapped).toBe(true);
    expect(read).not.toHaveBeenCalled();
    closed(fd);
  });

  it("rejects same-byte file replacement after a real read and closes the held fd", () => {
    const f = fixture(),
      nativeRead = fs.readSync.bind(fs);
    write(f.root, "replacement.json", f.bytes);
    let swapped = false,
      fd: number | undefined;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const count = nativeRead(...args);
      if (!swapped && count > 0) {
        swapped = true;
        fd = args[0];
        move(f.root, connectorLaunchBasename, "retained.json");
        move(f.root, "replacement.json", connectorLaunchBasename);
      }
      return count;
    });
    expect(() => loadConnectorLaunch(f.file)).toThrow(unavailable);
    expect(swapped).toBe(true);
    expect(
      same(stat(f.file), stat(path.join(f.root.path, "retained.json"))),
    ).toBe(false);
    expect(fs.readFileSync(f.file)).toEqual(f.bytes);
    closed(fd);
  });

  it("rejects root substitution after the last file check with the same file inode", () => {
    const f = fixture(),
      parked = newRoot(),
      originalPath = f.root.path;
    const nativeLstat = fs.lstatSync.bind(fs),
      beforeFile = stat(f.file);
    let checks = 0,
      substituted = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const actual = nativeLstat(...args);
      if (args[0] === f.file && ++checks === 2) {
        // Genuine last file stat, then a synchronous root swap: isolate the
        // final directory-inode check without inventing metadata or a seam.
        checkRoot(f.root);
        checkRoot(parked);
        expect(fs.readdirSync(parked.path)).toEqual([]);
        fs.renameSync(f.root.path, parked.path);
        f.root.path = parked.path;
        roots.splice(roots.indexOf(parked), 1);
        fs.mkdirSync(originalPath, { mode: 0o700 });
        const replacement: Root = {
          path: originalPath,
          stat: stat(originalPath),
          entries: new Map(),
        };
        roots.push(replacement);
        fs.chmodSync(originalPath, 0o700);
        fs.renameSync(path.join(f.root.path, connectorLaunchBasename), f.file);
        replacement.entries.set(
          connectorLaunchBasename,
          f.root.entries.get(connectorLaunchBasename)!,
        );
        f.root.entries.delete(connectorLaunchBasename);
        substituted = true;
      }
      return actual;
    });
    expect(() => loadConnectorLaunch(f.file)).toThrow(unavailable);
    expect(substituted).toBe(true);
    expect(checks).toBe(2);
    vi.restoreAllMocks();
    expect(same(f.root.stat, stat(originalPath))).toBe(false);
    expect(same(beforeFile, stat(f.file))).toBe(true);
    expect(stat(f.file).nlink).toBe(1n);
    expect(fs.readFileSync(f.file)).toEqual(f.bytes);
  });
});
