import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateLiveTaskStore } from "../../src/apps/desktop/live-task-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-tasks-"));
  roots.push(root);
  return root;
}

function storedTask(index: number) {
  return {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    label: `ChatGPT task ${index}`,
    provider: "chatgpt" as const,
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: index === 1,
    lifecycle: "idle" as const,
    conversationUrl: `https://chatgpt.com/c/task-${index}`,
  };
}

describe("private live task store", () => {
  it("persists only bounded task metadata across restart", async () => {
    const root = await temporaryRoot();
    const store = new PrivateLiveTaskStore({ root }, { now: () => 1_000 });
    const tasks = [storedTask(1), storedTask(2)];

    await store.save({ revision: 7, tasks });

    const restarted = new PrivateLiveTaskStore({ root });
    await expect(restarted.load()).resolves.toEqual({
      schema: 1,
      revision: 7,
      tasks,
      updatedAt: "1970-01-01T00:00:01.000Z",
    });
    const statePath = path.join(root, "live-tasks.json");
    const serialized = await fs.readFile(statePath, "utf8");
    expect(serialized).not.toMatch(
      /prompt canary|answer canary|file content canary|Bearer|cookie|token/iu,
    );
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it("preserves the prior state when an atomic replacement is interrupted", async () => {
    const root = await temporaryRoot();
    const stable = new PrivateLiveTaskStore({ root });
    await stable.save({ revision: 1, tasks: [storedTask(1)] });
    const interrupted = new PrivateLiveTaskStore(
      { root },
      { beforeCommit: vi.fn().mockRejectedValue(new Error("disk full")) },
    );

    await expect(
      interrupted.save({ revision: 2, tasks: [storedTask(2)] }),
    ).rejects.toThrow("disk full");
    await expect(stable.load()).resolves.toMatchObject({ revision: 1 });
  });

  it("rejects symbolic-link state without touching its target", async () => {
    const root = await temporaryRoot();
    const stateRoot = path.join(root, "state");
    const outside = path.join(root, "outside.json");
    await fs.mkdir(stateRoot, { mode: 0o700 });
    await fs.writeFile(outside, "preserve\n", { mode: 0o600 });
    await fs.symlink(outside, path.join(stateRoot, "live-tasks.json"));
    const store = new PrivateLiveTaskStore({ root: stateRoot });

    await expect(store.load()).rejects.toThrow("LIVE_TASK_STATE_UNSAFE");
    await expect(
      store.save({ revision: 1, tasks: [storedTask(1)] }),
    ).rejects.toThrow("LIVE_TASK_STATE_UNSAFE");
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("preserve\n");
  });
});
