import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RUN_MARKER_BYTES,
  RUN_MARKER_FILE_NAME,
  RunMarkerSchema,
  SAME_BOOT_TOLERANCE_MS,
  classifyRunMarker,
  currentBootTimeMs,
  processAlive,
  readRunMarker,
  removeRunMarker,
  runMarkerPath,
  sameBoot,
  writeRunMarker,
} from "../../src/apps/desktop/run-marker";

const roots: string[] = [];
// Any whole-second epoch instant; the tests never depend on the machine's
// real boot time, which a sandbox may refuse to report.
const BOOT = 1_758_000_000_000;
const startedAt = "2026-09-20T10:00:00.000Z";
const now = Date.parse(startedAt);

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

// The state root as the desktop names it, not yet created: the writer owns
// its creation like every other store does.
async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-marker-"));
  roots.push(root);
  return path.join(root, "farol-next-state");
}

async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (child.pid === undefined) throw new Error("child had no pid");
  return child.pid;
}

describe("run marker", () => {
  it("writes a private regular marker with the documented shape and replaces the one a previous run left", async () => {
    const root = await stateRoot();
    const first = await writeRunMarker(root, {
      pid: 4242,
      now,
      bootTime: BOOT,
    });
    expect(first).toEqual({ schema: 1, pid: 4242, startedAt, bootTime: BOOT });
    const file = runMarkerPath(root);
    const info = await fs.lstat(file);
    expect(info.isFile()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.mode & 0o077).toBe(0);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    const bytes = await fs.readFile(file, "utf8");
    expect(bytes).toBe(`${JSON.stringify(first)}\n`);
    expect(RunMarkerSchema.safeParse(JSON.parse(bytes)).success).toBe(true);
    expect(await readRunMarker(root)).toEqual({
      status: "read",
      marker: first,
    });

    // A crash leaves the marker; the next start replaces it with its own,
    // and a writer that could not read the boot time records that.
    const second = await writeRunMarker(root, {
      pid: 4343,
      now,
      bootTime: null,
    });
    expect(await readRunMarker(root)).toEqual({
      status: "read",
      marker: second,
    });
    expect((await fs.readdir(root)).sort()).toEqual([RUN_MARKER_FILE_NAME]);
  });

  it("refuses a relative root, an invalid pid, and replacing anything that is not a private regular file", async () => {
    await expect(
      writeRunMarker("relative", { pid: 1, now, bootTime: BOOT }),
    ).rejects.toThrow("RUN_MARKER_ROOT_NOT_ABSOLUTE");
    const root = await stateRoot();
    await expect(
      writeRunMarker(root, { pid: 0, now, bootTime: BOOT }),
    ).rejects.toThrow();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.mkdir(runMarkerPath(root));
    await expect(
      writeRunMarker(root, { pid: 1, now, bootTime: BOOT }),
    ).rejects.toThrow("RUN_MARKER_UNSAFE");
  });

  it("removes only the marker this pid wrote", async () => {
    const root = await stateRoot();
    await writeRunMarker(root, { pid: 4242, now, bootTime: BOOT });
    expect(await removeRunMarker(root, 9_999)).toEqual({
      removed: false,
      reason: "OTHER_PID",
    });
    expect(await readRunMarker(root)).toMatchObject({ status: "read" });
    expect(await removeRunMarker(root, 4242)).toEqual({ removed: true });
    expect(await readRunMarker(root)).toEqual({ status: "absent" });
    expect(await removeRunMarker(root, 4242)).toEqual({
      removed: false,
      reason: "ABSENT",
    });
  });

  it("reads with the private-file discipline the promotion reader applies, and leaves what it cannot read in place", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const file = runMarkerPath(root);
    const valid = { schema: 1, pid: 4242, startedAt, bootTime: BOOT };
    const cases: Array<[string, string, number]> = [
      ["CORRUPT", "{not json", 0o600],
      ["MALFORMED", JSON.stringify({ schema: 1, pid: 4242 }), 0o600],
      ["MALFORMED", JSON.stringify({ ...valid, extra: true }), 0o600],
      [
        "MALFORMED",
        JSON.stringify({ ...valid, startedAt: "2026-09-20T10:00:00Z" }),
        0o600,
      ],
      ["UNKNOWN_VERSION", JSON.stringify({ ...valid, schema: 2 }), 0o600],
      ["UNSAFE", JSON.stringify(valid), 0o644],
      [
        "OVERSIZED",
        `${" ".repeat(MAX_RUN_MARKER_BYTES)}${JSON.stringify(valid)}`,
        0o600,
      ],
    ];
    for (const [reason, text, mode] of cases) {
      await fs.rm(file, { force: true });
      await fs.writeFile(file, text, { mode });
      expect(await readRunMarker(root), reason).toEqual({
        status: "unreadable",
        reason,
      });
      expect(await removeRunMarker(root, 4242), reason).toEqual({
        removed: false,
        reason,
      });
      await expect(fs.lstat(file), reason).resolves.toBeDefined();
    }
    await fs.rm(file, { force: true });
    const outside = path.join(path.dirname(root), "outside.json");
    await fs.writeFile(outside, JSON.stringify(valid), { mode: 0o600 });
    await fs.symlink(outside, file);
    expect(await readRunMarker(root)).toEqual({
      status: "unreadable",
      reason: "SYMLINK",
    });
    expect(await removeRunMarker(root, 4242)).toEqual({
      removed: false,
      reason: "SYMLINK",
    });
    await expect(fs.lstat(file)).resolves.toBeDefined();
    await expect(fs.readFile(outside, "utf8")).resolves.toBe(
      JSON.stringify(valid),
    );
  });

  it("classifies a marker: a dead pid is a crash on any boot, a live pid is running only on the same boot, an unknown boot is never guessed", () => {
    const marker = { schema: 1 as const, pid: 4242, startedAt, bootTime: BOOT };
    const alive = () => true;
    const dead = () => false;
    expect(classifyRunMarker(marker, { bootTime: BOOT, isAlive: alive })).toBe(
      "running",
    );
    expect(
      classifyRunMarker(marker, {
        bootTime: BOOT + SAME_BOOT_TOLERANCE_MS,
        isAlive: alive,
      }),
    ).toBe("running");
    expect(
      classifyRunMarker(marker, {
        bootTime: BOOT - SAME_BOOT_TOLERANCE_MS,
        isAlive: alive,
      }),
    ).toBe("running");
    expect(
      classifyRunMarker(marker, {
        bootTime: BOOT + SAME_BOOT_TOLERANCE_MS + 1,
        isAlive: alive,
      }),
    ).toBe("crashed");
    expect(
      classifyRunMarker(marker, {
        bootTime: BOOT - 86_400_000,
        isAlive: alive,
      }),
    ).toBe("crashed");
    expect(classifyRunMarker(marker, { bootTime: BOOT, isAlive: dead })).toBe(
      "crashed",
    );
    expect(classifyRunMarker(marker, { bootTime: null, isAlive: alive })).toBe(
      "boot_unknown",
    );
    expect(
      classifyRunMarker(
        { ...marker, bootTime: null },
        { bootTime: BOOT, isAlive: alive },
      ),
    ).toBe("boot_unknown");
    expect(
      classifyRunMarker(
        { ...marker, bootTime: null },
        { bootTime: null, isAlive: dead },
      ),
    ).toBe("crashed");
    expect(sameBoot(BOOT, null)).toBe(false);
    expect(sameBoot(null, BOOT)).toBe(false);
  });

  it("liveness: this process is alive, an exited child is not, and a process this user may not signal counts as alive", async () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(await exitedChildPid())).toBe(false);
    // pid 1 exists on every macOS and is not signalable by an ordinary
    // user: `kill(1, 0)` is EPERM, and EPERM must read as alive.
    expect(processAlive(1)).toBe(true);
  });

  it("derives the boot time in whole seconds from the uptime, and reports null when the uptime cannot be read", () => {
    const instant = 1_000_000_000_000;
    expect(currentBootTimeMs(instant, () => 3_600)).toBe(instant - 3_600_000);
    expect(currentBootTimeMs(instant, () => 3_600.4)).toBe(instant - 3_600_000);
    expect(currentBootTimeMs(instant + 499, () => 3_600)).toBe(
      instant - 3_600_000,
    );
    expect(
      currentBootTimeMs(instant, () => {
        throw new Error("uv_uptime returned EPERM");
      }),
    ).toBeNull();
    expect(currentBootTimeMs(instant, () => Number.NaN)).toBeNull();
    expect(currentBootTimeMs(instant, () => -1)).toBeNull();
    expect(currentBootTimeMs(1_000, () => 5)).toBeNull();
    // The real reader: whole seconds, not in the future, stable across two
    // readings. A sandbox that denies the uptime sysctl yields null, which
    // is the documented outcome, not a failure of this test.
    const real = currentBootTimeMs();
    if (real !== null) {
      expect(real % 1_000).toBe(0);
      expect(real).toBeLessThanOrEqual(Date.now());
      expect(sameBoot(real, currentBootTimeMs())).toBe(true);
    }
  });
});
