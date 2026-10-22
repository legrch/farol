import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquirePromotionLease,
  isPromotionLeaseHeldSync,
  promotionLeasePath,
  releasePromotionLease,
  verifyPromotionLease,
} from "../../src/apps/desktop/promotion-lease";

const childScript = fileURLToPath(
  new URL("./fixtures/promotion-lease-child.mjs", import.meta.url),
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function userData(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-lease-"));
  roots.push(root);
  return root;
}

function runChild(
  userDataRoot: string,
  mode: "probe" | "acquire-release",
  generation = "child-generation",
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [childScript, userDataRoot, mode, generation],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), code });
    });
  });
}

function spawnHolder(userDataRoot: string, generation: string) {
  return spawn(
    process.execPath,
    [childScript, userDataRoot, "hold", generation],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function waitForLine(
  child: ReturnType<typeof spawn>,
  needle: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) {
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    setTimeout(
      () => reject(new Error(`timed out waiting for ${needle}`)),
      10_000,
    ).unref();
  });
}

function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  });
}

async function inodeOf(file: string): Promise<{ dev: bigint; ino: bigint }> {
  const info = await fs.lstat(file, { bigint: true });
  return { dev: info.dev, ino: info.ino };
}

describe("promotion lease", () => {
  it("is exclusive within a process: a second acquire refuses while the first holds it", async () => {
    const root = await userData();
    const first = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(first).not.toBeNull();
    const second = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(second).toBeNull();
    await releasePromotionLease(first!);
    const third = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(third).not.toBeNull();
    await releasePromotionLease(third!);
  });

  it("locks one private regular file at the documented path and keeps that inode across release and re-acquire", async () => {
    const root = await userData();
    const handle = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(handle).not.toBeNull();
    const file = promotionLeasePath(root);
    expect(handle!.file).toBe(file);
    const info = await fs.lstat(file);
    expect(info.isFile()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.mode & 0o077).toBe(0);
    expect(info.nlink).toBe(1);
    const held = JSON.parse(await fs.readFile(file, "utf8"));
    // Exactly the schema-1 record a binary on the previous protocol reads,
    // so it fails closed against a live holder instead of removing it.
    expect(Object.keys(held).sort()).toEqual([
      "acquiredAt",
      "generation",
      "nonce",
      "pid",
      "role",
      "schema",
    ]);
    expect(held).toMatchObject({
      schema: 1,
      generation: "gen-a",
      role: "promotion",
      pid: process.pid,
    });
    const before = await inodeOf(file);
    await releasePromotionLease(handle!);
    // Released: the file stays (the lock lives on this inode), emptied so no
    // reader mistakes the old record for a holder.
    const after = await fs.lstat(file);
    expect(after.size).toBe(0);
    expect(await inodeOf(file)).toEqual(before);
    const again = await acquirePromotionLease(root, "gen-b", "promotion");
    expect(again).not.toBeNull();
    expect(await inodeOf(file)).toEqual(before);
    await releasePromotionLease(again!);
  });

  it("a second release of the same handle is a no-op and never disturbs a later holder", async () => {
    const root = await userData();
    const first = await acquirePromotionLease(root, "gen-a", "promotion");
    await releasePromotionLease(first!);
    const second = await acquirePromotionLease(root, "gen-b", "admission");
    expect(second).not.toBeNull();
    await releasePromotionLease(first!);
    const probe = await runChild(root, "probe");
    expect(probe.stdout).toBe("REFUSED\n");
    expect(probe.code).toBe(1);
    expect(await verifyPromotionLease(second!)).toBe(true);
    await releasePromotionLease(second!);
  });

  it("fails closed on a symlinked lease file", async () => {
    const root = await userData();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-lease-outside-"),
    );
    roots.push(outside);
    const decoy = path.join(outside, "decoy.json");
    await fs.writeFile(decoy, "{}", { mode: 0o600 });
    await fs.mkdir(path.join(root, "farol-state"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.symlink(decoy, promotionLeasePath(root));
    await expect(
      acquirePromotionLease(root, "gen-a", "promotion"),
    ).rejects.toThrow(/PROMOTION_LEASE_UNSAFE/u);
    expect(isPromotionLeaseHeldSync(root)).toBe(true);
  });

  it("fails closed when the state directory is a symlink or is not private", async () => {
    const root = await userData();
    const elsewhere = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-lease-elsewhere-"),
    );
    roots.push(elsewhere);
    await fs.symlink(elsewhere, path.join(root, "farol-state"));
    await expect(
      acquirePromotionLease(root, "gen-a", "promotion"),
    ).rejects.toThrow(/PROMOTION_LEASE_UNSAFE/u);

    const shared = await userData();
    await fs.mkdir(path.join(shared, "farol-state"), { mode: 0o755 });
    await expect(
      acquirePromotionLease(shared, "gen-a", "promotion"),
    ).rejects.toThrow(/PROMOTION_LEASE_UNSAFE/u);
  });

  it("refuses an unknown role or an invalid generation before touching the file", async () => {
    const root = await userData();
    await expect(
      acquirePromotionLease(root, "gen-a", "owner" as never),
    ).rejects.toThrow(/PROMOTION_LEASE_ROLE_INVALID/u);
    await expect(acquirePromotionLease(root, "", "promotion")).rejects.toThrow(
      /PROMOTION_LEASE_GENERATION_INVALID/u,
    );
    await expect(fs.lstat(promotionLeasePath(root))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("the synchronous check reports the lock, including one held by this very process", async () => {
    const root = await userData();
    expect(isPromotionLeaseHeldSync(root)).toBe(false);
    const handle = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(isPromotionLeaseHeldSync(root)).toBe(true);
    await releasePromotionLease(handle!);
    expect(isPromotionLeaseHeldSync(root)).toBe(false);
    // The probe never took the lease: an acquire right after it succeeds.
    const again = await acquirePromotionLease(root, "gen-b", "admission");
    expect(again).not.toBeNull();
    await releasePromotionLease(again!);
  });

  it("cross-process proof: a lease taken in this process refuses a competing acquire in a separate one", async () => {
    const root = await userData();
    const handle = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(handle).not.toBeNull();
    const before = await inodeOf(handle!.file);

    const probe = await runChild(root, "probe");
    expect(probe.stdout).toBe("REFUSED\n");
    expect(probe.code).toBe(1);
    // The refused process never replaced the record or the inode.
    expect(JSON.parse(await fs.readFile(handle!.file, "utf8"))).toEqual(
      handle!.record,
    );
    expect(await inodeOf(handle!.file)).toEqual(before);

    await releasePromotionLease(handle!);
    const afterRelease = await runChild(root, "acquire-release");
    expect(afterRelease.stdout).toBe("ACQUIRED\nRELEASED\n");
    expect(afterRelease.code).toBe(0);
    expect(await inodeOf(handle!.file)).toEqual(before);
  });

  it("a crashed holder's lock is gone in the kernel: the next acquire succeeds at once, on the same inode", async () => {
    const root = await userData();
    const holder = spawnHolder(root, "gen-a");
    try {
      await waitForLine(holder, "ACQUIRED");
      const before = await inodeOf(promotionLeasePath(root));
      expect(isPromotionLeaseHeldSync(root)).toBe(true);
      await expect(
        acquirePromotionLease(root, "gen-b", "promotion"),
      ).resolves.toBeNull();

      await killAndWait(holder);

      expect(isPromotionLeaseHeldSync(root)).toBe(false);
      const recovered = await acquirePromotionLease(root, "gen-c", "promotion");
      expect(recovered).not.toBeNull();
      expect(recovered!.record.generation).toBe("gen-c");
      expect(await inodeOf(promotionLeasePath(root))).toEqual(before);
      await releasePromotionLease(recovered!);
    } finally {
      await killAndWait(holder);
    }
  });

  // S35-03/3, kernel-lock form: three real processes contend for ONE inode.
  // While A holds, B and C are both refused; after A dies, exactly one later
  // acquirer wins; the lease file's identity never changes and it never has
  // a second link, so there is no window in which a second holder could
  // lock a different file under the same name.
  it("S35-03/3 three real processes never produce two holders and never move the lease off its inode", async () => {
    const root = await userData();
    const file = promotionLeasePath(root);
    const holder = spawnHolder(root, "gen-a");
    try {
      await waitForLine(holder, "ACQUIRED");
      const identity = await inodeOf(file);

      const [b, c] = await Promise.all([
        runChild(root, "probe", "gen-b"),
        runChild(root, "probe", "gen-c"),
      ]);
      expect(b.stdout).toBe("REFUSED\n");
      expect(c.stdout).toBe("REFUSED\n");
      expect(await inodeOf(file)).toEqual(identity);
      expect((await fs.lstat(file)).nlink).toBe(1);
      expect(JSON.parse(await fs.readFile(file, "utf8")).generation).toBe(
        "gen-a",
      );

      await killAndWait(holder);

      const [d, e] = await Promise.all([
        runChild(root, "acquire-release", "gen-d"),
        runChild(root, "acquire-release", "gen-e"),
      ]);
      // Both may win in turn (each releases), but never at once: a winner
      // prints ACQUIRED then RELEASED; a loser prints REFUSED.
      for (const outcome of [d, e]) {
        expect(["ACQUIRED\nRELEASED\n", "REFUSED\n"]).toContain(outcome.stdout);
      }
      expect([d, e].some((outcome) => outcome.code === 0)).toBe(true);
      expect(await inodeOf(file)).toEqual(identity);
      expect((await fs.lstat(file)).nlink).toBe(1);
    } finally {
      await killAndWait(holder);
    }
  });

  it("fencing: a lease whose file was deleted underneath it no longer verifies, because a fresh acquirer locks a new inode", async () => {
    const root = await userData();
    const handle = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(handle).not.toBeNull();
    expect(await verifyPromotionLease(handle!)).toBe(true);

    // The one thing the kernel lock cannot survive: a person removing the
    // file by hand. A later acquirer then locks a different inode.
    await fs.unlink(handle!.file);
    expect(await verifyPromotionLease(handle!)).toBe(false);
    const holder = spawnHolder(root, "gen-b");
    try {
      await waitForLine(holder, "ACQUIRED");
      expect(await verifyPromotionLease(handle!)).toBe(false);
      expect(isPromotionLeaseHeldSync(root)).toBe(true);
    } finally {
      await killAndWait(holder);
    }
    await releasePromotionLease(handle!);
    expect(await verifyPromotionLease(handle!)).toBe(false);
  });

  it("a record left behind by the previous protocol is not a holder: the lock, not the bytes, decides", async () => {
    const root = await userData();
    await fs.mkdir(path.join(root, "farol-state"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      promotionLeasePath(root),
      `${JSON.stringify({
        schema: 1,
        generation: "gen-old",
        role: "promotion",
        pid: 999_999,
        nonce: "0".repeat(32),
        acquiredAt: "2026-09-19T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    expect(isPromotionLeaseHeldSync(root)).toBe(false);
    const handle = await acquirePromotionLease(root, "gen-new", "admission");
    expect(handle).not.toBeNull();
    expect(JSON.parse(await fs.readFile(handle!.file, "utf8"))).toMatchObject({
      generation: "gen-new",
      pid: process.pid,
    });
    await releasePromotionLease(handle!);
  });
});
