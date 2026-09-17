import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  beginCompaction,
  createContextSession,
  requestCheckpoint,
  type ContextBinding,
  type ContextSession,
} from "../../src/modules/chat/domain/context-continuity";
import {
  createCheckpointEnvelope,
  type CheckpointContent,
  type CheckpointEnvelope,
} from "../../src/modules/chat/domain/checkpoint";
import { PrivateContextStore } from "../../src/modules/chat/infra/repo/private-context-store";

const binding: ContextBinding = {
  ownerId: "owner-preview",
  taskId: "task-atlantic",
  hostThreadId: "thread-atlantic",
  sessionId: "session-atlantic",
  providerProfileId: "profile-isolated-next",
  modelId: "chatgpt-web/high",
  mode: "high",
};

const content: CheckpointContent = {
  goal: "Continue the exact Farol Next task.",
  activeConstraints: ["Do not repeat an outcome-unknown write."],
  latestCorrections: ["Use Watch Rail."],
  keyDecisions: ["Persist before retiring the old epoch."],
  completedWork: [
    {
      description: "Continuity core committed.",
      evidenceRefs: ["git:abe551a"],
    },
  ],
  unfinishedWork: ["Wire the host bridge."],
  unresolvedQuestions: ["Whether the retained source is still available."],
  unknownOutcomes: [
    { operationRef: "write-17", description: "Acknowledgement was lost." },
  ],
  artifactRefs: [
    { reference: "vnext/src/modules/chat", availability: "available" },
  ],
  attachmentRefs: [{ reference: "owner-image-1", availability: "unavailable" }],
  nextSafeStep: "Observe write-17 before another mutation.",
};

const request = {
  operationId: "compact-atlantic-1",
  source: "retained_agent" as const,
  sourceBoundary: "message-42",
};

function value<T>(result: {
  ok: boolean;
  value?: T;
  error?: { code: string };
}): T {
  if (!result.ok || result.value === undefined) {
    throw new Error(result.error?.code ?? "EXPECTED_SUCCESS");
  }
  return result.value;
}

function requestedSession(
  selectedBinding = binding,
  operationId = "compact-atlantic-1",
): ContextSession {
  return value(
    requestCheckpoint(
      value(
        beginCompaction(createContextSession(selectedBinding), {
          operationId,
          source: "retained_agent",
          sourceBoundary: `message-${operationId}`,
        }),
      ),
    ),
  );
}

function checkpoint(
  checkpointId: string,
  createdAt: number,
  selectedBinding = binding,
): CheckpointEnvelope {
  const requested = requestedSession(
    selectedBinding,
    `operation-${checkpointId}`,
  );
  return createCheckpointEnvelope(requested, content, {
    checkpointId,
    providerOperationId: `provider-${checkpointId}`,
    parentCheckpointId: null,
    sourceCursor: `cursor-${checkpointId}`,
    createdAt,
  });
}

async function descendants(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (!entry.isDirectory()) return [target];
      return [target, ...(await descendants(target))];
    }),
  );
  return nested.flat();
}

