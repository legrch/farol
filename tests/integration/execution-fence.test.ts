import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXECUTION_FENCE_DIRECTORY,
  PrivateExecutionFence,
} from "../../src/modules/computer/infra/mcp/execution-fence";

let root = "";

const recordEntries = async (directory: string) =>
  (await fs.readdir(directory)).filter((entry) => entry.endsWith(".json"));

const makeRoot = async () =>
  fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-")));

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("private execution fence", () => {
  it("holds closed recovery admission without leaving a crash-sticky mutation directory", async () => {
    root = await makeRoot();
    const recovery = new PrivateExecutionFence({ root });
    const connector = new PrivateExecutionFence({ root });
    await expect(
      recovery.withClosedRecoveryDrain(async () => {
        expect((await connector.acquireAdmission()).admitted).toBe(false);
        await expect(
          connector.withClosedRecoveryDrain(async () => undefined),
        ).rejects.toThrow("EXECUTION_FENCE_ACTIVE_COMPUTER_WORK");
        throw new Error("RECOVERY_INTERRUPTED");
      }),
    ).rejects.toThrow("RECOVERY_INTERRUPTED");
    await expect(
      fs.lstat(path.join(root, "execution-fence-mutation.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const after = await connector.acquireAdmission();
    expect(after.admitted).toBe(true);
    if (after.admitted) await after.release();
  });

  it("never clears a pre-existing unknown mutation exclusion for closed recovery", async () => {
    root = await makeRoot();
    const lock = path.join(root, "execution-fence-mutation.lock");
    await fs.mkdir(lock, { mode: 0o700 });
    const inode = (await fs.lstat(lock)).ino;
    const recovery = new PrivateExecutionFence({ root });
    let entered = false;
    await expect(
      recovery.withClosedRecoveryDrain(async () => {
        entered = true;
      }),
    ).rejects.toThrow("EXECUTION_FENCE_UNVERIFIED_MUTATION");
    expect(entered).toBe(false);
    expect((await fs.lstat(lock)).ino).toBe(inode);
  });

  it.each(["read", "shell", "summary"])(
    "refuses closed recovery while %s work is unresolved",
    async (kind) => {
      root = await makeRoot();
      const owner = new PrivateExecutionFence({ root });
      const recovery = new PrivateExecutionFence({ root });
      const admitted = await owner.acquireAdmission();
      if (!admitted.admitted) throw new Error(admitted.code);
      if (kind === "shell") await owner.reserveShell("unknown-shell");
      if (kind !== "read") await admitted.release();
      if (kind === "summary")
        await owner.raise({ operationId: "summary", taskId: "task" });
      let entered = false;
      try {
        await expect(
          recovery.withClosedRecoveryDrain(async () => {
            entered = true;
          }),
        ).rejects.toThrow();
        expect(entered).toBe(false);
      } finally {
        if (kind === "read") await admitted.release();
      }
    },
  );

  it("serializes an admitted effect with summary raise across independent instances", async () => {
    root = await makeRoot();
    const connector = new PrivateExecutionFence({ root });
    const desktop = new PrivateExecutionFence({ root });
    const admitted = await connector.acquireAdmission();
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    await expect(
      desktop.raise({ operationId: "summary", taskId: "task-a" }),
    ).rejects.toThrow("EXECUTION_FENCE_ACTIVE_COMPUTER_WORK");
    await admitted.release();
    await desktop.raise({ operationId: "summary", taskId: "task-a" });
    await expect(connector.acquireAdmission()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    await desktop.lower("summary");
    const after = await connector.acquireAdmission();
    expect(after.admitted).toBe(true);
    if (after.admitted) await after.release();
  });

  it("keeps an unverified shell reservation across connector restart until its owner proves cleanup", async () => {
    root = await makeRoot();
    const connector = new PrivateExecutionFence({ root });
    const desktop = new PrivateExecutionFence({ root });
    const admitted = await connector.acquireAdmission();
    if (!admitted.admitted) throw new Error(admitted.code);
    await connector.reserveShell("shell-a");
    await admitted.release();
    await expect(
      desktop.raise({ operationId: "summary", taskId: "task-a" }),
    ).rejects.toThrow("EXECUTION_FENCE_UNVERIFIED_SHELL");
    const restarted = new PrivateExecutionFence({ root });
    await expect(restarted.acquireAdmission()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_EXECUTION_FENCE_UNREADABLE",
    });
    await desktop.reconcile([]);
    expect(
      await recordEntries(path.join(root, EXECUTION_FENCE_DIRECTORY)),
    ).toHaveLength(1);
    await connector.clearShell("shell-a");
    const after = await restarted.acquireAdmission();
    if (!after.admitted) throw new Error(after.code);
    await after.release();
    await desktop.raise({ operationId: "summary", taskId: "task-a" });
    await desktop.lower("summary");
  });

  it("quarantines an unverified group for this connector and for a restarted connector", async () => {
    root = await makeRoot();
    const connector = new PrivateExecutionFence({ root });
    const admitted = await connector.acquireAdmission();
    if (!admitted.admitted) throw new Error(admitted.code);
    await connector.reserveShell("shell-unknown");
    connector.quarantineShell("shell-unknown");
    await admitted.release();
    for (const fence of [connector, new PrivateExecutionFence({ root })]) {
      await expect(fence.acquireAdmission()).resolves.toEqual({
        admitted: false,
        code: "COMPUTER_EXECUTION_FENCE_UNREADABLE",
      });
      await expect(
        fence.raise({ operationId: "summary", taskId: "task-a" }),
      ).rejects.toThrow("EXECUTION_FENCE_UNVERIFIED_SHELL");
    }
  });

  it("refuses summary raise while a separate process holds admission", async () => {
    root = await makeRoot();
    const desktop = new PrivateExecutionFence({ root });
    const initial = await desktop.acquireAdmission();
    if (!initial.admitted) throw new Error(initial.code);
    await initial.release();
    const lockFile = path.join(
      root,
      EXECUTION_FENCE_DIRECTORY,
      "admission.lock",
    );
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          "const fs = require('node:fs');",
          "const fd = fs.openSync(process.argv[1], fs.constants.O_RDWR | fs.constants.O_NONBLOCK | 0x10);",
          "process.stdout.write('held\\n');",
          "process.stdin.resume();",
          "process.stdin.once('end', () => { fs.closeSync(fd); process.exit(0); });",
        ].join("\n"),
        lockFile,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", (chunk) =>
          String(chunk).includes("held")
            ? resolve()
            : reject(new Error(String(chunk))),
        );
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`lease child exited: ${code}`)),
        );
      });
      await expect(
        desktop.raise({ operationId: "summary", taskId: "task-a" }),
      ).rejects.toThrow("EXECUTION_FENCE_ACTIVE_COMPUTER_WORK");
      child.stdin!.end();
      expect(await exited).toBe(0);
      await desktop.raise({ operationId: "summary", taskId: "task-a" });
      await desktop.lower("summary");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
  });

  it("keeps the shared lock after the parent FD closes while an owned child inherits it", async () => {
    root = await makeRoot();
    const desktop = new PrivateExecutionFence({ root });
    const admitted = await desktop.acquireAdmission();
    if (!admitted.admitted || admitted.fd === undefined) {
      throw new Error("admission FD unavailable");
    }
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      {
        stdio: ["ignore", "ignore", "ignore", admitted.fd],
      },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      await admitted.release();
      await expect(
        desktop.raise({ operationId: "summary", taskId: "task-a" }),
      ).rejects.toThrow("EXECUTION_FENCE_ACTIVE_COMPUTER_WORK");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
    await desktop.raise({ operationId: "summary", taskId: "task-a" });
    await desktop.lower("summary");
  });

  it("releases preflight denials but retains an ambiguous submitted effect lock", async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-")),
    );
    const fence = new PrivateExecutionFence({ root });
    const lock = path.join(root, "execution-fence-mutation.lock");
    let sent = false;
    await expect(
      fence.run(
        async () => {
          throw new Error("PREFLIGHT_DENIED");
        },
        async () => {
          sent = true;
        },
        () => false,
      ),
    ).rejects.toThrow("PREFLIGHT_DENIED");
    expect(sent).toBe(false);
    await expect(fs.access(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fence.run(
        async () => {},
        async () => {
          throw new Error("ACK_LOST");
        },
        () => false,
      ),
    ).rejects.toThrow("ACK_LOST");
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
  });

  it("serializes an admitted mutation with a later summary raise across instances", async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-")),
    );
    const connector = new PrivateExecutionFence({ root });
    const desktop = new PrivateExecutionFence({ root });
    let releaseEffect!: () => void;
    let entered!: () => void;
    const effectEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const effectRelease = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const mutation = connector.run(
      async () => {},
      async () => {
        entered();
        await effectRelease;
        return "sent";
      },
      () => false,
    );
    await effectEntered;
    let raised = false;
    const raise = desktop
      .raise({ operationId: "summary-after-send", taskId: "task-a" })
      .then(() => {
        raised = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(raised).toBe(false);
    releaseEffect();
    await expect(mutation).resolves.toBe("sent");
    await raise;
    expect(raised).toBe(true);
    let attempted = false;
    await expect(
      connector.run(
        async () => {},
        async () => {
          attempted = true;
        },
        () => false,
      ),
    ).rejects.toThrow("COMPUTER_SUMMARY_PHASE_ACTIVE");
    expect(attempted).toBe(false);
  });

  it("admits with no fence, refuses while any operation is raised, and admits again once every one is lowered", async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-")),
    );
    const writer = new PrivateExecutionFence({ root });
    // The connector's process reads the same root with its own instance.
    const reader = new PrivateExecutionFence({ root });

    await expect(reader.admits()).resolves.toEqual({ admitted: true });
    await writer.raise({ operationId: "compact-a", taskId: "task-a" });
    await expect(reader.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    // A second concurrent operation keeps the fence up after the first ends.
    await writer.raise({ operationId: "compact-b", taskId: "task-b" });
    await writer.lower("compact-a");
    await expect(reader.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    await writer.lower("compact-b");
    await expect(reader.admits()).resolves.toEqual({ admitted: true });
    // Lowering what is not raised is not an error.
    await expect(writer.lower("compact-a")).resolves.toBeUndefined();
    // Ending a task releases exactly the records it raised.
    await writer.raise({ operationId: "compact-a", taskId: "task-a" });
    await writer.raise({ operationId: "compact-a2", taskId: "task-a" });
    await writer.raise({ operationId: "compact-b", taskId: "task-b" });
    await writer.release("task-a");
    await expect(reader.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    await writer.release("task-b");
    await expect(reader.admits()).resolves.toEqual({ admitted: true });
    await expect(writer.release("task-none")).resolves.toBeUndefined();
    const record = path.join(root, EXECUTION_FENCE_DIRECTORY);
    expect((await fs.stat(record)).mode & 0o777).toBe(0o700);
  });

  it("fails closed on a record it cannot read, and a start keeps exactly the operations the store still holds", async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-")),
    );
    const fence = new PrivateExecutionFence({ root });
    const directory = path.join(root, EXECUTION_FENCE_DIRECTORY);
    // A start with nothing raised and nothing unresolved touches nothing.
    await fence.reconcile([]);
    await expect(fs.access(directory)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await fence.raise({ operationId: "compact-a", taskId: "task-a" });
    await fence.raise({ operationId: "compact-b", taskId: "task-b" });
    const recordOf = async (operationId: string) => {
      for (const entry of await fs.readdir(directory)) {
        const file = path.join(directory, entry);
        if ((await fs.readFile(file, "utf8")).includes(`"${operationId}"`)) {
          return file;
        }
      }
      throw new Error(`no record for ${operationId}`);
    };
    const recordA = await recordOf("compact-a");
    await fs.writeFile(recordA, "{not json", { mode: 0o600 });
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_EXECUTION_FENCE_UNREADABLE",
    });
    await fs.writeFile(
      path.join(directory, "a".repeat(64) + ".json"),
      JSON.stringify({ schema: 1, kind: "other" }),
      { mode: 0o600 },
    );
    await expect(fence.admits()).resolves.toMatchObject({ admitted: false });

    // A start at which the store still holds compact-a as possibly running:
    // its unreadable record is raised again, while compact-b, which the
    // store settled, and the foreign record are removed.
    await fence.reconcile([{ operationId: "compact-a", taskId: "task-a" }]);
    await expect(recordEntries(directory)).resolves.toEqual([
      path.basename(recordA),
    ]);
    expect(JSON.parse(await fs.readFile(recordA, "utf8"))).toMatchObject({
      operationId: "compact-a",
      taskId: "task-a",
    });
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    // An unresolved operation with no record at all is raised.
    await fence.reconcile([
      { operationId: "compact-a", taskId: "task-a" },
      { operationId: "compact-c", taskId: "task-c" },
    ]);
    await expect(recordEntries(directory)).resolves.toHaveLength(2);
    await expect(recordOf("compact-c")).resolves.toBeDefined();
    // Nothing possibly running: every record goes and admission returns.
    await fence.reconcile([]);
    await expect(recordEntries(directory)).resolves.toEqual([]);
    await expect(fence.admits()).resolves.toEqual({ admitted: true });
    await expect(fence.reconcile([])).resolves.toBeUndefined();
  });

  it("refuses a relative root", () => {
    expect(() => new PrivateExecutionFence({ root: "relative" })).toThrow(
      "EXECUTION_FENCE_ROOT_NOT_ABSOLUTE",
    );
  });
  it("raises the records a reconciliation requires before it removes anything stale", async () => {
    const fence = new PrivateExecutionFence({ root });
    await fence.raise({ operationId: "compact-stale", taskId: "task-gone" });
    // The required record cannot be written: its operation id is not a valid
    // record. The stale record must still be up afterwards.
    await expect(
      fence.reconcile([{ operationId: "x".repeat(161), taskId: "task-live" }]),
    ).rejects.toThrow();
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    // A reconciliation that can write its records then removes the stale one.
    await fence.reconcile([
      { operationId: "compact-live", taskId: "task-live" },
    ]);
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    await fence.reconcile([]);
    await expect(fence.admits()).resolves.toEqual({ admitted: true });
  });
});
