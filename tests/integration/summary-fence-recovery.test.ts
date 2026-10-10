import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatGptContextSummaryRoute } from "../../src/apps/desktop/chatgpt-context-summary";
import type {
  ChatGptReadonlyTaskResult,
  ChatGptTaskObserver,
} from "../../src/apps/desktop/chatgpt-route";
import { createCodexContextController } from "../../src/apps/desktop/codex-context-runtime";
import {
  startRouteBRuntime,
  type RouteBRuntime,
} from "../../src/apps/desktop/route-b-runtime";
import {
  FENCE_RECOVERY_SENTINEL,
  computerConnectorAdmission,
  recoverSummaryExecutionFence,
} from "../../src/apps/desktop/summary-fence-recovery";
import {
  deleteTaskContext,
  sweepOrphanTaskContexts,
} from "../../src/apps/desktop/task-context-cleanup";
import {
  createCheckpointEnvelope,
  type CheckpointContent,
} from "../../src/modules/chat/domain/checkpoint";
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
} from "../../src/modules/chat/domain/context-continuity";
import { PrivateContextStore } from "../../src/modules/chat/infra/repo/private-context-store";
import {
  ReadonlyComputerCallRequestSchema,
  type ReadonlyComputerContract,
} from "../../src/modules/computer/contract/readonly-computer-contract";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import {
  EXECUTION_FENCE_DIRECTORY,
  PrivateExecutionFence,
} from "../../src/modules/computer/infra/mcp/execution-fence";

const recordEntries = async (directory: string) =>
  (await fs.readdir(directory)).filter((entry) => entry.endsWith(".json"));

const threadId = "0199c0de-0000-7000-8000-00000000f011";

function binding(taskId: string): ContextBinding {
  return {
    ownerId: "owner-desktop",
    taskId,
    hostThreadId: taskId,
    sessionId: taskId,
    providerProfileId: "profile-isolated-next",
    modelId: "chatgpt",
    mode: "chatgpt",
  };
}

const checkpoint: CheckpointContent = {
  goal: "Summarize without tools.",
  activeConstraints: ["Never touch the workspace during a summary."],
  latestCorrections: [],
  keyDecisions: [],
  completedWork: [],
  unfinishedWork: ["Continue after compaction."],
  unresolvedQuestions: [],
  unknownOutcomes: [],
  artifactRefs: [],
  attachmentRefs: [],
  nextSafeStep: "Continue the task.",
};
const checkpointJson = JSON.stringify(checkpoint);

function value<T>(result: { ok: boolean; value?: T }): T {
  if (!result.ok || result.value === undefined)
    throw new Error("FIXTURE_TRANSITION_FAILED");
  return result.value;
}

async function completedSummary(store: PrivateContextStore, taskId: string) {
  // Controlled original-owner completion through the FSM, with real private
  // store bytes. This is a separate positive fixture, never a reconstruction
  // or replay of the crashed operation below, nor live provider/host proof.
  const requested = value(
    requestCheckpoint(
      value(
        beginCompaction(createContextSession(binding(taskId)), {
          operationId: `compact-${taskId}`,
          source: "retained_agent",
          sourceBoundary: `boundary-${taskId}`,
        }),
      ),
    ),
  );
  const original = createCheckpointEnvelope(requested, checkpoint, {
    checkpointId: `checkpoint-${taskId}`,
    providerOperationId: `provider-${taskId}`,
    sourceCursor: `cursor-${taskId}`,
    parentCheckpointId: null,
    createdAt: 1000,
  });
  await store.put(original);
  let session = value(recordValidatedCheckpoint(requested, original));
  session = value(markCheckpointStored(session));
  session = value(offerCheckpointHandoff(session));
  session = value(confirmHostContext(session, `confirmed-${taskId}`));
  session = value(markOldEpochRetired(session));
  session = value(activateNextEpoch(session));
  await store.save(session);
  // The completed head proves this exact original operation over even if
  // its summary-attempt bookkeeping and raised fence outlived completion.
  const attempt = {
    schemaVersion: 1 as const,
    operationId: original.operationId,
    binding: original.binding,
    source: original.source,
    sourceBoundary: original.sourceBoundary,
    phase: "possible_send" as const,
    conversationUrl: "https://chatgpt.com/c/fixture-completed",
    turnUserId: `user-${taskId}`,
    turnAssistantId: null,
  };
  await store.putSummaryAttempt(attempt);
  return { session, original, attempt };
}

