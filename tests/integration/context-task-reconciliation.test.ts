import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { reconcileTaskContexts } from "../../src/apps/desktop/context-task-state";
import {
  beginCompaction,
  createContextSession,
  type ContextBinding,
} from "../../src/modules/chat/domain/context-continuity";
import { PrivateContextStore } from "../../src/modules/chat/infra/repo/private-context-store";

function binding(taskId: string): ContextBinding {
  return {
    ownerId: "owner-desktop",
    taskId,
    hostThreadId: taskId,
    sessionId: taskId,
    providerProfileId: "profile-isolated-next",
    modelId: "farol-next/mind",
    mode: "mind",
  };
}

let root = "";

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("CCR-12 restart reconciles task context before admitting work", () => {
  it("replaces each restored copy with the private store's truth", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-reconcile-"));
    const store = new PrivateContextStore({ root });
    const moving = beginCompaction(
      createContextSession(binding("task-moving")),
      {
        operationId: "compact-1",
        source: "retained_agent",
        sourceBoundary: "sha256:boundary-1",
      },
    );
    if (!moving.ok) throw new Error(moving.error.code);
    await store.save(moving.value);
    await store.save(createContextSession(binding("task-idle")));

    const reconciled = await reconcileTaskContexts(
      ["task-moving", "task-idle", "task-new"],
      store,
      binding,
    );

    expect(reconciled).toEqual([
      {
        taskId: "task-moving",
        context: {
          epoch: 1,
          phase: moving.value.phase,
          source: "retained_agent",
          code: null,
        },
      },
      {
        taskId: "task-idle",
        context: { epoch: 1, phase: "active", source: null, code: null },
      },
      { taskId: "task-new", context: null },
    ]);
  });

  it("shows unreadable private state as blocked, never as the stale copy", async () => {
    const reconciled = await reconcileTaskContexts(
      ["task-corrupt"],
      {
        load: async () => {
          throw new Error("CONTEXT_STATE_UNSUPPORTED");
        },
      },
      binding,
    );

    expect(reconciled).toEqual([
      {
        taskId: "task-corrupt",
        context: {
          epoch: 1,
          phase: "blocked",
          source: null,
          code: "CONTEXT_STATE_UNSUPPORTED",
        },
      },
    ]);
  });
});
