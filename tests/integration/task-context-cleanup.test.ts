import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { deleteTaskContext } from "../../src/apps/desktop/task-context-cleanup";
import {
  beginCompaction,
  createContextSession,
  requestCheckpoint,
  type ContextBinding,
} from "../../src/modules/chat/domain/context-continuity";
import { PrivateContextStore } from "../../src/modules/chat/infra/repo/private-context-store";

const binding: ContextBinding = {
  ownerId: "owner-desktop",
  taskId: "task-close",
  hostThreadId: "task-close",
  sessionId: "task-close",
  providerProfileId: "profile-isolated-next",
  modelId: "farol-next/mind",
  mode: "mind",
};

let root = "";

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("CCR-11 closing a task deletes its private context state", () => {
  it("removes the task's sessions and checkpoints and leaves other tasks", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-task-close-"));
    const store = new PrivateContextStore({ root });
    const other = { ...binding, taskId: "task-other", sessionId: "task-other" };
    await store.save(createContextSession(binding));
    await store.save(createContextSession(other));

    await expect(deleteTaskContext(store, binding)).resolves.toBe("deleted");
    await expect(store.load(binding)).resolves.toBeNull();
    await expect(store.load(other)).resolves.toMatchObject({ epoch: 1 });
  });

  it("deletes a transition an earlier run left behind, and reports a failed deletion", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-task-close-"));
    const store = new PrivateContextStore({ root });
    // Nothing resumes a summary that was cut off by a quit or a crash, so its
    // phase must not keep the task from closing forever.
    const begun = beginCompaction(createContextSession(binding), {
      operationId: "compact-cut-off",
      source: "retained_agent",
      sourceBoundary: "turn-cut-off",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const requested = requestCheckpoint(begun.value);
    if (!requested.ok) throw new Error(requested.error.code);
    await store.save(requested.value);
    await expect(store.load(binding)).resolves.toMatchObject({
      phase: "checkpoint_requested",
    });

    await expect(deleteTaskContext(store, binding)).resolves.toBe("deleted");
    await expect(store.load(binding)).resolves.toBeNull();

    await expect(
      deleteTaskContext(
        {
          deleteTask: async () => {
            throw new Error("CONTEXT_TASK_DIRECTORY_UNSAFE");
          },
        },
        binding,
      ),
    ).resolves.toBe("failed");
  });
});
