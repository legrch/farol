import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAXIMUM_PROMPT_CHARACTERS,
  MAXIMUM_CHECKPOINT_CONTENT_BYTES,
  promptBudgetValid,
  promptWithinBudget,
} from "./limit";

describe("summary limits", () => {
  it("keeps the published sizes", () => {
    expect(DEFAULT_MAXIMUM_PROMPT_CHARACTERS).toBe(131_072);
    expect(MAXIMUM_CHECKPOINT_CONTENT_BYTES).toBe(262_144);
  });

  it("accepts only a positive whole number as a budget", () => {
    expect(promptBudgetValid(1)).toBe(true);
    expect(promptBudgetValid(DEFAULT_MAXIMUM_PROMPT_CHARACTERS)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(promptBudgetValid(bad)).toBe(false);
    }
  });

  it("admits a prompt exactly at the budget and refuses one past it", () => {
    expect(promptWithinBudget("abc", 3)).toBe(true);
    expect(promptWithinBudget("abcd", 3)).toBe(false);
    expect(promptWithinBudget("", 1)).toBe(true);
  });
});
