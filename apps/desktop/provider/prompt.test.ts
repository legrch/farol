import { describe, expect, it } from "vitest";
import { MAX_PROMPT_CHARACTERS, promptFromInput } from "./prompt";

const CHECKPOINT = "<checkpoint>";

function user(text: string): unknown {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function answer(text: string): unknown {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

describe("provider prompt", () => {
  it("prefixes trusted context to a plain string input", () => {
    expect(promptFromInput("hello", null, CHECKPOINT)).toBe("hello");
    expect(promptFromInput("hello", "ctx", CHECKPOINT)).toBe("ctx\n\nhello");
  });

  it("refuses a prompt past the budget", () => {
    const over = "x".repeat(MAX_PROMPT_CHARACTERS + 1);
    expect(promptFromInput(over, null, CHECKPOINT)).toBeNull();
    expect(
      promptFromInput("x".repeat(MAX_PROMPT_CHARACTERS), null, CHECKPOINT),
    ).toHaveLength(MAX_PROMPT_CHARACTERS);
    expect(promptFromInput([user(over)], null, CHECKPOINT)).toBeNull();
  });

  it("keeps only the user messages after the last item the conversation produced", () => {
    const input = [
      user("old question"),
      answer("old answer"),
      user("first"),
      user("second"),
    ];
    expect(promptFromInput(input, null, CHECKPOINT)).toBe("first\n\nsecond");
    expect(promptFromInput(input, "ctx", CHECKPOINT)).toBe(
      "ctx\n\nfirst\n\nsecond",
    );
  });

  it("reads string content and drops messages carrying the checkpoint", () => {
    const input = [
      { type: "message", role: "user", content: "plain" },
      user(`before ${CHECKPOINT} after`),
      user("kept"),
    ];
    expect(promptFromInput(input, null, CHECKPOINT)).toBe("plain\n\nkept");
  });

  it("returns nothing when the turn has no user message", () => {
    expect(promptFromInput([], null, CHECKPOINT)).toBeNull();
    expect(promptFromInput([answer("a")], null, CHECKPOINT)).toBeNull();
    expect(promptFromInput([user(CHECKPOINT)], null, CHECKPOINT)).toBeNull();
    expect(promptFromInput([], "ctx", CHECKPOINT)).toBe("ctx");
  });
});