describe("private context persistence", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function root(): Promise<string> {
    const created = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-context-"),
    );
    roots.push(created);
    return created;
  }

  it("survives a new store instance with exact binding and private modes", async () => {
    const stateRoot = await root();
    const first = new PrivateContextStore({ root: stateRoot });
    const session = requestedSession();
    const savedCheckpoint = checkpoint("checkpoint-1", 1_000);
    await first.save(session);
    await first.put(savedCheckpoint);
    const admission = await first.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    if (admission.status !== "acquired") {
      throw new Error(`EXPECTED_ADMISSION_${admission.status}`);
    }
    await first.releaseCompactionAdmission(admission.lease);

    const restarted = new PrivateContextStore({ root: stateRoot });
    await expect(restarted.load(binding)).resolves.toEqual(session);
    await expect(
      restarted.get(binding, savedCheckpoint.checkpointId),
    ).resolves.toEqual(savedCheckpoint);
    await expect(
      restarted.load({ ...binding, taskId: "task-harbor" }),
    ).resolves.toBeNull();
    await expect(
      restarted.get(
        { ...binding, taskId: "task-harbor" },
        savedCheckpoint.checkpointId,
      ),
    ).resolves.toBeNull();

    const paths = [stateRoot, ...(await descendants(stateRoot))];
    for (const target of paths) {
      const stat = await fs.lstat(target);
      expect(stat.mode & 0o077).toBe(0);
      expect(stat.mode & 0o700).toBe(stat.isDirectory() ? 0o700 : 0o600);
    }
  });

  it("retains exact canonical source across restart and rejects replacement", async () => {
    const stateRoot = await root();
    const first = new PrivateContextStore({ root: stateRoot });
    const source = {
      schemaVersion: 1 as const,
      operationId: "compact-atlantic-1",
      binding,
      source: "canonical_history" as const,
      sourceBoundary: "sha256:canonical-atlantic-1",
      variant: "streamed_compaction_item" as const,
      history: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Keep the correction." }],
        },
      ],
    };
    await first.putSource(source);

    const restarted = new PrivateContextStore({ root: stateRoot });
    await expect(
      restarted.getSource(binding, source.operationId),
    ).resolves.toEqual(source);
    await expect(
      restarted.getSource(
        { ...binding, taskId: "task-harbor" },
        source.operationId,
      ),
    ).resolves.toBeNull();
    await expect(
      restarted.putSource({
        ...source,
        history: [{ type: "message", role: "user", content: "changed" }],
      }),
    ).rejects.toThrow("CONTEXT_SOURCE_ID_CONFLICT");

    await restarted.deleteSource(binding, source.operationId);
    await expect(
      restarted.getSource(binding, source.operationId),
    ).resolves.toBeNull();
    await restarted.putSource(source);

    await restarted.deleteTask(binding);
    await expect(
      restarted.getSource(binding, source.operationId),
    ).resolves.toBeNull();
  });

  it("rejects over-budget canonical source before persistence", async () => {
    const stateRoot = await root();
    const store = new PrivateContextStore({
      root: stateRoot,
      maximumSourceRecordBytes: 512,
    });
    await expect(
      store.putSource({
        schemaVersion: 1,
        operationId: "compact-atlantic-large",
        binding,
        source: "canonical_history",
        sourceBoundary: "sha256:canonical-atlantic-large",
        variant: "unary_replacement_history",
        history: [{ type: "message", content: "x".repeat(1_024) }],
      }),
    ).rejects.toThrow("CONTEXT_SOURCE_OVERSIZED");
  });

  it("fences concurrent coordinators through the shared filesystem", async () => {
    const stateRoot = await root();
    const first = new PrivateContextStore({ root: stateRoot });
    const second = new PrivateContextStore({ root: stateRoot });

    const results = await Promise.all([
      first.acquireCompactionAdmission(binding, 1, request),
      second.acquireCompactionAdmission(binding, 1, {
        ...request,
        operationId: "automatic-atlantic-1",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "acquired"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "busy")).toHaveLength(
      1,
    );
    const acquired = results.find((result) => result.status === "acquired");
    if (!acquired || acquired.status !== "acquired") {
      throw new Error("EXPECTED_ONE_ADMISSION");
    }
    await first.releaseCompactionAdmission(acquired.lease);

    const persisted = await second.acquireCompactionAdmission(
      binding,
      1,
      acquired.admission.request,
    );
    expect(persisted).toMatchObject({
      status: "acquired",
      admission: acquired.admission,
    });
    if (persisted.status !== "acquired") {
      throw new Error(`EXPECTED_PERSISTED_ADMISSION_${persisted.status}`);
    }
    await second.releaseCompactionAdmission(persisted.lease);
  });

  it("rejects binding, epoch, and request changes against durable admission", async () => {
    const stateRoot = await root();
    const store = new PrivateContextStore({ root: stateRoot });
    const admitted = await store.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    if (admitted.status !== "acquired") {
      throw new Error(`EXPECTED_ADMISSION_${admitted.status}`);
    }
    await store.releaseCompactionAdmission(admitted.lease);

    const changedRequest = await store.acquireCompactionAdmission(binding, 1, {
      ...request,
      operationId: "automatic-atlantic-1",
    });
    expect(changedRequest).toEqual({
      status: "conflict",
      reason: "request",
    });

    const changedEpoch = await store.acquireCompactionAdmission(
      binding,
      2,
      request,
    );
    expect(changedEpoch).toEqual({ status: "conflict", reason: "epoch" });

    const changedBinding = await store.acquireCompactionAdmission(
      { ...binding, providerProfileId: "profile-foreign" },
      1,
      request,
    );
    expect(changedBinding).toEqual({
      status: "conflict",
      reason: "binding",
    });
  });

  it("reclaims a lease only after the recorded process is proven dead", async () => {
    const stateRoot = await root();
    const abandoned = new PrivateContextStore({ root: stateRoot });
    const first = await abandoned.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    if (first.status !== "acquired") {
      throw new Error(`EXPECTED_ADMISSION_${first.status}`);
    }

    const recovering = new PrivateContextStore(
      { root: stateRoot },
      { isProcessAlive: () => false },
    );
    const recovered = await recovering.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    expect(recovered).toMatchObject({ status: "acquired" });
    if (recovered.status !== "acquired") {
      throw new Error(`EXPECTED_RECOVERY_${recovered.status}`);
    }
    expect(recovered.lease.token).not.toBe(first.lease.token);
    await recovering.releaseCompactionAdmission(recovered.lease);
  });

  it("keeps the core session binding immutable", async () => {
    const stateRoot = await root();
    const store = new PrivateContextStore({ root: stateRoot });
    const session = createContextSession(binding);
    await store.save(session);

    const foreignBinding = {
      ...binding,
      providerProfileId: "profile-foreign",
    };
    await expect(store.load(foreignBinding)).resolves.toEqual(session);
    await expect(
      store.save(createContextSession(foreignBinding)),
    ).rejects.toThrow("CONTEXT_STATE_BINDING_MISMATCH");
  });

  it("keeps the previous durable session when replacement is interrupted", async () => {
    const stateRoot = await root();
    const stable = new PrivateContextStore({ root: stateRoot });
    const active = createContextSession(binding);
    await stable.save(active);
    const interrupted = new PrivateContextStore(
      { root: stateRoot },
      {
        beforeCommit: async (target) => {
          if (target.endsWith("session.json")) {
            throw new Error("SYNTHETIC_RENAME_INTERRUPTION");
          }
        },
      },
    );

    await expect(interrupted.save(requestedSession())).rejects.toThrow(
      "SYNTHETIC_RENAME_INTERRUPTION",
    );
    await expect(stable.load(binding)).resolves.toEqual(active);
    expect(
      (await descendants(stateRoot)).some((target) =>
        path.basename(target).includes(".tmp-"),
      ),
    ).toBe(false);
  });

  it("rejects corrupt and unsupported state without using it", async () => {
    const stateRoot = await root();
    const store = new PrivateContextStore({ root: stateRoot });
    await store.save(createContextSession(binding));
    const sessionFile = (await descendants(stateRoot)).find((target) =>
      target.endsWith("session.json"),
    );
    if (!sessionFile) throw new Error("SESSION_FILE_MISSING");

    await fs.writeFile(sessionFile, "{not-json", { mode: 0o600 });
    await expect(store.load(binding)).rejects.toThrow("CONTEXT_STATE_CORRUPT");

    await fs.writeFile(
      sessionFile,
      JSON.stringify({ schemaVersion: 99, kind: "context_session" }),
      { mode: 0o600 },
    );
    await expect(store.load(binding)).rejects.toThrow(
      "CONTEXT_STATE_UNSUPPORTED",
    );
  });

  it("bounds checkpoint retention and deletes only the exact task", async () => {
    const stateRoot = await root();
    const store = new PrivateContextStore({
      root: stateRoot,
      maxCheckpointsPerTask: 2,
    });
    await store.save(createContextSession(binding));
    await store.put(checkpoint("checkpoint-1", 1_000));
    await store.put(checkpoint("checkpoint-2", 2_000));
    await store.put(checkpoint("checkpoint-3", 3_000));
    await expect(store.get(binding, "checkpoint-1")).resolves.toBeNull();
    await expect(store.get(binding, "checkpoint-2")).resolves.toMatchObject({
      checkpointId: "checkpoint-2",
    });

    const otherBinding = {
      ...binding,
      taskId: "task-harbor",
      sessionId: "session-harbor",
    };
    await store.save(createContextSession(otherBinding));
    await store.put(checkpoint("checkpoint-harbor", 4_000, otherBinding));
    await store.deleteTask(binding);
    await expect(store.load(binding)).resolves.toBeNull();
    await expect(store.get(binding, "checkpoint-3")).resolves.toBeNull();
    await expect(store.load(otherBinding)).resolves.toMatchObject({
      binding: otherBinding,
    });
    await expect(
      store.get(otherBinding, "checkpoint-harbor"),
    ).resolves.toMatchObject({ checkpointId: "checkpoint-harbor" });
  });

  it("rejects conflicting or over-budget checkpoint replacement", async () => {
    const stateRoot = await root();
    const store = new PrivateContextStore({
      root: stateRoot,
      maximumCheckpointContentBytes: 2_048,
    });
    const original = checkpoint("checkpoint-1", 1_000);
    await store.put(original);
    await expect(
      store.put({
        ...original,
        content: { ...original.content, goal: "Different goal" },
      }),
    ).rejects.toThrow("CHECKPOINT_ID_CONFLICT");
    await expect(
      store.put({
        ...checkpoint("checkpoint-large", 2_000),
        content: { ...content, goal: "x".repeat(4_096) },
      }),
    ).rejects.toThrow("CHECKPOINT_CONTENT_OVERSIZED");
  });
});
