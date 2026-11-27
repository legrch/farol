import { describe, expect, it } from "vitest";
import { initial } from "../../../apps/desktop/renderer/snapshot";
import type { Intent, WindowSnapshot } from "./contract";
import {
  commandOutcomeUnknown,
  displayable,
  displayCode,
  followsSelectedTask,
  ownOpenUnsettled,
  presentBrowserEarly,
  presentBrowserReply,
  rearmsSetupCompletion,
  shortcutsReply,
  taskFailure,
  taskReceiptUnknown,
} from "./outcome";

const intent = (state: Intent["state"], code: string | null): Intent => ({
  id: "k",
  state,
  code,
});

describe("displayCode", () => {
  it("keeps bounded upper-case identifiers and hides everything else", () => {
    expect(displayCode("SOME_CODE_1")).toBe("SOME_CODE_1");
    expect(displayCode("some code")).toBe("DIAGNOSTIC_CODE_UNAVAILABLE");
    expect(displayCode("A".repeat(121))).toBe("DIAGNOSTIC_CODE_UNAVAILABLE");
  });
  it("keeps the state and null code of a result", () => {
    expect(displayable(intent("applied", null))).toEqual(
      intent("applied", null),
    );
    expect(displayable(intent("refused", "bad code"))).toEqual(
      intent("refused", "DIAGNOSTIC_CODE_UNAVAILABLE"),
    );
  });
});

describe("outcome classification", () => {
  it("an uncertain command is unknown, never refused", () => {
    expect(commandOutcomeUnknown("k")).toEqual(
      intent("unknown", "COMMAND_OUTCOME_UNKNOWN"),
    );
    expect(taskReceiptUnknown("k").state).toBe("unknown");
  });
  it("only explicit unknown task failures stay unknown", () => {
    expect(taskFailure("TASK_OUTCOME_UNKNOWN", "k").state).toBe("unknown");
    expect(taskFailure("X_OUTCOME_UNKNOWN_Y", "k").state).toBe("unknown");
    expect(taskFailure("TASK_CANCEL_FAILED", "k").state).toBe("unknown");
    expect(taskFailure("TASK_REFUSED", "k")).toEqual(
      intent("refused", "TASK_REFUSED"),
    );
  });
  it("a Cancel that raced the child's completion is unknown, not refused", () => {
    // The stop reached the child: a refusal would claim it was not touched.
    expect(taskFailure("AGENT_CANCEL_RACED_COMPLETION", "k")).toEqual(
      intent("unknown", "AGENT_CANCEL_RACED_COMPLETION"),
    );
  });
  it("AGENT_ASSIGNMENT_FAILED is unknown for a Cancel and refused for a run", () => {
    // A host `failed` reply to a Cancel means the stop was sent; a stored
    // terminal sends nothing. One code cannot tell them apart, so it is unknown.
    expect(taskFailure("AGENT_ASSIGNMENT_FAILED", "cancel:t")).toEqual({
      id: "cancel:t",
      state: "unknown",
      code: "AGENT_ASSIGNMENT_FAILED",
    });
    // A run refused before any spawn is a correct refusal.
    expect(taskFailure("AGENT_ASSIGNMENT_FAILED", "agent:t")).toEqual({
      id: "agent:t",
      state: "refused",
      code: "AGENT_ASSIGNMENT_FAILED",
    });
    expect(taskFailure("AGENT_ASSIGNMENT_FAILED", "rejoin:t").state).toBe(
      "refused",
    );
  });
  it("a shortcut reply is unknown unless it is a closed reply", () => {
    const bad = { success: false } as Parameters<typeof shortcutsReply>[0];
    const refused = { success: true, data: { ok: false } } as Parameters<
      typeof shortcutsReply
    >[0];
    const ok = { success: true, data: { ok: true } } as Parameters<
      typeof shortcutsReply
    >[0];
    expect(shortcutsReply(bad).state).toBe("unknown");
    expect(shortcutsReply(refused).code).toBe("SHORTCUTS_REFUSED");
    expect(shortcutsReply(ok)).toEqual({
      id: "shortcuts",
      state: "applied",
      code: null,
    });
  });
  it("a browser presentation reply is unknown when malformed", () => {
    const bad = { success: false } as Parameters<typeof presentBrowserReply>[1];
    expect(presentBrowserReply("k", bad).code).toBe(
      "CONFIGURATION_OUTCOME_UNKNOWN",
    );
    const refused = {
      success: true,
      data: { ok: false, error: "WHY" },
    } as unknown as Parameters<typeof presentBrowserReply>[1];
    expect(presentBrowserReply("k", refused)).toEqual(intent("refused", "WHY"));
  });
});

