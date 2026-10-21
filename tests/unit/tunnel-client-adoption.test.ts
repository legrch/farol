import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewedTunnelClientPath } from "../../src/apps/desktop/executable-discovery";
import { adoptReviewedTunnelClient } from "../../src/apps/desktop/tunnel-client-adoption";

const REVIEWED = Buffer.from(
  "reviewed tunnel-client build bytes\n".repeat(4_000),
);
const reviewed = {
  sha256: createHash("sha256").update(REVIEWED).digest("hex"),
  bytes: REVIEWED.length,
};
// x86_64 pins a different build: only the arm64 pin applies to these bytes.
const digests = {
  arm64: reviewed,
  x86_64: { sha256: "0".repeat(64), bytes: 1 },
};

let root: string;
let home: string;
let source: string;

beforeEach(async () => {
  // Adoption works on real paths; compare against the same spelling.
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-adoption-")),
  );
  home = path.join(root, "home");
  await fs.mkdir(home);
  source = path.join(root, "homebrew-tunnel-client");
  await fs.writeFile(source, REVIEWED, { mode: 0o755 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const adopt = (from = source, arch = "arm64") =>
  adoptReviewedTunnelClient(from, { home, arch, reviewedDigests: digests });

async function leftovers(): Promise<string[]> {
  const target = reviewedTunnelClientPath(home, "arm64", digests);
  if (!target) throw new Error("no target");
  try {
    return await fs.readdir(path.dirname(target.path));
  } catch {
    return [];
  }
}

describe("adoptReviewedTunnelClient", () => {
  it("copies the reviewed build into this user's reviewed build directory", async () => {
    const adopted = await adopt();
    const target = reviewedTunnelClientPath(home, "arm64", digests);
    expect(adopted).toEqual({
      ok: true,
      path: target?.path,
      sha256: reviewed.sha256,
    });
    if (!adopted.ok) return;
    const info = await fs.lstat(adopted.path);
    expect(info.isFile()).toBe(true);
    expect(info.uid).toBe(process.getuid?.());
    expect(info.mode & 0o777).toBe(0o755);
    expect(await fs.readFile(adopted.path)).toEqual(REVIEWED);
    expect(await leftovers()).toEqual(["tunnel-client"]);
  });

  it("creates every missing directory private to this user", async () => {
    const adopted = await adopt();
    if (!adopted.ok) throw new Error("not adopted");
    for (
      let directory = path.dirname(adopted.path);
      directory !== home;
      directory = path.dirname(directory)
    )
      expect((await fs.lstat(directory)).mode & 0o777).toBe(0o700);
  });

  it("refuses a destination another account could change", async () => {
    // A group-writable directory on the way to the copy.
    await fs.mkdir(path.join(home, ".local"), { mode: 0o700 });
    await fs.chmod(path.join(home, ".local"), 0o770);
    expect(await adopt()).toEqual({ ok: false, reason: "destination-unsafe" });
    await fs.chmod(path.join(home, ".local"), 0o700);
    // A symlinked directory on the way to the copy.
    const elsewhere = path.join(root, "elsewhere");
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.symlink(elsewhere, path.join(home, ".local", "libexec"));
    expect(await adopt()).toEqual({ ok: false, reason: "destination-unsafe" });
    expect(await fs.readdir(elsewhere)).toEqual([]);
    // A world-writable home.
    await fs.rm(path.join(home, ".local", "libexec"));
    await fs.chmod(home, 0o777);
    expect(await adopt()).toEqual({ ok: false, reason: "destination-unsafe" });
    await fs.chmod(home, 0o700);
    expect((await adopt()).ok).toBe(true);
  });

  it("refuses a directory whose ACL lets anyone change it", async () => {
    await fs.mkdir(path.join(home, ".local"), { mode: 0o700 });
    execFileSync("/bin/chmod", [
      "+a",
      "everyone allow add_file,delete_child",
      path.join(home, ".local"),
    ]);
    expect(await adopt()).toEqual({ ok: false, reason: "destination-unsafe" });
    execFileSync("/bin/chmod", ["-N", path.join(home, ".local")]);
    expect((await adopt()).ok).toBe(true);
  });

  it("checks the ancestors of home, which may belong only to root or this user", async () => {
    // The test home's ancestors (the per-user temp tree) pass; a home under a
    // group-writable parent does not.
    const shared = path.join(root, "shared");
    await fs.mkdir(shared, { mode: 0o700 });
    await fs.chmod(shared, 0o775);
    const nested = path.join(shared, "home");
    await fs.mkdir(nested, { mode: 0o700 });
    expect(
      await adoptReviewedTunnelClient(source, {
        home: nested,
        arch: "arm64",
        reviewedDigests: digests,
      }),
    ).toEqual({ ok: false, reason: "destination-unsafe" });
    await fs.chmod(shared, 0o700);
    expect(
      (
        await adoptReviewedTunnelClient(source, {
          home: nested,
          arch: "arm64",
          reviewedDigests: digests,
        })
      ).ok,
    ).toBe(true);
  });

  it("resolves a symlinked home to its real path before writing", async () => {
    const alias = path.join(root, "home-alias");
    await fs.symlink(home, alias);
    const adopted = await adoptReviewedTunnelClient(source, {
      home: alias,
      arch: "arm64",
      reviewedDigests: digests,
    });
    expect(adopted.ok).toBe(true);
    if (adopted.ok)
      expect(adopted.path.startsWith(await fs.realpath(home))).toBe(true);
  });

  it("replaces a stale copy at the target atomically", async () => {
    const target = reviewedTunnelClientPath(home, "arm64", digests);
    if (!target) throw new Error("no target");
    await fs.mkdir(path.dirname(target.path), { recursive: true, mode: 0o700 });
    await fs.writeFile(target.path, "stale");
    const adopted = await adopt();
    expect(adopted.ok).toBe(true);
    expect(await fs.readFile(target.path)).toEqual(REVIEWED);
  });

  it("refuses bytes that are not the reviewed build and leaves nothing behind", async () => {
    const tampered = Buffer.from(REVIEWED);
    tampered[10] = (tampered[10] ?? 0) ^ 0xff;
    await fs.writeFile(source, tampered);
    expect(await adopt()).toEqual({ ok: false, reason: "source-not-reviewed" });
    expect(await leftovers()).toEqual([]);
  });

  it("refuses a source of another size without writing anything", async () => {
    await fs.writeFile(source, Buffer.concat([REVIEWED, Buffer.from("x")]));
    expect(await adopt()).toEqual({ ok: false, reason: "source-not-reviewed" });
    expect(await leftovers()).toEqual([]);
  });

  it("refuses a FIFO source without waiting for a writer", async () => {
    const fifo = path.join(root, "fifo");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    expect(await adopt(fifo)).toEqual({
      ok: false,
      reason: "source-not-a-regular-file",
    });
    expect(await leftovers()).toEqual([]);
  });

  it("does not follow a symlinked source", async () => {
    const link = path.join(root, "link");
    await fs.symlink(source, link);
    expect(await adopt(link)).toEqual({
      ok: false,
      reason: "source-unreadable",
    });
  });

  it("refuses a directory, a missing source and an unreviewed architecture", async () => {
    expect(await adopt(root)).toEqual({
      ok: false,
      reason: "source-not-a-regular-file",
    });
    expect(await adopt(path.join(root, "missing"))).toEqual({
      ok: false,
      reason: "source-unreadable",
    });
    expect(await adopt(source, "ia32")).toEqual({
      ok: false,
      reason: "unsupported-architecture",
    });
  });
});
