import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatGptContextSummaryRoute } from "../../src/apps/desktop/chatgpt-context-summary";
import type {
  ChatGptReadonlyTaskResult,
  ChatGptTaskObserver,
} from "../../src/apps/desktop/chatgpt-route";
import { CodexCallerRelayClient } from "../../src/apps/computer-mcp/codex-caller-relay-client";
import {
  startCodexCallerRelay,
  type CodexCallerRelayRuntime,
} from "../../src/apps/desktop/codex-caller-relay";
import { createCodexContextController } from "../../src/apps/desktop/codex-context-runtime";
import type { ProviderTurnJournal } from "../../src/apps/desktop/provider-turn-journal";
import {
  startRouteBRuntime,
  type RouteBRuntime,
  type RouteBTaskSurfaces,
} from "../../src/apps/desktop/route-b-runtime";
import type { CheckpointContent } from "../../src/modules/chat/domain/checkpoint";

const threadId = "0199c0de-0000-7000-8000-00000000b001";

const checkpoint: CheckpointContent = {
  goal: "Answer through the Next route.",
  activeConstraints: ["Keep every change local."],
  latestCorrections: ["Use the second draft."],
  keyDecisions: ["Route B carries the turn."],
  completedWork: [],
  unfinishedWork: ["Continue after compaction."],
  unresolvedQuestions: [],
  unknownOutcomes: [],
  artifactRefs: [],
  attachmentRefs: [],
  nextSafeStep: "Continue the task.",
};

// One Farol task's ChatGPT conversation: it answers ordinary turns and, as the
// retained route, the summary-only checkpoint request.
class TaskConversation implements ChatGptContextSummaryRoute {
  readonly prompts: string[] = [];
  private url: string | null = "https://chatgpt.com/c/route-b-task";

  async runReadonlyTask(
    prompt: string,
    _attachments: readonly unknown[] = [],
    observer: ChatGptTaskObserver = {},
  ): Promise<ChatGptReadonlyTaskResult> {
    this.prompts.push(prompt);
    const text = prompt.includes("Return exactly one JSON object")
      ? JSON.stringify(checkpoint)
      : `Answer ${this.prompts.length}.`;
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

  currentConversationUrl(): string | null {
    return this.url;
  }

  retainedConversationUrl(): string | null {
    return this.url;
  }

  resetConversation(): void {
    this.url = "https://chatgpt.com/c/route-b-task-next";
  }

  dispose(): void {
    this.url = null;
  }
}

function initialRequest(turnId: string, text: string, input: unknown[] = []) {
  return {
    model: "farol-next/mind",
    stream: true,
    store: false,
    input: [
      ...input,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    ],
    tools: [],
    client_metadata: {
      session_id: threadId,
      thread_id: threadId,
      turn_id: turnId,
      root_turn_id: turnId,
    },
  };
}

describe("Route B runtime composed as the product composes it", () => {
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

  async function compose(
    surfaces: RouteBTaskSurfaces,
    task: ChatGptContextSummaryRoute,
    relay?: CodexCallerRelayRuntime,
    journal?: ProviderTurnJournal,
  ) {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-route-b-")),
    );
    roots.push(root);
    const controller = createCodexContextController({
      ownerId: "owner-desktop",
      providerProfileId: "profile-isolated-next",
      stateRoot: path.join(root, "context-continuity"),
      summaryRoutes: {
        retained: (binding) => (binding.taskId === threadId ? task : null),
        createFallback: vi.fn(),
      },
    });
    runtime = await startRouteBRuntime({
      stateRoot: root,
      surfaces,
      compaction: controller.continuity,
      ...(relay ? { relay } : {}),
      ...(journal ? { journal } : {}),
    });
    return { root, controller, runtime };
  }

  function post(
    route: RouteBRuntime,
    pathname: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${route.endpoint.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${route.endpoint.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("runs a host turn in the task bound to its thread, compacts it and continues with the checkpoint", async () => {
    const task = new TaskConversation();
    const surfaceFor = vi.fn(async (_threadId: string) => ({
      ok: true as const,
      surface: task,
    }));
    const settled = vi.fn();
    const { controller, runtime: route } = await compose(
      { surfaceFor, settled },
      task,
    );

    const first = await post(
      route,
      "/responses",
      initialRequest("turn-route-b-1", "Say hello through Route B."),
    );
    expect(first.status).toBe(200);
    const firstStream = await first.text();
    expect(firstStream).toContain("response.output_text.delta");
    expect(firstStream).toContain("Answer 1.");
    expect(firstStream).toContain("response.completed");
    expect(surfaceFor).toHaveBeenCalledWith(threadId);
    expect(task.prompts[0]).toContain("Say hello through Route B.");
    expect(settled).toHaveBeenCalledWith(threadId, "completed");

    // The host asks the provider to compact this thread's history.
    const history = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say hello through Route B." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Answer 1." }],
      },
    ];
    const compacted = await post(
      route,
      "/responses/compact",
      { model: "farol-next/mind", input: history },
      {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: threadId,
          turn_id: "turn-route-b-compact",
        }),
      },
    );
    expect(compacted.status).toBe(200);
    const replacement = (await compacted.json()) as { output: unknown[] };
    expect(task.prompts[1]).toContain(
      "Execution tools are unavailable for this operation.",
    );