function initialRequest(thread: string, turnId: string, text: string) {
  return {
    model: "chatgpt",
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    ],
    tools: [],
    client_metadata: {
      session_id: thread,
      thread_id: thread,
      turn_id: turnId,
      root_turn_id: turnId,
    },
  };
}

const compactionBody = {
  model: "chatgpt",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Read src/a.ts through the Computer connector now.",
        },
      ],
    },
  ],
};
const compactionHeaders = {
  "x-codex-turn-metadata": JSON.stringify({
    thread_id: threadId,
    turn_id: "turn-recovery-compact",
  }),
};

async function answer(
  text: string,
  observer: ChatGptTaskObserver,
): Promise<ChatGptReadonlyTaskResult> {
  await observer.onTextDelta?.({
    sequence: 1,
    delta: text,
    text,
    observedCharacters: text.length,
  });
  return {
    state: "completed",
    code: null,
    deltaCount: 1,
    observedCharacters: text.length,
    outputText: text,
  };
}

function fenceOf(fence: PrivateExecutionFence) {
  return {
    raise: (input: { operationId: string; binding: ContextBinding }) =>
      fence.raise({
        operationId: input.operationId,
        taskId: input.binding.taskId,
      }),
    lower: (input: { operationId: string }) => fence.lower(input.operationId),
  };
}

