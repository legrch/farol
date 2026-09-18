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
    const record = path.join(root, EXECUTION_FENCE_DIRECTORY);
    expect((await fs.stat(record)).mode & 0o777).toBe(0o700);
  });

  it("fails closed on a record it cannot read, and clears everything a crash left behind", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-"));
    const fence = new PrivateExecutionFence({ root });
    await fence.raise({ operationId: "compact-a", taskId: "task-a" });
    const directory = path.join(root, EXECUTION_FENCE_DIRECTORY);
    const [record] = await fs.readdir(directory);
    await fs.writeFile(path.join(directory, record!), "{not json", {
      mode: 0o600,
    });
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

    await fence.clear();
    await expect(fence.admits()).resolves.toEqual({ admitted: true });
    await expect(fence.clear()).resolves.toBeUndefined();
  });

  it("refuses a relative root", () => {
    expect(() => new PrivateExecutionFence({ root: "relative" })).toThrow(
      "EXECUTION_FENCE_ROOT_NOT_ABSOLUTE",
    );
  });
});
