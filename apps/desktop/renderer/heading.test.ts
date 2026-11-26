import { describe, expect, it } from "vitest";
import type { WindowSnapshot } from "../../../src/ui/renderer/contract";
import { setupSteps } from "../../../src/ui/renderer/setup-navigation";
import { title } from "./heading";

function snap(
  destination: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  return {
    activity: [],
    tasks: { tasks: [] },
    destination,
    ...over,
  } as unknown as WindowSnapshot;
}

describe("title", () => {
  it("names the settings page, falling back to Settings", () => {
    expect(title(snap({ area: "settings", page: "appearance" }), "all")).toBe(
      "Appearance",
    );
    expect(title(snap({ area: "settings", page: "nope" }), "all")).toBe(
      "Settings",
    );
  });
  it("names the addressed agent chat, falling back to ChatGPT", () => {
    const tasks = {
      tasks: [
        { taskId: "a", label: "Not an agent" },
        { taskId: "b", label: "Agent chat", agent: {} },
      ],
    };
    expect(
      title(snap({ area: "chatgpt", taskId: "b" }, { tasks }), "all"),
    ).toBe("Agent chat");
    expect(
      title(snap({ area: "chatgpt", taskId: "a" }, { tasks }), "all"),
    ).toBe("ChatGPT");
  });
  it("delegates the activity heading to the selected event", () => {
    const activity = [{ id: "e", label: "Recorded", phase: "completed" }];
    expect(title(snap({ area: "activity" }, { activity }), "all")).toBe(
      "Recorded",
    );
  });
  it("names setup steps, with the attachment step numbered", () => {
    expect(title(snap({ area: "setup", setupStep: "attachment" }), "all")).toBe(
      "4. Add Farol to ChatGPT",
    );
    const [step, label] = setupSteps[0]!;
    expect(title(snap({ area: "setup", setupStep: step }), "all")).toBe(label);
    expect(title(snap({ area: "setup", setupStep: "zzz" }), "all")).toBe(
      "Setup",
    );
  });
  it("defaults to Home", () => {
    expect(title(snap({ area: "home" }), "all")).toBe("Home");
  });
});
