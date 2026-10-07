import { execFile, spawn } from "node:child_process";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installedUpdateHelperModule } from "./fixtures/installed-update-helper-module";
import {
  startInstalledUpdateHelper,
  type InstalledUpdateRequest,
} from "../../src/modules/release/infra/native/installed-update-helper.js";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw new Error("UNEXPECTED_HELPER_SPAWN");
  }),
}));
const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

const source = {
  digest: "1".repeat(64),
  version: "0.1.0",
  buildId: "2".repeat(64),
};
const target = {
  digest: "3".repeat(64),
  version: "0.1.1",
  buildId: "4".repeat(64),
};
const accepted: InstalledUpdateRequest = {
  action: "apply",
  operationId: "a".repeat(32),
  source,
  target,
  drain: {
    status: "reconciled",
    acceptedSource: source.buildId,
    acceptedTarget: target.buildId,
  },
  pid: 987654,
  processStart: "Tue Sep 29 23:00:00 2026",
  waitSeconds: 5,
  relaunch: false,
};

describe("installed update launcher", () => {
  it("B06 refuses legacy app-only rollback after a real new-format settings save without changing the state", async () => {
    // Real module/file publication, not the later assembled app journey.
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-rollback-settings-"),
    );
    roots.push(root);
    const store = new ProductSettingsStore({ root });
    const service = new ProductConfigurationService(store);
    await service.initialize();
    expect(
      (await service.updateComputerFilePolicy("approved-roots-v1")).ok,
    ).toBe(true);
    const file = path.join(root, "config.json");
    const saved = await fs.readFile(file);
    expect((await store.load())!.computer.filePolicy).toBe("approved-roots-v1");
    for (const closed of [false, true]) {
      const input = {
        ...accepted,
        action: "rollback" as const,
        source: { ...source, version: "0.1.11-owner.beta.1" },
        target: { ...target, version: "0.2.0-owner.beta.2" },
        relaunch: false as const,
        ...(closed
          ? {
              predecessor: {
                kind: "confirmed_closed" as const,
                startedAt: new Date().toISOString(),
                lastQuitSha256: "5".repeat(64),
                stateIdentity: { device: "1", inode: "2" },
              },
            }
          : {}),
      };
      const release = vi.fn();
      const verify = vi.fn();
      await expect(
        startInstalledUpdateHelper(
          path.join(root, "not-read-helper.py"),
          input,
          {
            promotionLease: {
              descriptor: 99,
              identity: { device: "1", inode: "3" },
              verify,
              release,
            },
          },
        ),
      ).rejects.toThrow("INSTALLED_UPDATE_PREDECESSOR_STATE_UNQUALIFIED");
      expect(spawn).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(await fs.readFile(file)).toEqual(saved);
    }
  });
  it("rejects a changed helper before spawning it", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "farol-update-launcher-"),
    );
    roots.push(root);
    const helper = path.join(root, "update_helper.py");
    await fs.copyFile(
      path.join(process.cwd(), "resources/native/update_helper.py"),
      helper,
    );
    await fs.appendFile(helper, "\n# changed\n");
    const result = await startInstalledUpdateHelper(helper, accepted);
    expect(result).toMatchObject({
      status: "not_started",
      reason: "helper_preflight_failed",
    });
    expect(result.operation.pid).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("requires matching accepted build identities and a bounded process wait", async () => {
    await expect(
      startInstalledUpdateHelper("/nonexistent", {
        ...accepted,
        drain: { ...accepted.drain, acceptedTarget: source.buildId },
      }),
    ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
    await expect(
      startInstalledUpdateHelper("/nonexistent", {
        ...accepted,
        waitSeconds: 999,
      }),
    ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
  });

  it.each([
    ["recover", false],
    ["recover", true],
    ["rollback", true],
  ] as const)(
    "rejects closed %s with relaunch=%s at the TS input boundary",
    async (action, relaunch) => {
      const invalid = {
        ...accepted,
        action,
        relaunch,
        predecessor: {
          kind: "confirmed_closed",
          startedAt: "2026-09-29T22:00:00.000Z",
          lastQuitSha256: "5".repeat(64),
          stateIdentity: { device: "11", inode: "22" },
        },
      } as unknown as InstalledUpdateRequest;
      await expect(
        startInstalledUpdateHelper("/nonexistent", invalid),
      ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});

async function helperFixture(): Promise<{ root: string; helper: string }> {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-helper-bytes-"),
  );
  roots.push(root);
  const helper = path.join(root, "update_helper.py");
  await fs.copyFile(
    path.join(process.cwd(), "resources/native/update_helper.py"),
    helper,
  );
  return { root, helper };
}

type FifoDeadlinePhase = "startup" | "preflight" | "teardown";
function fifoWatchdog(expired: (phase: FifoDeadlinePhase) => void) {
  let phase: FifoDeadlinePhase | "expired" | "closed" = "startup";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (next: FifoDeadlinePhase, milliseconds: number) => {
    clearTimeout(timer);
    phase = next;
    timer = setTimeout(() => {
      phase = "expired";
      expired(next);
    }, milliseconds);
  };
  // Each lifecycle phase is bounded separately. 10 s + 1.5 s + 10 s leaves
  // fixture work inside the existing 30 s suite budget; the open budget is unchanged.
  arm("startup", 10_000);
  return {
    attempted() {
      if (phase !== "startup") return false;
      arm("preflight", 1500);
      return true;
    },
    returned() {
      if (phase === "preflight") arm("teardown", 10_000);
    },
    stop() {
      clearTimeout(timer);
      phase = "closed";
    },
  };
}

function withFifoClock(
  check: (
    watch: ReturnType<typeof fifoWatchdog>,
    expired: FifoDeadlinePhase[],
  ) => void,
) {
  vi.useFakeTimers();
  const expired: FifoDeadlinePhase[] = [];
  const watch = fifoWatchdog((phase) => expired.push(phase));
  try {
    check(watch, expired);
  } finally {
    watch.stop();
    vi.useRealTimers();
  }
}

// CPU-only clock/control evidence. These cases create no filesystem or child.
describe("FIFO probe watchdog phases", () => {
  it("excludes startup and natural child close from the descriptor budget", () => {
    withFifoClock((watch, expired) => {
      vi.advanceTimersByTime(9999);
      expect(watch.attempted()).toBe(true);
      vi.advanceTimersByTime(1499);
      watch.returned();
      vi.advanceTimersByTime(9999);
      expect(expired).toEqual([]);
      watch.stop();
      vi.advanceTimersByTime(30_000);
      expect(expired).toEqual([]);
    });
  });
  it("still expires a blocked preflight at exactly 1500 ms without rearming it", () => {
    withFifoClock((watch, expired) => {
      expect(watch.attempted()).toBe(true);
      vi.advanceTimersByTime(1499);
      expect(expired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(expired).toEqual(["preflight"]);
      expect(watch.attempted()).toBe(false);
      watch.returned();
      vi.advanceTimersByTime(30_000);
      expect(expired).toEqual(["preflight"]);
    });
  });
  it.each(["startup", "teardown"] as const)(
    "bounds %s independently",
    (phase) => {
      withFifoClock((watch, expired) => {
        if (phase === "teardown") {
          expect(watch.attempted()).toBe(true);
          watch.returned();
        }
        vi.advanceTimersByTime(9999);
        expect(expired).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(expired).toEqual([phase]);
        expect(watch.attempted()).toBe(false);
      });
    },
  );
});

// Run the blocking-open regression outside the test runner. No process opens the
// FIFO for writing; only this harness may terminate its exact owned child.
async function fifoProbe(replaceAtOpen: boolean) {
  const { root, helper } = await helperFixture();
  const moduleURL = await installedUpdateHelperModule(root);
  if (!replaceAtOpen) {
    await fs.unlink(helper);
    await execFileAsync("/usr/bin/mkfifo", [helper]);
  }
  const program = String.raw`
    import fs from "node:fs/promises";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const [moduleURL, helper, request, replaceAtOpen] = process.argv.slice(1);
    let continued = false;
    async function beginProbe() {
      process.stdout.write("attempt\n");
      let command = "";
      for await (const chunk of process.stdin) {
        command += chunk.toString();
        if (command.length > 16) throw new Error("PROBE_CONTINUATION_INVALID");
      }
      if (command !== "continue\n") throw new Error("PROBE_CONTINUATION_INVALID");
      continued = true;
    }
    // This probe is only allowed to reach helper preflight, never spawn Python.
    childProcess.spawn = () => { throw new Error("UNEXPECTED_HELPER_SPAWN"); };
    syncBuiltinESMExports();
    if (replaceAtOpen === "true") {
      const open = fs.open.bind(fs);
      fs.open = async (...args) => {
        if (args[0] === helper) {
          await fs.rename(helper, helper + ".saved");
          childProcess.execFileSync("/usr/bin/mkfifo", [helper]);
          // The parent arms the unchanged open deadline only after FIFO setup.
          await beginProbe();
        }
        return open(...args);
      };
    }
    const { startInstalledUpdateHelper } = await import(moduleURL);
    if (replaceAtOpen !== "true") await beginProbe();
    try {
      const result = await startInstalledUpdateHelper(helper, JSON.parse(request));
      process.stdout.write(result.reason + "\n");
      if (result.status !== "not_started" || result.operation.pid !== null || !continued) process.exitCode = 1;
    } catch (error) {
      process.stdout.write(error.message + "\n");
    }
  `;
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      program,
      moduleURL,
      helper,
      JSON.stringify(accepted),
      String(replaceAtOpen),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let stderr = "";
  let deadlineExpired = false;
  let deadlinePhase: FifoDeadlinePhase | null = null;
  const watchdog = fifoWatchdog((phase) => {
    deadlineExpired = true;
    deadlinePhase = phase;
    child.kill("SIGKILL");
  });
  child.stdin.on("error", (error: Error) => {
    stderr += error.message + "\n";
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.startsWith("attempt\n") && watchdog.attempted())
      child.stdin.end("continue\n");
    if (output === "attempt\nhelper_preflight_failed\n") watchdog.returned();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("close", (code, signal) => {
      watchdog.stop();
      resolve({ code, signal });
    });
    child.once("error", reject);
  });
  try {
    const exit = await closed;
    // Confirm both process close and fixture removal before asserting GREEN/RED.
    await fs.rm(root, { recursive: true });
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    return {
      ...exit,
      deadlineExpired,
      deadlinePhase,
      output,
      stderr,
      cleanup: "child_closed_and_fixture_removed",
    };
  } finally {
    watchdog.stop();
  }
}

describe("installed helper bounded descriptor read", () => {
  it.each([false, true])(
    "refuses a no-writer FIFO without hanging (replaceAtOpen=%s)",
    async (replaceAtOpen) => {
      const result = await fifoProbe(replaceAtOpen);
      expect(result, result.stderr).toMatchObject({
        code: 0,
        signal: null,
        deadlineExpired: false,
        deadlinePhase: null,
        output: "attempt\nhelper_preflight_failed\n",
        cleanup: "child_closed_and_fixture_removed",
      });
    },
  );

  it("rejects a same-byte inode substitution between lstat and open", async () => {
    const { helper } = await helperFixture();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
      await fs.rename(helper, helper + ".saved");
      await fs.copyFile(helper + ".saved", helper);
      return open(file, flags, mode);
    });
    const result = await startInstalledUpdateHelper(helper, accepted);
    expect(result).toMatchObject({
      status: "not_started",
      reason: "helper_preflight_failed",
    });
    expect(result.operation.pid).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("bounds a growing file to its checked size plus one sentinel byte", async () => {
    const { helper } = await helperFixture();
    const handle = await fs.open(helper, "r");
    const size = (await handle.stat()).size;
    let requested = 0;
    let allocated = 0;
    const read = vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        requested += length;
        allocated = Math.max(allocated, buffer.length);
        await fs.appendFile(helper, Buffer.alloc(128 * 1024));
        return handle.read(buffer, offset, length, position);
      },
    );
    const readFile = vi.fn(() => {
      throw new Error("UNBOUNDED_HELPER_READ");
    });
    const close = vi.fn(() => handle.close());
    vi.spyOn(fs, "open").mockResolvedValueOnce({
      stat: handle.stat.bind(handle),
      read,
      readFile,
      close,
    } as unknown as FileHandle);
    const result = await startInstalledUpdateHelper(helper, accepted);
    expect(result).toMatchObject({
      status: "not_started",
      reason: "helper_preflight_failed",
    });
    expect(result.operation.pid).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(allocated).toBe(size + 1);
    expect(requested).toBe(size + 1);
    expect(close).toHaveBeenCalledOnce();
  });
});
