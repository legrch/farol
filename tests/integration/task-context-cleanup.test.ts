import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { deleteTaskContext } from "../../src/apps/desktop/task-context-cleanup";
import {
  createContextSession,
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

    await expect(
      deleteTaskContext(store, binding, {
        epoch: 1,
        phase: "active",
        source: null,
        code: null,
      }),
    ).resolves.toBe("deleted");
    await expect(store.load(binding)).resolves.toBeNull();
    await expect(store.load(other)).resolves.toMatchObject({ epoch: 1 });
  });

  it("refuses while a context transition is moving, and when deletion fails", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-task-close-"));
    const store = new PrivateContextStore({ root });
    await store.save(createContextSession(binding));

    await expect(
      deleteTaskContext(store, binding, {
        epoch: 1,
        phase: "checkpoint_requested",
        source: "retained_agent",
        code: null,
      }),
    ).resolves.toBe("in_transition");
    await expect(store.load(binding)).resolves.toMatchObject({ epoch: 1 });

    await expect(
      deleteTaskContext(
        {
          deleteTask: async () => {
            throw new Error("CONTEXT_TASK_DIRECTORY_UNSAFE");
          },
        },
        binding,
        null,
      ),
    ).resolves.toBe("failed");
  });
});
