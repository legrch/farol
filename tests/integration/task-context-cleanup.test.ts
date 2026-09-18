import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  deleteTaskContext,
  sweepOrphanTaskContexts,
} from "../../src/apps/desktop/task-context-cleanup";
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

    // The connector's fence records the closed task raised go with it.
    const released: string[] = [];
    const fence = {
      release: async (taskId: string) => void released.push(taskId),
    };
    await expect(deleteTaskContext(store, binding, fence)).resolves.toBe(
      "deleted",
    );
    await expect(store.load(binding)).resolves.toBeNull();
    await expect(store.load(other)).resolves.toMatchObject({ epoch: 1 });
    expect(released).toEqual([binding.taskId]);
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

    // A deletion that fails leaves the task's context, and its fence, alone.
    const released: string[] = [];
    await expect(
      deleteTaskContext(
        {
          deleteTask: async () => {
            throw new Error("CONTEXT_TASK_DIRECTORY_UNSAFE");
          },
        },
        binding,
        { release: async (taskId) => void released.push(taskId) },
      ),
    ).resolves.toBe("failed");
    expect(released).toEqual([]);
    // A release that fails does not undo a deletion that succeeded.
    await store.save(createContextSession(binding));
    await expect(
      deleteTaskContext(store, binding, {
        release: async () => {
          throw new Error("EACCES");
        },
      }),
    ).resolves.toBe("deleted");
  });
});

describe("CC-21 orphan context sweep after restart", () => {
  const bindingFor = (taskId: string): ContextBinding => ({
    ...binding,
    taskId,
    hostThreadId: taskId,
    sessionId: taskId,
  });

  it("deletes only the context of a closed task whose deletion was cut off, keeps live and unreadable directories, and is idempotent", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-orphan-"));
    const store = new PrivateContextStore({ root });
    await store.save(createContextSession(bindingFor("task-live")));
    // The crash cut: the task's removal was saved, its context was not.
    await store.save(createContextSession(bindingFor("task-closed")));
    // A session record nobody can read names no owner.
    await store.save(createContextSession(bindingFor("task-unreadable")));
    const directories = await fs.readdir(path.join(root, "tasks"));
    let corrupted = "";
    for (const name of directories) {
      const file = path.join(root, "tasks", name, "session.json");
      if ((await fs.readFile(file, "utf8")).includes("task-unreadable")) {
        await fs.writeFile(file, "{not json", { mode: 0o600 });
        corrupted = name;
      }
    }
    expect(corrupted).not.toBe("");

    const released: string[] = [];
    const first = await sweepOrphanTaskContexts(
      store,
      { status: "loaded", taskIds: ["task-live"] },
      bindingFor,
      { release: async (taskId) => void released.push(taskId) },
    );
    expect(first).toEqual({
      swept: ["task-closed"],
      unreadable: 1,
      failed: [],
    });
    // Only the swept task's fence records are released with its context.
    expect(released).toEqual(["task-closed"]);
    await expect(store.load(bindingFor("task-live"))).resolves.toMatchObject({
      epoch: 1,
    });
    await expect(store.load(bindingFor("task-closed"))).resolves.toBeNull();
    await expect(
      fs.stat(path.join(root, "tasks", corrupted, "session.json")),
    ).resolves.toBeTruthy();

    // Again: nothing more to do, nothing revived.
    await expect(
      sweepOrphanTaskContexts(
        store,
        { status: "loaded", taskIds: ["task-live"] },
        bindingFor,
      ),
    ).resolves.toEqual({ swept: [], unreadable: 1, failed: [] });
  });

  it("sweeps nothing when the task registry could not be read, and reports a deletion that fails", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-orphan-"));
    const store = new PrivateContextStore({ root });
    await store.save(createContextSession(bindingFor("task-closed")));
    await expect(
      sweepOrphanTaskContexts(store, { status: "unavailable" }, bindingFor),
    ).resolves.toEqual({ swept: [], unreadable: 0, failed: [] });
    await expect(store.load(bindingFor("task-closed"))).resolves.toMatchObject({
      epoch: 1,
    });

    // A binding that is not this product's exact binding is not ours to
    // delete either.
    await expect(
      sweepOrphanTaskContexts(
        store,
        { status: "loaded", taskIds: [] },
        (id) => ({
          ...bindingFor(id),
          modelId: "farol-next/other",
        }),
      ),
    ).resolves.toEqual({ swept: [], unreadable: 0, failed: [] });

    await expect(
      sweepOrphanTaskContexts(
        {
          listTaskBindings: () => store.listTaskBindings(),
          deleteTask: async () => {
            throw new Error("CONTEXT_TASK_DIRECTORY_UNSAFE");
          },
        },
        { status: "loaded", taskIds: [] },
        bindingFor,
      ),
    ).resolves.toEqual({ swept: [], unreadable: 0, failed: ["task-closed"] });
  });
});
