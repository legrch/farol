import { describe, expect, it } from "vitest";
import { searchMatchDisplay } from "../../src/ui/computer-presentation";

describe("Computer search match presentation", () => {
  it("marks a truncated excerpt instead of presenting it as the whole line", () => {
    expect(searchMatchDisplay({ text: "…needle…", truncated: true })).toEqual({
      text: "…needle… …",
      title: "Excerpt of a longer line around the match",
    });
  });

  it("shows a complete line unchanged", () => {
    expect(searchMatchDisplay({ text: "needle", truncated: false })).toEqual({
      text: "needle",
      title: null,
    });
  });
});
