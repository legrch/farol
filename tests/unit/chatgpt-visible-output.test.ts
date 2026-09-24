import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ChatGptVisibleOutput,
  type VisibleOutputBlock,
  type VisibleOutputItem,
} from "../../src/apps/desktop/chatgpt-visible-output";

const block = (
  id: string,
  position: number,
  text: string,
  complete = true,
  channel: VisibleOutputBlock["channel"] = "answer",
): VisibleOutputBlock => ({ id, position, text, complete, channel });
const snapshot = (blocks: readonly VisibleOutputBlock[], terminal = false) => ({
  sourceId: "owned-assistant-message",
  blocks,
  terminal,
});
const tracker = () => new ChatGptVisibleOutput("owned-assistant-message", 10);

describe("public ChatGPT semantic output (synthetic observations only)", () => {
  it("waits for semantic completion and stability, not a text prefix", () => {
    const output = tracker();
    expect(
      output.observe(snapshot([block("p", 0, "Read [doc]", false)]), 0),
    ).toEqual([]);
    expect(
      output.observe(
        snapshot([block("p", 0, "Read [doc](https://example.test)", true)]),
        20,
      ),
    ).toEqual([]);
    const items = output.observe(
      snapshot([block("p", 0, "Read [doc](https://example.test)")]),
      30,
    );
    expect(items).toEqual([
      {
        sequence: 1,
        id: "p",
        channel: "answer",
        text: "Read [doc](https://example.test)",
      },
    ]);
    expect(output.answerText()).toBe("Read [doc](https://example.test)");
  });

  it("retains committed blocks when virtualization removes the prefix", () => {
    const output = tracker();
    output.observe(
      snapshot([block("a", 0, "First"), block("b", 10, "Second", false)]),
      0,
    );
    expect(
      output.observe(
        snapshot([block("a", 0, "First"), block("b", 10, "Second", false)]),
        10,
      ),
    ).toHaveLength(1);
    expect(output.observe(snapshot([block("b", 10, "Second")]), 20)).toEqual(
      [],
    );
    expect(output.observe(snapshot([block("b", 10, "Second")]), 30)).toEqual([
      { sequence: 2, id: "b", channel: "answer", text: "Second" },
    ]);
    expect(output.observe(snapshot([block("b", 10, "Second")]), 40)).toEqual(
      [],
    );
    expect(output.answerText()).toBe("First\n\nSecond");
  });

  it("does not lose an uncommitted block or let later output overtake it", () => {
    const output = tracker();
    output.observe(snapshot([block("a", 0, "Pending", false)]), 0);
    expect(output.observe(snapshot([block("b", 10, "Later")]), 20)).toEqual([]);
    expect(output.observe(snapshot([block("b", 10, "Later")]), 40)).toEqual([]);
    const recovered = output.observe(
      snapshot([block("a", 0, "Pending"), block("b", 10, "Later")], true),
      50,
    );
    expect(recovered.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("fails closed if terminal evidence omits an uncommitted block", () => {
    const output = tracker();
    output.observe(snapshot([block("a", 0, "Pending", false)]), 0);
    expect(() => output.observe(snapshot([], true), 10)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_PENDING_MISSING",
    );
    expect(output.answerText()).toBe("");
  });

  it.each([
    block("a", 0, "Changed"),
    block("a", 0, "Original", true, "commentary"),
    block("a", 1, "Original"),
  ])("never retracts or revises an emitted item", (changed) => {
    const output = tracker();
    output.observe(snapshot([block("a", 0, "Original")]), 0);
    output.observe(snapshot([block("a", 0, "Original")]), 10);
    expect(() => output.observe(snapshot([changed]), 20)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED",
    );
    expect(() =>
      output.observe(snapshot([block("a", 0, "Original")]), 30),
    ).toThrow("CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED");
    expect(output.answerText()).toBe("Original");
  });

  it("separates display channels without creating executable tool events", () => {
    const output = tracker();
    const items = output.observe(
      snapshot(
        [
          block("s", 0, "Reading files", true, "status"),
          block("c", 1, "I found the relevant test.", true, "commentary"),
          block("a", 2, "The result is 42."),
        ],
        true,
      ),
      0,
    );
    expect(items.map((item) => [item.sequence, item.channel])).toEqual([
      [1, "status"],
      [2, "commentary"],
      [3, "answer"],
    ]);
    expect(items.every((item) => !("arguments" in item))).toBe(true);
    expect(output.answerText()).toBe("The result is 42.");
  });

  it.each(
    [
      [block("a", 1, "One"), block("b", 0, "Two")],
      [block("a", 0, "One"), block("a", 1, "Two")],
      [block("a", 0, "One"), block("b", 0, "Two")],
    ].map((blocks) => ({ blocks })),
  )(
    "rejects duplicate or non-monotonic source identity before emission",
    ({ blocks }) => {
      const output = tracker();
      expect(() => output.observe(snapshot(blocks, true), 0)).toThrow(
        "CHATGPT_VISIBLE_OUTPUT_ORDER_CHANGED",
      );
      expect(output.answerText()).toBe("");
    },
  );

  it("rejects a different block at an already observed position", () => {
    const output = tracker();
    output.observe(snapshot([block("a", 0, "One", false)]), 0);
    expect(() => output.observe(snapshot([block("b", 0, "Two")]), 10)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_ORDER_CHANGED",
    );
  });

  it("rejects a changed source, invalid payload and a backwards clock", () => {
    expect(() =>
      tracker().observe({ ...snapshot([]), sourceId: "other" }, 0),
    ).toThrow("CHATGPT_VISIBLE_OUTPUT_SOURCE_CHANGED");
    expect(() =>
      tracker().observe({ ...snapshot([]), extra: "private" }, 0),
    ).toThrow("CHATGPT_VISIBLE_OUTPUT_INVALID");
    const output = tracker();
    output.observe(snapshot([]), 10);
    expect(() => output.observe(snapshot([]), 9)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_INVALID",
    );
  });

  it("bounds retained content, including pending blocks not currently visible", () => {
    const output = new ChatGptVisibleOutput(
      "owned-assistant-message",
      10,
      6,
      2,
    );
    output.observe(snapshot([block("a", 0, "1234", false)]), 0);
    expect(() => output.observe(snapshot([block("b", 10, "567")]), 10)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_LIMIT",
    );
    expect(() => new ChatGptVisibleOutput("", -1)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_INVALID",
    );
    const limited = new ChatGptVisibleOutput(
      "owned-assistant-message",
      10,
      100,
      1,
    );
    expect(() =>
      limited.observe(snapshot([block("a", 0, "A"), block("b", 1, "B")]), 0),
    ).toThrow("CHATGPT_VISIBLE_OUTPUT_LIMIT");
  });

  it("closes at terminal and preserves Markdown and Unicode exactly", () => {
    const output = tracker();
    const text =
      '```go\nfmt.Println("Привет 👋")\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    expect(
      output.observe(snapshot([block("code", 0, text, false)], true), 0)[0]
        ?.text,
    ).toBe(text);
    expect(output.answerText()).toBe(text);
    expect(() => output.observe(snapshot([], true), 1)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_CLOSED",
    );
  });

  it("never duplicates output under repeated partial snapshots", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 60 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (texts) => {
          const output = new ChatGptVisibleOutput("owned-assistant-message", 0);
          const seen: VisibleOutputItem[] = [];
          const blocks = texts.map((text, index) =>
            block(`b-${index}`, index * 10, text),
          );
          for (let index = 0; index < blocks.length; index += 1) {
            const current = snapshot(
              blocks.slice(Math.max(0, index - 2), index + 1),
            );
            seen.push(...output.observe(current, index));
            seen.push(...output.observe(current, index));
          }
          seen.push(...output.observe(snapshot([], true), texts.length));
          expect(seen.map((item) => item.text)).toEqual(texts);
          expect(seen.map((item) => item.sequence)).toEqual(
            texts.map((_, i) => i + 1),
          );
          expect(output.answerText()).toBe(texts.join("\n\n"));
        },
      ),
      { numRuns: 100 },
    );
  });
});
