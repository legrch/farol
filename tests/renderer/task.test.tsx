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
async function mount() {
  const f = fixture();
  const running = { ...task(), lifecycle: "running" };
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
