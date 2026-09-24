import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ChatGptContextSummaryDriver,
  type ChatGptContextSummaryRoute,
} from "../../src/apps/desktop/chatgpt-context-summary";
import type { ChatGptReadonlyTaskResult } from "../../src/apps/desktop/chatgpt-route";
import type { ContextSummaryRequest } from "../../src/modules/chat/app/port/context-summarizer";
import type { CheckpointContent } from "../../src/modules/chat/domain/checkpoint";
import type { ContextBinding } from "../../src/modules/chat/domain/context-continuity";
import {
  PrivateContextStore,
  type StoredContextSource,
} from "../../src/modules/chat/infra/repo/private-context-store";

const binding: ContextBinding = {
  ownerId: "owner-preview",
  taskId: "thread-context-1",
  hostThreadId: "thread-context-1",
  sessionId: "thread-context-1",
  providerProfileId: "profile-isolated-next",
  modelId: "farol-next/mind",
  mode: "mind",
};

const content: CheckpointContent = {
  goal: "Finish Farol Next safely.",
  activeConstraints: ["Do not publish."],
  latestCorrections: ["Use the corrected workspace."],
  keyDecisions: ["Preserve outcome unknown."],
  completedWork: [
    { description: "Read completed.", evidenceRefs: ["receipt-read-1"] },
  ],
  unfinishedWork: ["Continue the next safe step."],
  unresolvedQuestions: ["Did write-17 finish?"],
  unknownOutcomes: [
    { operationRef: "write-17", description: "Result was not observed." },
  ],
  artifactRefs: [{ reference: "vnext/README.md", availability: "available" }],
  attachmentRefs: [
    { reference: "attachment-owner-1", availability: "unavailable" },
  ],
  nextSafeStep: "Observe write-17 before another mutation.",
};

const request: ContextSummaryRequest = {
  binding,
  epoch: 1,
  operationId: "compact-context-1",
  source: "retained_agent",
  sourceBoundary: "sha256:source-1",
  parentCheckpointId: null,
  capability: { kind: "checkpoint_return", operationId: "compact-context-1" },
  executionTools: [],
};

function source(
  selected: StoredContextSource["source"] = "retained_agent",
): StoredContextSource {
  return {
    schemaVersion: 1,
    operationId: request.operationId,
    binding,
    source: selected,
    sourceBoundary: request.sourceBoundary,
    variant: "unary_replacement_history",
    history: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Never publish." }],
      },
      {
        type: "function_call_output",
        call_id: "receipt-read-1",
        output: "read",
      },
      {
        type: "function_call_output",
        call_id: "write-17",
        output: "unknown",
      },
    ],
  };
}

function route(
  result: ChatGptReadonlyTaskResult,
  retainedConversationUrl = "https://chatgpt.com/c/summary-context-1",
): ChatGptContextSummaryRoute & {
  runReadonlyTask: ReturnType<typeof vi.fn>;
  currentConversationUrl: ReturnType<typeof vi.fn>;
  retainedConversationUrl: ReturnType<typeof vi.fn>;
  resetConversation: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    runReadonlyTask: vi.fn(async () => result),
    currentConversationUrl: vi
      .fn()
      .mockReturnValue("https://chatgpt.com/c/summary-context-1"),
    retainedConversationUrl: vi.fn().mockReturnValue(retainedConversationUrl),
    resetConversation: vi.fn((): void => undefined),
    dispose: vi.fn((): void => undefined),
  };
}

