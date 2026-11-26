import { describe, expect, it, vi } from "vitest";
import { scriptedChatgptPorts } from "../../../tests/support/chatgpt-configuration-ports";
import {
  failureOf,
  sliceScene,
} from "../../../tests/support/chatgpt-configuration-slice";
import { createChatgptAttachment } from "./attachment";
import type { PendingChatGptAttachmentTask } from "./ports";

// Refusal order, expiry and cleanup order only; no real picker, staging
// directory or private journal is involved.
const operationId = "00000000-0000-4000-8000-000000000001";

function scene() {
  const base = sliceScene();
  const state = {
    route: {} as unknown,
    pending: null as PendingChatGptAttachmentTask | null,
    pendingReadonly: null as unknown,
    stagingReady: true,
    conversationFailure: null as ReturnType<typeof base.failure> | null,
    journalDiscards: true,
  };
  const discard = vi.fn(async (_root: string, id: string) => {
    base.events.push(`discard:${id}`);
  });
  const ports = scriptedChatgptPorts({
    configuration: () => base.configuration as never,
    chatGptRoute: () => state.route as never,
    pendingChatGptReadonlyTask: () => state.pendingReadonly as never,
    pendingChatGptAttachmentTask: () => state.pending,
    setPendingChatGptAttachmentTask: (value) => {
      state.pending = value;
      base.events.push(`pending:${value === null ? "null" : "value"}`);
    },
    attachmentStagingReady: () => state.stagingReady,
    setAttachmentStagingReady: (value) => {
      state.stagingReady = value;
      base.events.push(`staging:${value}`);
    },
    desktopAdmission: base.admission,
    statePaths: () => ({ attachmentStaging: "/staging" }),
    configurationFailure: base.failure,
    chatGptConversationAdmissionFailure: () => state.conversationFailure,
    discardPreparedChatGptTask: async (id) => {
      base.events.push(`journal.discard:${id}`);
      return state.journalDiscards;
    },
    discardChatGptAttachments: discard as never,
  });
  return {
    ...base,
    state,
    discard,
    handler: createChatgptAttachment(ports),
  };
}

function pending(expiresAt: number): PendingChatGptAttachmentTask {
  return {
    operationId,
    attachments: { operationId, attachments: [] } as never,
    prompt: "prompt",
    chatGptVerification: {} as never,
    expiresAt,
  };
}

describe("attachment slice", () => {
  it("refuses a missing route before any other check", async () => {
    const s = scene();
    s.state.route = null;
    const result = await s.handler.configureAttachment({
      kind: "chatgpt.prepare-attachment-task",
    });
    expect(failureOf(result)).toBe("CHATGPT_ROUTE_UNAVAILABLE");
  });

  it("refuses an occupied chat lane before the conversation admission", async () => {
    const s = scene();
    s.state.conversationFailure = s.failure("CHATGPT_CONVERSATION_REFUSED");
    const lane = s.admission.reserveAdmitted("chatgpt-task");
    const result = await s.handler.configureAttachment({
      kind: "chatgpt.prepare-attachment-task",
    });
    lane.release();
    expect(failureOf(result)).toBe("CHATGPT_TASK_IN_PROGRESS");
  });

  it("refuses unavailable staging, then a pending readonly preview", async () => {
    const s = scene();
    s.state.stagingReady = false;
    s.state.pendingReadonly = { operationId };
    expect(
      failureOf(
        await s.handler.configureAttachment({
          kind: "chatgpt.prepare-attachment-task",
        }),
      ),
    ).toBe("CHATGPT_ATTACHMENT_STAGING_FAILED");
    s.state.stagingReady = true;
    expect(
      failureOf(
        await s.handler.configureAttachment({
          kind: "chatgpt.prepare-attachment-task",
        }),
      ),
    ).toBe("CHATGPT_ATTACHMENT_PREVIEW_PENDING");
  });

  it("refuses a submit without a matching preview", async () => {
    const s = scene();
    const result = await s.handler.configureAttachment({
      kind: "chatgpt.submit-attachment-task",
      operationId,
    });
    expect(failureOf(result)).toBe("CHATGPT_ATTACHMENT_PREVIEW_NOT_FOUND");
  });

  it("clears an expired preview, its staging and its journal entry on submit", async () => {
    const s = scene();
    s.state.pending = pending(Date.now() - 1);
    const result = await s.handler.configureAttachment({
      kind: "chatgpt.submit-attachment-task",
      operationId,
    });
    expect(failureOf(result)).toBe("CHATGPT_ATTACHMENT_PREVIEW_EXPIRED");
    expect(s.events).toEqual([
      "pending:null",
      `discard:${operationId}`,
      `journal.discard:${operationId}`,
    ]);
  });

  it("cancels by clearing the preview, then staging, then the journal entry", async () => {
    const s = scene();
    s.state.pending = pending(Date.now() + 60_000);
    const result = await s.handler.configureAttachment({
      kind: "chatgpt.cancel-attachment-task",
      operationId,
    });
    expect(result).toMatchObject({ ok: true });
    expect(s.events).toEqual([
      "pending:null",
      `discard:${operationId}`,
      `journal.discard:${operationId}`,
    ]);
  });

  it("marks staging unusable when its discard fails on cancel", async () => {
    const s = scene();
    s.state.pending = pending(Date.now() + 60_000);
    s.discard.mockRejectedValue(new Error("disk"));
    const result = await s.handler.configureAttachment({
      kind: "chatgpt.cancel-attachment-task",
      operationId,
    });
    expect(failureOf(result)).toBe("CHATGPT_ATTACHMENT_STAGING_FAILED");
    expect(s.state.stagingReady).toBe(false);
  });
});
