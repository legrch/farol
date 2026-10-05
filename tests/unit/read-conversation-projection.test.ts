import { describe, expect, it } from "vitest";
import { projectReadConversation } from "../../apps/desktop/read-conversation-projection.ts";
import {
  ReadConversationPromptSchema,
  ReadConversationCursorSchema,
} from "../../src/pkg/product-settings/chat-conversation.ts";
import { ProductConfigurationCommandSchema } from "../../src/pkg/product-settings/contract.ts";
import { configurationEffectOutcome } from "../../src/ui/configuration-outcome.ts";
import type { ReadConversationProjection } from "../../apps/desktop/bridge/read-conversation.ts";

const handle = {
  handleId: "handle",
  binding: {
    profileId: "profile",
    backendGeneration: "backend",
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    operationId: "operation",
    turnGeneration: "1",
  },
};
function fixture(): ReadConversationProjection {
  return {
    handle,
    state: {
      handle,
      conversationId: "conversation",
      phase: "running",
      hasResult: false,
      deliveryAcknowledged: false,
      lifecycleSettled: false,
      released: false,
      followReady: false,
    },
    cursor: "2",
    frames: [
      { sequence: "1", kind: "response.created", data: {} },
      {
        sequence: "2",
        kind: "response.output_text.delta",
        data: { delta: "Useful output." },
      },
    ],
  };
}
describe("renderer-safe Go Chat projection", () => {
  it("parses bounded counters without throwing on malformed input", () => {
    for (const value of ["", "x", "-1", "01", "18446744073709551616"])
      expect(ReadConversationCursorSchema.safeParse(value).success).toBe(false);
    expect(
      ReadConversationCursorSchema.safeParse("18446744073709551615").success,
    ).toBe(true);
  });
  it("keeps exact owner and all transport sequences without inventing completion", () => {
    const p = fixture();
    const view = projectReadConversation("original", p);
    expect(view.binding).toEqual(handle.binding);
    expect(view.frames).toEqual([
      { sequence: "1" },
      { sequence: "2", delta: "Useful output." },
    ]);
    expect(view.result).toBeUndefined();
    expect(view.followReady).toBe(false);
    expect(view.operationId).toBe("original");
  });
  it("refuses malformed useful output instead of dropping it then ACKing the cursor", () => {
    const original = fixture();
    const p = {
      ...original,
      frames: [{ ...original.frames[1]!, data: { delta: 42 } }],
    };
    expect(() => projectReadConversation("original", p)).toThrow(
      "read_chat_projection_invalid",
    );
  });
  it.each(["a", "я", "😀"])(
    "enforces the same complete UTF-8 prompt bound for %s",
    (unit) => {
      const count = 8192 / new TextEncoder().encode(unit).length;
      expect(
        ReadConversationPromptSchema.safeParse(unit.repeat(count)).success,
      ).toBe(true);
      expect(
        ReadConversationPromptSchema.safeParse(unit.repeat(count) + "x")
          .success,
      ).toBe(false);
    },
  );
  it("refuses blank, unpaired surrogate, or extra fields in a Follow command", () => {
    const base = {
      kind: "chatgpt.follow-readonly-conversation",
      operationId: "00000000-0000-4000-8000-000000000000",
      handleId: "owned",
    };
    for (const prompt of [" ", "\ud800"])
      expect(
        ProductConfigurationCommandSchema.safeParse({ ...base, prompt })
          .success,
      ).toBe(false);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        ...base,
        prompt: "Next?",
        newConversation: true,
      }).success,
    ).toBe(false);
  });
  it("classifies a known wire reply describing uncertainty as unknown", () => {
    expect(
      configurationEffectOutcome({
        kind: "refused",
        result: {
          ok: false,
          error: "CHATGPT_CONVERSATION_UNCONFIRMED",
          snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
        },
      }),
    ).toBe("unknown");
  });
});