describe("ChatGPT summary-only context driver", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function storeRoot(): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-summary-driver-"),
    );
    roots.push(root);
    return root;
  }

  async function store(): Promise<PrivateContextStore> {
    return new PrivateContextStore({ root: await storeRoot() });
  }

  it("uses the retained route with no tools and observes its durable result after restart", async () => {
    const state = await store();
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 2,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const routes = {
      retained: vi.fn().mockReturnValue(retained),
      createFallback: vi.fn(),
    };
    const first = new ChatGptContextSummaryDriver({ store: state, routes });

    await expect(
      first.selectSource({
        binding,
        variant: "unary_replacement_history",
        history: source().history,
      }),
    ).resolves.toBe("retained_agent");
    await expect(first.request({ request, source: source() })).resolves.toEqual(
      {
        status: "completed",
        providerOperationId: expect.stringMatching(/^summary-[a-f0-9]{40}$/u),
        sourceCursor: expect.stringMatching(/^conversation:[a-f0-9]{64}$/u),
        content,
        summarizer: {
          engine: "current_chatgpt",
          provider: "chatgpt-web",
          observedModel: null,
          observedEffort: null,
          providerOperationId: expect.stringMatching(/^summary-[a-f0-9]{40}$/u),
          sourceBoundary: source().sourceBoundary,
          sourceCursor: expect.stringMatching(/^conversation:[a-f0-9]{64}$/u),
        },
      },
    );
    expect(retained.runReadonlyTask).toHaveBeenCalledTimes(1);
    const prompt = retained.runReadonlyTask.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Execution tools are unavailable");
    expect(prompt).toContain(JSON.stringify(source().history));
    expect(routes.createFallback).not.toHaveBeenCalled();

    const restarted = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => null, createFallback: vi.fn() },
    });
    await expect(
      restarted.observe({ request, source: source() }),
    ).resolves.toEqual({
      status: "completed",
      providerOperationId: expect.stringMatching(/^summary-[a-f0-9]{40}$/u),
      sourceCursor: expect.stringMatching(/^conversation:[a-f0-9]{64}$/u),
      content,
      summarizer: {
        engine: "current_chatgpt",
        provider: "chatgpt-web",
        observedModel: null,
        observedEffort: null,
        providerOperationId: expect.stringMatching(/^summary-[a-f0-9]{40}$/u),
        sourceBoundary: source().sourceBoundary,
        sourceCursor: expect.stringMatching(/^conversation:[a-f0-9]{64}$/u),
      },
    });
    expect(retained.runReadonlyTask).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the retained route shows another conversation by the time of dispatch", async () => {
    const state = await store();
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 2,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    // Prepared from the retained conversation; the owner's live surface then
    // moves to a newer one before the prompt would be typed.
    retained.currentConversationUrl
      .mockReturnValueOnce("https://chatgpt.com/c/summary-context-1")
      .mockReturnValue("https://chatgpt.com/c/newer-conversation");
    const driver = new ChatGptContextSummaryDriver({
      store: state,
      routes: {
        retained: vi.fn().mockReturnValue(retained),
        createFallback: vi.fn(),
      },
    });

    await expect(
      driver.request({ request, source: source() }),
    ).resolves.toEqual({
      status: "not_submitted",
      code: "SUMMARY_SOURCE_MOVED",
    });
    expect(retained.runReadonlyTask).not.toHaveBeenCalled();
    await expect(
      state.getSummaryAttempt(request.binding, request.operationId),
    ).resolves.toBeNull();
  });

  it("CC-15/CC-03 raises the execution fence before the retained summary is submitted, keeps it up while the outcome is unknown, and lowers it once the turn is over", async () => {
    const state = await store();
    const events: string[] = [];
    const fence = {
      raise: vi.fn(async (input: { operationId: string }) => {
        events.push(`raise:${input.operationId}`);
      }),
      lower: vi.fn(async (input: { operationId: string }) => {
        events.push(`lower:${input.operationId}`);
      }),
    };
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    retained.runReadonlyTask.mockImplementation(async () => {
      events.push("submit");
      return {
        state: "completed",
        code: null,
        deltaCount: 1,
        observedCharacters: JSON.stringify(content).length,
        outputText: JSON.stringify(content),
      };
    });
    const driver = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
      fence,
    });
    await expect(
      driver.request({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(events).toEqual([
      "raise:compact-context-1",
      "submit",
      "lower:compact-context-1",
    ]);

    // An unknown outcome may still be summarizing on the page: the fence
    // stays up until the turn is observed to be over.
    const unknownState = await store();
    const unknown = route({
      state: "outcome_unknown",
      code: "CHATGPT_PAGE_UNREACHABLE",
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
      turnUserId: "user-message-1",
      turnAssistantId: null,
    });
    const unknownEvents: string[] = [];
    const unknownFence = {
      raise: vi.fn(async () => {
        unknownEvents.push("raise");
      }),
      lower: vi.fn(async () => {
        unknownEvents.push("lower");
      }),
    };
    const unknownDriver = new ChatGptContextSummaryDriver({
      store: unknownState,
      routes: { retained: () => unknown, createFallback: vi.fn() },
      fence: unknownFence,
    });
    await expect(
      unknownDriver.request({ request, source: source() }),
    ).resolves.toMatchObject({ status: "outcome_unknown" });
    expect(unknownEvents).toEqual(["raise"]);

    // A fence that cannot be raised blocks the summary before anything is
    // submitted; nothing is left dispatched.
    const blockedState = await store();
    const blockedRoute = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const blockedDriver = new ChatGptContextSummaryDriver({
      store: blockedState,
      routes: { retained: () => blockedRoute, createFallback: vi.fn() },
      fence: {
        raise: async () => {
          throw new Error("EACCES");
        },
        lower: async () => undefined,
      },
    });
    await expect(
      blockedDriver.request({ request, source: source() }),
    ).resolves.toEqual({
      status: "blocked",
      code: "SUMMARY_FENCE_UNAVAILABLE",
    });
    expect(blockedRoute.runReadonlyTask).not.toHaveBeenCalled();
    await expect(
      blockedState.getSummaryAttempt(binding, request.operationId),
    ).resolves.toBeNull();
  });

  it("CC-03/CC-05 carries the exact bound history into the retained summary, and a page that cannot submit is classified rather than replaced by a fallback", async () => {
    const state = await store();
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const routes = { retained: () => retained, createFallback: vi.fn() };
    const driver = new ChatGptContextSummaryDriver({ store: state, routes });
    // A turn the retained conversation never saw is still summarized: the
    // canonical history to the boundary travels with the request.
    const unseen = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Unseen suffix: keep the draft." }],
    };
    const bound = {
      ...source(),
      history: [...source().history, unseen],
    };
    await expect(
      driver.request({ request, source: bound }),
    ).resolves.toMatchObject({ status: "completed" });
    const prompt = retained.runReadonlyTask.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Unseen suffix: keep the draft.");
    expect(prompt).toContain(`"sourceBoundary":"${request.sourceBoundary}"`);
    expect(routes.createFallback).not.toHaveBeenCalled();

    // The retained page exists but cannot submit: not a missing source.
    const signedOut = route({
      state: "not_authenticated",
      code: "CHATGPT_SIGN_IN_REQUIRED",
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    const signedOutRoutes = {
      retained: () => signedOut,
      createFallback: vi.fn(),
    };
    const signedOutDriver = new ChatGptContextSummaryDriver({
      store: await store(),
      routes: signedOutRoutes,
    });
    await expect(
      signedOutDriver.selectSource({
        binding,
        variant: "unary_replacement_history",
        history: source().history,
      }),
    ).resolves.toBe("retained_agent");
    await expect(
      signedOutDriver.request({ request, source: source() }),
    ).resolves.toEqual({
      status: "not_submitted",
      code: "SUMMARY_SIGN_IN_REQUIRED",
    });
    expect(signedOutRoutes.createFallback).not.toHaveBeenCalled();
  });

  it("selects a persisted retained conversation before its surface reopens", async () => {
    const state = await store();
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    retained.currentConversationUrl.mockReturnValue(null);
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });

    await expect(
      summary.selectSource({
        binding,
        variant: "unary_replacement_history",
        history: source().history,
      }),
    ).resolves.toBe("retained_agent");
  });

  it("uses and retires an isolated fallback only when retained context is missing", async () => {
    const state = await store();
    const fallback = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const routes = {
      retained: vi.fn().mockReturnValue(null),
      createFallback: vi.fn().mockReturnValue(fallback),
    };
    const selectedSource = source("canonical_history");
    const selectedRequest = {
      ...request,
      source: "canonical_history" as const,
    };
    const summary = new ChatGptContextSummaryDriver({ store: state, routes });

    await expect(
      summary.selectSource({
        binding,
        variant: selectedSource.variant,
        history: selectedSource.history,
      }),
    ).resolves.toBe("canonical_history");
    await expect(
      summary.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "completed", content });
    expect(routes.createFallback).toHaveBeenCalledWith(binding);
    expect(fallback.runReadonlyTask).toHaveBeenCalledTimes(1);

    await expect(
      summary.retire({
        binding,
        epoch: 1,
        operationId: request.operationId,
        source: selectedSource,
      }),
    ).resolves.toEqual({ status: "retired" });
    expect(fallback.dispose).toHaveBeenCalledTimes(1);
    expect(fallback.resetConversation).not.toHaveBeenCalled();
  });

  // A12: an isolated fallback belongs to its operation alone. Once the source
  // is proven it is released whatever it shows by then, a failed release is
  // retried without a second summary, and a route the operation does not own
  // is never disposed.
  async function fallbackSummarized(state: PrivateContextStore) {
    const fallback = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: {
        retained: () => retained,
        createFallback: vi.fn().mockReturnValue(fallback),
      },
    });
    const selectedSource = source("canonical_history");
    await expect(
      summary.request({
        request: { ...request, source: "canonical_history" },
        source: selectedSource,
      }),
    ).resolves.toMatchObject({ status: "completed", content });
    const retire = () =>
      summary.retire({
        binding,
        epoch: 1,
        operationId: request.operationId,
        source: selectedSource,
      });
    return { fallback, retained, retire };
  }

  it("A12 releases an owned fallback that shows no conversation once its source is proven", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-summary-driver-"),
    );
    roots.push(root);
    let fallbackUrls: ReturnType<typeof vi.fn>[] = [];
    class ClearingStore extends PrivateContextStore {
      override async putRetirement(
        candidate: Parameters<PrivateContextStore["putRetirement"]>[0],
      ): Promise<void> {
        await super.putRetirement(candidate);
        // The fallback page leaves its conversation while the retirement is
        // recorded: nothing is left to detach, but the lease is still owned.
        for (const url of fallbackUrls) url.mockReturnValue(null);
      }
    }
    const { fallback, retained, retire } = await fallbackSummarized(
      new ClearingStore({ root }),
    );
    fallbackUrls = [
      fallback.currentConversationUrl,
      fallback.retainedConversationUrl,
    ];

    await expect(retire()).resolves.toEqual({ status: "retired" });
    expect(fallback.dispose).toHaveBeenCalledTimes(1);
    expect(fallback.resetConversation).not.toHaveBeenCalled();
    expect(retained.dispose).not.toHaveBeenCalled();
    expect(retained.resetConversation).not.toHaveBeenCalled();
  });

  it("A12 retries a failed release of an owned fallback without a second summary", async () => {
    const { fallback, retained, retire } = await fallbackSummarized(
      await store(),
    );
    fallback.dispose.mockImplementationOnce(() => {
      throw new Error("SYNTHETIC_DISPOSE_FAILURE");
    });

    await expect(retire()).resolves.toEqual({
      status: "outcome_unknown",
      code: "SOURCE_RETIREMENT_UNKNOWN",
    });
    await expect(retire()).resolves.toEqual({ status: "retired" });
    expect(fallback.dispose).toHaveBeenCalledTimes(2);
    expect(fallback.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(fallback.resetConversation).not.toHaveBeenCalled();
    expect(retained.dispose).not.toHaveBeenCalled();
  });

  it("A12 never disposes a retained route the operation does not own", async () => {
    const state = await store();
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });
    await expect(
      summary.request({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed" });

    await expect(
      summary.retire({
        binding,
        epoch: 1,
        operationId: request.operationId,
        source: source(),
      }),
    ).resolves.toEqual({ status: "retired" });
    expect(retained.resetConversation).toHaveBeenCalledTimes(1);
    expect(retained.dispose).not.toHaveBeenCalled();
  });

  it("does not retire a newer retained conversation after restart", async () => {
    const state = await store();
    const original = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const first = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => original, createFallback: vi.fn() },
    });
    await expect(
      first.request({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed" });

    const newer = route(
      {
        state: "completed",
        code: null,
        deltaCount: 0,
        observedCharacters: 0,
        outputText: JSON.stringify(content),
      },
      "https://chatgpt.com/c/newer-task-conversation",
    );
    newer.currentConversationUrl.mockReturnValue(
      "https://chatgpt.com/c/newer-task-conversation",
    );
    const restarted = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => newer, createFallback: vi.fn() },
    });

    await expect(
      restarted.retire({
        binding,
        epoch: 1,
        operationId: request.operationId,
        source: source(),
      }),
    ).resolves.toEqual({
      status: "blocked",
      code: "SOURCE_RETIREMENT_SUPERSEDED",
    });
    expect(newer.resetConversation).not.toHaveBeenCalled();
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.not.toBeNull();
  });

  it("retires the exact retained conversation after restart", async () => {
    const state = await store();
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const routes = { retained: () => retained, createFallback: vi.fn() };
    const first = new ChatGptContextSummaryDriver({ store: state, routes });
    await expect(
      first.request({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed" });

    const restarted = new ChatGptContextSummaryDriver({ store: state, routes });
    await expect(
      restarted.retire({
        binding,
        epoch: 1,
        operationId: request.operationId,
        source: source(),
      }),
    ).resolves.toEqual({ status: "retired" });
    expect(retained.resetConversation).toHaveBeenCalledTimes(1);
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toBeNull();
  });

  it("does not resubmit when browser completion is unknown", async () => {
    const state = await store();
    const retained = route({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_TIMEOUT",
      deltaCount: 1,
      observedCharacters: 12,
      outputText: "partial json",
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });

    await expect(
      summary.request({ request, source: source() }),
    ).resolves.toEqual({
      status: "outcome_unknown",
      code: "SUMMARY_SUBMISSION_UNRESOLVED",
    });
    await expect(
      summary.observe({ request, source: source() }),
    ).resolves.toEqual({
      status: "outcome_unknown",
      code: "SUMMARY_SUBMISSION_UNRESOLVED",
    });
    expect(retained.runReadonlyTask).toHaveBeenCalledTimes(1);
  });

  it("observes a late reply for the same correlated summary without resubmitting", async () => {
    const state = await store();
    const retained = Object.assign(
      route({
        state: "outcome_unknown",
        code: "CHATGPT_TASK_TIMEOUT",
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
        turnUserId: "summary-user-1",
        turnAssistantId: null,
      }),
      {
        observeReadonlyTask: vi.fn(async () => ({
          state: "completed" as const,
          code: null,
          deltaCount: 1,
          observedCharacters: JSON.stringify(content).length,
          outputText: JSON.stringify(content),
          turnUserId: "summary-user-1",
          turnAssistantId: "summary-assistant-1",
        })),
      },
    );
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });

    await expect(
      summary.request({ request, source: source() }),
    ).resolves.toMatchObject({ status: "outcome_unknown" });
    await expect(
      summary.observe({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed", content });
    expect(retained.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(retained.observeReadonlyTask).toHaveBeenCalledTimes(1);
  });

  it("keeps a post-send usage limit outcome unknown and retains its fallback", async () => {
    const state = await store();
    const fallback = route({
      state: "outcome_unknown",
      code: "CHATGPT_USAGE_LIMITED",
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: {
        retained: () => null,
        createFallback: vi.fn().mockReturnValue(fallback),
      },
    });
    const selectedSource = source("canonical_history");
    const selectedRequest = {
      ...request,
      source: "canonical_history" as const,
    };

    await expect(
      summary.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toEqual({
      status: "outcome_unknown",
      code: "SUMMARY_USAGE_LIMITED_AFTER_SEND",
    });
    expect(fallback.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(fallback.dispose).not.toHaveBeenCalled();
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toBeNull();
  });

  it("recovers a prepared-only attempt as definitely not submitted", async () => {
    const state = await store();
    const retained = route({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    retained.runReadonlyTask.mockRejectedValueOnce(
      new Error("synthetic crash before dispatch intent"),
    );
    const first = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });

    await expect(first.request({ request, source: source() })).resolves.toEqual(
      {
        status: "outcome_unknown",
        code: "SUMMARY_SUBMISSION_UNRESOLVED",
      },
    );
    await expect(
      state.getSummaryAttempt(binding, request.operationId),
    ).resolves.toMatchObject({ phase: "prepared" });

    const restarted = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });
    await expect(
      restarted.observe({ request, source: source() }),
    ).resolves.toEqual({
      status: "not_submitted",
      code: "SUMMARY_NOT_SUBMITTED",
    });
    expect(retained.runReadonlyTask).toHaveBeenCalledTimes(1);
  });

  it("preserves a possible-send attempt across restart without another submission", async () => {
    const state = await store();
    const fallback = route({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    fallback.runReadonlyTask.mockImplementationOnce(
      async (_prompt, _attachments, observer) => {
        await observer?.onDispatchIntent?.();
        throw new Error("synthetic crash after dispatch intent");
      },
    );
    const createFallback = vi.fn().mockReturnValue(fallback);
    const selectedSource = source("canonical_history");
    const selectedRequest = {
      ...request,
      source: "canonical_history" as const,
    };
    const first = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => null, createFallback },
    });

    await expect(
      first.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "outcome_unknown" });
    await expect(
      state.getSummaryAttempt(binding, request.operationId),
    ).resolves.toMatchObject({ phase: "possible_send" });

    const restartedCreate = vi.fn();
    const restarted = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => null, createFallback: restartedCreate },
    });
    await expect(
      restarted.observe({ request: selectedRequest, source: selectedSource }),
    ).resolves.toEqual({
      status: "outcome_unknown",
      code: "SUMMARY_SUBMISSION_UNRESOLVED",
    });
    expect(fallback.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(restartedCreate).not.toHaveBeenCalled();
  });

  it("recovers and observes one correlated fallback attempt after restart", async () => {
    const state = await store();
    const fallback = route({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_TIMEOUT",
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    fallback.runReadonlyTask.mockImplementationOnce(
      async (_prompt, _attachments, observer) => {
        await observer?.onDispatchIntent?.();
        await observer?.onCorrelation?.({
          turnUserId: "summary-user-restart",
          turnAssistantId: null,
        });
        return {
          state: "outcome_unknown",
          code: "CHATGPT_TASK_TIMEOUT",
          deltaCount: 0,
          observedCharacters: 0,
          outputText: "",
          turnUserId: "summary-user-restart",
          turnAssistantId: null,
        };
      },
    );
    const selectedSource = source("canonical_history");
    const selectedRequest = {
      ...request,
      source: "canonical_history" as const,
    };
    const first = new ChatGptContextSummaryDriver({
      store: state,
      routes: {
        retained: () => null,
        createFallback: vi.fn().mockReturnValue(fallback),
      },
    });
    await expect(
      first.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "outcome_unknown" });

    const recovered = Object.assign(
      route({
        state: "completed",
        code: null,
        deltaCount: 1,
        observedCharacters: JSON.stringify(content).length,
        outputText: JSON.stringify(content),
      }),
      {
        observeReadonlyTask: vi.fn(async () => ({
          state: "completed" as const,
          code: null,
          deltaCount: 1,
          observedCharacters: JSON.stringify(content).length,
          outputText: JSON.stringify(content),
          turnUserId: "summary-user-restart",
          turnAssistantId: "summary-assistant-restart",
        })),
      },
    );
    const recoverFallback = vi.fn().mockReturnValue(recovered);
    const restarted = new ChatGptContextSummaryDriver({
      store: state,
      routes: {
        retained: () => null,
        createFallback: vi.fn(),
        recoverFallback,
      },
    });

    await expect(
      restarted.observe({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "completed", content });
    expect(fallback.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(recovered.observeReadonlyTask).toHaveBeenCalledTimes(1);
    expect(recoverFallback).toHaveBeenCalledWith(
      binding,
      "https://chatgpt.com/c/summary-context-1",
    );
  });

  it("observes an unresolved fallback operation instead of dispatching it twice", async () => {
    const state = await store();
    const fallback = route({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_TIMEOUT",
      deltaCount: 1,
      observedCharacters: 12,
      outputText: "partial json",
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: {
        retained: () => null,
        createFallback: vi.fn().mockReturnValue(fallback),
      },
    });
    const selectedSource = source("canonical_history");
    const selectedRequest = {
      ...request,
      source: "canonical_history" as const,
    };

    await expect(
      summary.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "outcome_unknown" });
    await expect(
      summary.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "outcome_unknown" });
    expect(fallback.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(fallback.dispose).not.toHaveBeenCalled();
    expect(fallback.resetConversation).not.toHaveBeenCalled();
  });

  it("retains a received fallback result and retries only local persistence", async () => {
    const state = await store();
    const putSummary = vi
      .spyOn(state, "putSummary")
      .mockRejectedValueOnce(new Error("synthetic summary store failure"));
    const fallback = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(content).length,
      outputText: JSON.stringify(content),
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: {
        retained: () => null,
        createFallback: vi.fn().mockReturnValue(fallback),
      },
    });
    const selectedSource = source("canonical_history");
    const selectedRequest = {
      ...request,
      source: "canonical_history" as const,
    };

    await expect(
      summary.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "completed", content });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toBeNull();
    expect(fallback.dispose).not.toHaveBeenCalled();

    await expect(
      summary.observe({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "completed", content });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toMatchObject({ content });
    expect(putSummary).toHaveBeenCalledTimes(2);
    expect(fallback.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(fallback.dispose).not.toHaveBeenCalled();
  });

  it("F2-2 recovers a completed retained result across a real restart after a publication failure, without a second submission", async () => {
    const root = await storeRoot();
    const state = new PrivateContextStore({ root });
    const putSummary = vi
      .spyOn(state, "putSummary")
      .mockRejectedValueOnce(new Error("synthetic summary store failure"));
    const retained = route({
      state: "outcome_unknown",
      code: null,
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    retained.runReadonlyTask.mockImplementationOnce(
      async (_prompt, _attachments, observer) => {
        await observer?.onDispatchIntent?.();
        await observer?.onCorrelation?.({
          turnUserId: "summary-user-pub-fail",
          turnAssistantId: "summary-assistant-pub-fail",
        });
        return {
          state: "completed",
          code: null,
          deltaCount: 1,
          observedCharacters: JSON.stringify(content).length,
          outputText: JSON.stringify(content),
          turnUserId: "summary-user-pub-fail",
          turnAssistantId: "summary-assistant-pub-fail",
        };
      },
    );
    const first = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });

    await expect(
      first.request({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed", content });
    expect(putSummary).toHaveBeenCalledTimes(1);
    // The publication failed: nothing durable proves the summary exists yet,
    // and the correlated attempt is still the only record of what happened.
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toBeNull();
    await expect(
      state.getSummaryAttempt(binding, request.operationId),
    ).resolves.toMatchObject({
      phase: "possible_send",
      turnUserId: "summary-user-pub-fail",
      turnAssistantId: "summary-assistant-pub-fail",
    });

    // A real restart: a fresh driver instance, a fresh route instance (the
    // app reconnected to the same retained conversation) and a fresh store
    // instance over the same on-disk root. Nothing here is the same
    // in-memory object as `first`, so the recovery below can only come from
    // what the first instance left on disk.
    const restartedState = new PrivateContextStore({ root });
    const restartedPutSummary = vi.spyOn(restartedState, "putSummary");
    const recovered = Object.assign(
      route({
        state: "outcome_unknown",
        code: null,
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
      }),
      {
        observeReadonlyTask: vi.fn(async () => ({
          state: "completed" as const,
          code: null,
          deltaCount: 1,
          observedCharacters: JSON.stringify(content).length,
          outputText: JSON.stringify(content),
          turnUserId: "summary-user-pub-fail",
          turnAssistantId: "summary-assistant-pub-fail",
        })),
      },
    );
    const restarted = new ChatGptContextSummaryDriver({
      store: restartedState,
      routes: {
        retained: vi.fn().mockReturnValue(recovered),
        createFallback: vi.fn(),
      },
    });

    await expect(
      restarted.observe({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed", content });
    expect(recovered.runReadonlyTask).not.toHaveBeenCalled();
    expect(recovered.observeReadonlyTask).toHaveBeenCalledTimes(1);
    // The first instance never published again; the restarted one
    // published exactly once, from what it observed.
    expect(putSummary).toHaveBeenCalledTimes(1);
    expect(restartedPutSummary).toHaveBeenCalledTimes(1);
    await expect(
      restartedState.getSummary(binding, request.operationId),
    ).resolves.toMatchObject({ content });
    await expect(
      restartedState.getSummaryAttempt(binding, request.operationId),
    ).resolves.toBeNull();

    // A second restart is idempotent: the durable summary answers directly,
    // with no route work and no further publication at all.
    const secondState = new PrivateContextStore({ root });
    const secondPutSummary = vi.spyOn(secondState, "putSummary");
    const secondRestartRetained = vi.fn();
    const secondRestart = new ChatGptContextSummaryDriver({
      store: secondState,
      routes: {
        retained: secondRestartRetained,
        createFallback: vi.fn(),
      },
    });
    await expect(
      secondRestart.observe({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed", content });
    expect(secondRestartRetained).not.toHaveBeenCalled();
    expect(secondPutSummary).not.toHaveBeenCalled();
    expect(putSummary).toHaveBeenCalledTimes(1);
    expect(restartedPutSummary).toHaveBeenCalledTimes(1);
  });

  it("releases a definitely unsubmitted fallback before a clean later attempt", async () => {
    const state = await store();
    const first = route({
      state: "failed_before_submit",
      code: "CHATGPT_SUBMIT_UNAVAILABLE",
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    const second = route({
      state: "failed_before_submit",
      code: "CHATGPT_SUBMIT_UNAVAILABLE",
      deltaCount: 0,
      observedCharacters: 0,
      outputText: "",
    });
    const createFallback = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => null, createFallback },
    });
    const selectedSource = source("canonical_history");
    const selectedRequest = {
      ...request,
      source: "canonical_history" as const,
    };

    await expect(
      summary.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "not_submitted" });
    await expect(
      summary.request({ request: selectedRequest, source: selectedSource }),
    ).resolves.toMatchObject({ status: "not_submitted" });
    expect(createFallback).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed summary output without replacing durable context", async () => {
    const state = await store();
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: 2,
      outputText: "{}",
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });

    await expect(
      summary.request({ request, source: source() }),
    ).resolves.toEqual({
      status: "blocked",
      code: "CHECKPOINT_CONTENT_INVALID",
    });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toBeNull();
  });

  it("CCR-10 repairs a summary that drops an unknown effect or fabricates a receipt", async () => {
    const state = await store();
    const history = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Never publish." }],
      },
      {
        type: "function_call",
        call_id: "read-1",
        name: "exec_command",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "read-1", output: "done" },
      {
        type: "function_call",
        call_id: "write-17",
        name: "apply_patch",
        arguments: "{}",
      },
    ];
    const mutated: CheckpointContent = {
      ...content,
      completedWork: [
        { description: "Read completed.", evidenceRefs: ["read-1"] },
        { description: "Published the release.", evidenceRefs: ["publish-99"] },
      ],
      unresolvedQuestions: [],
      // The model forgot the write whose result never arrived.
      unknownOutcomes: [],
    };
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(mutated).length,
      outputText: JSON.stringify(mutated),
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });

    const receipt = await summary.request({
      request,
      source: { ...source(), history },
    });

    expect(receipt).toMatchObject({
      status: "completed",
      content: {
        completedWork: [
          { description: "Read completed.", evidenceRefs: ["read-1"] },
        ],
        unresolvedQuestions: [
          "Unverified, no receipt exists: Published the release.",
        ],
        unknownOutcomes: [
          {
            operationRef: "write-17",
            description:
              "apply_patch was called but no result was delivered before compaction.",
          },
        ],
      },
    });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toMatchObject({
      content: { unknownOutcomes: [{ operationRef: "write-17" }] },
    });
  });

  it("keeps attachment references but never treats model text as byte availability", async () => {
    const state = await store();
    const claimedAvailable: CheckpointContent = {
      ...content,
      attachmentRefs: content.attachmentRefs.map((attachment) => ({
        ...attachment,
        availability: "available" as const,
      })),
    };
    const retained = route({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: JSON.stringify(claimedAvailable).length,
      outputText: JSON.stringify(claimedAvailable),
    });
    const summary = new ChatGptContextSummaryDriver({
      store: state,
      routes: { retained: () => retained, createFallback: vi.fn() },
    });

    await expect(
      summary.request({ request, source: source() }),
    ).resolves.toMatchObject({
      status: "completed",
      content: {
        attachmentRefs: [
          { reference: "attachment-owner-1", availability: "unavailable" },
        ],
      },
    });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toMatchObject({
      content: {
        attachmentRefs: [
          { reference: "attachment-owner-1", availability: "unavailable" },
        ],
      },
    });
  });
});

// HR-014/F1: retiring a retained source must survive a local fault behind the
// reset that cleared the route's URL, and a restart, without resetting a
// newer conversation, without a second summary, and without ever taking a
// null URL on its own as proof that a retirement happened.
class FaultyContextStore extends PrivateContextStore {
  private readonly faults = new Map<string, number>();

  failOnce(name: "deleteSummary" | "deleteSummaryAttempt"): void {
    this.faults.set(name, (this.faults.get(name) ?? 0) + 1);
  }

  private take(name: string): boolean {
    const remaining = this.faults.get(name) ?? 0;
    if (remaining < 1) return false;
    this.faults.set(name, remaining - 1);
    return true;
  }

  override async deleteSummary(
    target: ContextBinding,
    operationId: string,
  ): Promise<void> {
    if (this.take("deleteSummary")) throw new Error("SYNTHETIC_UNLINK_FAILURE");
    return super.deleteSummary(target, operationId);
  }

  override async deleteSummaryAttempt(
    target: ContextBinding,
    operationId: string,
  ): Promise<void> {
    if (this.take("deleteSummaryAttempt")) {
      throw new Error("SYNTHETIC_UNLINK_FAILURE");
    }
    return super.deleteSummaryAttempt(target, operationId);
  }
}

// A route whose reset does what production's does to its identity: it points
// the route at the home page and publishes no conversation, so neither URL
// getter names the retired conversation afterwards.
function statefulRoute(
  conversationUrl: string | null = "https://chatgpt.com/c/summary-context-1",
) {
  const page = { url: conversationUrl, resets: 0, submissions: 0 };
  const route: ChatGptContextSummaryRoute = {
    runReadonlyTask: async (): Promise<ChatGptReadonlyTaskResult> => {
      page.submissions += 1;
      return {
        state: "completed",
        code: null,
        deltaCount: 1,
        observedCharacters: JSON.stringify(content).length,
        outputText: JSON.stringify(content),
      };
    },
    currentConversationUrl: () => page.url,
    retainedConversationUrl: () => page.url,
    resetConversation: () => {
      page.resets += 1;
      page.url = null;
    },
    dispose: () => undefined,
  };
  return { route, page };
}

describe("HR-014/F1 retained-source retirement recovery", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function stateRoot(): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-summary-retire-"),
    );
    roots.push(root);
    return root;
  }

  const retirement = () => ({
    binding,
    epoch: 1,
    operationId: request.operationId,
    source: source(),
  });

  function driverFor(
    state: PrivateContextStore,
    route: ChatGptContextSummaryRoute | null,
  ): ChatGptContextSummaryDriver {
    return new ChatGptContextSummaryDriver({
      store: state,
      routes: {
        retained: () => route,
        createFallback: () => {
          throw new Error("FALLBACK_FORBIDDEN");
        },
      },
    });
  }

  async function summarized(
    state: PrivateContextStore,
    route: ChatGptContextSummaryRoute,
  ): Promise<ChatGptContextSummaryDriver> {
    const driver = driverFor(state, route);
    await expect(
      driver.request({ request, source: source() }),
    ).resolves.toMatchObject({ status: "completed" });
    return driver;
  }

  async function cleanedUp(state: PrivateContextStore): Promise<void> {
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toBeNull();
    await expect(
      state.getSummaryAttempt(binding, request.operationId),
    ).resolves.toBeNull();
  }

  it("HR-014 R1 retires the exact retained conversation once through a reset that clears its URL", async () => {
    const state = new FaultyContextStore({ root: await stateRoot() });
    const { route, page } = statefulRoute();
    const driver = await summarized(state, route);

    await expect(driver.retire(retirement())).resolves.toEqual({
      status: "retired",
    });
    expect(page).toEqual({ url: null, resets: 1, submissions: 1 });
    await cleanedUp(state);
  });

  for (const fault of ["deleteSummary", "deleteSummaryAttempt"] as const) {
    it(`HR-014 R2/R3 finishes only the local cleanup after ${fault} failed once behind the reset`, async () => {
      const state = new FaultyContextStore({ root: await stateRoot() });
      const { route, page } = statefulRoute();
      const driver = await summarized(state, route);
      state.failOnce(fault);

      await expect(driver.retire(retirement())).resolves.toEqual({
        status: "blocked",
        code: "CONTEXT_SUMMARY_CLEANUP_FAILED",
      });
      expect(page).toEqual({ url: null, resets: 1, submissions: 1 });

      await expect(driver.retire(retirement())).resolves.toEqual({
        status: "retired",
      });
      expect(page).toEqual({ url: null, resets: 1, submissions: 1 });
      await cleanedUp(state);
    });
  }

  it("HR-014 R2 resumes the same operation after a restart onto the present, empty route", async () => {
    const root = await stateRoot();
    const state = new FaultyContextStore({ root });
    const { route, page } = statefulRoute();
    const driver = await summarized(state, route);
    state.failOnce("deleteSummary");
    await expect(driver.retire(retirement())).resolves.toMatchObject({
      code: "CONTEXT_SUMMARY_CLEANUP_FAILED",
    });

    // The restarted route is restored from the null conversation the reset
    // published: present, and naming no conversation at all.
    const restartedState = new PrivateContextStore({ root });
    const restarted = statefulRoute(null);
    await expect(
      driverFor(restartedState, restarted.route).retire(retirement()),
    ).resolves.toEqual({ status: "retired" });
    expect(restarted.page).toEqual({ url: null, resets: 0, submissions: 0 });
    expect(page.submissions).toBe(1);
    await cleanedUp(restartedState);
  });

  it("HR-014 resets again when a restart restored the conversation it was retiring", async () => {
    const root = await stateRoot();
    const state = new FaultyContextStore({ root });
    const { route } = statefulRoute();
    const driver = await summarized(state, route);
    state.failOnce("deleteSummary");
    await expect(driver.retire(retirement())).resolves.toMatchObject({
      code: "CONTEXT_SUMMARY_CLEANUP_FAILED",
    });

    // The reset's null conversation was never persisted, so the restarted
    // route shows the very conversation being retired.
    const restarted = statefulRoute();
    await expect(
      driverFor(new PrivateContextStore({ root }), restarted.route).retire(
        retirement(),
      ),
    ).resolves.toEqual({ status: "retired" });
    expect(restarted.page).toEqual({ url: null, resets: 1, submissions: 0 });
  });

  it("HR-014 R5 never resets a newer conversation at the recovery boundary", async () => {
    const state = new FaultyContextStore({ root: await stateRoot() });
    const { route, page } = statefulRoute();
    const driver = await summarized(state, route);
    state.failOnce("deleteSummary");
    await expect(driver.retire(retirement())).resolves.toMatchObject({
      code: "CONTEXT_SUMMARY_CLEANUP_FAILED",
    });
    page.url = "https://chatgpt.com/c/newer-task-conversation";

    await expect(driver.retire(retirement())).resolves.toEqual({
      status: "blocked",
      code: "SOURCE_RETIREMENT_SUPERSEDED",
    });
    expect(page).toMatchObject({
      url: "https://chatgpt.com/c/newer-task-conversation",
      resets: 1,
    });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.not.toBeNull();
  });

  it("HR-014 never takes a null URL alone as proof of a retirement that never started", async () => {
    const state = new FaultyContextStore({ root: await stateRoot() });
    const { route, page } = statefulRoute();
    const driver = await summarized(state, route);
    // The page left the conversation on its own before any retirement.
    page.url = null;

    await expect(driver.retire(retirement())).resolves.toEqual({
      status: "outcome_unknown",
      code: "SOURCE_RETIREMENT_UNKNOWN",
    });
    expect(page.resets).toBe(0);
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.not.toBeNull();
  });

  it("HR-014 never resets a conversation the route moved to while the retirement was being recorded", async () => {
    const root = await stateRoot();
    const { route, page } = statefulRoute();
    await summarized(new PrivateContextStore({ root }), route);
    // Recording the retirement is the one wait between proving the source
    // and resetting the route; the owner starts a new conversation during it.
    class MovingStore extends PrivateContextStore {
      override async putRetirement(
        candidate: Parameters<PrivateContextStore["putRetirement"]>[0],
      ): Promise<void> {
        await super.putRetirement(candidate);
        page.url = "https://chatgpt.com/c/newer-task-conversation";
      }
    }
    const state = new MovingStore({ root });

    await expect(driverFor(state, route).retire(retirement())).resolves.toEqual(
      { status: "blocked", code: "SOURCE_RETIREMENT_SUPERSEDED" },
    );
    expect(page).toMatchObject({
      url: "https://chatgpt.com/c/newer-task-conversation",
      resets: 0,
    });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.not.toBeNull();
  });

  // A10: a committed retirement whose route now shows another conversation is
  // a known, classified state -- not an unknown and not a success. Repeating
  // it never resets the newer conversation and never loses the summary or the
  // commitment; the retirement finishes once the route leaves that newer
  // conversation for the source or for no conversation at all.
  async function supersededAfterCommitment(root: string) {
    const { route, page } = statefulRoute();
    await summarized(new PrivateContextStore({ root }), route);
    class MovingStore extends PrivateContextStore {
      override async putRetirement(
        candidate: Parameters<PrivateContextStore["putRetirement"]>[0],
      ): Promise<void> {
        await super.putRetirement(candidate);
        page.url = "https://chatgpt.com/c/newer-task-conversation";
      }
    }
    const state = new MovingStore({ root });
    await expect(driverFor(state, route).retire(retirement())).resolves.toEqual(
      { status: "blocked", code: "SOURCE_RETIREMENT_SUPERSEDED" },
    );
    return { state, route, page };
  }

  it("A10 keeps a superseded retirement classified across repeats without resetting the newer conversation", async () => {
    const root = await stateRoot();
    const { state, route, page } = await supersededAfterCommitment(root);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        driverFor(new PrivateContextStore({ root }), route).retire(
          retirement(),
        ),
      ).resolves.toEqual({
        status: "blocked",
        code: "SOURCE_RETIREMENT_SUPERSEDED",
      });
    }
    expect(page).toMatchObject({
      url: "https://chatgpt.com/c/newer-task-conversation",
      resets: 0,
      submissions: 1,
    });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.not.toBeNull();
    await expect(state.getRetirement(binding)).resolves.toMatchObject({
      operationId: request.operationId,
      epoch: 1,
    });
  });

  it("A10 finishes a superseded retirement once the route shows the source again", async () => {
    const root = await stateRoot();
    const { route, page } = await supersededAfterCommitment(root);
    page.url = "https://chatgpt.com/c/summary-context-1";
    const state = new PrivateContextStore({ root });

    await expect(driverFor(state, route).retire(retirement())).resolves.toEqual(
      { status: "retired" },
    );
    expect(page).toEqual({ url: null, resets: 1, submissions: 1 });
    await cleanedUp(state);
  });

  it("A10 finishes a committed retirement once the route shows no conversation, without a reset", async () => {
    const root = await stateRoot();
    const { route, page } = await supersededAfterCommitment(root);
    page.url = null;
    const state = new PrivateContextStore({ root });

    await expect(driverFor(state, route).retire(retirement())).resolves.toEqual(
      { status: "retired" },
    );
    expect(page).toEqual({ url: null, resets: 0, submissions: 1 });
    await cleanedUp(state);
  });

  it("A10 classifies a route that left the source before any commitment and never records one", async () => {
    const state = new PrivateContextStore({ root: await stateRoot() });
    const { route, page } = statefulRoute();
    await summarized(state, route);
    page.url = "https://chatgpt.com/c/newer-task-conversation";

    await expect(driverFor(state, route).retire(retirement())).resolves.toEqual(
      { status: "blocked", code: "SOURCE_RETIREMENT_SUPERSEDED" },
    );
    expect(page.resets).toBe(0);
    await expect(state.getRetirement(binding)).resolves.toBeNull();
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.not.toBeNull();

    // Only the source itself proves the retirement: back on it, the one
    // reset follows.
    page.url = "https://chatgpt.com/c/summary-context-1";
    await expect(driverFor(state, route).retire(retirement())).resolves.toEqual(
      { status: "retired" },
    );
    expect(page.resets).toBe(1);
    await cleanedUp(state);
  });

  it("HR-014 never takes a missing retained route as proof of retirement", async () => {
    const state = new FaultyContextStore({ root: await stateRoot() });
    const { route } = statefulRoute();
    await summarized(state, route);

    // A launch whose live tasks failed to load has no route to prove or
    // reset; a later healthy launch could restore the very conversation.
    await expect(driverFor(state, null).retire(retirement())).resolves.toEqual({
      status: "outcome_unknown",
      code: "SOURCE_RETIREMENT_UNKNOWN",
    });
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.not.toBeNull();
  });

  it("HR-014 lets a foreign binding touch nothing", async () => {
    const state = new FaultyContextStore({ root: await stateRoot() });
    const { route, page } = statefulRoute();
    const driver = await summarized(state, route);

    await expect(
      driver.retire({
        ...retirement(),
        binding: { ...binding, taskId: "foreign-task" },
      }),
    ).resolves.toEqual({ status: "blocked", code: "SUMMARY_SOURCE_MISMATCH" });
    expect(page.resets).toBe(0);
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.not.toBeNull();
  });
});
