import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskEditor } from "../../src/ui/renderer/task";
import { WindowController } from "../../src/ui/renderer/controller";
import { bootstrap, deferred, fixture, task } from "./fixture";

// Renderer/typed-adapter fixtures only. No provider or native task execution.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  document.body.replaceChildren();
});
async function mount(over: Record<string, unknown> = {}) {
  const f = fixture();
  const running = { ...task(), lifecycle: "running", ...over };
  const state = { revision: 1, tasks: [running] };
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    taskRevision: 1,
    tasks: [running],
  });
  vi.mocked(f.api.task).mockResolvedValue({
    ok: true,
    state,
    selectedTaskId: null,
  });
  const c = new WindowController(f.api);
  await c.start();
  c.navigate({ area: "chatgpt", taskId: "task-1" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return (
      <TaskEditor
        key={snapshot.destination.taskId}
        snapshot={snapshot}
        facade={c}
      />
    );
  }
  const render = () =>
    act(async () =>
      root.render(
        <StrictMode>
          <View />
        </StrictMode>,
      ),
    );
  await render();
  cleanup.push(async () => {
    await act(async () => root.unmount());
    c.dispose();
  });
  const button = (label: string) => {
    const result = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  };
  return {
    f,
    c,
    host,
    state,
    button,
    result: () =>
      host.querySelector('[aria-label="Chat action results"]')?.textContent,
    click: (label: string) => act(async () => button(label).click()),
    hide: () => act(async () => root.render(null)),
    show: render,
  };
}

