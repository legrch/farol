import { describe, expect, it } from "vitest";
import {
  agentWorkspaceFixedReason,
  reviewComputerRequestPrerequisite,
  TASK_MENU_BUSY_NOTE,
  taskMenuNote,
  type TaskMenuNoteState,
} from "../../src/ui/task-menu-presentation";

const idle: TaskMenuNoteState = {
  feedback: "",
  busy: false,
  contextLocked: false,
  contextLabel: null,
  agentLocked: false,
  agentRunning: false,
  uncertain: false,
  lifecycle: "complete",
};

describe("the task menu's one sentence", () => {
  it("says a command is in flight instead of saying nothing", () => {
    // The guard that refuses a second command is correct. Refusing it in
    // silence is what made a pressed control indistinguishable from a
    // broken one: the feedback line is cleared when the command starts, so
    // without this the owner pressed and read nothing at all.
    expect(taskMenuNote({ ...idle, busy: true })).toBe(TASK_MENU_BUSY_NOTE);
    expect(TASK_MENU_BUSY_NOTE).not.toBe("");
  });

  it("does not offer advice about actions it is not accepting right now", () => {
    // Every one of these would otherwise print standing advice about Cancel
    // and Close while the menu was refusing both.
    for (const state of [
      { ...idle, busy: true, lifecycle: "running" },
      { ...idle, busy: true, contextLocked: true, contextLabel: "Handoff" },
      { ...idle, busy: true, agentLocked: true, agentRunning: true },
      { ...idle, busy: true, uncertain: true },
    ]) {
      expect(taskMenuNote(state)).toBe(TASK_MENU_BUSY_NOTE);
    }
  });

  it("lets a finished command's own result outrank the busy sentence", () => {
    // feedback is only set once a command has completed, so if both are
    // somehow present the result is the newer fact and the answer to what
    // the owner just did.
    expect(
      taskMenuNote({ ...idle, busy: true, feedback: "Task renamed." }),
    ).toBe("Task renamed.");
  });

  it("keeps every existing sentence, in the order it had", () => {
    expect(
      taskMenuNote({ ...idle, contextLocked: true, contextLabel: "Handoff" }),
    ).toMatch(/^Handoff is still active\./u);
    expect(
      taskMenuNote({ ...idle, contextLocked: true, contextLabel: null }),
    ).toMatch(/^Context transition is still active\./u);
    expect(
      taskMenuNote({ ...idle, agentLocked: true, agentRunning: true }),
    ).toMatch(/Cancel interrupts this exact native child/u);
    expect(
      taskMenuNote({ ...idle, agentLocked: true, agentRunning: false }),
    ).toMatch(/Closing and provider cancellation stay unavailable/u);
    expect(taskMenuNote({ ...idle, uncertain: true })).toMatch(
      /^Outcome unknown is not Failed\./u,
    );
    expect(taskMenuNote({ ...idle, lifecycle: "running" })).toMatch(
      /^Cancel requests a provider stop\./u,
    );
    expect(taskMenuNote(idle)).toMatch(/^Close removes this local task/u);
  });

  it("puts a context lock ahead of an agent lock, as it always did", () => {
    expect(
      taskMenuNote({
        ...idle,
        contextLocked: true,
        contextLabel: "Handoff",
        agentLocked: true,
        uncertain: true,
      }),
    ).toMatch(/^Handoff is still active\./u);
  });
});

describe("the Agent's approved-workspace field", () => {
  it("says which workspace it is fixed to, and where to change it", () => {
    const reason = agentWorkspaceFixedReason(true);
    expect(reason).toContain("one workspace it has verified");
    expect(reason).toContain("Computer");
  });

  it("names the prerequisite when nothing has been verified yet", () => {
    const reason = agentWorkspaceFixedReason(false);
    expect(reason).toContain("No workspace has been verified");
    expect(reason).toContain("Approve one in Computer");
  });

  it("always has something to say, so the field is never silently inert", () => {
    for (const ready of [true, false]) {
      expect(agentWorkspaceFixedReason(ready).length).toBeGreaterThan(0);
    }
  });
});

describe("why Review Computer request cannot be pressed", () => {
  it("says the task is not waiting for one, rather than sitting grey", () => {
    expect(reviewComputerRequestPrerequisite(false)).toBe(
      "This task is not waiting for a Computer request right now.",
    );
  });

  it("has nothing to say when a request is actually waiting", () => {
    expect(reviewComputerRequestPrerequisite(true)).toBeNull();
  });
});
