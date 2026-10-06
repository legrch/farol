import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  forbidIO: false,
  calls: [] as string[],
  beforeOpen: null as null | ((name: string, flags: unknown) => Promise<void>),
  afterRead: null as null | ((name: string) => Promise<void>),
  afterSync: null as null | ((name: string) => Promise<void>),
  afterClose: null as null | ((name: string) => Promise<void>),
  failStat: null as string | null,
  foreignPath: null as string | null,
  shortRead: null as string | null,
  shortWrite: false,
  failWrite: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const observe = (name: unknown) => {
    hooks.calls.push(String(name));
    if (hooks.forbidIO) throw new Error("UNEXPECTED_FILESYSTEM_CALL");
  };
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      observe(args[0]);
      return actual.mkdir(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      observe(args[0]);
      return actual.realpath(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      observe(args[0]);
      const stat = await actual.lstat(...args);
      return args[0] === hooks.foreignPath
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
            uid: args[1]?.bigint
              ? BigInt(process.getuid!() + 1)
              : process.getuid!() + 1,
          })
        : stat;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      observe(args[0]);
      const name = String(args[0]);
      await hooks.beforeOpen?.(name, args[1]);
      const file = await actual.open(...args);
      return new Proxy(file, {
        get(target, property) {
          if (property === "stat")
            return async (...options: Parameters<typeof file.stat>) => {
              if (hooks.failStat === name) throw new Error("STAT_UNAVAILABLE");
              return target.stat(...options);
            };
          if (property === "read")
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              if (hooks.shortRead === name) return { bytesRead: 0, buffer };
              const read = await target.read(buffer, offset, length, position);
              await hooks.afterRead?.(name);
              return read;
            };
          if (property === "write")
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              if (hooks.failWrite) throw new Error("WRITE_FAILED");
              return target.write(
                buffer,
                offset,
                hooks.shortWrite ? Math.min(length, 7) : length,
                position,
              );
            };
          if (property === "sync")
            return async () => {
              await target.sync();
              await hooks.afterSync?.(name);
            };
          if (property === "close")
            return async () => {
              await target.close();
              await hooks.afterClose?.(name);
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createGithubUpdateTransport,
  type GithubUpdateTransport,
} from "../../src/modules/release/infra/native/github-update-transport";
import {
  MAX_ARCHIVE_BYTES,
  type ReleaseManifest,
  type RetainedReleaseManifest,
} from "../../src/modules/release/domain/github-release-contract";

// The filesystem cases use disposable roots and scripted race points. Their
// payload is synthetic archive bytes, and the package verifier is doubled:
// these tests do not qualify a ZIP/package, an installed app or a release feed.
const roots: string[] = [];
const bytes = Buffer.from("synthetic local archive bytes");
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function manifest(payload = bytes): ReleaseManifest {
  return {
    schema: "farol.github-release/1",
    repository: "legrch/farol",
    channel: "owner-beta",
    product: "Farol Next Preview",
    bundleId: "local.farol.next.preview",
    version: "0.2.0-owner.beta.2",
    buildVersion: "16",
    sourceCommit: "1".repeat(40),
    sourceTreeDigest: "2".repeat(64),
    buildId: "3".repeat(64),
    artifactSha256: "4".repeat(64),
    archiveSha256: sha(payload),
    archiveName: "Farol-0.2.0-owner.beta.2-darwin-arm64.zip",
    archiveSize: payload.length,
    platform: "darwin",
    arch: "arm64",
    signing: "unsigned",
    notarized: false,
    sourceDirty: false,
  };
}
function transport(root: string) {
  const openHttps = vi.fn(async () => {
    throw new Error("UNEXPECTED_NETWORK");
  });
  const verifyPackage = vi.fn(
    async (_handle: string, expected: RetainedReleaseManifest) => ({
      identity: { ...expected, updateChannel: "github-owner-beta" },
      stagedAppPath: "/synthetic/Farol.app",
      stagingRoot: "/synthetic",
    }),
  );
  return {
    instance: createGithubUpdateTransport({
      privateStateDirectory: root,
      openHttps,
      verifyPackage,
    }),
    openHttps,
    verifyPackage,
  };
}
async function fixture(payload = bytes) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "farol-local-archive-")),
  );
  roots.push(root);
  const state = path.join(root, "state");
  await fs.mkdir(state, { mode: 0o700 });
  const source = path.join(root, "selected.zip");
  await fs.writeFile(source, payload, { mode: 0o644 });
  return {
    root,
    state,
    source,
    stage: path.join(state, "github-updates"),
    manifest: manifest(payload),
    ...transport(state),
  };
}
async function imported(
  instance: GithubUpdateTransport,
  source: string,
  expected: ReleaseManifest,
) {
  const result = await instance.importLocal(source, expected);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
async function emptyStage(stage: string) {
  const entries = await fs.readdir(stage);
  expect(entries).toHaveLength(1);
  const handle = path.join(stage, entries[0]!);
  expect((await fs.stat(handle)).size).toBe(0);
  return handle;
}

afterEach(async () => {
  hooks.forbidIO = false;
  hooks.calls.length = 0;
  hooks.beforeOpen = null;
  hooks.afterRead = null;
  hooks.afterSync = null;
  hooks.afterClose = null;
  hooks.failStat = null;
  hooks.foreignPath = null;
  hooks.shortRead = null;
  hooks.shortWrite = false;
  hooks.failWrite = false;
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe("local archive pure admission", () => {
  it.each([
    { repository: "legrch/farol-releases" },
    { repository: "other/farol" },
    { sourceDirty: true },
    { archiveSize: 0 },
    { archiveSize: MAX_ARCHIVE_BYTES + 1 },
    { archiveSha256: "invalid" },
    { archiveName: "other.zip" },
    { unexpected: true },
  ])(
    "rejects a non-current or invalid manifest before IO: %j",
    async (change) => {
      hooks.forbidIO = true;
      const t = transport("/unused");
      expect(
        await t.instance.importLocal("/selected.zip", {
          ...manifest(),
          ...change,
        }),
      ).toMatchObject({
        ok: false,
        kind: "package_mismatch",
        certainty: "known",
      });
      expect(hooks.calls).toEqual([]);
      expect(t.openHttps).not.toHaveBeenCalled();
      expect(t.verifyPackage).not.toHaveBeenCalled();
    },
  );
  it.each(["selected.zip", "/tmp/../selected.zip", "file:///selected.zip", ""])(
    "rejects noncanonical input before IO: %s",
    async (source) => {
      hooks.forbidIO = true;
      expect(
        await transport("/unused").instance.importLocal(source, manifest()),
      ).toMatchObject({ ok: false, reason: "invalid_handle" });
      expect(hooks.calls).toEqual([]);
    },
  );
  it("does not allocate after lifetime cancellation", async () => {
    hooks.forbidIO = true;
    const t = transport("/unused");
    t.instance.cancelPending();
    expect(
      await t.instance.importLocal("/selected.zip", manifest()),
    ).toMatchObject({ ok: false, reason: "cancelled", certainty: "known" });
    expect(hooks.calls).toEqual([]);
  });
});

describe("local archive disposable filesystem", () => {
  it("issues the ordinary private handle for verification, discard and reuse", async () => {
    const f = await fixture();
    const opens: Array<{ name: string; flags: number }> = [];
    hooks.beforeOpen = async (name, flags) => {
      opens.push({ name, flags: Number(flags) });
    };
    const first = await imported(f.instance, f.source, f.manifest);
    expect(first).toEqual({
      handle: expect.stringMatching(/\/github-updates\/[a-f0-9-]{36}\.zip$/u),
      size: bytes.length,
      sha256: sha(bytes),
    });
    expect(await fs.readFile(first.handle)).toEqual(bytes);
    expect(await fs.readFile(f.source)).toEqual(bytes);
    expect((await fs.stat(first.handle)).mode & 0o777).toBe(0o600);
    expect(
      opens.find((item) => item.name === f.source)!.flags &
        constants.O_NOFOLLOW,
    ).not.toBe(0);
    expect(
      opens.find((item) => item.name === f.source)!.flags &
        constants.O_NONBLOCK,
    ).not.toBe(0);
    expect(f.verifyPackage).not.toHaveBeenCalled();
    expect(
      await f.instance.verifyPackage(first.handle, f.manifest),
    ).toMatchObject({ ok: true });
    expect(f.verifyPackage).toHaveBeenCalledWith(first.handle, f.manifest);
    expect(await f.instance.discard(first.handle)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await emptyStage(f.stage)).toBe(first.handle);
    expect((await imported(f.instance, f.source, f.manifest)).handle).toBe(
      first.handle,
    );
    expect(f.openHttps).not.toHaveBeenCalled();
    expect(await fs.readdir(f.state)).toEqual(["github-updates"]);
  });
  it("permits cold retained verification and checksum-bound reclamation", async () => {
    const f = await fixture();
    const first = await imported(f.instance, f.source, f.manifest);
    const cold = transport(f.state);
    expect(
      await cold.instance.verifyPackage(first.handle, f.manifest),
    ).toMatchObject({ ok: true });
    expect(
      await cold.instance.reclaimRetained(first.handle, f.manifest),
    ).toEqual({ ok: true, value: undefined });
    expect(await emptyStage(f.stage)).toBe(first.handle);
    expect((await imported(cold.instance, f.source, f.manifest)).handle).toBe(
      first.handle,
    );
  });
  it.each([
    "symlink",
    "parent-alias",
    "hardlink",
    "directory",
    "foreign-owner",
    "missing",
  ])("refuses unsafe source without stage allocation: %s", async (kind) => {
    const f = await fixture();
    let source = f.source;
    if (kind === "symlink") {
      source = path.join(f.root, "alias.zip");
      await fs.symlink(f.source, source);
    }
    if (kind === "parent-alias") {
      await fs.symlink(f.root, path.join(f.root, "alias"));
      source = path.join(f.root, "alias/selected.zip");
    }
    if (kind === "hardlink")
      await fs.link(f.source, path.join(f.root, "linked.zip"));
    if (kind === "directory") source = f.root;
    // Metadata double: no chown or other privileged operation is needed.
    if (kind === "foreign-owner") hooks.foreignPath = f.source;
    if (kind === "missing") source = path.join(f.root, "missing.zip");
    expect(await f.instance.importLocal(source, f.manifest)).toMatchObject({
      ok: false,
      certainty: "known",
    });
    expect(await fs.readdir(f.state)).toEqual([]);
    expect(await fs.readFile(f.source)).toEqual(bytes);
  });
  it("refuses source substitution between metadata and no-follow open", async () => {
    const f = await fixture();
    hooks.beforeOpen = async (name) => {
      if (name !== f.source) return;
      hooks.beforeOpen = null;
      await fs.rename(f.source, f.source + ".old");
      await fs.writeFile(f.source, bytes);
    };
    expect(await f.instance.importLocal(f.source, f.manifest)).toMatchObject({
      ok: false,
    });
    expect(await fs.readdir(f.state)).toEqual([]);
  });
  it("validates size before allocation and clears a checksum rejection through the existing owner", async () => {
    const f = await fixture();
    expect(
      await f.instance.importLocal(f.source, {
        ...f.manifest,
        archiveSize: bytes.length + 1,
      }),
    ).toMatchObject({ ok: false, reason: "content_length" });
    expect(await fs.readdir(f.state)).toEqual([]);
    expect(
      await f.instance.importLocal(f.source, {
        ...f.manifest,
        archiveSha256: "0".repeat(64),
      }),
    ).toMatchObject({ ok: false, reason: "verification", certainty: "known" });
    const reusable = await emptyStage(f.stage);
    expect((await imported(f.instance, f.source, f.manifest)).handle).toBe(
      reusable,
    );
  });
  it.each(["grow", "replace", "rewrite", "short"])(
    "rejects a changing or short source and preserves it: %s",
    async (kind) => {
      const f = await fixture();
      if (kind === "short") hooks.shortRead = f.source;
      hooks.afterRead = async (name) => {
        if (name !== f.source) return;
        hooks.afterRead = null;
        if (kind === "grow") await fs.appendFile(f.source, "extra");
        if (kind === "replace") await fs.rename(f.source, f.source + ".old");
        if (kind === "replace" || kind === "rewrite")
          await fs.writeFile(f.source, Buffer.alloc(bytes.length, 9));
      };
      expect(await f.instance.importLocal(f.source, f.manifest)).toMatchObject({
        ok: false,
        certainty: "known",
      });
      await emptyStage(f.stage);
      expect((await fs.stat(f.source)).size).toBeGreaterThan(0);
    },
  );
  it("handles partial writes without losing bytes", async () => {
    const f = await fixture();
    hooks.shortWrite = true;
    const result = await imported(f.instance, f.source, f.manifest);
    expect(await fs.readFile(result.handle)).toEqual(bytes);
  });
  it.each(["cancel", "deadline", "write-failure"])(
    "bounds copy and confirms partial-stage cleanup: %s",
    async (kind) => {
      const f = await fixture(Buffer.alloc(150_000, 7));
      let reads = 0;
      hooks.afterRead = async (name) => {
        if (name !== f.source || ++reads !== 2) return;
        if (kind === "cancel") f.instance.cancelPending();
        if (kind === "deadline")
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
        if (kind === "write-failure") hooks.failWrite = true;
      };
      expect(await f.instance.importLocal(f.source, f.manifest)).toMatchObject({
        ok: false,
        certainty: "known",
        reason:
          kind === "cancel"
            ? "cancelled"
            : kind === "deadline"
              ? "timeout"
              : "stream",
      });
      await emptyStage(f.stage);
      expect(await fs.readFile(f.source)).toEqual(Buffer.alloc(150_000, 7));
    },
  );
  it("pins manifest values before asynchronous copy", async () => {
    const f = await fixture();
    const selected = { ...f.manifest };
    hooks.afterRead = async (name) => {
      if (name !== f.source) return;
      selected.archiveSha256 = "0".repeat(64);
      selected.archiveSize = 1;
    };
    expect(await f.instance.importLocal(f.source, selected)).toMatchObject({
      ok: true,
      value: { size: bytes.length, sha256: sha(bytes) },
    });
  });
  it("rehashes staged bytes before issuing a handle", async () => {
    const f = await fixture();
    hooks.afterSync = async (name) => {
      if (!name.startsWith(f.stage + "/")) return;
      hooks.afterSync = null;
      await fs.writeFile(name, Buffer.alloc(bytes.length, 8));
    };
    expect(await f.instance.importLocal(f.source, f.manifest)).toMatchObject({
      ok: false,
      reason: "verification",
    });
    await emptyStage(f.stage);
  });
  it.each(["stage-file", "stage-directory", "state-directory"])(
    "retains uncertainty and never truncates a substitute: %s",
    async (kind) => {
      const f = await fixture();
      const sentinel = Buffer.from("foreign replacement");
      let replacement = "";
      hooks.afterSync = async (name) => {
        if (!name.startsWith(f.stage + "/")) return;
        hooks.afterSync = null;
        if (kind === "stage-file") await fs.rename(name, name + ".old");
        else {
          const directory = kind === "stage-directory" ? f.stage : f.state;
          await fs.rename(directory, directory + ".old");
          await fs.mkdir(f.stage, { recursive: true, mode: 0o700 });
        }
        replacement = name;
        await fs.writeFile(name, sentinel, { mode: 0o600 });
      };
      expect(await f.instance.importLocal(f.source, f.manifest)).toMatchObject({
        ok: false,
        certainty: "unknown",
      });
      expect(await fs.readFile(replacement)).toEqual(sentinel);
      expect(await f.instance.discard(replacement)).toMatchObject({
        ok: false,
        reason: "invalid_handle",
      });
    },
  );
  it.each(["replace", "unreadable"])(
    "does not truncate an unproven reusable descriptor: %s",
    async (kind) => {
      const f = await fixture();
      const first = await imported(f.instance, f.source, f.manifest);
      await f.instance.discard(first.handle);
      const sentinel = Buffer.from("preserve existing bytes");
      if (kind === "replace") {
        await fs.rename(first.handle, first.handle + ".old");
        await fs.writeFile(first.handle, sentinel, { mode: 0o600 });
      } else hooks.failStat = first.handle;
      expect(await f.instance.importLocal(f.source, f.manifest)).toMatchObject({
        ok: false,
        certainty: "unknown",
      });
      expect(await fs.readFile(first.handle)).toEqual(
        kind === "replace" ? sentinel : Buffer.alloc(0),
      );
    },
  );
  it("does not issue bytes substituted during final close", async () => {
    const f = await fixture();
    let replacement = "";
    hooks.afterClose = async (name) => {
      if (!name.startsWith(f.stage + "/")) return;
      hooks.afterClose = null;
      await fs.rename(name, name + ".old");
      await fs.writeFile(name, "replacement", { mode: 0o600 });
      replacement = name;
    };
    expect(await f.instance.importLocal(f.source, f.manifest)).toMatchObject({
      ok: false,
      certainty: "unknown",
    });
    expect(await fs.readFile(replacement, "utf8")).toBe("replacement");
    expect(await f.instance.discard(replacement)).toMatchObject({
      ok: false,
      reason: "invalid_handle",
    });
  });
});
