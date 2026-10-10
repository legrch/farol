import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import {
  activateNextEpoch,
  beginCompaction,
  confirmHostContext,
  createContextSession,
  markCheckpointStored,
  markOldEpochRetired,
  offerCheckpointHandoff,
  recordValidatedCheckpoint,
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
import {
  CodexContextContinuity,
  type CodexContextSummaryDriver,
} from "../../src/apps/desktop/codex-context-continuity";

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

async function firstJsonLine(
  stream: NodeJS.ReadableStream,
): Promise<{ target: string }> {
  stream.setEncoding("utf8");
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline < 0) continue;
    return JSON.parse(buffered.slice(0, newline)) as { target: string };
  }
  throw new Error("CONTEXT_CRASH_FIXTURE_SIGNAL_MISSING");
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

  it("retains one exact completed summary receipt for observation after restart", async () => {
    const stateRoot = await root();
    const first = new PrivateContextStore({ root: stateRoot });
    const summary = {
      schemaVersion: 1 as const,
      operationId: "compact-atlantic-1",
      binding,
      providerOperationId: "provider-summary-1",
      sourceCursor: "conversation:sha256-summary-1",
      content,
    };
    await first.putSummary(summary);

    const restarted = new PrivateContextStore({ root: stateRoot });
    await expect(
      restarted.getSummary(binding, summary.operationId),
    ).resolves.toEqual(summary);
    await expect(
      restarted.putSummary({
        ...summary,
        providerOperationId: "provider-summary-forged",
      }),
    ).rejects.toThrow("CONTEXT_SUMMARY_ID_CONFLICT");
    await restarted.deleteSummary(binding, summary.operationId);
    await expect(
      restarted.getSummary(binding, summary.operationId),
    ).resolves.toBeNull();
  });

  it("persists monotonic summary-send certainty and exact message identity", async () => {
    const stateRoot = await root();
    const first = new PrivateContextStore({ root: stateRoot });
    const prepared = {
      schemaVersion: 1 as const,
      operationId: request.operationId,
      binding,
      source: request.source,
      sourceBoundary: request.sourceBoundary,
      phase: "prepared" as const,
      conversationUrl: null,
      turnUserId: null,
      turnAssistantId: null,
    };
    await first.putSummaryAttempt(prepared);
    const possibleSend = {
      ...prepared,
      phase: "possible_send" as const,
      conversationUrl: "https://chatgpt.com/c/context-atlantic",
      turnUserId: "summary-user-atlantic",
    };
    await first.putSummaryAttempt(possibleSend);
    await expect(
      first.putSummaryAttempt(possibleSend),
    ).resolves.toBeUndefined();
    await expect(
      first.putSummaryAttempt({
        ...possibleSend,
        turnUserId: null,
        turnAssistantId: "summary-assistant-atlantic",
      }),
    ).rejects.toThrow("CONTEXT_SUMMARY_ATTEMPT_INVALID");

    const restarted = new PrivateContextStore({ root: stateRoot });
    await expect(
      restarted.getSummaryAttempt(binding, request.operationId),
    ).resolves.toEqual({
      ...prepared,
      phase: "possible_send",
      conversationUrl: "https://chatgpt.com/c/context-atlantic",
      turnUserId: "summary-user-atlantic",
    });
    await expect(restarted.putSummaryAttempt(prepared)).rejects.toThrow(
      "CONTEXT_SUMMARY_ATTEMPT_CONFLICT",
    );
    await expect(
      restarted.putSummaryAttempt({
        ...prepared,
        phase: "outcome_unknown",
        conversationUrl: "https://chatgpt.com/c/context-forged",
        turnUserId: "summary-user-atlantic",
      }),
    ).rejects.toThrow("CONTEXT_SUMMARY_ATTEMPT_CONFLICT");
    await restarted.deleteSummaryAttempt(binding, request.operationId);
    await expect(
      restarted.deleteSummaryAttempt(binding, request.operationId),
    ).resolves.toBeUndefined();
    await expect(
      restarted.getSummaryAttempt(binding, request.operationId),
    ).resolves.toBeNull();
    await expect(restarted.getSummaryAttempt(binding, "")).rejects.toThrow(
      "CONTEXT_SUMMARY_ATTEMPT_ID_INVALID",
    );
    await expect(restarted.deleteSummaryAttempt(binding, "")).rejects.toThrow(
      "CONTEXT_SUMMARY_ATTEMPT_ID_INVALID",
    );
  });

  it("lists every summary attempt a task holds, and refuses to list past one it cannot read", async () => {
    const stateRoot = await root();
    const store = new PrivateContextStore({ root: stateRoot });
    await expect(store.listSummaryAttempts(binding)).resolves.toEqual([]);
    const prepared = {
      schemaVersion: 1 as const,
      operationId: "compact-list-prepared",
      binding,
      source: request.source,
      sourceBoundary: request.sourceBoundary,
      phase: "prepared" as const,
      conversationUrl: null,
      turnUserId: null,
      turnAssistantId: null,
    };
    const possibleSend = {
      ...prepared,
      operationId: "compact-list-sent",
      phase: "possible_send" as const,
      conversationUrl: "https://chatgpt.com/c/context-list",
      turnUserId: "summary-user-list",
    };
    await store.putSummaryAttempt(prepared);
    await store.putSummaryAttempt(possibleSend);
    const restarted = new PrivateContextStore({ root: stateRoot });
    const listed = await restarted.listSummaryAttempts(binding);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([prepared, possibleSend]));
    // Another task's attempts are not this task's.
    await expect(
      restarted.listSummaryAttempts({
        ...binding,
        taskId: "task-harbor",
        hostThreadId: "task-harbor",
        sessionId: "task-harbor",
      }),
    ).resolves.toEqual([]);
    // One attempt that cannot be read makes the whole list unknown.
    const [taskKey] = await fs.readdir(path.join(stateRoot, "tasks"));
    const directory = path.join(
      stateRoot,
      "tasks",
      taskKey!,
      "summary-attempts",
    );
    const [file] = (await fs.readdir(directory)).sort();
    await fs.writeFile(path.join(directory, file!), "{not json", {
      mode: 0o600,
    });
    await expect(restarted.listSummaryAttempts(binding)).rejects.toThrow(
      /CONTEXT_SUMMARY_ATTEMPT/u,
    );
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

  it("rejects a previously valid owner after the admission lease changes", async () => {
    const stateRoot = await root();
    const stale = new PrivateContextStore({ root: stateRoot });
    const current = new PrivateContextStore({ root: stateRoot });
    const first = await stale.acquireCompactionAdmission(binding, 1, request);
    if (first.status !== "acquired") {
      throw new Error(`EXPECTED_FIRST_ADMISSION_${first.status}`);
    }
    await stale.save(createContextSession(binding), first.lease);
    await stale.releaseCompactionAdmission(first.lease);

    const second = await current.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    if (second.status !== "acquired") {
      throw new Error(`EXPECTED_SECOND_ADMISSION_${second.status}`);
    }
    const requested = requestedSession();
    await expect(current.save(requested)).rejects.toThrow(
      "CONTEXT_ADMISSION_LEASE_REQUIRED",
    );
    await expect(
      current.save(
        { ...requested, binding: { ...binding, sessionId: "session-foreign" } },
        second.lease,
      ),
    ).rejects.toThrow("CONTEXT_ADMISSION_LEASE_MISMATCH");
    await current.save(requested, second.lease);

    await expect(
      stale.save(createContextSession(binding), first.lease),
    ).rejects.toThrow("CONTEXT_ADMISSION_LEASE_MISMATCH");
    await expect(current.load(binding)).resolves.toEqual(requested);
    await current.releaseCompactionAdmission(second.lease);
    await expect(current.save(requested, second.lease)).rejects.toThrow(
      "CONTEXT_ADMISSION_LEASE_MISSING",
    );
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
    const abandoned = new PrivateContextStore(
      { root: stateRoot },
      {
        processId: 4_101,
        processInstanceId: "a".repeat(32),
      },
    );
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
      {
        processId: 4_102,
        processInstanceId: "b".repeat(32),
        isProcessAlive: () => false,
      },
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

  it("distinguishes a reused PID from the original process instance", async () => {
    const stateRoot = await root();
    const abandoned = new PrivateContextStore(
      { root: stateRoot },
      {
        processId: 4_242,
        processInstanceId: "a".repeat(32),
      },
    );
    const original = await abandoned.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    if (original.status !== "acquired") {
      throw new Error(`EXPECTED_ORIGINAL_ADMISSION_${original.status}`);
    }

    const restarted = new PrivateContextStore(
      { root: stateRoot },
      {
        processId: 4_242,
        processInstanceId: "b".repeat(32),
        isProcessAlive: () => true,
      },
    );
    const recovered = await restarted.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    expect(recovered.status).toBe("acquired");
    if (recovered.status === "acquired") {
      await restarted.releaseCompactionAdmission(recovered.lease);
    }
  });

  it("fails closed when a foreign recorded PID is still alive", async () => {
    const stateRoot = await root();
    const owner = new PrivateContextStore(
      { root: stateRoot },
      {
        processId: 4_242,
        processInstanceId: "a".repeat(32),
      },
    );
    const original = await owner.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    if (original.status !== "acquired") {
      throw new Error(`EXPECTED_ORIGINAL_ADMISSION_${original.status}`);
    }

    const observer = new PrivateContextStore(
      { root: stateRoot },
      {
        processId: 4_343,
        processInstanceId: "b".repeat(32),
        isProcessAlive: () => true,
      },
    );
    await expect(
      observer.acquireCompactionAdmission(binding, 1, request),
    ).rejects.toThrow("CONTEXT_ADMISSION_OWNER_AMBIGUOUS");
  });

  it("does not let a delayed stale reclaimer remove a live successor", async () => {
    const stateRoot = await root();
    const abandoned = new PrivateContextStore(
      { root: stateRoot },
      {
        processId: 4_101,
        processInstanceId: "a".repeat(32),
      },
    );
    const original = await abandoned.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    if (original.status !== "acquired") {
      throw new Error(`EXPECTED_ORIGINAL_ADMISSION_${original.status}`);
    }

    let observed!: () => void;
    const staleObserved = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let resume!: () => void;
    const mayRepair = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let successorInstalled = false;
    const delayed = new PrivateContextStore(
      { root: stateRoot },
      {
        processId: 4_102,
        processInstanceId: "b".repeat(32),
        isProcessAlive: () => successorInstalled,
        afterStaleLeaseRead: async () => {
          observed();
          await mayRepair;
        },
      },
    );
    const delayedAdmission = delayed.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    await staleObserved;

    const successor = new PrivateContextStore(
      { root: stateRoot },
      {
        processId: 4_103,
        processInstanceId: "c".repeat(32),
        isProcessAlive: () => false,
      },
    );
    const current = await successor.acquireCompactionAdmission(
      binding,
      1,
      request,
    );
    if (current.status !== "acquired") {
      throw new Error(`EXPECTED_SUCCESSOR_ADMISSION_${current.status}`);
    }
    successorInstalled = true;
    resume();

    await expect(delayedAdmission).rejects.toThrow(
      "CONTEXT_ADMISSION_OWNER_AMBIGUOUS",
    );
    await expect(
      successor.save(requestedSession(), current.lease),
    ).resolves.toBeUndefined();
    await successor.releaseCompactionAdmission(current.lease);
  });

  it("does not expose a create-only record before its bytes are durable", async () => {
    const stateRoot = await root();
    let created!: (target: string) => void;
    const privateRecordCreated = new Promise<string>((resolve) => {
      created = resolve;
    });
    let resume!: () => void;
    const mayWrite = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const store = new PrivateContextStore(
      { root: stateRoot },
      {
        afterExclusiveCreate: async (target) => {
          created(target);
          await mayWrite;
        },
      },
    );
    const admission = store.acquireCompactionAdmission(binding, 1, request);
    const publicTarget = await privateRecordCreated;
    let targetExists = true;
    try {
      await fs.lstat(publicTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      targetExists = false;
    } finally {
      resume();
    }

    const acquired = await admission;
    expect(targetExists).toBe(false);
    expect(acquired.status).toBe("acquired");
    if (acquired.status === "acquired") {
      await store.releaseCompactionAdmission(acquired.lease);
    }
  });

  it("finalizes a complete hardlink publication before reading it", async () => {
    const stateRoot = await root();
    let published!: (target: string) => void;
    const recordPublished = new Promise<string>((resolve) => {
      published = resolve;
    });
    let resume!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const writer = new PrivateContextStore(
      { root: stateRoot },
      {
        afterExclusivePublish: async (target) => {
          published(target);
          await mayFinish;
        },
      },
    );
    const admission = writer.acquireCompactionAdmission(binding, 1, request);
    const publicTarget = await recordPublished;
    expect((await fs.lstat(publicTarget)).nlink).toBe(2);

    const restarted = new PrivateContextStore({ root: stateRoot });
    await expect(
      restarted.acquireCompactionAdmission(binding, 1, request),
    ).resolves.toEqual({ status: "busy" });
    expect((await fs.lstat(publicTarget)).nlink).toBe(1);
    resume();

    const acquired = await admission;
    expect(acquired.status).toBe("acquired");
    if (acquired.status === "acquired") {
      await writer.releaseCompactionAdmission(acquired.lease);
    }
  });

  it("recovers complete lease and admission records after writer termination", async () => {
    const fixtureRoot = await root();
    const bundle = path.join(fixtureRoot, "context-record-crash-writer.mjs");
    await build({
      entryPoints: [
        path.resolve("tests/fixtures/context-record-crash-writer.ts"),
      ],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });

    for (const crashPoint of ["lease", "admission"] as const) {
      const stateRoot = await root();
      const child = spawn(process.execPath, [bundle, stateRoot, crashPoint], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.stdout)
        throw new Error("CONTEXT_CRASH_FIXTURE_STDOUT_MISSING");
      const { target } = await firstJsonLine(child.stdout);
      expect((await fs.lstat(target)).nlink).toBe(2);
      expect(child.kill("SIGKILL")).toBe(true);
      await once(child, "exit");
      expect((await fs.lstat(target)).nlink).toBe(2);

      const restarted = new PrivateContextStore({ root: stateRoot });
      const recovered = await restarted.acquireCompactionAdmission(
        binding,
        1,
        request,
      );
      expect(recovered.status).toBe("acquired");
      if (recovered.status === "acquired") {
        await restarted.releaseCompactionAdmission(recovered.lease);
      }
    }
  }, 10_000);

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
    let current = createContextSession(binding);
    await store.save(current);
    for (const [index, checkpointId] of [
      "checkpoint-1",
      "checkpoint-2",
      "checkpoint-3",
    ].entries()) {
      const requested = value(
        requestCheckpoint(
          value(
            beginCompaction(current, {
              operationId: `operation-${checkpointId}`,
              source: "retained_agent",
              sourceBoundary: `message-operation-${checkpointId}`,
            }),
          ),
        ),
      );
      const original = createCheckpointEnvelope(requested, content, {
        checkpointId,
        providerOperationId: `provider-${checkpointId}`,
        parentCheckpointId: current.lastCheckpointId,
        sourceCursor: `cursor-${checkpointId}`,
        createdAt: (index + 1) * 1000,
      });
      await store.put(original);
      current = value(
        activateNextEpoch(
          value(
            markOldEpochRetired(
              value(
                confirmHostContext(
                  value(
                    offerCheckpointHandoff(
                      value(
                        markCheckpointStored(
                          value(recordValidatedCheckpoint(requested, original)),
                        ),
                      ),
                    ),
                  ),
                  `confirmed-${checkpointId}`,
                ),
              ),
            ),
          ),
        ),
      );
      await store.save(current);
    }
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

  it("pins the last good and newly written checkpoints across clock rollback", async () => {
    const stateRoot = await root();
    const store = new PrivateContextStore({
      root: stateRoot,
      maxCheckpointsPerTask: 2,
    });
    await store.save({
      ...createContextSession(binding),
      epoch: 2,
      lastCheckpointId: "checkpoint-1",
      lastCompletedOperationId: "operation-checkpoint-1",
      lastCompletedRequest: {
        operationId: "operation-checkpoint-1",
        source: "retained_agent",
        sourceBoundary: "message-operation-checkpoint-1",
      },
    });
    await store.put(checkpoint("checkpoint-1", 3_000));
    await store.put(checkpoint("checkpoint-2", 2_000));
    await store.put(checkpoint("checkpoint-3", 1_000));

    await expect(store.get(binding, "checkpoint-1")).resolves.toMatchObject({
      checkpointId: "checkpoint-1",
    });
    await expect(store.get(binding, "checkpoint-3")).resolves.toMatchObject({
      checkpointId: "checkpoint-3",
    });
    await expect(store.get(binding, "checkpoint-2")).resolves.toBeNull();
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

  // CC-3-CYCLE: a task must survive three consecutive ordinary context
  // cycles (create -> use -> summarise/retire -> reuse), each carried by a
  // NEW `PrivateContextStore` instance, not an in-memory object this test
  // still holds. Every other durability test in this file proves at most
  // one restart at the store layer alone; none drives the real
  // `CodexContextContinuity` composition (the actual create/retire
  // entrypoint) through more than one cycle. This is one sequential test
  // rather than `it.each`, because the three cycles are not independent
  // cases: cycle 2 depends on exactly what cycle 1 left on `stateRoot`, and
  // cycle 3 on cycle 2. The `cycles` array below is the enumerated table
  // this one test walks; each entry's own reuse-then-create-then-retire
  // block is the repeated unit.
  it("keeps one task's context intact through three consecutive ordinary cycles, each carried by a new store instance", async () => {
    const stateRoot = await root();
    const ownerId = "owner-preview";
    const providerProfileId = "profile-isolated-next";
    const modelId = "farol-next/mind";
    const threadId = "thread-three-cycles";
    const taskBinding: ContextBinding = {
      ownerId,
      taskId: threadId,
      hostThreadId: threadId,
      sessionId: threadId,
      providerProfileId,
      modelId,
      mode: "mind",
    };
    // Control: an unrelated task's binding must stay untouched throughout,
    // so a passing assertion below cannot be explained by "there was
    // something on disk" rather than "this task's own state was there".
    const foreignBinding: ContextBinding = {
      ...taskBinding,
      taskId: "thread-unrelated",
      hostThreadId: "thread-unrelated",
      sessionId: "thread-unrelated",
    };

    function cycleSummary(label: string): CodexContextSummaryDriver {
      const cycleContent: CheckpointContent = {
        ...content,
        goal: `${label} cycle: ${content.goal}`,
      };
      const receipt = {
        status: "completed" as const,
        providerOperationId: `provider-${label}`,
        sourceCursor: `cursor-${label}`,
        content: cycleContent,
      };
      return {
        selectSource: async () => "retained_agent" as const,
        request: async () => receipt,
        observe: async () => receipt,
        retire: async () => ({ status: "retired" as const }),
      };
    }

    function markerlessReuseTurn(turnId: string) {
      return {
        body: {
          model: modelId,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Continue the task." }],
            },
          ],
          client_metadata: {
            session_id: threadId,
            thread_id: threadId,
            turn_id: turnId,
          },
        },
      };
    }

    const cycles = ["first", "second", "third"] as const;
    let previousLabel: (typeof cycles)[number] | null = null;

    for (const [index, label] of cycles.entries()) {
      const expectedEpochAfterRetire = index + 2; // 1 -> 2 -> 3 -> 4

      // A fresh store AND a fresh composition instance: nothing but what
      // actually reached `stateRoot` on disk crosses this boundary.
      const store = new PrivateContextStore({ root: stateRoot });
      const continuity = new CodexContextContinuity({
        ownerId,
        providerProfileId,
        store,
        summary: cycleSummary(label),
      });

      // "reuse": prove the PREVIOUS cycle's retirement is durable before
      // this cycle overwrites it. The first cycle has nothing to reuse yet.
      if (previousLabel) {
        const resumed = await continuity.prepareTurn(
          markerlessReuseTurn(`turn-reuse-${label}`),
        );
        if (!resumed.ok) throw new Error(resumed.error.code);
        expect(resumed.value.trustedContext).toContain(previousLabel);
      }

      // "create" + "use": an ordinary compaction summarizing history so far.
      const handoff = await continuity.compact({
        endpoint: "responses_compact",
        body: {
          model: modelId,
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: `${label} cycle history.` },
              ],
            },
          ],
        },
        metadataHeader: JSON.stringify({
          thread_id: threadId,
          turn_id: `turn-compact-${label}`,
        }),
      });
      if (!handoff.ok) throw new Error(handoff.error.code);
      expect(handoff.value.variant).toBe("unary_replacement_history");

      // "summarise/retire": the host confirms, retiring the old epoch and
      // activating the next one.
      const confirmed = await continuity.confirmHostCompaction({
        modelId,
        threadId,
        turnId: `turn-compact-${label}`,
        itemId: `item-${label}`,
        signal: "turn_completed",
      });
      expect(confirmed).toMatchObject({
        ok: true,
        value: { phase: "active", epoch: expectedEpochAfterRetire },
      });

      // A fifth, unrelated store instance never sees this task's state
      // under a foreign binding (the control case).
      await expect(
        new PrivateContextStore({ root: stateRoot }).load(foreignBinding),
      ).resolves.toBeNull();

      previousLabel = label;
    }

    // The third cycle's own retirement is read back by a final, brand-new
    // store instance and composition object that never performed any of
    // the three cycles above: the whole chain survived independently of
    // any in-memory object this test still holds.
    const verifyStore = new PrivateContextStore({ root: stateRoot });
    await expect(verifyStore.load(taskBinding)).resolves.toMatchObject({
      phase: "active",
      epoch: 4,
    });
    const verifyContinuity = new CodexContextContinuity({
      ownerId,
      providerProfileId,
      store: verifyStore,
      summary: cycleSummary("verification"),
    });
    const finalReuse = await verifyContinuity.prepareTurn(
      markerlessReuseTurn("turn-reuse-verification"),
    );
    if (!finalReuse.ok) throw new Error(finalReuse.error.code);
    expect(finalReuse.value.trustedContext).toContain("third");
  });
});
