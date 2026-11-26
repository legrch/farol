import { describe, expect, it } from "vitest";
import { pages } from "./pages";

describe("pages", () => {
  it("lists the settings pages in rail order with their headings", () => {
    expect(pages).toEqual([
      ["general", "General"],
      ["appearance", "Appearance"],
      ["shortcuts", "Keyboard shortcuts"],
    ]);
  });
});
