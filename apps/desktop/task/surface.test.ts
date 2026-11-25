import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatGptOpenResult,
  ChatGptRoute,
} from "../../../src/apps/desktop/chatgpt-route";
import { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import {
  ProductTaskCommandResultSchema,
  type ProductTask,
  type ProductTaskCommandResult,
} from "../../../src/modules/chat/contract/product-task";
import type { TaskSurfaceStatus } from "../../../src/pkg/ipc/task-surface-status";
import { createTaskSurface, type TaskSurfacePorts } from "./surface";

// The live-task surface helpers over scripted owners. Main's window is a field
// the getter reads afresh, the route is a scripted stand-in whose open settles
// when the test says so, and the layout, focus and persistence ports record
// the order they are called in. A real registry holds the saved tasks and the
// real schema parses the results; no window, surface, provider or profile runs.
const tasksChannel = "farol:tasks-state";

function task(lifecycle: ProductTask["lifecycle"] = "idle") {
  return {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    label: "ChatGPT task 1",
    provider: "chatgpt" as const,
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle,
  } satisfies ProductTask;
}

type OpenResult = ChatGptOpenResult;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function build(
  options: Readonly<{
    demoMode?: boolean;
    closed?: boolean;
    window?: boolean;
    persist?: () => Promise<void>;
    publishStatus?: (status: TaskSurfaceStatus) => void;
  }> = {},
) {
  const state = {
    window: options.window === false ? null : {},
    closed: options.closed ?? false,
  };
  const registry = new LiveTaskRegistry(5);
  const routes = new Map<string, Pick<ChatGptRoute, "open">>();
  const failures = new Map<string, string>();
  const sent: { channel: string; state: unknown }[] = [];
  const order: string[] = [];
  const statuses: TaskSurfaceStatus[] = [];
  const persist = vi.fn(options.persist ?? (() => Promise.resolve()));
  const ports: TaskSurfacePorts<ProductTaskCommandResult> = {
    currentWindow: () =>
      state.window === null
        ? null
        : {
            webContents: {
              send: (channel, value) => {
                sent.push({ channel, state: value });
              },
            },
          },
    demoMode: options.demoMode ?? false,
    channels: { tasksState: tasksChannel },
    desktopAdmission: { closed: () => state.closed },
    liveTaskRegistry: registry,
    liveTaskRoutes: routes,
    taskSurfaceFailures: failures,
    parseResult: (candidate) => ProductTaskCommandResultSchema.parse(candidate),
    persistLiveTaskState: persist,
    publishTaskSurfaceStatus: (status) => {
      statuses.push(status);
      order.push(`status:${status.state}`);
      options.publishStatus?.(status);
    },
    applyLayout: () => {
      order.push("layout");
    },
    focusForLayoutAfterRendererCommit: () => {
      order.push("focus");
    },
  };
  function admit(lifecycle: ProductTask["lifecycle"] = "idle") {
    const saved = task(lifecycle);
    expect(registry.admit(saved).status).toBe("admitted");
    return saved;
  }
  function route(taskId: string) {
    const pending = deferred<OpenResult>();
    const open = vi.fn(() => pending.promise);
    routes.set(taskId, { open });
    return { pending, open };
  }
  return {
    state,
    registry,
    routes,
    failures,
    sent,
    order,
    statuses,
    persist,
    admit,
    route,
    subject: createTaskSurface(ports),
  };
}

const opened: OpenResult = { status: "opened" };
const unreachable: OpenResult = { status: "unreachable" };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("publishTasksState", () => {
  it("sends the registry snapshot on the tasks channel", () => {
    const h = build();
    h.admit();
    h.subject.publishTasksState();
    expect(h.sent).toEqual([
      { channel: tasksChannel, state: h.registry.snapshot() },
    ]);
  });

  it("reads the window afresh at each publish", () => {
    const h = build();
    h.admit();
    h.state.window = null;
    h.subject.publishTasksState();
    expect(h.sent).toEqual([]);
    h.state.window = {};
    h.subject.publishTasksState();
    expect(h.sent).toHaveLength(1);
  });

  it("publishes nothing without a window", () => {
    const h = build({ window: false });
    h.admit();
    expect(() => h.subject.publishTasksState()).not.toThrow();
    expect(h.sent).toEqual([]);
  });

  it("publishes nothing in demo mode", () => {
    const h = build({ demoMode: true });
    h.admit();
    h.subject.publishTasksState();
    expect(h.sent).toEqual([]);
  });
});

describe("taskFailure and taskSuccess", () => {
  it("returns a classified failure carrying the current state", () => {
    const h = build();
    h.admit();
    expect(h.subject.taskFailure("TASK_NOT_FOUND")).toEqual({
      ok: false,
      error: "TASK_NOT_FOUND",
      state: h.registry.snapshot(),
    });
  });

  it("returns a success with the selected task and the current state", () => {
    const h = build();
    const saved = h.admit();
    expect(h.subject.taskSuccess(saved.taskId)).toEqual({
      ok: true,
      state: h.registry.snapshot(),
      selectedTaskId: saved.taskId,
    });
    expect(h.subject.taskSuccess(null)).toMatchObject({
      ok: true,
      selectedTaskId: null,
    });
  });

  it("reads the registry at call time, so a later change is in the result", () => {
    const h = build();
    const before = h.subject.taskSuccess(null);
    h.admit();
    const after = h.subject.taskSuccess(null);
    expect(after).not.toEqual(before);
    expect(after).toMatchObject({ state: h.registry.snapshot() });
  });

  it("lets a refused parse reach the caller, never a half result", () => {
    const h = build();
    expect(() => h.subject.taskFailure("NOT_A_COMMAND_ERROR")).toThrow();
  });
});

describe("setLiveTaskLifecycle", () => {
  it("sets, publishes and then persists the new lifecycle", async () => {
    const h = build();
    const saved = h.admit();
    h.subject.setLiveTaskLifecycle(saved.taskId, "running");
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("running");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.state).toEqual(h.registry.snapshot());
    expect(h.persist).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("running");
  });

  it("does nothing when the lifecycle is already the requested one", () => {
    const h = build();
    const saved = h.admit("running");
    h.subject.setLiveTaskLifecycle(saved.taskId, "running");
    expect(h.sent).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("surfaces a failed save as an unknown outcome and never repeats it", async () => {
    const h = build({ persist: () => Promise.reject(new Error("DISK")) });
    const saved = h.admit();
    h.subject.setLiveTaskLifecycle(saved.taskId, "running");
    await flush();
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("outcome_unknown");
    // The lifecycle change and the surfaced failure each publish once.
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.state).toEqual(h.registry.snapshot());
  });

  it("does not publish or persist for an unknown task", () => {
    const h = build();
    h.subject.setLiveTaskLifecycle("missing", "running");
    expect(h.sent).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });
});

describe("surfaceLiveTaskPersistenceFailure", () => {
  it("marks the task unknown and publishes", () => {
    const h = build();
    const saved = h.admit();
    h.subject.surfaceLiveTaskPersistenceFailure(saved.taskId);
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("outcome_unknown");
    expect(h.sent).toHaveLength(1);
  });

  it("ignores an unknown task", () => {
    const h = build();
    h.subject.surfaceLiveTaskPersistenceFailure("missing");
    expect(h.sent).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });
});

describe("openLiveTaskSurface", () => {
  it("publishes ready, then lays out and focuses, once the route opens", async () => {
    const h = build();
    const saved = h.admit();
    h.failures.set(saved.taskId, "TASK_SURFACE_UNREACHABLE");
    const { pending, open } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    pending.resolve(opened);
    expect(await opening).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.failures.has(saved.taskId)).toBe(false);
    expect(h.statuses).toEqual([
      { taskId: saved.taskId, state: "ready", error: null },
    ]);
    expect(h.order).toEqual(["status:ready", "layout", "focus"]);
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("idle");
  });

  it("returns a failed task to idle when its surface opens", async () => {
    const h = build();
    const saved = h.admit("failed");
    const { pending } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    pending.resolve(opened);
    expect(await opening).toBe(true);
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("idle");
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("classifies an unreachable surface once and fails the idle task", async () => {
    const h = build();
    const saved = h.admit();
    const { pending, open } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    pending.resolve(unreachable);
    expect(await opening).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.failures.get(saved.taskId)).toBe("TASK_SURFACE_UNREACHABLE");
    expect(h.statuses).toEqual([
      {
        taskId: saved.taskId,
        state: "failed",
        error: "TASK_SURFACE_UNREACHABLE",
      },
    ]);
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("failed");
    expect(h.order).toEqual(["status:failed"]);
  });

  it("classifies a rejected open the same way, without rethrowing", async () => {
    const h = build();
    const saved = h.admit();
    const { pending } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    pending.reject(new Error("ROUTE_BROKE"));
    expect(await opening).toBe(false);
    expect(h.failures.get(saved.taskId)).toBe("TASK_SURFACE_UNREACHABLE");
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("failed");
  });

  it.each(["running", "outcome_unknown", "completed"] as const)(
    "keeps a %s task's lifecycle when its surface is unreachable",
    async (lifecycle) => {
      const h = build();
      const saved = h.admit(lifecycle);
      const { pending } = h.route(saved.taskId);
      const opening = h.subject.openLiveTaskSurface(saved.taskId);
      pending.resolve(unreachable);
      expect(await opening).toBe(false);
      expect(h.registry.get(saved.taskId)?.lifecycle).toBe(lifecycle);
      expect(h.failures.get(saved.taskId)).toBe("TASK_SURFACE_UNREACHABLE");
      expect(h.persist).not.toHaveBeenCalled();
    },
  );

  it("keeps the classified failure when the status observer throws", async () => {
    const h = build({
      publishStatus: () => {
        throw new Error("OBSERVER_DOWN");
      },
    });
    const saved = h.admit();
    const { pending } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    pending.resolve(unreachable);
    expect(await opening).toBe(false);
    expect(h.failures.get(saved.taskId)).toBe("TASK_SURFACE_UNREACHABLE");
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("failed");
  });

  it("refuses without opening when admission is closed", async () => {
    const h = build({ closed: true });
    const saved = h.admit();
    const { open } = h.route(saved.taskId);
    expect(await h.subject.openLiveTaskSurface(saved.taskId)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(h.order).toEqual([]);
  });

  it.each(["route", "task"] as const)(
    "refuses without the saved %s",
    async (missing) => {
      const h = build();
      const saved = h.admit();
      const { open } = h.route(saved.taskId);
      if (missing === "route") h.routes.delete(saved.taskId);
      else h.registry.remove(saved.taskId);
      expect(await h.subject.openLiveTaskSurface(saved.taskId)).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(h.order).toEqual([]);
    },
  );

  it.each([
    ["removed", "opened"],
    ["removed", "unreachable"],
    ["route replaced", "opened"],
    ["route replaced", "unreachable"],
  ] as const)(
    "does nothing when the task is %s while the surface %s settles",
    async (change, outcome) => {
      const h = build();
      const saved = h.admit();
      const { pending } = h.route(saved.taskId);
      const opening = h.subject.openLiveTaskSurface(saved.taskId);
      if (change === "removed") h.registry.remove(saved.taskId);
      else h.routes.set(saved.taskId, { open: () => Promise.resolve(opened) });
      pending.resolve(outcome === "opened" ? opened : unreachable);
      expect(await opening).toBe(false);
      expect(h.order).toEqual([]);
      expect(h.failures.size).toBe(0);
      expect(h.persist).not.toHaveBeenCalled();
    },
  );

  it("stops after the ready status when it withdraws the route", async () => {
    const h = build({
      publishStatus: (status) => {
        if (status.state === "ready") h.routes.clear();
      },
    });
    const saved = h.admit("failed");
    const { pending } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    pending.resolve(opened);
    expect(await opening).toBe(false);
    expect(h.order).toEqual(["status:ready"]);
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("failed");
  });

  it("reads the window afresh after the await, so a closed window is not written", async () => {
    const h = build();
    const saved = h.admit("failed");
    const { pending } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    h.state.window = null;
    pending.resolve(opened);
    expect(await opening).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("idle");
  });

  it("publishes the recovered lifecycle to the window that exists after the await", async () => {
    const h = build({ window: false });
    const saved = h.admit("failed");
    const { pending } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    h.state.window = {};
    pending.resolve(opened);
    expect(await opening).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  it("publishes no task list in demo mode while still opening the surface", async () => {
    const h = build({ demoMode: true });
    const saved = h.admit("failed");
    const { pending } = h.route(saved.taskId);
    const opening = h.subject.openLiveTaskSurface(saved.taskId);
    pending.resolve(opened);
    expect(await opening).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.order).toEqual(["status:ready", "layout", "focus"]);
    expect(h.registry.get(saved.taskId)?.lifecycle).toBe("idle");
  });
});
