import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXECUTION_FENCE_DIRECTORY,
  PrivateExecutionFence,
} from "../../src/modules/computer/infra/mcp/execution-fence";

let root = "";

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("private execution fence", () => {
  it("admits with no fence, refuses while any operation is raised, and admits again once every one is lowered", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-"));
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
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-"));
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
    await expect(fs.readdir(directory)).resolves.toEqual([
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
    await expect(fs.readdir(directory)).resolves.toHaveLength(2);
    await expect(recordOf("compact-c")).resolves.toBeDefined();
    // Nothing possibly running: every record goes and admission returns.
    await fence.reconcile([]);
    await expect(fs.readdir(directory)).resolves.toEqual([]);
    await expect(fence.admits()).resolves.toEqual({ admitted: true });
    await expect(fence.reconcile([])).resolves.toBeUndefined();
  });

  it("refuses a relative root", () => {
    expect(() => new PrivateExecutionFence({ root: "relative" })).toThrow(
      "EXECUTION_FENCE_ROOT_NOT_ABSOLUTE",
    );
  });
});
