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

  async function compose(surfaces: RouteBTaskSurfaces, task: TaskConversation) {
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
