import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCodexContextController,
  startCodexContextRuntime,
  type CodexContextRuntime,
} from "../../src/apps/desktop/codex-context-runtime";
import { toProductTaskContext } from "../../src/apps/desktop/context-task-state";
import type { ChatGptContextSummaryRoute } from "../../src/apps/desktop/chatgpt-context-summary";
import type { CodexChatGptConversation } from "../../src/apps/desktop/codex-chatgpt-provider";
import type { CheckpointContent } from "../../src/modules/chat/domain/checkpoint";
import type { ProductTaskContext } from "../../src/modules/chat/contract/product-task";
import type { ContextBinding } from "../../src/modules/chat/domain/context-continuity";
import {
  HOST_CHECKPOINT_PREFIX,
  replayHostCheckpoint,
} from "../../src/modules/chat/infra/client/host-compaction-codec";
import { PrivateContextStore } from "../../src/modules/chat/infra/repo/private-context-store";

const token = "context-runtime-test-token";
const model = "farol-next/mind" as const;
const threadId = "thread-context-runtime";
const binding: ContextBinding = {
  ownerId: "owner-preview",
  taskId: threadId,
  hostThreadId: threadId,
  sessionId: threadId,
  providerProfileId: "profile-isolated-next",
  modelId: model,
  mode: "mind",
};

const protectedFacts = {
  earlyConstraint: "Keep every change local until owner review.",
  latestCorrection: "Use report-v2.md; report-v1.md is obsolete.",
  forbiddenAction: "Never publish, push, sign, or release.",
  completedReceipt: "receipt-write-report-v2",
  unknownOperation: "external-write-unknown-7",
  artifact: "/workspace/report-v2.md",
  attachment: "attachment:image-owner-1",
} as const;

function checkpoint(cycle: number): CheckpointContent {
  return {
    goal: "Complete the context continuity acceptance safely.",
    activeConstraints: [
      protectedFacts.earlyConstraint,
      protectedFacts.forbiddenAction,
    ],
    latestCorrections: [protectedFacts.latestCorrection],
    keyDecisions: [
      "An unknown external write must be observed before another mutation.",
    ],
    completedWork: [
      {
        description: "Updated the current report artifact.",
        evidenceRefs: [protectedFacts.completedReceipt],
      },
    ],
    unfinishedWork: [`Continue ordinary epoch ${cycle + 1}.`],
    unresolvedQuestions: ["Did the unknown external write complete?"],
    unknownOutcomes: [
      {
        operationRef: protectedFacts.unknownOperation,
        description: "Submission may have happened; do not repeat it.",
      },
    ],
    artifactRefs: [
      { reference: protectedFacts.artifact, availability: "available" },
    ],
    attachmentRefs: [
      {
        reference: protectedFacts.attachment,
        availability: "unavailable",
      },
    ],
    nextSafeStep: `Observe the unknown write, then continue epoch ${cycle + 1}.`,
  };
}

