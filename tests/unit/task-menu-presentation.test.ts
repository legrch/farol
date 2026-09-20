import { describe, expect, it } from "vitest";
import {
  agentActionPrerequisite,
  agentFieldPrerequisite,
  agentWorkspaceFixedReason,
  reviewComputerRequestPrerequisite,
  taskCancelPrerequisite,
  taskClosePrerequisite,
  taskRenamePrerequisite,
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
  agentUnavailable: null,
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

describe("why Run or Rejoin Agent cannot be pressed", () => {
  const runnable = {
    busy: false,
    workspaceReason: null,
    uncertain: false,
    contextLocked: false,
    needsRejoin: false,
    objective: "Review the changed files",
    scopeValid: true,
  };

  it("says a rejoin is blocked by its workspace, instead of going quiet", () => {
    // The reported case: a child is running, the workspace stops being
    // verified, and the panel goes on saying "Running · Rejoin checks the
    // same native child" over a dead button.
    const reason = agentActionPrerequisite({
      ...runnable,
      needsRejoin: true,
      workspaceReason: "The approved workspace is no longer verified.",
    });
    expect(reason).toBe("The approved workspace is no longer verified.");
  });

  it("carries that same reason into the menu's note", () => {
    expect(
      taskMenuNote({
        ...idle,
        agentUnavailable: "The approved workspace is no longer verified.",
      }),
    ).toBe("The approved workspace is no longer verified.");
  });

  it("leaves an ordinary task's note alone", () => {
    // shell.ts passes this field only for a task that has an Agent
    // assignment; the note must behave exactly as before without it.
    expect(taskMenuNote(idle)).toMatch(/^Close removes this local task/u);
  });

  it("lets a rejoin past the objective and scope, which it does not need", () => {
    expect(
      agentActionPrerequisite({
        ...runnable,
        needsRejoin: true,
        objective: "",
        scopeValid: false,
      }),
    ).toBeNull();
  });

  it("asks a new assignment for an objective and a usable scope", () => {
    expect(agentActionPrerequisite({ ...runnable, objective: "   " })).toBe(
      "Describe what this Agent assignment should do.",
    );
    expect(agentActionPrerequisite({ ...runnable, scopeValid: false })).toMatch(
      /canonical relative paths/u,
    );
  });

  it("keeps the order the disabled flag already had", () => {
    expect(
      agentActionPrerequisite({
        ...runnable,
        busy: true,
        workspaceReason: "workspace",
        uncertain: true,
      }),
    ).toBe(TASK_MENU_BUSY_NOTE);
    expect(
      agentActionPrerequisite({
        ...runnable,
        workspaceReason: "workspace",
        uncertain: true,
      }),
    ).toBe("workspace");
    expect(
      agentActionPrerequisite({
        ...runnable,
        uncertain: true,
        contextLocked: true,
      }),
    ).toMatch(/^Outcome unknown is not Failed\./u);
  });

  it("has nothing to say when the assignment can run", () => {
    expect(agentActionPrerequisite(runnable)).toBeNull();
  });
});

describe("why the selected task cannot be renamed", () => {
  const renameable = { busy: false, provider: "chatgpt", label: "A name" };

  it("names the one condition the handler used to swallow", () => {
    // `if (task?.provider !== "chatgpt") return;` — enabled control, silent
    // return, no command and no feedback. A press with no effect and no
    // sentence reads exactly like a hang, and is how this reached us: as a
    // thirty-second wait for a message that was never going to arrive.
    expect(taskRenamePrerequisite({ ...renameable, provider: "fixture" })).toBe(
      "Only a live ChatGPT task can be renamed.",
    );
    expect(taskRenamePrerequisite({ ...renameable, provider: null })).toBe(
      "Only a live ChatGPT task can be renamed.",
    );
  });

  it("asks for a name rather than renaming a task to nothing", () => {
    expect(taskRenamePrerequisite({ ...renameable, label: "   " })).toBe(
      "Enter a name for this task.",
    );
  });

  it("puts the in-flight command first, as the other controls do", () => {
    expect(
      taskRenamePrerequisite({
        ...renameable,
        busy: true,
        provider: "fixture",
      }),
    ).toBe(TASK_MENU_BUSY_NOTE);
  });

  it("has nothing to say for a live task with a name", () => {
    expect(taskRenamePrerequisite(renameable)).toBeNull();
  });
});

describe("the task-menu controls that carried a boolean and no sentence", () => {
  it("says why Cancel is unavailable, for each of its reasons", () => {
    const running = {
      busy: false,
      contextLocked: false,
      agentRunning: false,
      agentLocked: false,
      lifecycle: "running",
    };
    expect(taskCancelPrerequisite(running)).toBeNull();
    expect(taskCancelPrerequisite({ ...running, busy: true })).toBe(
      TASK_MENU_BUSY_NOTE,
    );
    expect(taskCancelPrerequisite({ ...running, contextLocked: true })).toMatch(
      /context operation is still active/u,
    );
    expect(
      taskCancelPrerequisite({ ...running, lifecycle: "complete" }),
    ).toMatch(/nothing to ask the provider to stop/u);
    expect(taskCancelPrerequisite({ ...running, agentLocked: true })).toMatch(
      /has to be reconciled/u,
    );
    // A running native child stays cancellable whatever the task's own
    // lifecycle says — the flag always allowed that and now the sentence
    // agrees.
    expect(
      taskCancelPrerequisite({
        ...running,
        agentRunning: true,
        lifecycle: "complete",
        agentLocked: true,
      }),
    ).toBeNull();
  });

  it("says why Close is unavailable", () => {
    expect(
      taskClosePrerequisite({ busy: false, agentLocked: false }),
    ).toBeNull();
    expect(taskClosePrerequisite({ busy: true, agentLocked: false })).toBe(
      TASK_MENU_BUSY_NOTE,
    );
    expect(taskClosePrerequisite({ busy: false, agentLocked: true })).toMatch(
      /has to be reconciled/u,
    );
  });

  it("gives the five Agent fields one reason between them", () => {
    const editable = {
      busy: false,
      agentLocked: false,
      workspaceReason: null,
    };
    expect(agentFieldPrerequisite(editable)).toBeNull();
    expect(agentFieldPrerequisite({ ...editable, busy: true })).toBe(
      TASK_MENU_BUSY_NOTE,
    );
    expect(agentFieldPrerequisite({ ...editable, agentLocked: true })).toMatch(
      /locked until the existing native child/u,
    );
    expect(
      agentFieldPrerequisite({
        ...editable,
        workspaceReason: "No verified workspace.",
      }),
    ).toBe("No verified workspace.");
  });
});
