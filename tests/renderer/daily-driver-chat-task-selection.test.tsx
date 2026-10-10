import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Shell } from "../../src/ui/renderer/shell";
import { Services } from "../../src/ui/renderer/services";
import { WindowController } from "../../src/ui/renderer/controller";
import { bootstrap, fixture, task } from "./fixture";
// Real renderer/controller publications, mocked API; no native/provider proof.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const other = { ...task("other-task"), label: "Other work" };
const target = {
  ...task("target-task"),
  label: "Current work",
  agent: {
    phase: "running",
    workspaceId: "approved",
    parentDelivery: "not_applicable",
    workspaceEnforcement: "verified",
    resultAvailable: false,
  },
};
async function mount() {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    taskRevision: 1,
    tasks: [other, target],
  });
  const c = new WindowController(f.api);
  await c.start();
  c.navigate({ area: "chatgpt", taskId: other.taskId });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StrictMode>
        <Services value={c}>
          <Shell />
        </Services>
      </StrictMode>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    c.dispose();
  });
  const captured = host.querySelector<HTMLButtonElement>(
    '[aria-label="Farol work"] button',
  )!;
  expect(captured.textContent).toContain("Current work");
  return { f, c, host, captured };
}
it.each([
  "removed",
  "task-replaced",
  "session-rebound",
  "turn-rebound",
  "observation-unavailable",
  "stale",
  "offline",
] as const)(
  "retained Farol work selection refuses %s before React rerenders",
  async (change) => {
    const { f, c, captured } = await mount();
    const navigate = vi.spyOn(c, "navigate");
    const activate = vi.spyOn(c, "task");
    await act(async () => {
      if (change === "stale")
        f.emit("tasks", {
          revision: 1,
          tasks: [other, { ...target, label: "Conflicting observation" }],
        });
      else if (change === "offline")
        f.emit("runtime", {
          state: "offline",
          error: null,
          identity: null,
          embeddedNode: null,
          embeddedElectron: null,
        });
      else {
        const changed =
          change === "task-replaced"
            ? { ...target, taskId: "replacement-task" }
            : change === "session-rebound"
              ? { ...target, sessionId: "replacement-session" }
              : change === "turn-rebound"
                ? { ...target, turnId: "replacement-turn" }
                : {
                    ...target,
                    agent: { ...target.agent, observation: "unavailable" },
                  };
        f.emit("tasks", {
          revision: 2,
          tasks: change === "removed" ? [other] : [other, changed],
        });
      }
      // The subscribed facade is already current; this node still holds the old render.
      expect(captured.isConnected).toBe(true);
      expect(captured.textContent).toContain("Current work");
      captured.click();
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(c.getSnapshot().destination.taskId).toBe(other.taskId);
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
  },
);
it.each(["unchanged", "metadata-update"] as const)(
  "retained Farol work selection activates a current task after %s",
  async (change) => {
    const { f, c, captured } = await mount();
    const current =
      change === "metadata-update"
        ? { ...target, label: "Renamed current work", pinned: true }
        : target;
    vi.mocked(f.api.task).mockResolvedValue({
      ok: true,
      state: { revision: 2, tasks: [other, current] },
      selectedTaskId: target.taskId,
    });
    await act(async () => {
      if (change === "metadata-update")
        f.emit("tasks", { revision: 2, tasks: [other, current] });
      expect(captured.textContent).toContain("Current work");
      captured.click();
    });
    expect(f.api.task).toHaveBeenCalledExactlyOnceWith({
      kind: "task.activate",
      taskId: target.taskId,
    });
    expect(c.getSnapshot().destination).toMatchObject({
      area: "chatgpt",
      taskId: target.taskId,
    });
    expect(f.api.configure).not.toHaveBeenCalled();
  },
);

it.each([
  "session-rebound",
  "turn-rebound",
  "observation-unavailable",
] as const)(
  "Farol work activation refuses %s published by a navigation subscriber",
  async (change) => {
    const { f, c, captured } = await mount();
    const activate = vi.spyOn(c, "task");
    let published = false;
    const unsubscribe = c.subscribe(() => {
      if (published || c.getSnapshot().destination.taskId !== target.taskId)
        return;
      published = true;
      const changed =
        change === "session-rebound"
          ? { ...target, sessionId: "replacement-session" }
          : change === "turn-rebound"
            ? { ...target, turnId: "replacement-turn" }
            : {
                ...target,
                agent: { ...target.agent, observation: "unavailable" },
              };
      f.emit("tasks", { revision: 2, tasks: [other, changed] });
    });
    try {
      await act(async () => captured.click());
      expect(published).toBe(true);
      expect(c.getSnapshot()).toMatchObject({
        status: "current",
        runtime: "ready",
      });
      expect(c.getSnapshot().tasks.revision).toBe(2);
      expect(activate).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
      expect(f.api.configure).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  },
);
it("Farol work activation preserves same-identity metadata published by a navigation subscriber", async () => {
  const { f, c, captured } = await mount();
  const current = { ...target, label: "Renamed current work", pinned: true };
  vi.mocked(f.api.task).mockResolvedValue({
    ok: true,
    state: { revision: 2, tasks: [other, current] },
    selectedTaskId: target.taskId,
  });
  let published = false;
  const unsubscribe = c.subscribe(() => {
    if (published || c.getSnapshot().destination.taskId !== target.taskId)
      return;
    published = true;
    f.emit("tasks", { revision: 2, tasks: [other, current] });
  });
  try {
    await act(async () => captured.click());
    expect(published).toBe(true);
    expect(f.api.task).toHaveBeenCalledExactlyOnceWith({
      kind: "task.activate",
      taskId: target.taskId,
    });
    expect(c.getSnapshot().destination).toMatchObject({
      area: "chatgpt",
      taskId: target.taskId,
    });
    expect(f.api.configure).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});