describe("HR-011/F1 a restart during a possibly submitted summary keeps the Computer connector fenced", () => {
  const roots: string[] = [];
  let runtime: RouteBRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps a crashed original summary and its fence when task cleanup cannot prove completion, without a second submission", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-recovery-")),
    );
    roots.push(root);
    const launchRoot = path.join(root, "computer-authority");
    await fs.mkdir(launchRoot, { recursive: true, mode: 0o700 });
    const fenceDirectory = path.join(launchRoot, EXECUTION_FENCE_DIRECTORY);
    const stateRoot = path.join(root, "context-continuity");

    // The independent effect observer: the contract counts every call that
    // reaches it. The connector's MCP process reads the fence on its own and
    // outlives the desktop process that raised it.
    let contractCalls = 0;
    const contract: ReadonlyComputerContract = {
      async execute(value) {
        contractCalls += 1;
        const request = ReadonlyComputerCallRequestSchema.parse(value);
        return {
          ok: false,
          correlation: {
            ownerId: request.ownerId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            taskEpoch: request.taskEpoch,
            participantId: request.participantId,
            turnId: request.turnId,
            generation: request.generation,
            callId: request.callId,
            workspaceId: request.workspaceId,
            relativePath: request.operation.relativePath,
            operation: request.operation,
          },
          error: {
            code: "AUTHORITY_PATH_DENIED",
            source: "owner-restriction",
            retry: "never",
          },
        };
      },
    };
    const server = createReadonlyComputerMcpServer(
      contract,
      {
        ownerId: "owner-desktop",
        sessionId: "secure-mcp-session",
        taskId: "secure-mcp-task",
        taskEpoch: 1,
        participantId: "secure-mcp-main",
        turnId: "secure-mcp-turn",
        generation: 1,
      },
      undefined,
      undefined,
      undefined,
      new PrivateExecutionFence({ root: launchRoot }),
    );
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const computerRead = async () =>
      (
        await client.callTool({
          name: "computer_workspace_read",
          arguments: { workspaceId: "farol", relativePath: "src/a.ts" },
        })
      ).structuredContent;
    const post = (
      route: RouteBRuntime,
      pathname: string,
      body: unknown,
      headers = {},
    ) =>
      fetch(`${route.endpoint.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${route.endpoint.token}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });

    // First life: the summary's page correlates the turn, then the process
    // is gone before any outcome is known.
    let summaries = 0;
    const firstLife: ChatGptContextSummaryRoute = {
      runReadonlyTask: async (prompt, _attachments, observer = {}) => {
        if (prompt.includes("Return exactly one JSON object")) {
          summaries += 1;
          await observer.onDispatchIntent?.();
          await observer.onCorrelation?.({
            turnUserId: "summary-user-crash",
            turnAssistantId: null,
          });
          throw new Error("synthetic crash while the summary runs");
        }
        return answer("Task A answered.", observer);
      },
      currentConversationUrl: () => "https://chatgpt.com/c/fence-recovery",
      retainedConversationUrl: () => "https://chatgpt.com/c/fence-recovery",
      resetConversation: () => undefined,
      dispose: () => undefined,
    };
    const firstFence = new PrivateExecutionFence({ root: launchRoot });
    const first = createCodexContextController({
      ownerId: "owner-desktop",
      providerProfileId: "profile-isolated-next",
      stateRoot,
      summaryRoutes: {
        retained: (binding) => (binding.taskId === threadId ? firstLife : null),
        createFallback: vi.fn(),
      },
      summaryFence: fenceOf(firstFence),
    });
    runtime = await startRouteBRuntime({
      stateRoot: root,
      surfaces: {
        surfaceFor: async () => ({ ok: true, surface: firstLife }),
      },
      compaction: first.continuity,
    });

    try {
      // Positive control: before any summary the connector serves the call.
      expect(await computerRead()).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_PATH_DENIED" },
      });
      expect(contractCalls).toBe(1);

      const turn = await post(
        runtime,
        "/responses",
        initialRequest(threadId, "turn-recovery-1", "Work on A."),
      );
      expect(await turn.text()).toContain("response.completed");

      const crashed = await post(
        runtime,
        "/responses/compact",
        compactionBody,
        compactionHeaders,
      );
      expect(crashed.status).toBe(422);
      expect(await crashed.text()).toContain(
        "FAROL_NEXT_COMPACTION_SUMMARY_OUTCOME_UNKNOWN",
      );
      expect(summaries).toBe(1);
      // What a crash leaves behind: one raised record, one possibly sent
      // attempt, and a connector that keeps refusing on its own.
      await expect(recordEntries(fenceDirectory)).resolves.toHaveLength(1);
      await runtime.close();
      runtime = null;
      expect(await computerRead()).toMatchObject({
        ok: false,
        error: { code: "COMPUTER_SUMMARY_PHASE_ACTIVE" },
      });
      expect(contractCalls).toBe(1);

      // Second life: a new process reconciles the fence with the store it
      // finds. Nothing proved the summary over, so the record stays.
      const secondLife: ChatGptContextSummaryRoute = {
        runReadonlyTask: async (_prompt, _attachments, observer = {}) => {
          summaries += 1;
          return answer("Task A answered again.", observer);
        },
        observeReadonlyTask: async () => {
          return {
            state: "completed",
            code: null,
            deltaCount: 1,
            observedCharacters: checkpointJson.length,
            outputText: checkpointJson,
          };
        },
        currentConversationUrl: () => "https://chatgpt.com/c/fence-recovery",
        retainedConversationUrl: () => "https://chatgpt.com/c/fence-recovery",
        resetConversation: () => undefined,
        dispose: () => undefined,
      };
      const secondFence = new PrivateExecutionFence({ root: launchRoot });
      const second = createCodexContextController({
        ownerId: "owner-desktop",
        providerProfileId: "profile-isolated-next",
        stateRoot,
        summaryRoutes: {
          retained: (binding) =>
            binding.taskId === threadId ? secondLife : null,
          createFallback: vi.fn(),
        },
        summaryFence: fenceOf(secondFence),
      });
      await expect(
        recoverSummaryExecutionFence({
          fence: secondFence,
          store: second.store,
        }),
      ).resolves.toEqual({ status: "reconciled", unresolved: 1 });
      await expect(recordEntries(fenceDirectory)).resolves.toHaveLength(1);
      expect(await computerRead()).toMatchObject({
        ok: false,
        error: { code: "COMPUTER_SUMMARY_PHASE_ACTIVE" },
      });
      expect(contractCalls).toBe(1);

      // Asked again, the compaction stays unknown: nothing observes the page
      // a crash lost, and nothing submits a second summary. The connector
      // keeps refusing exactly as long as that lasts.
      runtime = await startRouteBRuntime({
        stateRoot: root,
        surfaces: {
          surfaceFor: async () => ({ ok: true, surface: secondLife }),
        },
        compaction: second.continuity,
      });
      const repeated = await post(
        runtime,
        "/responses/compact",
        compactionBody,
        compactionHeaders,
      );
      expect(repeated.status).toBe(422);
      expect(await repeated.text()).toContain(
        "FAROL_NEXT_COMPACTION_SUMMARY_OUTCOME_UNKNOWN",
      );
      expect(summaries).toBe(1);
      expect(await computerRead()).toMatchObject({
        ok: false,
        error: { code: "COMPUTER_SUMMARY_PHASE_ACTIVE" },
      });
      expect(contractCalls).toBe(1);

      // Closing the task proves neither publication nor completion of its
      // original operation. Quarantine retains both private evidence and fence.
      const retainedSession = await second.store.load(binding(threadId));
      if (!retainedSession?.operation)
        throw new Error("FIXTURE_OPERATION_MISSING");
      const operationId = retainedSession.operation.operationId;
      const retainedAttempts = await second.store.listSummaryAttempts(
        binding(threadId),
      );
      const retainedSource = await second.store.getSource(
        binding(threadId),
        operationId,
      );
      expect(retainedAttempts).toHaveLength(1);
      expect(retainedSource).not.toBeNull();
      await expect(
        deleteTaskContext(second.store, binding(threadId), secondFence),
      ).resolves.toBe("failed");
      await expect(second.store.load(binding(threadId))).resolves.toEqual(
        retainedSession,
      );
      await expect(
        second.store.listSummaryAttempts(binding(threadId)),
      ).resolves.toEqual(retainedAttempts);
      await expect(
        second.store.getSource(binding(threadId), operationId),
      ).resolves.toEqual(retainedSource);
      await expect(recordEntries(fenceDirectory)).resolves.toHaveLength(1);
      expect(await computerRead()).toMatchObject({
        ok: false,
        error: { code: "COMPUTER_SUMMARY_PHASE_ACTIVE" },
      });
      expect(contractCalls).toBe(1);
      expect(summaries).toBe(1);
      // A later start still finds the same possibly running original.
      await expect(
        recoverSummaryExecutionFence({
          fence: new PrivateExecutionFence({ root: launchRoot }),
          store: second.store,
        }),
      ).resolves.toEqual({ status: "reconciled", unresolved: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps every record when the store cannot be read, drops what the store settled, and settles two summaries independently", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-recovery-")),
    );
    roots.push(root);
    const launchRoot = path.join(root, "computer-authority");
    await fs.mkdir(launchRoot, { recursive: true, mode: 0o700 });
    const fenceDirectory = path.join(launchRoot, EXECUTION_FENCE_DIRECTORY);
    const stateRoot = path.join(root, "context-continuity");
    const store = new PrivateContextStore({ root: stateRoot });
    const attempt = (
      taskId: string,
      operationId: string,
      phase: "prepared" | "possible_send" | "outcome_unknown",
    ) => ({
      schemaVersion: 1 as const,
      operationId,
      binding: binding(taskId),
      source: "retained_agent" as const,
      sourceBoundary: `sha256:${operationId}`,
      phase,
      conversationUrl: phase === "prepared" ? null : "https://chatgpt.com/c/r",
      turnUserId: phase === "prepared" ? null : `user-${operationId}`,
      turnAssistantId: null,
    });
    // Sessions exist for two tasks; a third task's session is unreadable.
    await store.save(createContextSession(binding("task-a")));
    await store.save(createContextSession(binding("task-b")));
    await store.putSummaryAttempt(
      attempt("task-a", "compact-a", "possible_send"),
    );
    await store.putSummaryAttempt(
      attempt("task-b", "compact-b", "outcome_unknown"),
    );
    await store.putSummaryAttempt(
      attempt("task-b", "compact-b-prepared", "prepared"),
    );
    const fence = new PrivateExecutionFence({ root: launchRoot });
    await fence.raise({ operationId: "compact-a", taskId: "task-a" });
    await fence.raise({ operationId: "compact-b-prepared", taskId: "task-b" });
    await fence.raise({ operationId: "compact-stale", taskId: "task-gone" });
    await expect(recordEntries(fenceDirectory)).resolves.toHaveLength(3);

    // An unreadable task proves nothing: every record stays as it is.
    const tasks = path.join(stateRoot, "tasks");
    const unreadable = path.join(tasks, "c".repeat(64));
    await fs.mkdir(unreadable, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(unreadable, "session.json"), "{not json", {
      mode: 0o600,
    });
    await expect(
      recoverSummaryExecutionFence({ fence, store }),
    ).resolves.toEqual({ status: "kept", code: "CONTEXT_TASK_UNREADABLE" });
    await expect(recordEntries(fenceDirectory)).resolves.toHaveLength(3);
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    // So does an attempt that cannot be read.
    await fs.rm(unreadable, { recursive: true, force: true });
    const attemptFileOf = async (operationId: string) => {
      for (const key of await fs.readdir(tasks)) {
        const directory = path.join(tasks, key, "summary-attempts");
        for (const entry of await fs.readdir(directory).catch(() => [])) {
          const file = path.join(directory, entry);
          if ((await fs.readFile(file, "utf8")).includes(`"${operationId}"`)) {
            return file;
          }
        }
      }
      throw new Error(`no attempt for ${operationId}`);
    };
    const attemptA = await attemptFileOf("compact-a");
    const attemptBytes = await fs.readFile(attemptA);
    await fs.writeFile(attemptA, "{not json", { mode: 0o600 });
    await expect(
      recoverSummaryExecutionFence({ fence, store }),
    ).resolves.toEqual({ status: "kept", code: "CONTEXT_STORE_UNREADABLE" });
    await expect(recordEntries(fenceDirectory)).resolves.toHaveLength(3);
    await fs.writeFile(attemptA, attemptBytes, { mode: 0o600 });

    // A readable store settles it: the prepared attempt never reached a page
    // and the stale record has no attempt at all, so both records go; the
    // two possibly running summaries keep theirs, one of them raised anew.
    await expect(
      recoverSummaryExecutionFence({ fence, store }),
    ).resolves.toEqual({ status: "reconciled", unresolved: 2 });
    await expect(recordEntries(fenceDirectory)).resolves.toHaveLength(2);
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    // Settling A does not discharge B; only both over admits again.
    await store.deleteSummaryAttempt(binding("task-a"), "compact-a");
    await fence.lower("compact-a");
    await expect(
      recoverSummaryExecutionFence({ fence, store }),
    ).resolves.toEqual({ status: "reconciled", unresolved: 1 });
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    // Registry absence does not settle B's original unknown summary. A
    // separate completed original is sweepable, while live A stays untouched.
    const retainedB = await store.listSummaryAttempts(binding("task-b"));
    const liveA = await store.load(binding("task-a"));
    const settled = await completedSummary(store, "task-settled");
    await fence.raise({
      operationId: settled.original.operationId,
      taskId: "task-settled",
    });
    await expect(
      sweepOrphanTaskContexts(
        store,
        { status: "loaded", taskIds: ["task-a"] },
        binding,
        fence,
      ),
    ).resolves.toEqual({
      swept: ["task-settled"],
      unreadable: 0,
      failed: ["task-b"],
    });
    await expect(store.load(binding("task-settled"))).resolves.toBeNull();
    await expect(store.load(binding("task-a"))).resolves.toEqual(liveA);
    await expect(store.listSummaryAttempts(binding("task-b"))).resolves.toEqual(
      retainedB,
    );
    await expect(
      recoverSummaryExecutionFence({ fence, store }),
    ).resolves.toEqual({ status: "reconciled", unresolved: 1 });
    await expect(recordEntries(fenceDirectory)).resolves.toHaveLength(1);
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
  });
  describe.each(["close", "sweep"] as const)(
    "%s cleanup with an original completed head",
    (cleanup) => {
      it.each(["completed", "withheld", "outcome_unknown", "unsafe"] as const)(
        "%s deletion releases only a confirmed task and preserves other tasks",
        async (outcome) => {
          const root = await fs.realpath(
            await fs.mkdtemp(
              path.join(os.tmpdir(), "farol-next-fence-cleanup-"),
            ),
          );
          roots.push(root);
          const launchRoot = path.join(root, "computer-authority");
          await fs.mkdir(launchRoot, { mode: 0o700 });
          const stateRoot = path.join(root, "context-continuity");
          const store = new PrivateContextStore({ root: stateRoot });
          const { session, original, attempt } = await completedSummary(
            store,
            "task-completed",
          );
          const live = createContextSession(binding("task-live"));
          await store.save(live);
          const fence = new PrivateExecutionFence({ root: launchRoot });
          await fence.raise({
            operationId: original.operationId,
            taskId: session.binding.taskId,
          });
          const fenceDirectory = path.join(
            launchRoot,
            EXECUTION_FENCE_DIRECTORY,
          );
          const records = await recordEntries(fenceDirectory);
          const fenceFile = path.join(fenceDirectory, records[0]!);
          const fenceBytes = await fs.readFile(fenceFile);
          const release = vi.fn((taskId: string) => fence.release(taskId));
          const deletion = vi.fn(async (target: ContextBinding) => {
            // Inject acknowledgement faults at the cleanup port. This proves
            // fence ordering, not a native filesystem durability failure.
            if (outcome === "withheld")
              throw new Error("FIXTURE_DELETION_WITHHELD");
            await store.deleteTask(target);
            if (outcome === "outcome_unknown")
              throw new Error("FIXTURE_DELETION_ACK_UNKNOWN");
          });
          if (outcome === "unsafe") {
            // Real unsafe task-directory permissions must refuse deletion.
            for (const key of await fs.readdir(path.join(stateRoot, "tasks"))) {
              const directory = path.join(stateRoot, "tasks", key);
              if (
                (
                  await fs.readFile(
                    path.join(directory, "session.json"),
                    "utf8",
                  )
                ).includes('"task-completed"')
              )
                await fs.chmod(directory, 0o755);
            }
          }
          const ports = {
            deleteTask: deletion,
            listTaskBindings: () => store.listTaskBindings(),
          };
          if (cleanup === "close") {
            await expect(
              deleteTaskContext(ports, session.binding, { release }),
            ).resolves.toBe(outcome === "completed" ? "deleted" : "failed");
          } else {
            await expect(
              sweepOrphanTaskContexts(
                ports,
                { status: "loaded", taskIds: ["task-live"] },
                binding,
                { release },
              ),
            ).resolves.toEqual({
              swept: outcome === "completed" ? ["task-completed"] : [],
              unreadable: 0,
              failed: outcome === "completed" ? [] : ["task-completed"],
            });
          }
          expect(deletion).toHaveBeenCalledExactlyOnceWith(session.binding);
          await expect(store.load(live.binding)).resolves.toEqual(live);
          if (outcome === "completed") {
            expect(release).toHaveBeenCalledExactlyOnceWith("task-completed");
            await expect(store.load(session.binding)).resolves.toBeNull();
            await expect(
              store.get(session.binding, original.checkpointId),
            ).resolves.toBeNull();
            await expect(
              store.listSummaryAttempts(session.binding),
            ).resolves.toEqual([]);
            await expect(recordEntries(fenceDirectory)).resolves.toEqual([]);
            await expect(fence.admits()).resolves.toEqual({ admitted: true });
            await expect(
              recoverSummaryExecutionFence({ fence, store }),
            ).resolves.toEqual({ status: "reconciled", unresolved: 0 });
          } else {
            expect(release).not.toHaveBeenCalled();
            await expect(fs.readFile(fenceFile)).resolves.toEqual(fenceBytes);
            await expect(fence.admits()).resolves.toEqual({
              admitted: false,
              code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
            });
            if (outcome === "outcome_unknown") {
              // The deletion took effect before the acknowledgement was lost;
              // cleanup still may not discharge the fence or repeat the effect.
              await expect(store.load(session.binding)).resolves.toBeNull();
            } else {
              await expect(store.load(session.binding)).resolves.toEqual(
                session,
              );
              await expect(
                store.get(session.binding, original.checkpointId),
              ).resolves.toEqual(original);
              await expect(
                store.listSummaryAttempts(session.binding),
              ).resolves.toEqual([attempt]);
            }
          }
        },
      );
    },
  );
  it("holds the connector closed when a required fence record cannot be materialized, until a later start reconciles for real", async () => {
    const launchRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-fence-recovery-")),
    );
    roots.push(launchRoot);
    const fence = new PrivateExecutionFence({ root: launchRoot });
    const binding = {
      ownerId: "owner-desktop",
      taskId: "task-held",
      hostThreadId: "task-held",
      sessionId: "task-held",
      providerProfileId: "profile-isolated-next",
      modelId: "chatgpt",
      mode: "chatgpt",
    };
    // The store still holds a possibly running summary whose record cannot
    // be written: its operation id is not a valid fence record.
    const unwritable = {
      listTaskBindings: async () => [{ readable: true, binding }],
      listSummaryAttempts: async () => [
        { operationId: "x".repeat(161), phase: "possible_send" },
      ],
    } as unknown as Parameters<typeof recoverSummaryExecutionFence>[0]["store"];
    await expect(
      recoverSummaryExecutionFence({ fence, store: unwritable }),
    ).resolves.toEqual({
      status: "kept",
      code: "EXECUTION_FENCE_UNRECONCILED",
      held: true,
    });
    await expect(fence.admits()).resolves.toEqual({
      admitted: false,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    });
    const sentinelFile = path.join(
      launchRoot,
      "execution-fence",
      `${createHash("sha256").update(FENCE_RECOVERY_SENTINEL.operationId).digest("hex")}.json`,
    );
    expect(JSON.parse(await fs.readFile(sentinelFile, "utf8"))).toMatchObject({
      operationId: FENCE_RECOVERY_SENTINEL.operationId,
      taskId: FENCE_RECOVERY_SENTINEL.taskId,
    });
    // A later start whose store proves every summary over reconciles for
    // real: the sentinel is stale and goes, and the connector is admitted.
    const settled = {
      listTaskBindings: async () => [{ readable: true, binding }],
      listSummaryAttempts: async () => [],
    } as unknown as Parameters<typeof recoverSummaryExecutionFence>[0]["store"];
    await expect(
      recoverSummaryExecutionFence({ fence, store: settled }),
    ).resolves.toEqual({ status: "reconciled", unresolved: 0 });
    await expect(fence.admits()).resolves.toEqual({ admitted: true });
  });
  it("refuses to expose the Computer connector after a start that could hold no fence record, or none at all", () => {
    expect(computerConnectorAdmission(null)).toEqual({
      admissible: false,
      code: "COMPUTER_FENCE_UNHELD",
    });
    expect(
      computerConnectorAdmission({
        status: "kept",
        code: "EXECUTION_FENCE_UNRECONCILED",
        held: false,
      }),
    ).toEqual({ admissible: false, code: "COMPUTER_FENCE_UNHELD" });
    // A held sentinel, a reconciled start and a kept fence leave the
    // refusal to the records the broker reads.
    expect(
      computerConnectorAdmission({
        status: "kept",
        code: "EXECUTION_FENCE_UNRECONCILED",
        held: true,
      }),
    ).toEqual({ admissible: true });
    expect(
      computerConnectorAdmission({ status: "reconciled", unresolved: 2 }),
    ).toEqual({ admissible: true });
    expect(
      computerConnectorAdmission({
        status: "kept",
        code: "CONTEXT_STORE_UNREADABLE",
      }),
    ).toEqual({ admissible: true });
  });
});
