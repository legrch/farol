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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-lease-"));
  roots.push(root);
  return root;
}

function runChild(
  userDataRoot: string,
  mode: "probe" | "hold" | "acquire-release",
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

  it("writes a private regular file at the documented path, never a symlink or a shared one", async () => {
    const root = await userData();
    const handle = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(handle).not.toBeNull();
    const file = promotionLeasePath(root);
    expect(handle!.file).toBe(file);
    const info = await fs.lstat(file);
    expect(info.isFile()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.mode & 0o077).toBe(0);
    await releasePromotionLease(handle!);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releasing a lease that was already recovered as stale does not remove the replacement", async () => {
    const root = await userData();
    const first = await acquirePromotionLease(root, "gen-a", "promotion", {
      pid: 999_999, // A pid that is never our own and never alive.
      isAlive: () => false,
    });
    expect(first).not.toBeNull();
    // The lease looks abandoned to any caller using the real liveness check;
    // a second, live acquire recovers it.
    const second = await acquirePromotionLease(root, "gen-b", "promotion");
    expect(second).not.toBeNull();
    expect(second!.record.generation).toBe("gen-b");
    // The original handle's release must not touch the replacement.
    await releasePromotionLease(first!);
    await expect(fs.lstat(promotionLeasePath(root))).resolves.toBeDefined();
    await releasePromotionLease(second!);
  });

  it("fails closed on a symlinked lease file", async () => {
    const root = await userData();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-lease-outside-"),
    );
    roots.push(outside);
    const decoy = path.join(outside, "decoy.json");
    await fs.writeFile(decoy, "{}", { mode: 0o600 });
    await fs.mkdir(path.join(root, "farol-next-state"), { recursive: true });
    await fs.symlink(decoy, promotionLeasePath(root));
    await expect(
      acquirePromotionLease(root, "gen-a", "promotion"),
    ).rejects.toThrow(/PROMOTION_LEASE/u);
    expect(isPromotionLeaseHeldSync(root)).toBe(true);
  });

  it("the sync check work admission uses reports nothing held for a fresh root", async () => {
    const root = await userData();
    expect(isPromotionLeaseHeldSync(root)).toBe(false);
  });

  it("cross-process proof: a lease taken in this process refuses a competing acquire in a separate one", async () => {
    const root = await userData();
    const handle = await acquirePromotionLease(root, "gen-a", "promotion");
    expect(handle).not.toBeNull();
    expect(isPromotionLeaseHeldSync(root)).toBe(false); // Our own pid: not "held by another".

    const probe = await runChild(root, "probe");
    expect(probe.stdout).toBe("REFUSED\n");
    expect(probe.code).toBe(1);

    await releasePromotionLease(handle!);
    const afterRelease = await runChild(root, "acquire-release");
    expect(afterRelease.stdout).toBe("ACQUIRED\nRELEASED\n");
    expect(afterRelease.code).toBe(0);
  });

  it("a crash that leaves the lease behind is recovered by liveness, never a wedge", async () => {
    const root = await userData();
    const holder = spawn(
      process.execPath,
      [childScript, root, "hold", "gen-a"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await waitForLine(holder, "ACQUIRED");
      expect(isPromotionLeaseHeldSync(root)).toBe(true);
      // A live competing attempt in this process is refused while the child
      // really holds the lease.
      await expect(
        acquirePromotionLease(root, "gen-b", "promotion"),
      ).resolves.toBeNull();

      holder.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        holder.once("close", () => resolve()),
      );

      // The dead holder's lease is stale; recovery must not wedge the next
      // acquire, and the sync check must not keep reporting it held.
      const recovered = await acquirePromotionLease(root, "gen-c", "promotion");
      expect(recovered).not.toBeNull();
      expect(recovered!.record.generation).toBe("gen-c");
      await releasePromotionLease(recovered!);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  // S35-03/3: two real processes race to recover the SAME stale lease.
  // Process A claims the stale bytes, then — deterministically, via a real
  // file handshake, not a coin flip on OS scheduling — pauses before it
  // decides what to do with them. While A is paused, a second real process B
  // sees the lease file genuinely absent (A took it) and legitimately
  // acquires a fresh lease of its own. A then resumes holding only the OLD,
  // now-superseded bytes: it must never destroy B's fresh, live lease, and
  // it must end up refused, not believing it also holds the lease.
  it("S35-03/3 two real processes racing the same stale lease never let one destroy the other's fresh one", async () => {
    const root = await userData();

    // Seed a real, genuinely stale lease: a holder that really acquired it,
    // then really died.
    const deadHolder = spawn(
      process.execPath,
      [childScript, root, "hold", "gen-dead"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForLine(deadHolder, "ACQUIRED");
    deadHolder.kill("SIGKILL");
    await new Promise<void>((resolve) =>
      deadHolder.once("close", () => resolve()),
    );

    const handshake = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-lease-handshake-"),
    );
    roots.push(handshake);
    const readyFile = path.join(handshake, "a-ready");
    const goFile = path.join(handshake, "go");

    // Process A: recovers the stale lease, but pauses right after claiming
    // it (see `promotion-lease-child.mjs`) until this test says "go".
    const recoverer = spawn(
      process.execPath,
      [childScript, root, "recover-pause", "gen-a", readyFile, goFile],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const recovererOutput: Buffer[] = [];
    recoverer.stdout.on("data", (chunk: Buffer) => recovererOutput.push(chunk));
    try {
      // Wait for A to have exclusively claimed the stale bytes and to be
      // paused (the ready marker is written only from inside that pause).
      await expect
        .poll(
          () =>
            fs.access(readyFile).then(
              () => true,
              () => false,
            ),
          {
            timeout: 10_000,
          },
        )
        .toBe(true);

      // While A is paused, the lease file is genuinely absent (A holds only
      // its private claim). Process B — a real, separate process — now
      // legitimately acquires a fresh lease at that same path.
      expect(
        await fs.lstat(promotionLeasePath(root)).catch(() => null),
      ).toBeNull();
      const freshHolder = spawn(
        process.execPath,
        [childScript, root, "hold", "gen-b"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        await waitForLine(freshHolder, "ACQUIRED");
        const freshRecordBefore = JSON.parse(
          await fs.readFile(promotionLeasePath(root), "utf8"),
        );
        expect(freshRecordBefore.generation).toBe("gen-b");

        // Let A resume and finish.
        await fs.writeFile(goFile, "go", { mode: 0o600 });
        const exitCode = await new Promise<number | null>((resolve) => {
          recoverer.once("close", (code) => resolve(code));
        });
        const output = Buffer.concat(recovererOutput).toString("utf8");

        // A must lose the race deterministically: it must never claim to
        // hold the lease once a fresh, live holder already exists, and it
        // must never have removed or replaced that holder's record.
        expect(output).toBe("REFUSED\n");
        expect(exitCode).toBe(1);
        const freshRecordAfter = JSON.parse(
          await fs.readFile(promotionLeasePath(root), "utf8"),
        );
        expect(freshRecordAfter).toEqual(freshRecordBefore);
      } finally {
        freshHolder.kill("SIGKILL");
      }
    } finally {
      recoverer.kill("SIGKILL");
    }
  });
});
