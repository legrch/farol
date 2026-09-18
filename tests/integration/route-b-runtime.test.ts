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

  it("CCR-07 lets a summary reach zero host tools even with a ticket open mid-turn", async () => {
    const relayRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-relay-")),
    );
    roots.push(relayRoot);
    const relay = await startCodexCallerRelay({ root: relayRoot });
    try {
      const client = new CodexCallerRelayClient(relay.endpoint);
      let ticket: RegExpExecArray | null = null;
      let release!: () => void;
      const thinking = new Promise<void>((resolve) => {
        release = resolve;
      });
      const summaryAttempts: unknown[] = [];
      const task: ChatGptContextSummaryRoute = {
        runReadonlyTask: async (prompt, _attachments, observer = {}) => {
          if (prompt.includes("Return exactly one JSON object")) {
            // The summarized history tells the model to run a command; it
            // tries, with the ticket the running turn still holds.
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
          const text = "Finished without tools.";
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
        currentConversationUrl: () => "https://chatgpt.com/c/route-b-fence",
        retainedConversationUrl: () => "https://chatgpt.com/c/route-b-fence",
        resetConversation: () => undefined,
        dispose: () => undefined,
      };
      const { runtime: route } = await compose(
        { surfaceFor: async () => ({ ok: true, surface: task }) },
        task,
        relay,
      );
      const running = post(route, "/responses", {
        ...initialRequest("turn-route-b-fence", "Work on it."),
        tools: [
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
        ],
      });
      await vi.waitFor(() => expect(ticket).not.toBeNull());

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
            turn_id: "turn-route-b-fence-compact",
          }),
        },
      );
      expect(compacted.status).toBe(200);
      expect(summaryAttempts).toEqual([
        { ok: false, error: expect.objectContaining({ retry: "never" }) },
      ]);

      release();
      const stream = await (await running).text();
      expect(stream).toContain("Finished without tools.");
      expect(stream).not.toContain('"type":"function_call"');
    } finally {
      await relay.close();
    }
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