function history(cycle: number, previous: readonly unknown[] = []): unknown[] {
  if (cycle > 1) {
    return [
      ...previous,
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Continue after verified epoch ${cycle - 1}.`,
          },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: `Ordinary result ${cycle - 1}.` },
        ],
      },
    ];
  }
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: protectedFacts.earlyConstraint }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: protectedFacts.forbiddenAction }],
    },
    {
      type: "function_call_output",
      call_id: "write-report-v2",
      output: protectedFacts.completedReceipt,
    },
    {
      type: "function_call_output",
      call_id: protectedFacts.unknownOperation,
      output: "outcome_unknown",
    },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `${protectedFacts.latestCorrection} Artifact ${protectedFacts.artifact}. Missing attachment ${protectedFacts.attachment}.`,
        },
      ],
    },
  ];
}

class DeterministicSummaryRoute implements ChatGptContextSummaryRoute {
  readonly prompts: string[] = [];
  resetCount = 0;
  disposeCount = 0;
  private currentUrl: string | null;

  constructor(
    private readonly content: CheckpointContent,
    conversationUrl: string,
  ) {
    this.currentUrl = conversationUrl;
  }

  async runReadonlyTask(prompt: string) {
    this.prompts.push(prompt);
    return {
      state: "completed" as const,
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(this.content).length,
      outputText: JSON.stringify(this.content),
    };
  }

  currentConversationUrl(): string | null {
    return this.currentUrl;
  }

  retainedConversationUrl(): string | null {
    return this.currentUrl;
  }

  resetConversation(): void {
    this.resetCount += 1;
    this.currentUrl = null;
  }

  dispose(): void {
    this.disposeCount += 1;
    this.currentUrl = null;
  }
}

function compactionHeaders(turnId: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: threadId,
      turn_id: turnId,
    }),
  };
}

function ordinaryBody(input: readonly unknown[], cycle: number) {
  return {
    model,
    stream: true,
    store: false,
    input: [
      ...input,
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `Continue ordinary cycle ${cycle}.` },
        ],
      },
    ],
    tools: [],
    client_metadata: {
      session_id: threadId,
      thread_id: threadId,
      turn_id: `turn-continue-${cycle}`,
      root_turn_id: `turn-continue-${cycle}`,
    },
  };
}

function assertProtectedFacts(content: CheckpointContent): void {
  expect(content.activeConstraints).toEqual(
    expect.arrayContaining([
      protectedFacts.earlyConstraint,
      protectedFacts.forbiddenAction,
    ]),
  );
  expect(content.latestCorrections).toContain(protectedFacts.latestCorrection);
  expect(content.completedWork).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        evidenceRefs: expect.arrayContaining([protectedFacts.completedReceipt]),
      }),
    ]),
  );
  expect(content.unknownOutcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operationRef: protectedFacts.unknownOperation,
      }),
    ]),
  );
  expect(content.artifactRefs).toContainEqual({
    reference: protectedFacts.artifact,
    availability: "available",
  });
  expect(content.attachmentRefs).toContainEqual({
    reference: protectedFacts.attachment,
    availability: "unavailable",
  });
  expect(content.nextSafeStep).toContain("Observe the unknown write");
}

describe("assembled Codex context runtime", () => {
  const roots: string[] = [];
  const runtimes: CodexContextRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function stateRoot(): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-context-runtime-"),
    );
    roots.push(root);
    return root;
  }

  it("composes continuity without starting the model-visible provider", async () => {
    const root = await stateRoot();
    const retained = new DeterministicSummaryRoute(
      checkpoint(1),
      "https://chatgpt.com/c/context-controller-1",
    );
    const controller = createCodexContextController({
      ownerId: binding.ownerId,
      providerProfileId: binding.providerProfileId,
      stateRoot: root,
      summaryRoutes: {
        retained: () => retained,
        createFallback: vi.fn(),
      },
    });

    const compacted = await controller.continuity.compact({
      endpoint: "responses_compact",
      body: { model, input: history(1) },
      metadataHeader: JSON.stringify({
        thread_id: binding.hostThreadId,
        turn_id: "turn-controller-compact",
      }),
    });

    expect(compacted.ok).toBe(true);
    expect(await controller.store.load(binding)).toMatchObject({
      phase: "handoff_offered",
      epoch: 1,
    });
  });

  it("keeps the current epoch and one submission when summary usage is limited", async () => {
    const root = await stateRoot();
    const retained = {
      runReadonlyTask: vi.fn(async () => ({
        state: "outcome_unknown" as const,
        code: "CHATGPT_USAGE_LIMITED" as const,
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
      })),
      currentConversationUrl: vi
        .fn()
        .mockReturnValue("https://chatgpt.com/c/context-usage-limited"),
      retainedConversationUrl: vi
        .fn()
        .mockReturnValue("https://chatgpt.com/c/context-usage-limited"),
      resetConversation: vi.fn(),
      dispose: vi.fn(),
    } satisfies ChatGptContextSummaryRoute;
    const runtime = await startCodexContextRuntime({
      ownerId: binding.ownerId,
      providerProfileId: binding.providerProfileId,
      stateRoot: root,
      model,
      token,
      conversation: { run: vi.fn() },
      summaryRoutes: {
        retained: () => retained,
        createFallback: vi.fn(),
      },
    });
    runtimes.push(runtime);
    const request = () =>
      fetch(`${runtime.provider.baseUrl}/v1/responses/compact`, {
        method: "POST",
        headers: compactionHeaders("turn-usage-limited"),
        body: JSON.stringify({ model, input: history(1) }),
      });

    const first = await request();
    expect(first.status).toBe(422);
    await expect(first.json()).resolves.toEqual({
      error: { code: "FAROL_NEXT_COMPACTION_SUMMARY_BLOCKED" },
    });
    const repeated = await request();
    expect(repeated.status).toBe(422);
    await expect(repeated.json()).resolves.toEqual({
      error: { code: "FAROL_NEXT_COMPACTION_SUMMARY_BLOCKED" },
    });

    const session = await new PrivateContextStore({ root }).load(binding);
    expect(session).toMatchObject({
      phase: "blocked",
      epoch: 1,
      blockedCode: "SUMMARY_USAGE_LIMITED",
      operation: {
        source: "retained_agent",
      },
    });
    expect(toProductTaskContext(session!)).toEqual({
      epoch: 1,
      phase: "blocked",
      source: "retained_agent",
      code: "SUMMARY_USAGE_LIMITED",
    });
    expect(retained.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(retained.resetConversation).not.toHaveBeenCalled();
    expect(retained.dispose).not.toHaveBeenCalled();
  });

  it("runs three ordinary retained compactions across restart without losing protected facts", async () => {
    const root = await stateRoot();
    const routes = [1, 2, 3, 4].map(
      (cycle) =>
        new DeterministicSummaryRoute(
          checkpoint(cycle),
          `https://chatgpt.com/c/context-cycle-${cycle}`,
        ),
    );
    let retained = routes[0]!;
    let ordinaryTurns = 0;
    const conversation: CodexChatGptConversation = {
      run: vi.fn(async (_input, observer) => {
        ordinaryTurns += 1;
        const text = `Ordinary result ${ordinaryTurns}.`;
        await observer.onTextDelta({
          sequence: 1,
          delta: text,
          text,
          observedCharacters: text.length,
        });
        retained = routes[ordinaryTurns]!;
        return {
          state: "completed" as const,
          code: null,
          outputText: text,
          observedProvider: "deterministic-local",
          observedModel: null,
          observedMode: null,
        };
      }),
    };
    const summaryRoutes = {
      retained: vi.fn(() => retained),
      createFallback: vi.fn(),
    };
    const visibleContextStates: ProductTaskContext[] = [];
    const start = () =>
      startCodexContextRuntime({
        ownerId: binding.ownerId,
        providerProfileId: binding.providerProfileId,
        stateRoot: root,
        model,
        token,
        conversation,
        summaryRoutes,
        onContextStateChanged: (session) => {
          visibleContextStates.push(toProductTaskContext(session));
        },
      });
    let runtime = await start();
    runtimes.push(runtime);
    let exactHistory = history(1);
    const operationIds = new Set<string>();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const compact = await fetch(
        `${runtime.provider.baseUrl}/v1/responses/compact`,
        {
          method: "POST",
          headers: compactionHeaders(`turn-compact-${cycle}`),
          body: JSON.stringify({ model, input: exactHistory }),
        },
      );
      expect(compact.status).toBe(200);
      const replacement = (await compact.json()) as { output: unknown[] };
      const replayed = replayHostCheckpoint(replacement.output, 256 * 1_024);
      expect(replayed.ok).toBe(true);
      if (!replayed.ok) throw new Error(replayed.error.code);
      expect(replayed.value.checkpoint).toMatchObject({
        epoch: cycle,
        source: "retained_agent",
        binding,
      });
      assertProtectedFacts(replayed.value.checkpoint.content);
      operationIds.add(replayed.value.checkpoint.operationId);

      if (cycle === 1) {
        await runtime.close();
        runtimes.splice(runtimes.indexOf(runtime), 1);
        runtime = await start();
        runtimes.push(runtime);
      }

      const continued = await fetch(
        `${runtime.provider.baseUrl}/v1/responses`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(ordinaryBody(replacement.output, cycle)),
        },
      );
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain("response.completed");
      const session = await new PrivateContextStore({ root }).load(binding);
      expect(session).toMatchObject({
        phase: "active",
        epoch: cycle + 1,
        lastCompletedOperationId: replayed.value.checkpoint.operationId,
      });
      expect(routes[cycle - 1]!.resetCount).toBe(1);
      exactHistory = history(cycle + 1, replacement.output);
    }

    expect(operationIds).toHaveLength(3);
    expect(conversation.run).toHaveBeenCalledTimes(3);
    for (const [input] of vi.mocked(conversation.run).mock.calls) {
      expect(input.prompt).toContain(protectedFacts.earlyConstraint);
      expect(input.prompt).toContain(protectedFacts.latestCorrection);
      expect(input.prompt).toContain(protectedFacts.completedReceipt);
      expect(input.prompt).toContain(protectedFacts.unknownOperation);
      expect(input.prompt).not.toContain(HOST_CHECKPOINT_PREFIX);
    }
    expect(summaryRoutes.createFallback).not.toHaveBeenCalled();
    expect(routes.slice(0, 3).map((route) => route.prompts.length)).toEqual([
      1, 1, 1,
    ]);
    for (const route of routes.slice(0, 3)) {
      expect(route.prompts[0]).toContain(
        "Execution tools are unavailable for this operation.",
      );
    }
    expect(visibleContextStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          epoch: 1,
          phase: "checkpoint_requested",
          source: "retained_agent",
        }),
        expect.objectContaining({
          epoch: 1,
          phase: "handoff_offered",
          source: "retained_agent",
        }),
        expect.objectContaining({
          epoch: 4,
          phase: "active",
          source: "retained_agent",
        }),
      ]),
    );
  });

  it("projects a trusted streamed checkpoint into the actual next model input", async () => {
    const root = await stateRoot();
    const retained = new DeterministicSummaryRoute(
      checkpoint(1),
      "https://chatgpt.com/c/context-streamed-1",
    );
    const summaryRoutes = {
      retained: vi.fn(() => retained),
      createFallback: vi.fn(),
    };
    const controller = createCodexContextController({
      ownerId: binding.ownerId,
      providerProfileId: binding.providerProfileId,
      stateRoot: root,
      summaryRoutes,
    });
    const handoff = await controller.continuity.compact({
      endpoint: "responses",
      body: {
        model,
        stream: true,
        input: [...history(1), { type: "compaction_trigger" }],
      },
      metadataHeader: JSON.stringify({
        thread_id: threadId,
        turn_id: "turn-streamed-compact",
      }),
    });
    if (!handoff.ok || handoff.value.variant !== "streamed_compaction_item") {
      throw new Error("EXPECTED_STREAMED_HANDOFF");
    }
    const conversation: CodexChatGptConversation = {
      run: vi.fn(async (_input, observer) => {
        await observer.onTextDelta({
          sequence: 1,
          delta: "Continued.",
          text: "Continued.",
          observedCharacters: 10,
        });
        return {
          state: "completed" as const,
          code: null,
          outputText: "Continued.",
          observedProvider: "deterministic-local",
          observedModel: null,
          observedMode: null,
        };
      }),
    };
    const runtime = await startCodexContextRuntime({
      ownerId: binding.ownerId,
      providerProfileId: binding.providerProfileId,
      stateRoot: root,
      model,
      token,
      conversation,
      summaryRoutes,
    });
    runtimes.push(runtime);

    const continued = await fetch(`${runtime.provider.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(ordinaryBody([handoff.value.item], 1)),
    });
    expect(continued.status).toBe(200);
    await continued.text();
    expect(conversation.run).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(conversation.run).mock.calls[0]![0].prompt;
    expect(prompt).toContain(protectedFacts.earlyConstraint);
    expect(prompt).toContain(protectedFacts.latestCorrection);
    expect(prompt).toContain(protectedFacts.completedReceipt);
    expect(prompt).toContain(protectedFacts.unknownOperation);
    expect(prompt).toContain("Continue ordinary cycle 1.");
    expect(prompt).not.toContain(HOST_CHECKPOINT_PREFIX);
  });

  it("uses one isolated canonical-history fallback only when retained context is absent", async () => {
    const root = await stateRoot();
    const fallback = new DeterministicSummaryRoute(
      checkpoint(1),
      "https://chatgpt.com/c/context-fallback-1",
    );
    const summaryRoutes = {
      retained: vi.fn().mockReturnValue(null),
      createFallback: vi.fn().mockReturnValue(fallback),
    };
    const conversation: CodexChatGptConversation = {
      run: vi.fn(async (_input, observer) => {
        await observer.onTextDelta({
          sequence: 1,
          delta: "Recovered safely.",
          text: "Recovered safely.",
          observedCharacters: 17,
        });
        return {
          state: "completed" as const,
          code: null,
          outputText: "Recovered safely.",
          observedProvider: "deterministic-local",
          observedModel: null,
          observedMode: null,
        };
      }),
    };
    const runtime = await startCodexContextRuntime({
      ownerId: binding.ownerId,
      providerProfileId: binding.providerProfileId,
      stateRoot: root,
      model,
      token,
      conversation,
      summaryRoutes,
    });
    runtimes.push(runtime);
    const exactHistory = history(1);

    const compact = await fetch(
      `${runtime.provider.baseUrl}/v1/responses/compact`,
      {
        method: "POST",
        headers: compactionHeaders("turn-fallback-compact"),
        body: JSON.stringify({ model, input: exactHistory }),
      },
    );
    expect(compact.status).toBe(200);
    const replacement = (await compact.json()) as { output: unknown[] };
    const replayed = replayHostCheckpoint(replacement.output, 256 * 1_024);
    if (!replayed.ok) throw new Error(replayed.error.code);
    expect(replayed.value.checkpoint.source).toBe("canonical_history");
    assertProtectedFacts(replayed.value.checkpoint.content);
    expect(summaryRoutes.createFallback).toHaveBeenCalledTimes(1);
    expect(fallback.prompts).toHaveLength(1);
    expect(fallback.prompts[0]).toContain(JSON.stringify(exactHistory));

    const continued = await fetch(`${runtime.provider.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(ordinaryBody(replacement.output, 1)),
    });
    expect(continued.status).toBe(200);
    await continued.text();
    expect(fallback.disposeCount).toBe(1);
    expect(fallback.resetCount).toBe(0);
  });
});
