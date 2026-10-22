import { describe, expect, it } from "vitest";
import {
  adjacentSetupSection,
  setupSections,
  visibleSetupSection,
} from "../../src/ui/renderer/setup-checklist";

describe("guided Setup order", () => {
  it("has one four-step order after welcome", () => {
    expect(setupSections).toEqual([
      ["overview", "Overview"],
      ["signin", "Sign in"],
      ["folders", "Workspaces"],
      ["connection", "Connect this Mac"],
      ["attachment", "Add to ChatGPT"],
    ]);
  });
  it("keeps legacy and invalid routes at welcome", () => {
    for (const step of ["finish", null, undefined, 17, {}, "invalid"]) {
      expect(visibleSetupSection(step)).toBe("overview");
      expect(adjacentSetupSection(step, 1)).toBe("signin");
    }
  });
  it("moves only to the adjacent guided step", () => {
    for (let i = 0; i < setupSections.length; i++) {
      const step = setupSections[i]![0];
      expect(adjacentSetupSection(step, -1)).toBe(
        setupSections[i - 1]?.[0] ?? null,
      );
      expect(adjacentSetupSection(step, 1)).toBe(
        setupSections[i + 1]?.[0] ?? null,
      );
    }
  });
});
