import { describe, expect, it } from "vitest";
import { ChatGptPublicTurn } from "../../src/apps/desktop/chatgpt-public-turn";

// Qualified source frames, not native DOM or live ChatGPT evidence.
const message = (id: string, text: string | null, complete = true) => ({
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

describe("settled segments under a retained reply identity", () => {
  const segment = (id: string, text: string | null, complete = true) => ({
    id,
    text,
    complete,
  });
  const segmented = (
    segments: ReturnType<typeof segment>[],
    complete = false,
  ) => ({
    ...message("a", "", complete),
    text: segments.some((item) => item.text === null)
      ? null
      : segments.map((item) => item.text).join("\n\n") || null,
    segments,
  });
  it("emits a useful prefix before terminal, appends same text with distinct IDs and deduplicates remounts", () => {
    const turn = new ChatGptPublicTurn("u", "a", 0);
    const one = segment("s1", "pear");
    expect(
      turn.observe(frame([segmented([one])]), 0).items.map((item) => item.id),
    ).toEqual(["s1"]);
    expect(turn.observe(frame([segmented([one])]), 1).items).toEqual([]);
    const two = segment("s2", "pear");
    expect(
      turn
        .observe(frame([segmented([one, two])]), 2)
        .items.map((item) => item.id),
    ).toEqual(["s2"]);
    expect(
      turn.observe(frame([segmented([one, two], true)], true), 3),
    ).toMatchObject({ answer: "pear\n\npear", items: [], completed: true });
  });
  it("retains a mounting empty segmented reply and requires overlap before appending a suffix", () => {
    const turn = new ChatGptPublicTurn("u", "a", 0);
    expect(turn.observe(frame([segmented([])]), 0).items).toEqual([]);
    turn.observe(frame([segmented([segment("s1", "one")])]), 1);
    expect(() =>
      turn.observe(frame([segmented([segment("s2", "two")])]), 2),
    ).toThrow("CHATGPT_PUBLIC_SOURCE_GAP");
  });
  it("keeps committed mutation sticky and rejects settlement regression", () => {
    for (const changed of [
      segment("s1", "changed"),
      segment("s1", "one", false),
      segment("s1", null, false),
    ]) {
      const turn = new ChatGptPublicTurn("u", "a", 0);
      turn.observe(frame([segmented([segment("s1", "one")])]), 0);
      expect(() => turn.observe(frame([segmented([changed])]), 1)).toThrow();
      expect(() =>
        turn.observe(frame([segmented([segment("s1", "one")])]), 2),
      ).toThrow();
    }
  });
  it("refuses profile changes, reordering, duplicate segment IDs and forged terminal proof", () => {
    const turn = new ChatGptPublicTurn("u", "a", 0);
    turn.observe(frame([segmented([segment("s1", "one")])]), 0);
    expect(() => turn.observe(frame([message("a", "one")]), 1)).toThrow(
      "CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED",
    );
    for (const segments of [
      [segment("s1", "one"), segment("s1", "two")],
      [segment("s1", "one"), segment("s2", "two", false)],
    ]) {
      expect(() =>
        new ChatGptPublicTurn("u", "a", 0).observe(
          frame([segmented(segments, true)], true),
          0,
        ),
      ).toThrow();
    }
    const ordered = new ChatGptPublicTurn("u", "a", 0);
    ordered.observe(
      frame([segmented([segment("s1", "one"), segment("s2", "two")])]),
      0,
    );
    expect(() =>
      ordered.observe(
        frame([segmented([segment("s2", "two"), segment("s1", "one")])]),
        1,
      ),
    ).toThrow("CHATGPT_PUBLIC_SOURCE_ORDER");
  });
  it("does not let pending segments or unfinished reply boundaries be overtaken", () => {
    const turn = new ChatGptPublicTurn("u", "a", 0);
    expect(
      turn.observe(
        frame([
          segmented([segment("s1", null, false), segment("s2", "later")]),
          message("b", "next reply"),
        ]),
        0,
      ).items,
    ).toEqual([]);
    expect(() =>
      turn.observe(frame([segmented([segment("s2", "later")], true)], true), 1),
    ).toThrow();
    const unfinished = new ChatGptPublicTurn("u", "a", 0);
    expect(
      unfinished
        .observe(
          frame([segmented([segment("s1", "prefix")]), message("b", "later")]),
          0,
        )
        .items.map((item) => item.id),
    ).toEqual(["s1"]);
  });
});

it("waits for a mounting Markdown root before selecting its settled-segment projection", () => {
  const turn = new ChatGptPublicTurn("u", "a", 0);
  expect(turn.observe(frame([message("a", null, false)]), 0).items).toEqual([]);
  const prefix = {
    ...message("a", "prefix", false),
    segments: [{ id: "s1", text: "prefix", complete: true }],
  };
  expect(turn.observe(frame([prefix]), 1).items.map((item) => item.id)).toEqual(
    ["s1"],
  );
  expect(turn.observe(frame([message("a", null, false)]), 2).items).toEqual([]);
  expect(turn.observe(frame([prefix]), 3).items).toEqual([]);
});

it("blocks a missing unmaterialized message prefix and rejects inconsistent terminal segment text", () => {
  const turn = new ChatGptPublicTurn("u", "a", 0);
  turn.observe(
    frame([message("a", null, false), message("b", "later", false)]),
    0,
  );
  expect(turn.observe(frame([message("b", "later")]), 1).items).toEqual([]);
  const forged = {
    ...message("a", "different"),
    segments: [{ id: "s1", text: "prefix", complete: true }],
  };
  expect(() =>
    new ChatGptPublicTurn("u", "a", 0).observe(frame([forged], true), 0),
  ).toThrow("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
});

describe("deferred reply projection and unconditional committed validation", () => {
  const segmented = (
    id: string,
    values: [string, string][],
    complete = false,
  ) => ({
    ...message(id, values.map(([, text]) => text).join("\n\n"), complete),
    segments: values.map(([id, text]) => ({ id, text, complete: true })),
  });
  it("allows an earlier reply root to mount and append before a deferred later reply", () => {
    for (const mounting of [true, false]) {
      const turn = new ChatGptPublicTurn("u", "a", 0);
      const initial = mounting
        ? message("a", null, false)
        : segmented("a", [["s1", "prefix"]]);
      expect(
        turn
          .observe(frame([initial, message("b", "later")]), 0)
          .items.map((item) => item.id),
      ).toEqual(mounting ? [] : ["s1"]);
      const next = segmented(
        "a",
        mounting
          ? [["s1", "prefix"]]
          : [
              ["s1", "prefix"],
              ["s2", "append"],
            ],
      );
      expect(
        turn
          .observe(frame([next, message("b", "later")]), 1)
          .items.map((item) => item.id),
      ).toEqual(mounting ? ["s1"] : ["s2"]);
      const final = turn.observe(
        frame([{ ...next, complete: true }, message("b", "later")], true),
        2,
      );
      expect(final.items.map((item) => item.id)).toEqual(["b"]);
      expect(final.answer).toBe(
        mounting ? "prefix\n\nlater" : "prefix\n\nappend\n\nlater",
      );
    }
  });
  it("detects visible committed mutation behind a missing earlier root and remains failed after restoration", () => {
    const turn = new ChatGptPublicTurn("u", "a", 0);
    const a = segmented("a", [["s1", "one"]], true);
    const b = segmented("b", [["s2", "two"]], true);
    expect(turn.observe(frame([a, b]), 0).items).toHaveLength(2);
    expect(() =>
      turn.observe(
        frame([
          message("a", null, false),
          segmented("b", [["s2", "MUTATED"]], true),
        ]),
        1,
      ),
    ).toThrow("CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED");
    expect(() => turn.observe(frame([a, b]), 2)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED",
    );
  });
  it("retains deferred segment anchors and cannot skip their unseen pending prefix", () => {
    const turn = new ChatGptPublicTurn("u", "a", 0);
    const b = segmented(
      "b",
      [
        ["s2", "two"],
        ["s3", "three"],
      ],
      true,
    );
    turn.observe(frame([message("a", null, false), b]), 0);
    expect(
      turn
        .observe(
          frame([message("a", "one"), segmented("b", [["s3", "three"]], true)]),
          1,
        )
        .items.map((item) => item.id),
    ).toEqual(["a"]);
    expect(
      turn.observe(frame([message("a", "one"), b], true), 2),
    ).toMatchObject({ completed: true, answer: "one\n\ntwo\n\nthree" });
  });
  it("admits a materialized later reply after an already committed closed owner was virtualized", () => {
    const turn = new ChatGptPublicTurn("u", "a", 0);
    turn.observe(frame([message("a", "one"), message("b", null, false)]), 0);
    expect(turn.observe(frame([message("b", "two")], true), 1)).toMatchObject({
      completed: true,
      answer: "one\n\ntwo",
    });
  });
});

it("retains a deferred missing tail before admitting the next owner", () => {
  const turn = new ChatGptPublicTurn("u", "a", 0);
  const b = (tail: boolean) => ({
    ...message("b", tail ? "two\n\nthree" : "two"),
    segments: [
      { id: "s2", text: "two", complete: true },
      ...(tail ? [{ id: "s3", text: "three", complete: true }] : []),
    ],
  });
  expect(
    turn.observe(frame([message("a", null, false), b(true)]), 0).items,
  ).toEqual([]);
  expect(
    turn
      .observe(frame([message("a", "one"), b(false), message("c", "later")]), 1)
      .items.map((item) => item.id),
  ).toEqual(["a", "s2"]);
  expect(
    turn.observe(
      frame([message("a", "one"), b(true), message("c", "later")], true),
      2,
    ),
  ).toMatchObject({
    items: [{ id: "s3" }, { id: "c" }],
    completed: true,
    answer: "one\n\ntwo\n\nthree\n\nlater",
  });
});