it.each([
  ["Rename", "rename", "TASK_SURFACE_UNREACHABLE", "Could not be completed"],
  [
    "Pin",
    "pin",
    "TASK_OPERATION_IN_PROGRESS",
    "Another action is still in progress",
  ],
  ["Cancel work", "cancel", "TASK_CANCEL_FAILED", "Outcome unknown"],
  ["Close chat", "close", "TASK_SURFACE_UNREACHABLE", "Could not be completed"],
] as const)(
  "retains %s outcome in its panel after dismissal",
  async (label, action, code, message) => {
    const h = await mount();
    vi.mocked(h.f.api.task).mockResolvedValueOnce({
      ok: false,
      error: code,
      state: h.state,
    });
    await h.click(label);
    expect(h.result()).toContain(`${label}: ${message}`);
    expect(h.result()).not.toContain(code);
    await h.hide();
    await h.show();
    expect(h.result()).toContain(`${label}: ${message}`);
    expect(h.c.getSnapshot().intents[`${action}:task-1`]?.code).toBe(code);
    if (action === "cancel") {
      expect(h.button(label).disabled).toBe(true);
      await h.click(label);
    }
    expect(h.f.api.task).toHaveBeenCalledTimes(1);
  },
);
it("retains a late unknown Cancel after unmount and never reports it as cancelled", async () => {
  const h = await mount();
  const waiting = deferred<unknown>();
  vi.mocked(h.f.api.task).mockReturnValueOnce(waiting.promise);
  await h.click("Cancel work");
  expect(h.result()).toContain("Cancel work: In progress");
  expect(h.button("Cancel work").disabled).toBe(true);
  await h.hide();
  await act(async () =>
    waiting.resolve({ ok: false, error: "TASK_CANCEL_FAILED", state: h.state }),
  );
  await h.show();
  expect(h.result()).toContain("Cancel work: Outcome unknown");
  expect(h.result()).not.toContain("Confirmed");
  expect(h.button("Cancel work").disabled).toBe(true);
  await h.click("Cancel work");
  expect(h.f.api.task).toHaveBeenCalledTimes(1);
});
it("keeps Cancel available after the page it would have stopped changed", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "TASK_CANCEL_PAGE_CHANGED",
    state: h.state,
  });
  await h.click("Cancel work");
  expect(h.result()).toContain(
    "Cancel work: Not cancelled. The ChatGPT window no longer shows this task's turn. Use Stop in the ChatGPT window",
  );
  expect(h.result()).not.toContain("Outcome unknown");
  expect(h.button("Cancel work").disabled).toBe(false);
  await h.click("Cancel work");
  expect(h.f.api.task).toHaveBeenCalledTimes(2);
});
it("keeps Cancel available, and says why, while the turn is not yet bound to its conversation", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "TASK_CANCEL_NOT_YET_BOUND",
    state: h.state,
  });
  await h.click("Cancel work");
  expect(h.result()).toContain("Cancel work: Not cancelled yet");
  expect(h.result()).not.toContain("Outcome unknown");
  expect(h.button("Cancel work").disabled).toBe(false);
  await h.click("Cancel work");
  expect(h.f.api.task).toHaveBeenCalledTimes(2);
});
// A Cancel whose click may have run leaves the task unknown; its turn is
// still in flight until the route reports it settled.
const unknownTask = (revision: number, inFlight: boolean) => ({
  revision,
  tasks: [
    {
      ...task(),
      lifecycle: "outcome_unknown",
      ...(inFlight ? { turnInFlight: true } : {}),
    },
  ],
});
it.each([
  ["running", false],
  ["idle", true],
  ["completed", true],
  ["failed", true],
  ["cancelled", true],
  ["outcome_unknown", false],
] as const)(
  "keeps Cancel disabled for a %s task whose turn in flight is %s",
  async (lifecycle, inFlight) => {
    const h = await mount({
      lifecycle,
      ...(inFlight ? { turnInFlight: true } : {}),
    });
    expect(h.button("Cancel work").disabled).toBe(lifecycle !== "running");
    await h.click("Cancel work");
    expect(h.f.api.task).toHaveBeenCalledTimes(lifecycle === "running" ? 1 : 0);
  },
);
it("offers Cancel again for an unknown task whose turn is still in flight", async () => {
  const h = await mount({ lifecycle: "outcome_unknown", turnInFlight: true });
  expect(h.button("Cancel work").disabled).toBe(false);
  await h.click("Cancel work");
  expect(h.f.api.task).toHaveBeenCalledWith({
    kind: "task.cancel",
    taskId: "task-1",
  });
});
it("retries an unconfirmed Cancel while the turn runs, and confirms it", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "TASK_CANCEL_FAILED",
    state: unknownTask(2, true),
  });
  await h.click("Cancel work");
  expect(h.result()).toContain("Cancel work: Outcome unknown");
  // The unknown result stays retained, and the retry is still offered.
  expect(h.c.getSnapshot().intents["cancel:task-1"]?.state).toBe("unknown");
  expect(h.button("Cancel work").disabled).toBe(false);

  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: true,
    state: {
      revision: 3,
      tasks: [{ ...task(), lifecycle: "cancelled" }],
    },
    selectedTaskId: null,
  });
  await h.click("Cancel work");
  expect(h.f.api.task).toHaveBeenCalledTimes(2);
  expect(h.result()).toContain("Cancel work: Confirmed.");
  expect(h.button("Cancel work").disabled).toBe(true);
});
it("keeps a second unconfirmed Cancel unknown and retryable", async () => {
  const h = await mount();
  for (const revision of [2, 3]) {
    vi.mocked(h.f.api.task).mockResolvedValueOnce({
      ok: false,
      error: "TASK_CANCEL_FAILED",
      state: unknownTask(revision, true),
    });
    expect(h.button("Cancel work").disabled).toBe(false);
    await h.click("Cancel work");
    expect(h.result()).toContain("Cancel work: Outcome unknown");
  }
  expect(h.f.api.task).toHaveBeenCalledTimes(2);
  expect(h.button("Cancel work").disabled).toBe(false);
});
it("does not downgrade the unknown result when the retry is refused", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "TASK_CANCEL_FAILED",
    state: unknownTask(2, true),
  });
  await h.click("Cancel work");
  // The turn settled before the retry reached the main process.
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "TASK_NOT_RUNNING",
    state: unknownTask(3, false),
  });
  await h.click("Cancel work");
  expect(h.f.api.task).toHaveBeenCalledTimes(2);
  expect(h.result()).toContain("Cancel work: Outcome unknown");
  expect(h.c.getSnapshot().intents["cancel:task-1"]).toMatchObject({
    state: "unknown",
    code: "TASK_CANCEL_FAILED",
  });
  // Nothing is in flight now: the retry is gone.
  expect(h.button("Cancel work").disabled).toBe(true);
  await h.click("Cancel work");
  expect(h.f.api.task).toHaveBeenCalledTimes(2);
});
it("closes the retry when the turn settles after an unknown Cancel", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "TASK_CANCEL_FAILED",
    state: unknownTask(2, true),
  });
  await h.click("Cancel work");
  expect(h.button("Cancel work").disabled).toBe(false);
  await act(async () => h.f.emit("tasks", unknownTask(3, false)));
  expect(h.button("Cancel work").disabled).toBe(true);
});
it("keeps Cancel disabled after any other unknown outcome, even with the turn in flight", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
    state: unknownTask(2, true),
  });
  await h.click("Cancel work");
  expect(h.result()).toContain("Cancel work: Outcome unknown");
  expect(h.c.getSnapshot().intents["cancel:task-1"]?.code).toBe(
    "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
  );
  expect(h.button("Cancel work").disabled).toBe(true);
  await h.click("Cancel work");
  expect(h.f.api.task).toHaveBeenCalledTimes(1);
});
it("never lifts the lock of another action's unknown result", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    // The one code that lifts a Cancel's lock, on an action it must not lift.
    error: "TASK_CANCEL_FAILED",
    state: unknownTask(2, true),
  });
  await h.click("Pin");
  expect(h.result()).toContain("Pin: Outcome unknown");
  expect(h.button("Pin").disabled).toBe(true);
  await h.click("Pin");
  expect(h.f.api.task).toHaveBeenCalledTimes(1);
});
it("shows successful Close even after the closed chat disappears from the task list", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: true,
    state: { revision: 2, tasks: [] },
    selectedTaskId: null,
  });
  await h.click("Close chat");
  expect(h.result()).toContain("Close chat: Confirmed.");
  await h.hide();
  await h.show();
  expect(h.result()).toContain("Close chat: Confirmed.");
  expect(h.f.api.task).toHaveBeenCalledTimes(1);
});
it("does not attach one chat's refusal to another chat", async () => {
  const h = await mount();
  vi.mocked(h.f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "TASK_SURFACE_UNREACHABLE",
    state: h.state,
  });
  await h.click("Rename");
  await act(async () =>
    h.f.emit("tasks", {
      revision: 2,
      tasks: [...h.state.tasks, task("task-2")],
    }),
  );
  await act(async () => h.c.navigate({ area: "chatgpt", taskId: "task-2" }));
  expect(h.result()).toBeUndefined();
  await act(async () => h.c.navigate({ area: "chatgpt", taskId: "task-1" }));
  expect(h.result()).toContain("Rename: Could not be completed");
  expect(h.f.api.task).toHaveBeenCalledTimes(1);
});
it("shows an immediate validation refusal even after an earlier successful action", async () => {
  const h = await mount();
  await h.click("Rename");
  expect(h.result()).toContain("Rename: Confirmed");
  vi.spyOn(h.c, "task").mockResolvedValueOnce({
    id: "rename:task-1",
    state: "refused",
    code: "TASK_COMMAND_INVALID",
  });
  await h.click("Rename");
  expect(h.result()).toContain("Rename: Could not be completed");
  expect(h.result()).not.toContain("Rename: Confirmed");
  expect(h.f.api.task).toHaveBeenCalledTimes(1);
});
