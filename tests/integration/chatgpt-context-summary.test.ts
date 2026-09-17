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

  async function store(): Promise<PrivateContextStore> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-summary-driver-"),
    );
    roots.push(root);
    return new PrivateContextStore({ root });
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
    });
    expect(retained.runReadonlyTask).toHaveBeenCalledTimes(1);
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

  it("blocks on an explicit usage limit and releases only an owned fallback", async () => {
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
      status: "blocked",
      code: "SUMMARY_USAGE_LIMITED",
    });
    expect(fallback.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(fallback.dispose).toHaveBeenCalledTimes(1);
    await expect(
      state.getSummary(binding, request.operationId),
    ).resolves.toBeNull();
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
});
