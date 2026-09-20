import { describe, expect, it } from "vitest";
import {
  guardedEditApplyPrerequisite,
  searchMatchDisplay,
  workspaceSearchPrerequisite,
} from "../../src/ui/computer-presentation";

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

describe("why a Computer control cannot be used yet", () => {
  it("names the verification before the pattern, in the order the owner meets them", () => {
    expect(workspaceSearchPrerequisite(false, "")).toBe(
      "Verify this workspace again first.",
    );
    expect(workspaceSearchPrerequisite(false, "needle")).toBe(
      "Verify this workspace again first.",
    );
    expect(workspaceSearchPrerequisite(true, "   ")).toBe(
      "Enter a text pattern to search for.",
    );
    expect(workspaceSearchPrerequisite(true, "needle")).toBeNull();
  });

  it("states the half of the guarded-edit rule that was only ever enforced", () => {
    // The note above the fields states "one exact match". That the
    // replacement must differ was enforced silently.
    expect(guardedEditApplyPrerequisite("same", "same")).toContain(
      "identical to the text it replaces",
    );
    expect(guardedEditApplyPrerequisite("", "anything")).toBe(
      "Enter the exact text to replace.",
    );
    expect(guardedEditApplyPrerequisite("old", "new")).toBeNull();
  });

  it("asks for the text to replace before comparing it to anything", () => {
    expect(guardedEditApplyPrerequisite("", "")).toBe(
      "Enter the exact text to replace.",
    );
  });
});