describe("setup completion rearming", () => {
  it("only pre-transport refusals rearm", () => {
    expect(rearmsSetupCompletion(intent("refused", "SETUP_INCOMPLETE"))).toBe(
      true,
    );
    expect(
      rearmsSetupCompletion(intent("refused", "CURRENT_STATE_REQUIRED")),
    ).toBe(true);
    expect(rearmsSetupCompletion(intent("refused", "OTHER"))).toBe(false);
    expect(rearmsSetupCompletion(intent("unknown", "SETUP_INCOMPLETE"))).toBe(
      false,
    );
  });
});

const ready = (patch: Partial<WindowSnapshot> = {}): WindowSnapshot => ({
  ...initial,
  status: "current",
  runtime: "ready",
  ...patch,
});

describe("browser presentation", () => {
  it("refuses outside the browser area", () => {
    expect(presentBrowserEarly(ready(), "k")?.state).toBe("refused");
  });
  it("is already applied once the document is loaded or a task owns it", () => {
    const chat = { ...initial.destination, area: "chatgpt" as const };
    expect(
      presentBrowserEarly(ready({ destination: chat, route: "loaded" }), "k")
        ?.state,
    ).toBe("applied");
    expect(
      presentBrowserEarly(ready({ destination: { ...chat, taskId: "t" } }), "k")
        ?.state,
    ).toBe("applied");
  });
  it("keeps an unsettled own open and otherwise proceeds to transport", () => {
    const chat = { ...initial.destination, area: "chatgpt" as const };
    const open = ready({
      destination: chat,
      intents: { "settings:chatgpt.open-browser:": intent("unknown", null) },
    });
    expect(ownOpenUnsettled(open)).toBe(true);
    expect(presentBrowserEarly(open, "k")?.code).toBe(
      "CHATGPT_PRESENTATION_UNAVAILABLE",
    );
    const applied = ready({
      destination: chat,
      intents: { "settings:chatgpt.open-sign-in:": intent("applied", null) },
    });
    expect(ownOpenUnsettled(applied)).toBe(false);
    expect(presentBrowserEarly(applied, "k")).toBeNull();
  });
});

describe("followsSelectedTask", () => {
  const selected = { taskId: "t", sessionId: "s", turnId: "u" };
  const state = ready({
    tasks: { revision: 1, tasks: [selected] },
    overlay: "none",
  } as Partial<WindowSnapshot>);
  const input = {
    sameContext: true,
    state,
    selected: selected as Parameters<typeof followsSelectedTask>[0]["selected"],
    navigationUnchanged: true,
  };
  it("follows only when every fence still holds", () => {
    expect(followsSelectedTask(input)).toBe(true);
    expect(followsSelectedTask({ ...input, sameContext: false })).toBe(false);
    expect(followsSelectedTask({ ...input, navigationUnchanged: false })).toBe(
      false,
    );
    expect(
      followsSelectedTask({
        ...input,
        state: { ...state, overlay: "search" },
      }),
    ).toBe(false);
    expect(
      followsSelectedTask({
        ...input,
        state: { ...state, runtime: "offline" },
      }),
    ).toBe(false);
    expect(
      followsSelectedTask({
        ...input,
        selected: { ...selected, turnId: "other" } as typeof input.selected,
      }),
    ).toBe(false);
  });
});
