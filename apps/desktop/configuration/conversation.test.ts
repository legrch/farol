import { describe, expect, it, vi } from "vitest";
import { scriptedChatgptPorts } from "../../../tests/support/chatgpt-configuration-ports";
import {
  failureOf,
  sliceScene,
} from "../../../tests/support/chatgpt-configuration-slice";
import { createChatgptConversation } from "./conversation";
import type { GoReadonlyConversation } from "./ports";

// Command routing, refusal order and effect order only; no Go core, journal or
// real ChatGPT page is involved.
const operationId = "00000000-0000-4000-8000-000000000001";
const handleId = "00000000-0000-4000-8000-000000000004";

function scene() {
  const base = sliceScene();
  const state = {
    route: null as unknown,
    store: null as unknown,
    journal: null as unknown,
    core: { id: "core" } as unknown,
    active: null as GoReadonlyConversation | null,
    recoverable: null as { operationId: string; result: unknown } | null,
    persisted: false,
    pendingReadonly: null as unknown,
  };
  const route = {
    resetConversation: vi.fn(() => {
      base.events.push("route.reset");
    }),
  };
  const store = {
    clear: vi.fn(async () => {
      base.events.push("store.clear");
    }),
  };
  const journal = {
    acknowledgeDelivery: vi.fn(async (id: string) => {
      base.events.push(`journal.ack:${id}`);
    }),
  };
  state.route = route;
  state.store = store;
  state.journal = journal;
  const ports = scriptedChatgptPorts({
    configuration: () => base.configuration as never,
    chatGptRoute: () => state.route as never,
    desktopGoCore: () => state.core as never,
    directChatStart: () => null,
    goReadonlyConversation: () => state.active,
    setGoReadonlyConversation: (value) => {
      state.active = value;
    },
    pendingChatGptReadonlyTask: () => state.pendingReadonly as never,
    pendingChatGptAttachmentTask: () => null,
    recoverableChatGptTask: () => state.recoverable as never,
    setRecoverableChatGptTask: (value) => {
      state.recoverable = value as never;
      base.events.push("recoverable:cleared");
    },
    recoverableChatGptObservationPersisted: () => state.persisted,
    setRecoverableChatGptObservationPersisted: (value) => {
      state.persisted = value;
    },
    chatGptConversationStore: () => state.store as never,
    setChatGptConversation: () => {
      base.events.push("conversation:cleared");
    },
    chatGptTaskJournal: () => state.journal as never,
    desktopAdmission: base.admission,
    configurationFailure: base.failure,
    chatGptConversationContinuity: () => "not_observed",
    chatGptJournalObservation: (result) => ({ journal: result }),
  });
  return {
    ...base,
    state,
    route,
    store,
    journal,
    handler: createChatgptConversation(ports),
  };
}

describe("conversation slice", () => {
  it("refuses a start without a retained inspection", async () => {
    const s = scene();
    const result = await s.handler.configureConversation({
      kind: "chatgpt.start-conversation",
      operationId,
      confirmationId: "00000000-0000-4000-8000-000000000003",
      prompt: "hello",
    });
    expect(failureOf(result)).toBe("CHATGPT_CONVERSATION_REFUSED");
  });

  it("refuses a readonly conversation command for another operation", async () => {
    const s = scene();
    s.state.active = {
      pending: null,
      operationId: "00000000-0000-4000-8000-000000000009",
      core: s.state.core as never,
      client: {} as never,
      start: Promise.resolve(s.failure("SETTINGS_UNAVAILABLE")),
    };
    const result = await s.handler.configureConversation({
      kind: "chatgpt.observe-readonly-conversation",
      operationId,
      handleId,
      cursor: "0",
    });
    expect(failureOf(result)).toBe("CHATGPT_CONVERSATION_REFUSED");
  });

  it("refuses recovery without a retained result", async () => {
    const s = scene();
    const result = await s.handler.configureConversation({
      kind: "chatgpt.recover-task-result",
    });
    expect(failureOf(result)).toBe("CHATGPT_TASK_RESULT_NOT_FOUND");
  });

  it("refuses a reset while the chat lane is occupied or a preview is pending", async () => {
    const s = scene();
    const lane = s.admission.reserveAdmitted("chatgpt-task");
    expect(
      failureOf(
        await s.handler.configureConversation({
          kind: "chatgpt.reset-conversation",
        }),
      ),
    ).toBe("CHATGPT_TASK_IN_PROGRESS");
    lane.release();
    s.state.pendingReadonly = { operationId };
    expect(
      failureOf(
        await s.handler.configureConversation({
          kind: "chatgpt.reset-conversation",
        }),
      ),
    ).toBe("CHATGPT_TASK_PREVIEW_PENDING");
    expect(s.store.clear).not.toHaveBeenCalled();
  });

  it("clears the store, then the retained record, then the route", async () => {
    const s = scene();
    const result = await s.handler.configureConversation({
      kind: "chatgpt.reset-conversation",
    });
    expect(result).toMatchObject({
      ok: true,
      evidence: { kind: "chatgpt.conversation-reset", state: "new" },
    });
    expect(s.events).toEqual([
      "store.clear",
      "conversation:cleared",
      "route.reset",
    ]);
  });

  it("refuses an acknowledgement without a journal", async () => {
    const s = scene();
    s.state.journal = null;
    const result = await s.handler.configureConversation({
      kind: "chatgpt.ack-task-result",
      operationId,
    });
    expect(failureOf(result)).toBe("CHATGPT_TASK_JOURNAL_FAILED");
  });

  it("records the retained observation once before acknowledging delivery", async () => {
    const s = scene();
    s.state.recoverable = { operationId, result: { text: "done" } };
    await s.handler.configureConversation({
      kind: "chatgpt.ack-task-result",
      operationId,
    });
    expect(s.events).toEqual([
      'recordChatGptObservation:{"journal":{"text":"done"}}',
      `journal.ack:${operationId}`,
      "recoverable:cleared",
    ]);
    expect(s.state.persisted).toBe(false);
  });
});