    // The next ordinary turn carries the validated checkpoint as context.
    const next = await post(
      route,
      "/responses",
      initialRequest("turn-route-b-2", "Continue.", replacement.output),
    );
    expect(next.status).toBe(200);
    expect(await next.text()).toContain("response.completed");
    expect(task.prompts[2]).toContain("Use the second draft.");
    await expect(
      controller.store.load({
        ownerId: "owner-desktop",
        taskId: threadId,
        hostThreadId: threadId,
        sessionId: threadId,
        providerProfileId: "profile-isolated-next",
        modelId: "farol-next/mind",
        mode: "mind",
      }),
    ).resolves.toMatchObject({ phase: "active", epoch: 2 });
  });

  it("HR-009/F1 sends the epoch's checkpoint in the actual next prompt when the host omits the marker after an exact confirmation", async () => {
    const task = new TaskConversation();
    const { controller, runtime: route } = await compose(
      { surfaceFor: async () => ({ ok: true as const, surface: task }) },
      task,
    );
    const first = await post(
      route,
      "/responses",
      initialRequest("turn-hidden-1", "Say hello through Route B."),
    );
    expect(await first.text()).toContain("response.completed");
    const compacted = await post(
      route,
      "/responses/compact",
      {
        model: "farol-next/mind",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Say hello through Route B." },
            ],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Answer 1." }],
          },
        ],
      },
      {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: threadId,
          turn_id: "turn-hidden-compact",
        }),
      },
    );
    expect(compacted.status).toBe(200);
    // The host confirms the compaction exactly and keeps the marker to
    // itself; the next ordinary request carries only the new message.
    await expect(
      controller.continuity.confirmHostCompaction({
        modelId: "farol-next/mind",
        threadId,
        turnId: "turn-hidden-compact",
        itemId: null,
        signal: "thread_compacted",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { phase: "active", epoch: 2 },
    });
    const summaries = task.prompts.length;

    const next = await post(
      route,
      "/responses",
      initialRequest("turn-hidden-2", "Continue after the hidden marker."),
    );
    expect(next.status).toBe(200);
    expect(await next.text()).toContain("response.completed");
    expect(task.prompts).toHaveLength(summaries + 1);
    expect(task.prompts[summaries]).toContain(
      "Continue after the hidden marker.",
    );
    // The constraint lives only in the checkpoint, never in the new message.
    expect(task.prompts[summaries]).toContain("Keep every change local.");
    expect(task.prompts[summaries]).toContain("Use the second draft.");
  });

  it("correlates one host tool that ChatGPT invokes through the caller relay", async () => {
    const relayRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-relay-")),
    );
    roots.push(relayRoot);
    const relay = await startCodexCallerRelay({ root: relayRoot });
    try {
      const client = new CodexCallerRelayClient(relay.endpoint);
      const invocations: unknown[] = [];
      // ChatGPT reads the ticket from its prompt, calls the connector tool and
      // answers with what the host returned.
      const task: ChatGptContextSummaryRoute = {
        runReadonlyTask: async (prompt, _attachments, observer = {}) => {
          const ticket =
            /with ticket ([a-f0-9]{64}) and binding ([a-f0-9]{64})/u.exec(
              prompt,
            );
          if (!ticket) throw new Error("TICKET_MISSING");
          const described = await client.request({
            operation: "describe",
            ticket: ticket[1]!,
            binding: ticket[2]!,
          });
          invocations.push(described);
          const invoked = await client.request({
            operation: "invoke",
            ticket: ticket[1]!,
            binding: ticket[2]!,
            operationId: "chatgpt-operation-1",
            name: "exec_command",
            namespace: null,
            arguments: { cmd: "printf ROUTE_B_TOOL_OK" },
          });
          invocations.push(invoked);
          const text =
            invoked.ok && invoked.operation === "invoke"
              ? `Host said ${invoked.output}.`
              : "No tool result.";
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
        },
        currentConversationUrl: () => "https://chatgpt.com/c/route-b-tools",
        retainedConversationUrl: () => "https://chatgpt.com/c/route-b-tools",
        resetConversation: () => undefined,
        dispose: () => undefined,
      };
      const { runtime: route } = await compose(
        { surfaceFor: async () => ({ ok: true, surface: task }) },
        task,
        relay,
      );
      const tools = [
        {
          type: "function",
          name: "exec_command",
          description:
            "Run one command through the exact native host registry.",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string", minLength: 1 } },
            required: ["cmd"],
            additionalProperties: false,
          },
          strict: true,
        },
      ];
      const initial = {
        ...initialRequest("turn-route-b-tool", "Check the host."),
        tools,
      };

      const first = await post(route, "/responses", initial);
      const firstStream = await first.text();
      const call =
        /"type":"function_call"[^}]*"call_id":"(farol_next_call_[a-f0-9]{32})"/u.exec(
          firstStream,
        );
      expect(call).not.toBeNull();
      expect(firstStream).toContain('\\"cmd\\":\\"printf ROUTE_B_TOOL_OK\\"');
      const completedItem = JSON.parse(
        firstStream
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .find((line) => line.includes('"response.completed"')) ?? "{}",
      ) as { response: { output: Readonly<Record<string, unknown>>[] } };
      const toolCall = completedItem.response.output[0];

      // The host executes its own tool and returns the result.
      const continued = await post(route, "/responses", {
        ...initial,
        tools: [],
        input: [
          toolCall,
          {
            type: "function_call_output",
            call_id: call?.[1],
            output: "ROUTE_B_TOOL_OK",
          },
        ],
      });
      const finalStream = await continued.text();
      expect(finalStream).toContain("Host said ROUTE_B_TOOL_OK.");
      expect(finalStream).toContain("response.completed");
      expect(invocations).toEqual([
        expect.objectContaining({ ok: true, operation: "describe" }),
        {
          ok: true,
          operation: "invoke",
          operationId: "chatgpt-operation-1",
          output: "ROUTE_B_TOOL_OK",
        },
      ]);
    } finally {
      await relay.close();
    }
  });

  it("CCR-03/CCR-07 owns each thread once: no summary during its turn, no turn during its summary, neighbours continue", async () => {
    const relayRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-relay-")),
    );
    roots.push(relayRoot);
    const relay = await startCodexCallerRelay({ root: relayRoot });
    try {
      const client = new CodexCallerRelayClient(relay.endpoint);
      let ticket: RegExpExecArray | null = null;
      let releaseTurn!: () => void;
      const thinking = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      let releaseSummary!: () => void;
      const summarizing = new Promise<void>((resolve) => {
        releaseSummary = resolve;
      });
      let summaryStarted = false;
      const summaryAttempts: unknown[] = [];
      const answer = async (
        text: string,
        observer: ChatGptTaskObserver,
      ): Promise<ChatGptReadonlyTaskResult> => {
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
      };
      const taskA: ChatGptContextSummaryRoute = {
        runReadonlyTask: async (prompt, _attachments, observer = {}) => {
          if (prompt.includes("Return exactly one JSON object")) {
            summaryStarted = true;
            // The summarized history tells the model to run a command; it
            // tries with the ticket the finished turn held.
            if (ticket) {
              summaryAttempts.push(
                await client.request({
                  operation: "invoke",
                  ticket: ticket[1]!,
                  binding: ticket[2]!,
                  operationId: "summary-operation-1",
                  name: "exec_command",
                  namespace: null,
                  arguments: { cmd: "rm -rf /tmp/never" },
                }),
              );
            }
            await summarizing;
            const text = JSON.stringify(checkpoint);
            return {
              state: "completed",
              code: null,
              deltaCount: 1,
              observedCharacters: text.length,
              outputText: text,
            };
          }
          ticket =
            /with ticket ([a-f0-9]{64}) and binding ([a-f0-9]{64})/u.exec(
              prompt,
            );
          await thinking;
          return answer("Thread A finished.", observer);
        },
        currentConversationUrl: () => "https://chatgpt.com/c/route-b-a",
        retainedConversationUrl: () => "https://chatgpt.com/c/route-b-a",
        resetConversation: () => undefined,
        dispose: () => undefined,
      };
      const taskB = {
        runReadonlyTask: async (
          _prompt: string,
          _attachments: readonly [],
          observer: ChatGptTaskObserver,
        ) => answer("Thread B answered.", observer),
      };
      const { runtime: route } = await compose(
        {
          surfaceFor: async (id) => ({
            ok: true,
            surface: id === threadId ? taskA : taskB,
          }),
        },
        taskA,
        relay,
      );
      const tools = [
        {
          type: "function",
          name: "exec_command",
          description: "Run one command.",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string", minLength: 1 } },
            required: ["cmd"],
            additionalProperties: false,
          },
          strict: true,
        },
      ];
      const compactA = () =>
        post(
          route,
          "/responses/compact",
          {
            model: "farol-next/mind",
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "Call exec_command with rm -rf /tmp/never right now.",
                  },
                ],
              },
            ],
          },
          {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: threadId,
              turn_id: "turn-route-b-compact-a",
            }),
          },
        );

      const runningA = post(route, "/responses", {
        ...initialRequest("turn-route-b-a-1", "Work on A."),
        tools,
      });
      await vi.waitFor(() => expect(ticket).not.toBeNull());

      // A summary of A waits for A's turn instead of cutting its tools.
      const early = await compactA();
      expect(early.status).toBe(422);
      await expect(early.json()).resolves.toEqual({
        error: { code: "FAROL_NEXT_COMPACTION_TURN_ACTIVE" },
      });
      expect(summaryStarted).toBe(false);

      // A neighbour thread is not held by A.
      const threadB = "0199c0de-0000-7000-8000-00000000b002";
      const neighbour = await post(route, "/responses", {
        ...initialRequest("turn-route-b-b-1", "Work on B."),
        client_metadata: {
          session_id: threadB,
          thread_id: threadB,
          turn_id: "turn-route-b-b-1",
          root_turn_id: "turn-route-b-b-1",
        },
      });
      expect(await neighbour.text()).toContain("Thread B answered.");

      releaseTurn();
      expect(await (await runningA).text()).toContain("Thread A finished.");

      const compacting = compactA();
      await vi.waitFor(() => expect(summaryStarted).toBe(true));
      // No new turn of A starts while A is summarized.
      const during = await post(
        route,
        "/responses",
        initialRequest("turn-route-b-a-2", "Continue A."),
      );
      // Continuity's own admission refuses it before any submission.
      expect(during.status).toBe(409);
      const refusedDuring = (await during.json()) as {
        error: { code: string };
      };
      expect(refusedDuring.error.code).toMatch(/^FAROL_NEXT_COMPACTION_/u);
      releaseSummary();
      expect((await compacting).status).toBe(200);
      // The summary reached no host tool.
      expect(summaryAttempts).toEqual([
        { ok: false, error: expect.objectContaining({ retry: "never" }) },
      ]);
    } finally {
      await relay.close();
    }
  });

  it("sends each turn only its own messages and the checkpoint until a turn delivers it", async () => {
    const task = new TaskConversation();
    let refuseNext = false;
    const surfaceFor = vi.fn(async (_threadId: string) =>
      refuseNext
        ? ((refuseNext = false),
          { ok: false as const, code: "TASK_CAPACITY_REACHED" })
        : { ok: true as const, surface: task },
    );
    const { runtime: route } = await compose({ surfaceFor }, task);
    const message = (role: "user" | "assistant", text: string) => ({
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    });

    const first = await post(
      route,
      "/responses",
      initialRequest("turn-history-1", "First request."),
    );
    expect(await first.text()).toContain("response.completed");
    // The host resends the whole history; the task's conversation already
    // holds the earlier request, so only the new one is sent.
    const second = await post(
      route,
      "/responses",
      initialRequest("turn-history-2", "Second request.", [
        message("user", "First request."),
        message("assistant", "Answer 1."),
      ]),
    );
    expect(await second.text()).toContain("response.completed");
    expect(task.prompts[1]).toContain("Second request.");
    expect(task.prompts[1]).not.toContain("First request.");

    const compacted = await post(
      route,
      "/responses/compact",
      {
        model: "farol-next/mind",
        input: [
          message("user", "First request."),
          message("assistant", "Answer 1."),
          message("user", "Second request."),
          message("assistant", "Answer 2."),
        ],
      },
      {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: threadId,
          turn_id: "turn-history-compact",
        }),
      },
    );
    expect(compacted.status).toBe(200);
    const replacement = ((await compacted.json()) as { output: unknown[] })
      .output;
    const summaries = task.prompts.length;

    // The first turn after the compaction is refused before anything is
    // sent. The same turn repeated is admitted, and still carries the
    // checkpoint that never reached the conversation.
    refuseNext = true;
    const refused = await post(
      route,
      "/responses",
      initialRequest("turn-history-3", "Third request.", replacement),
    );
    expect(await refused.text()).toContain("TASK_CAPACITY_REACHED");
    expect(task.prompts).toHaveLength(summaries);
    const repeated = await post(
      route,
      "/responses",
      initialRequest("turn-history-3", "Third request.", replacement),
    );
    expect(await repeated.text()).toContain("response.completed");
    expect(task.prompts[summaries]).toContain("Use the second draft.");
    expect(task.prompts[summaries]).toContain("Third request.");

    // Later turns keep the compaction item in their history. They are
    // admitted, and do not repeat a checkpoint that was delivered.
    const fourth = await post(
      route,
      "/responses",
      initialRequest("turn-history-4", "Fourth request.", [
        ...replacement,
        message("user", "Third request."),
        message("assistant", `Answer ${summaries + 1}.`),
      ]),
    );
    expect(fourth.status).toBe(200);
    expect(await fourth.text()).toContain("response.completed");
    expect(task.prompts[summaries + 1]).toContain("Fourth request.");
    expect(task.prompts[summaries + 1]).not.toContain("Use the second draft.");
    expect(task.prompts[summaries + 1]).not.toContain("Third request.");
  });

  it("reports a thread as owned only while this process uses it", async () => {
    const task = new TaskConversation();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime: route } = await compose(
      {
        surfaceFor: async () => {
          await gate;
          return { ok: true as const, surface: task };
        },
      },
      task,
    );
    expect(route.owns(threadId)).toBe(false);

    const running = post(
      route,
      "/responses",
      initialRequest("turn-owned-1", "Hold the thread."),
    );
    await vi.waitFor(() => expect(route.owns(threadId)).toBe(true));
    expect(route.owns("0199c0de-0000-7000-8000-00000000b0ff")).toBe(false);
    release();
    expect(await (await running).text()).toContain("response.completed");
    expect(route.owns(threadId)).toBe(false);
  });

  it("HR-007 owns a thread from its turn's preparation through durable admission until the turn runs, and not after a refusal", async () => {
    const task = new TaskConversation();
    const admitted = new Map<string, string>();
    let admitting = false;
    let releaseAdmission: () => void = () => undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const journal: ProviderTurnJournal = {
      admit: async (key, intentSha256) => {
        admitting = true;
        await admission;
        const existing = admitted.get(key);
        if (existing === undefined) {
          admitted.set(key, intentSha256);
          return "admitted";
        }
        return existing === intentSha256 ? "replayed" : "conflict";
      },
      release: async (key) => {
        admitted.delete(key);
      },
    };
    const surfaceFor = vi.fn(async (_threadId: string) => ({
      ok: true as const,
      surface: task,
    }));
    const { runtime: route } = await compose(
      { surfaceFor },
      task,
      undefined,
      journal,
    );

    const running = post(
      route,
      "/responses",
      initialRequest("turn-owned-1", "Hold the thread."),
    );
    await vi.waitFor(() => expect(admitting).toBe(true));
    // Prepared, not yet durably admitted, not yet running: still owned.
    expect(route.owns(threadId)).toBe(true);
    expect(surfaceFor).not.toHaveBeenCalled();
    releaseAdmission();
    expect(await (await running).text()).toContain("response.completed");
    expect(route.owns(threadId)).toBe(false);

    // The same identity with another intent is refused before anything
    // runs, and the refusal leaves nothing owned.
    const conflict = await post(
      route,
      "/responses",
      initialRequest("turn-owned-1", "Another request entirely."),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: { code: "FAROL_NEXT_TURN_INTENT_CONFLICT" },
    });
    expect(route.owns(threadId)).toBe(false);
    expect(task.prompts).toHaveLength(1);
  });

  it("refuses an unknown caller and a thread that cannot get a task", async () => {
    const task = new TaskConversation();
    const { runtime: route } = await compose(
      {
        surfaceFor: async () => ({
          ok: false,
          code: "TASK_CAPACITY_REACHED",
        }),
      },
      task,
    );

    const foreign = await fetch(`${route.endpoint.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer not-the-route-token-at-all",
        "content-type": "application/json",
      },
      body: JSON.stringify(initialRequest("turn-foreign", "Hello")),
    });
    expect(foreign.status).toBe(401);

    const refused = await post(
      route,
      "/responses",
      initialRequest("turn-capacity", "Hello"),
    );
    expect(refused.status).toBe(200);
    const stream = await refused.text();
    expect(stream).toContain("TASK_CAPACITY_REACHED");
    expect(stream).not.toContain("response.completed");
    expect(task.prompts).toEqual([]);
  });
});
