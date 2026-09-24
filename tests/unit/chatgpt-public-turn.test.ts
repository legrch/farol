import { describe, expect, it } from "vitest";
import { ChatGptPublicTurn } from "../../src/apps/desktop/chatgpt-public-turn";

// Qualified source frames, not native DOM or live ChatGPT evidence.
const message = (id: string, text: string, complete = true) => ({
  id,
  text,
  complete,
  channel: "answer" as const,
});
const frame = (messages: ReturnType<typeof message>[], terminal = false) => ({
  userId: "u",
  messages,
  terminal,
});

describe("public turn source reconciliation", () => {
  it("streams closed messages and retains their order across remount/virtualization", () => {
    const source = new ChatGptPublicTurn("u", "a", 10);
    expect(source.observe(frame([message("a", "**one**")]), 0).items).toEqual(
      [],
    );
    expect(
      source.observe(frame([message("a", "**one**")]), 10).items,
    ).toHaveLength(1);
    expect(
      source.observe(
        frame([message("a", "**one**"), message("b", "two", false)]),
        11,
      ).items,
    ).toEqual([]);
    const result = source.observe(frame([message("b", "two")], true), 12);
    expect(result.items.map((item) => item.text)).toEqual(["two"]);
    expect(result.answer).toBe("**one**\n\ntwo");
    expect(result.completed).toBe(true);
  });
  it("does not assign a local window index to an unanchored suffix", () => {
    const source = new ChatGptPublicTurn("u", "a", 0);
    source.observe(frame([message("a", "one")]), 0);
    expect(() => source.observe(frame([message("b", "two")]), 1)).toThrow(
      "CHATGPT_PUBLIC_SOURCE_GAP",
    );
  });
  it("refuses a resumed frame without its retained first assistant anchor", () => {
    expect(() =>
      new ChatGptPublicTurn("u", "a").observe(frame([message("b", "two")]), 0),
    ).toThrow("CHATGPT_PUBLIC_SOURCE_GAP");
  });
  it("detects a committed rewrite and keeps failure sticky", () => {
    const source = new ChatGptPublicTurn("u", "a", 0);
    source.observe(frame([message("a", "one")]), 0);
    expect(() => source.observe(frame([message("a", "changed")]), 1)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED",
    );
    expect(() => source.observe(frame([message("a", "one")]), 2)).toThrow();
  });
  it("requires every pending message and a completed final answer at terminal", () => {
    const source = new ChatGptPublicTurn("u", "a", 0);
    source.observe(frame([message("a", "one", false)]), 0);
    expect(() =>
      source.observe(frame([message("a", "one", false)], true), 1),
    ).toThrow("CHATGPT_PUBLIC_TERMINAL_UNQUALIFIED");
  });
  it("buffers incomplete Markdown and never releases later output around it", () => {
    const source = new ChatGptPublicTurn("u", "a", 0);
    const pending = { ...message("a", ""), text: null, complete: false };
    expect(
      source.observe(
        {
          userId: "u",
          messages: [pending, message("b", "later")],
          terminal: false,
        },
        0,
      ).items,
    ).toEqual([]);
    expect(() =>
      source.observe(frame([message("b", "later")], true), 1),
    ).toThrow("CHATGPT_PUBLIC_PENDING_MISSING");
  });
  it("distinguishes public status/commentary from the final answer", () => {
    const source = new ChatGptPublicTurn("u", "a", 0);
    const result = source.observe(
      {
        userId: "u",
        terminal: true,
        messages: [
          { ...message("a", "Searching"), channel: "status" },
          { ...message("b", "Checking"), channel: "commentary" },
          message("c", "Done 👋"),
        ],
      },
      0,
    );
    expect(result.items.map((item) => item.channel)).toEqual([
      "status",
      "commentary",
      "answer",
    ]);
    expect(result.answer).toBe("Done 👋");
  });
  it("refuses duplicate IDs, source changes and prefix insertion", () => {
    expect(() =>
      new ChatGptPublicTurn("u", "a").observe(
        frame([message("a", "x"), message("a", "x")]),
        0,
      ),
    ).toThrow();
    expect(() =>
      new ChatGptPublicTurn("u", "a").observe(
        { ...frame([message("a", "x")]), userId: "other" },
        0,
      ),
    ).toThrow();
    const source = new ChatGptPublicTurn("u", "a", 0);
    source.observe(frame([message("a", "x")]), 0);
    expect(() =>
      source.observe(frame([message("b", "new"), message("a", "x")]), 1),
    ).toThrow();
  });
});

it("rejects a new or rewritten parent instead of trusting arbitrary missing ancestry", () => {
  const source = new ChatGptPublicTurn("u", "a", 0);
  source.observe(
    {
      ...frame([message("a", "A"), message("b", "B", false)]),
      messages: [
        { ...message("a", "A"), parentId: "u" },
        { ...message("b", "B", false), parentId: "a" },
      ],
    },
    0,
  );
  expect(() =>
    source.observe(
      { ...frame([]), messages: [{ ...message("b", "B"), parentId: "other" }] },
      1,
    ),
  ).toThrow("CHATGPT_PUBLIC_SOURCE_PARENT_UNQUALIFIED");
  expect(() =>
    new ChatGptPublicTurn("u", "a", 0).observe(
      {
        ...frame([]),
        messages: [{ ...message("a", "A"), parentId: "missing" }],
      },
      0,
    ),
  ).toThrow("CHATGPT_PUBLIC_SOURCE_PARENT_UNQUALIFIED");
});
