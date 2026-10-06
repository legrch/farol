import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeQuitReceipt } from "../../src/apps/desktop/quit-receipt";

const processFixture = vi.hoisted(() => ({
  alive: true,
  start: "selected-start",
}));
vi.mock("../../src/apps/desktop/run-marker", async (original) => ({
  ...(await original<typeof import("../../src/apps/desktop/run-marker")>()),
  processAlive: () => processFixture.alive,
  readProcessStart: () => processFixture.start,
  currentBootTimeMs: () => 1000,
}));
import { captureInstalledPredecessor } from "../../src/apps/desktop/installed-predecessor";

let home: string;
let state: string;
const pid = 987654;
const marker = {
  schema: 1,
  pid,
  startedAt: "2026-09-01T00:00:00.000Z",
  bootTime: 1000,
  processStart: "selected-start",
};
const signal = vi.fn();
beforeEach(async () => {
  processFixture.alive = true;
  processFixture.start = "selected-start";
  signal.mockReset();
  home = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-predecessor-"),
  );
  const profile = path.join(
    home,
    "Library/Application Support/Farol Next Preview",
  );
  state = path.join(profile, "farol-next-state");
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.chmod(profile, 0o700);
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  vi.spyOn(process, "kill").mockImplementation(signal);
  await fs.writeFile(path.join(state, "running.json"), JSON.stringify(marker), {
    mode: 0o600,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

async function closeFixture(
  at = "2026-09-01T00:01:00.000Z",
  drained = true,
  unconfirmed: string[] = [],
) {
  const bytes = serializeQuitReceipt({ drained, unconfirmed }, at);
  await fs.writeFile(path.join(state, "last-quit.json"), bytes, {
    mode: 0o600,
  });
  await fs.unlink(path.join(state, "running.json"));
  processFixture.alive = false;
  return bytes;
}

describe("installed predecessor (native files, process observations simulated)", () => {
  it("requests ordinary Quit once and binds fresh closure to the original lifetime", async () => {
    const control = await captureInstalledPredecessor();
    expect(control.original).toEqual({
      pid,
      startedAt: marker.startedAt,
      processStart: marker.processStart,
    });
    await control.requestQuit();
    expect(signal).toHaveBeenCalledExactlyOnceWith(pid, "SIGTERM");
    await expect(control.requestQuit()).rejects.toThrow("ALREADY_ATTEMPTED");
    await expect(control.observeClosed()).rejects.toThrow("STILL_PRESENT");
    const bytes = await closeFixture();
    const proof = await control.observeClosed();
    const physical = await fs.lstat(state, { bigint: true });
    expect(proof).toEqual({
      ...control.original,
      quitDigest: createHash("sha256").update(bytes).digest("hex"),
      stateIdentity: {
        device: physical.dev.toString(),
        inode: physical.ino.toString(),
      },
    });
    expect(await control.observeClosed()).toEqual(proof);
    expect(proof).not.toHaveProperty("exitCode");
  });

  it.each(["different-start", "different-marker", "different-root"])(
    "refuses %s before signaling",
    async (change) => {
      const control = await captureInstalledPredecessor();
      if (change === "different-start") processFixture.start = "another-start";
      if (change === "different-marker")
        await fs.writeFile(
          path.join(state, "running.json"),
          JSON.stringify({ ...marker, pid: pid + 1 }),
        );
      if (change === "different-root") {
        await fs.rename(state, state + "-original");
        await fs.mkdir(state, { mode: 0o700 });
      }
      await expect(control.requestQuit()).rejects.toThrow(/LIFETIME|ROOT/u);
      expect(signal).not.toHaveBeenCalled();
      await expect(control.requestQuit()).rejects.toThrow("ALREADY_ATTEMPTED");
    },
  );

  it.each([
    "stale",
    "future",
    "undrained",
    "unconfirmed",
    "missing",
    "marker-present",
  ])(
    "never upgrades %s closure evidence after PID absence",
    async (scenario) => {
      const control = await captureInstalledPredecessor();
      await closeFixture(
        scenario === "stale"
          ? marker.startedAt
          : scenario === "future"
            ? "2099-01-01T00:00:00.000Z"
            : undefined,
        scenario !== "undrained",
        scenario === "unconfirmed" ? ["child"] : [],
      );
      if (scenario === "missing")
        await fs.unlink(path.join(state, "last-quit.json"));
      if (scenario === "marker-present")
        await fs.writeFile(
          path.join(state, "running.json"),
          JSON.stringify(marker),
          { mode: 0o600 },
        );
      await expect(control.observeClosed()).rejects.toThrow();
      await fs.rm(path.join(state, "running.json"), { force: true });
      await fs.writeFile(
        path.join(state, "last-quit.json"),
        serializeQuitReceipt(
          { drained: true, unconfirmed: [] },
          "2026-09-01T00:02:00.000Z",
        ),
        { mode: 0o600 },
      );
      await expect(control.observeClosed()).rejects.toThrow(
        "CLOSURE_UNCONFIRMED",
      );
      expect(signal).not.toHaveBeenCalled();
    },
  );

  it("refuses a changed receipt after a known closure without adopting its new digest", async () => {
    const control = await captureInstalledPredecessor();
    await closeFixture();
    await control.observeClosed();
    await fs.writeFile(
      path.join(state, "last-quit.json"),
      serializeQuitReceipt(
        { drained: true, unconfirmed: [] },
        "2026-09-01T00:02:00.000Z",
      ),
    );
    await expect(control.observeClosed()).rejects.toThrow("QUIT_CHANGED");
  });

  it.each(["refusal", "different-digest"])(
    "cannot publish over a concurrent %s",
    async (concurrent) => {
      const control = await captureInstalledPredecessor();
      await closeFixture();
      let markPaused!: () => void;
      const paused = new Promise<void>((resolve) => {
        markPaused = resolve;
      });
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const realpath = fs.realpath.bind(fs);
      let homeObservations = 0;
      vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        if (args[0] === home && ++homeObservations === 2) {
          markPaused();
          await resumed;
        }
        return realpath(...args);
      });
      const first = control.observeClosed();
      // Attach a rejection handler before releasing either observation.
      const result = first.then(
        (proof) => ({ proof }),
        (error: unknown) => ({ error }),
      );
      try {
        await paused;
        await fs.writeFile(
          path.join(state, "last-quit.json"),
          serializeQuitReceipt(
            { drained: concurrent !== "refusal", unconfirmed: [] },
            "2026-09-01T00:02:00.000Z",
          ),
        );
        if (concurrent === "refusal") {
          await expect(control.observeClosed()).rejects.toThrow(
            "QUIT_UNCONFIRMED",
          );
        } else {
          await expect(control.observeClosed()).resolves.toMatchObject(
            control.original,
          );
        }
      } finally {
        resume();
      }
      const outcome = await result;
      expect(outcome).toHaveProperty("error");
      if ("error" in outcome) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toContain(
          concurrent === "refusal" ? "CLOSURE_UNCONFIRMED" : "QUIT_CHANGED",
        );
      }
      await expect(control.observeClosed()).rejects.toThrow(
        "CLOSURE_UNCONFIRMED",
      );
      expect(signal).not.toHaveBeenCalled();
    },
  );

  it("does not repeat an uncertain signal", async () => {
    const control = await captureInstalledPredecessor();
    signal.mockImplementation(() => {
      throw new Error("fixture signal outcome unknown");
    });
    await expect(control.requestQuit()).rejects.toThrow(
      "fixture signal outcome unknown",
    );
    await expect(control.requestQuit()).rejects.toThrow("ALREADY_ATTEMPTED");
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it.each(["symlink", "hardlink", "shared"])(
    "refuses %s marker files at capture",
    async (kind) => {
      const file = path.join(state, "running.json");
      if (kind === "shared") await fs.chmod(file, 0o644);
      else if (kind === "hardlink")
        await fs.link(file, path.join(state, "alias"));
      else {
        await fs.rename(file, file + "-original");
        await fs.symlink(file + "-original", file);
      }
      await expect(captureInstalledPredecessor()).rejects.toThrow();
      expect(signal).not.toHaveBeenCalled();
    },
  );
});
