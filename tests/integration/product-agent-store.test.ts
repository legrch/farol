import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PrivateProductAgentStore,
  type ProductAgentInput,
} from "../../src/apps/desktop/product-agent-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-agent-input-"));
  roots.push(root);
  return root;
}

function input(overrides: Partial<ProductAgentInput> = {}): ProductAgentInput {
  return {
    taskId: "task-a",
    sessionId: "session-a",
    assignmentId: "assignment-a",
    authorityId: "authority-a",
    parentParticipantId: "main-a",
    agentParticipantId: "agent-a",
    taskEpoch: 7,
    generation: 1,
    workspaceId: "workspace-a",
    focusPath: "/workspace/approved",
    objective: "Find the continuity marker without reading excluded files.",
    computerGeneration: 7,
    executableSha256: "a".repeat(64),
    schemaSha256: "b".repeat(64),
    buildId: "build-a",
    expiresAt: 50_000,
    createdAt: "1970-01-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("private product Agent input store", () => {
  it("persists one exact private objective with owner-only modes", async () => {
    const root = await temporaryRoot();
    const store = new PrivateProductAgentStore({ root });

    await store.save(input());

    await expect(
      new PrivateProductAgentStore({ root }).load("task-a"),
    ).resolves.toEqual(input());
    const files = await fs.readdir(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(root, files[0]!))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("keeps the previous admitted objective when replacement is interrupted", async () => {
    const root = await temporaryRoot();
    const stable = new PrivateProductAgentStore({ root });
    await stable.save(input());
    const interrupted = new PrivateProductAgentStore(
      { root },
      { beforeCommit: vi.fn().mockRejectedValue(new Error("disk full")) },
    );

    await expect(
      interrupted.save(input({ assignmentId: "assignment-b" })),
    ).rejects.toThrow("disk full");
    await expect(stable.load("task-a")).resolves.toEqual(input());
  });

  it("removes only the exact task journal", async () => {
    const root = await temporaryRoot();
    const store = new PrivateProductAgentStore({ root });
    await store.save(input());
    await store.save(
      input({
        taskId: "task-b",
        sessionId: "session-b",
        assignmentId: "assignment-b",
      }),
    );

    await store.remove("task-a");

    await expect(store.load("task-a")).resolves.toBeNull();
    await expect(store.load("task-b")).resolves.toMatchObject({
      assignmentId: "assignment-b",
    });
  });
});
