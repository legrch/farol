import { describe, expect, it } from "vitest";
import {
  chatViewLabel,
  navigationTitle,
} from "../../src/ui/navigation-presentation";

describe("chat view labels", () => {
  it.each([1, 2, 3, 4, 5, 12])(
    "shortens saved default view %i without renumbering",
    (ordinal) => {
      expect(chatViewLabel(`ChatGPT task ${ordinal}`)).toBe(
        `ChatGPT ${ordinal}`,
      );
      expect(chatViewLabel(`ChatGPT ${ordinal}`)).toBe(`ChatGPT ${ordinal}`);
    },
  );
  it("preserves custom names and strips only the explicit demo prefix", () => {
    expect(chatViewLabel("Review task 3")).toBe("Review task 3");
    expect(chatViewLabel("ChatGPT task research")).toBe(
      "ChatGPT task research",
    );
    expect(chatViewLabel("Demo · ChatGPT task 2")).toBe("ChatGPT 2");
  });
});

describe("window navigation title", () => {
  it.each(["Overview", "Sign in", "Folders", "Connection", "Add to ChatGPT"])(
    "shows the selected Setup page %s",
    (setupPage) => {
      expect(
        navigationTitle({ section: "computer", setupPage, settingsPage: null }),
      ).toBe(setupPage);
    },
  );
  it("does not leak the retained Setup selection into other sections", () => {
    expect(
      navigationTitle({
        section: "activity",
        setupPage: "Overview",
        settingsPage: "model",
      }),
    ).toBe("Activity");
    expect(
      navigationTitle({
        section: "browser",
        setupPage: "Folders",
        settingsPage: "diagnostics",
      }),
    ).toBe("ChatGPT");
    expect(
      navigationTitle({
        section: "settings",
        setupPage: "Connection",
        settingsPage: "preferences",
      }),
    ).toBe("Preferences");
  });
});
