import { describe, expect, it, vi } from "vitest";
import { scriptedChatgptPorts } from "../../../tests/support/chatgpt-configuration-ports";
import {
  failureOf,
  sliceScene,
} from "../../../tests/support/chatgpt-configuration-slice";
import type {
  GoReadonlyConversation,
  PendingChatGptReadonlyTask,
} from "./ports";
import { createChatgptReadonly } from "./readonly";

// Refusal order, expiry and cleanup order only; no Go core, native workspace
// or real ChatGPT page is involved.
const operationId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";

function scene() {
  const base = sliceScene();
  const state = {
    route: {} as unknown,
    conversation: null as GoReadonlyConversation | null,
    pending: null as PendingChatGptReadonlyTask | null,
    pendingAttachment: null as unknown,
    conversationFailure: null as ReturnType<typeof base.failure> | null,
    discards: true,
  };
  const ports = scriptedChatgptPorts({
    configuration: () => base.configuration as never,
    chatGptRoute: () => state.route as never,
    goReadonlyConversation: () => state.conversation,
    setGoReadonlyConversation: (value) => {
      state.conversation = value;
      base.events.push(`conversation:${value === null ? "null" : "value"}`);
    },
    pendingChatGptReadonlyTask: () => state.pending,
    pendingChatGptAttachmentTask: () => state.pendingAttachment as never,
    desktopAdmission: base.admission,
    configurationFailure: base.failure,
    chatGptConversationAdmissionFailure: () => state.conversationFailure,
    discardPreparedReadonlyTask: async () => {
      base.events.push("discard");
      return state.discards;
    },
  });
  return { ...base, state, handler: createChatgptReadonly(ports) };
}

function pending(expiresAt: number): PendingChatGptReadonlyTask {
  return {
    operationId,
    workspaceId,
    workspaceLabel: "fixture",
    computerGeneration: 1,
    relativePath: "notes.txt",
    bytes: 5,
    contextCharacters: 5,
    contextTruncated: false,
    excludedPaths: [],
    prompt: "prompt",
    chatGptVerification: {} as never,
    expiresAt,
  };
}

const prepare = {
  kind: "chatgpt.prepare-readonly-task",
  workspaceId,
} as const;

describe("readonly slice", () => {
  it("refuses a prepare while a readonly conversation is retained", async () => {
    const s = scene();
    s.state.conversation = {} as never;
    expect(failureOf(await s.handler.configureReadonly(prepare))).toBe(
      "CHATGPT_TASK_IN_PROGRESS",
    );
  });

  it("refuses a prepare without a route, then with an occupied chat lane", async () => {
    const s = scene();
    s.state.route = null;
    expect(failureOf(await s.handler.configureReadonly(prepare))).toBe(
      "CHATGPT_ROUTE_UNAVAILABLE",
    );
    s.state.route = {};
    const lane = s.admission.reserveAdmitted("chatgpt-task");
    expect(failureOf(await s.handler.configureReadonly(prepare))).toBe(
      "CHATGPT_TASK_IN_PROGRESS",
    );
    lane.release();
  });

  it("returns the conversation admission failure before a pending attachment preview", async () => {
    const s = scene();
    s.state.conversationFailure = s.failure("CHATGPT_CONVERSATION_REFUSED");
    s.state.pendingAttachment = { operationId };
    expect(failureOf(await s.handler.configureReadonly(prepare))).toBe(
      "CHATGPT_CONVERSATION_REFUSED",
    );
    s.state.conversationFailure = null;
    expect(failureOf(await s.handler.configureReadonly(prepare))).toBe(
      "CHATGPT_TASK_PREVIEW_PENDING",
    );
  });

  it("refuses an unqualified prepare and releases the chat lane", async () => {
    const s = scene();
    expect(failureOf(await s.handler.configureReadonly(prepare))).not.toBe(
      null,
    );
    expect(s.admission.occupied("chatgpt-task")).toBe(false);
  });

  it("refuses a submit without a matching preview and releases the chat lane", async () => {
    const s = scene();
    const result = await s.handler.configureReadonly({
      kind: "chatgpt.submit-readonly-task",
      operationId,
    });
    expect(failureOf(result)).toBe("CHATGPT_TASK_PREVIEW_NOT_FOUND");
    expect(s.admission.occupied("chatgpt-task")).toBe(false);
  });

  it("discards an expired preview on submit and reports it expired", async () => {
    const s = scene();
    s.state.pending = pending(Date.now() - 1);
    const result = await s.handler.configureReadonly({
      kind: "chatgpt.submit-readonly-task",
      operationId,
    });
    expect(failureOf(result)).toBe("CHATGPT_TASK_PREVIEW_EXPIRED");
    expect(s.events).toEqual(["discard"]);
  });

  it("requires review when an expired preview cannot be discarded", async () => {
    const s = scene();
    s.state.pending = pending(Date.now() - 1);
    s.state.discards = false;
    const result = await s.handler.configureReadonly({
      kind: "chatgpt.submit-readonly-task",
      operationId,
    });
    expect(failureOf(result)).toBe("CHATGPT_TASK_REQUIRES_REVIEW");
  });

  it("refuses a cancel for an unknown preview", async () => {
    const s = scene();
    const result = await s.handler.configureReadonly({
      kind: "chatgpt.cancel-readonly-task",
      operationId,
    });
    expect(failureOf(result)).toBe("CHATGPT_TASK_PREVIEW_NOT_FOUND");
  });

  it("drops the retained conversation only when it still holds the cancelled preview", async () => {
    const s = scene();
    const task = pending(Date.now() + 60_000);
    s.state.pending = task;
    s.state.conversation = {
      pending: task,
      operationId,
      core: {} as never,
      client: { canWithdrawAdmission: vi.fn(() => true) } as never,
      start: Promise.resolve(s.failure("SETTINGS_UNAVAILABLE")),
    };
    const result = await s.handler.configureReadonly({
      kind: "chatgpt.cancel-readonly-task",
      operationId,
    });
    expect(result).toMatchObject({ ok: true });
    expect(s.events).toEqual(["discard", "conversation:null"]);
  });
});
