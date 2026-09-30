import { execFile, spawn } from "node:child_process";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startInstalledUpdateHelper,
  type InstalledUpdateRequest,
} from "../../src/modules/release/infra/native/installed-update-helper.js";

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

// Run the blocking-open regression outside the test runner. No process opens the
// FIFO for writing; only this harness may terminate its exact owned child.
async function fifoProbe(replaceAtOpen: boolean) {
  const { root, helper } = await helperFixture();
  if (!replaceAtOpen) {
    await fs.unlink(helper);
    await execFileAsync("/usr/bin/mkfifo", [helper]);
  }
  const program = String.raw`
    import fs from "node:fs/promises";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const [moduleURL, helper, request, replaceAtOpen] = process.argv.slice(1);
    // This probe is only allowed to reach helper preflight, never spawn Python.
    childProcess.spawn = () => { throw new Error("UNEXPECTED_HELPER_SPAWN"); };
    syncBuiltinESMExports();
    if (replaceAtOpen === "true") {
      const open = fs.open.bind(fs);
      fs.open = async (...args) => {
        if (args[0] === helper) {
          await fs.rename(helper, helper + ".saved");
          childProcess.execFileSync("/usr/bin/mkfifo", [helper]);
        }
        return open(...args);
      };
    }
    const { startInstalledUpdateHelper } = await import(moduleURL);
    process.stdout.write("attempt\n");
    try {
      const result = await startInstalledUpdateHelper(helper, JSON.parse(request));
      process.stdout.write(result.reason + "\n");
      if (result.status !== "not_started" || result.operation.pid !== null) process.exitCode = 1;
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
      pathToFileURL(
        path.join(
          process.cwd(),
          "src/modules/release/infra/native/installed-update-helper.ts",
        ),
      ).href,
      helper,
      JSON.stringify(accepted),
      String(replaceAtOpen),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let stderr = "";
  let deadlineExpired = false;
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    child.kill("SIGKILL");
  }, 1500);
  try {
    const exit = await closed;
    // Confirm both process close and fixture removal before asserting GREEN/RED.
    await fs.rm(root, { recursive: true });
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    return {
      ...exit,
      deadlineExpired,
      output,
      stderr,
      cleanup: "child_closed_and_fixture_removed",
    };
  } finally {
    clearTimeout(deadline);
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
