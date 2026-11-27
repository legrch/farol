import { describe, expect, it } from "vitest";
import {
  bindingFingerprint,
  identityFromRequest,
  MAX_TOOLS,
  responseRequestSchema,
} from "./request";

const base = {
  model: "m",
  stream: true,
  input: "hi",
  tools: [],
  client_metadata: {
    session_id: "s",
    thread_id: "t",
    turn_id: "u",
    root_turn_id: "r",
  },
};

describe("provider request", () => {
  it("accepts a streamed request and keeps unknown fields", () => {
    const parsed = responseRequestSchema.safeParse({ ...base, extra: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.extra).toBe(1);
  });

  it("refuses a non-streamed, stored or chained request", () => {
    expect(
      responseRequestSchema.safeParse({ ...base, stream: false }).success,
    ).toBe(false);
    expect(
      responseRequestSchema.safeParse({ ...base, store: true }).success,
    ).toBe(false);
    expect(
      responseRequestSchema.safeParse({ ...base, previous_response_id: "p" })
        .success,
    ).toBe(false);
  });

  it("bounds the advertised tools", () => {
    const tools = Array.from({ length: MAX_TOOLS + 1 }, () => ({}));
    expect(responseRequestSchema.safeParse({ ...base, tools }).success).toBe(
      false,
    );
  });

  it("reads the identity and binds model and identity only", () => {
    const a = responseRequestSchema.parse(base);
    expect(identityFromRequest(a)).toEqual({
      sessionId: "s",
      threadId: "t",
      turnId: "u",
      rootTurnId: "r",
    });
    const sameBinding = responseRequestSchema.parse({ ...base, input: "x" });
    expect(bindingFingerprint(sameBinding)).toBe(bindingFingerprint(a));
    const otherModel = responseRequestSchema.parse({ ...base, model: "n" });
    expect(bindingFingerprint(otherModel)).not.toBe(bindingFingerprint(a));
  });
});
