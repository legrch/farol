import { describe, expect, it } from "vitest";
import type { PhysicalBinding } from "../chatgpt-physical-api.ts";
import { correlate } from "./correlation.ts";

const base = {
  viewId: "v1",
  viewGeneration: 1,
  documentGeneration: 1,
  partition: "persist:farol-dev-chatgpt",
} as const;
const chat: PhysicalBinding = {
  ...base,
  url: "https://chatgpt.com/c/abc",
  phase: "conversation",
  conversationId: "abc",
};
const home: PhysicalBinding = {
  ...base,
  url: "https://chatgpt.com/",
  phase: "home",
  conversationId: null,
};
const none = { userTurnId: "", replyId: "" };
const unknown = (run: () => unknown) =>
  expect(run).toThrow(
    expect.objectContaining({
      state: "unknown",
      code: "chat_browser_frame_correlation_unknown",
    }),
  );

describe("browser correlation", () => {
  it("reports no turn while the provider names none", () => {
    expect(
      correlate(home, { userTurnId: null, replyId: null }, none, {}),
    ).toBeNull();
  });

  it("identifies a new turn in a conversation", () => {
    expect(
      correlate(chat, { userTurnId: "u1", replyId: "r1" }, none, {}),
    ).toEqual({
      userTurnId: "u1",
      replyId: "r1",
      conversationId: "abc",
    });
    expect(
      correlate(chat, { userTurnId: "u1", replyId: null }, none, {})?.replyId,
    ).toBeNull();
  });

  it("refuses malformed pairs", () => {
    unknown(() =>
      correlate(chat, { userTurnId: null, replyId: "r1" }, none, {}),
    );
    unknown(() =>
      correlate(chat, { userTurnId: "-bad", replyId: null }, none, {}),
    );
    unknown(() =>
      correlate(chat, { userTurnId: "u1", replyId: "-bad" }, none, {}),
    );
  });

  it("refuses a turn outside a conversation or replaying the previous turn", () => {
    unknown(() =>
      correlate(home, { userTurnId: "u1", replyId: "r1" }, none, {}),
    );
    const prior = { userTurnId: "u0", replyId: "r0" };
    unknown(() =>
      correlate(chat, { userTurnId: "u0", replyId: "r1" }, prior, {}),
    );
    unknown(() =>
      correlate(chat, { userTurnId: "u1", replyId: "r0" }, prior, {}),
    );
  });

  it("refuses a pair that contradicts an adopted turn", () => {
    unknown(() =>
      correlate(chat, { userTurnId: "u2", replyId: "r1" }, none, {
        userId: "u1",
      }),
    );
    unknown(() =>
      correlate(chat, { userTurnId: "u1", replyId: "r2" }, none, {
        userId: "u1",
        replyId: "r1",
      }),
    );
    expect(
      correlate(chat, { userTurnId: "u1", replyId: "r1" }, none, {
        userId: "u1",
        replyId: "r1",
      })?.userTurnId,
    ).toBe("u1");
  });
});
