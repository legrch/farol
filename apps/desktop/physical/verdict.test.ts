import { describe, expect, it } from "vitest";
import {
  fullTerminal,
  refuse,
  sameView,
  selectionMatches,
  unknown,
  validCorrelation,
} from "./verdict";

const view = {
  viewId: "1",
  viewGeneration: 1,
  documentGeneration: 1,
  partition: "persist:farol-dev-chatgpt",
} as const;
const home = {
  ...view,
  phase: "home",
  url: "https://chatgpt.com/",
  conversationId: null,
} as const;
const fact = (value: string) => ({
  state: "observed" as const,
  source: "public-dom" as const,
  value,
});
const none = { state: "unknown" as const, code: "not-exposed" as const };
const selection = (required: boolean) =>
  ({
    controls: {
      modelLabel: "M",
      effortLabel: "E",
      modeLabel: null,
      connector: null,
    },
    requiredControls: {
      model: true,
      effort: required,
      mode: false,
      connector: false,
    },
  }) as never;
const observed = (effort: typeof none | ReturnType<typeof fact>) =>
  ({
    modelLabel: fact("M"),
    effortLabel: effort,
    modeLabel: none,
    connectorLabel: none,
  }) as never;
const message = (id: string, parentId: string | null, complete = true) => ({
  id,
  parentId,
  channel: "answer",
  complete,
  text: "a",
});
const frame = (terminal: boolean, complete = true) =>
  ({
    userId: "u",
    terminal,
    messages: [message("r", "u", complete)],
  }) as never;
const basis = {
  correlation: { userTurnId: null, replyId: null },
  baselineUserIds: ["old"],
  previous: null,
};

describe("verdict", () => {
  it("builds classified failures", () => {
    expect(refuse("A")).toEqual({ state: "refused", code: "A" });
    expect(unknown("B")).toEqual({ state: "unknown", code: "B" });
  });

  it("compares view identity only", () => {
    expect(
      sameView(
        home as never,
        { ...home, url: "https://chatgpt.com/x" } as never,
      ),
    ).toBe(true);
    expect(
      sameView(home as never, { ...home, viewGeneration: 2 } as never),
    ).toBe(false);
  });

  it("matches observed labels to declared controls", () => {
    expect(selectionMatches(selection(true), observed(fact("E")))).toBe(true);
    expect(selectionMatches(selection(true), observed(fact("X")))).toBe(false);
    expect(selectionMatches(selection(true), observed(none))).toBe(false);
    expect(selectionMatches(selection(false), observed(none))).toBe(true);
  });

  it("requires a complete answer for terminal frames", () => {
    expect(fullTerminal(frame(true))).toBe(true);
    expect(fullTerminal(frame(true, false))).toBe(false);
    expect(fullTerminal(frame(false))).toBe(false);
  });

  it("accepts only correlations that extend the adopted identity", () => {
    const ids = { userTurnId: "u", replyId: "r" };
    expect(validCorrelation(basis, ids, frame(false))).toBe(true);
    expect(validCorrelation(basis, ids, null)).toBe(false);
    expect(
      validCorrelation(basis, { userTurnId: "old", replyId: null }, null),
    ).toBe(false);
    expect(
      validCorrelation(
        { ...basis, correlation: ids },
        { ...ids, replyId: "z" },
        null,
      ),
    ).toBe(false);
    expect(validCorrelation(basis, ids, frame(true, false))).toBe(false);
  });
});
