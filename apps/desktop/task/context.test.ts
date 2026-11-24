import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import {
  LiveTaskRegistry,
  type PromotionLeaseGuard,
} from "../../../src/apps/desktop/live-task-registry";
import { TaskMutationGate } from "../../../src/apps/desktop/task-mutation-gate";
import {
  createContextHost,
  type ContextBinding,
  type ContextHostPorts,
  type ExecutionFence,
} from "./context";

// The Route B and context host over scripted owners. Main's `let`s are fields
// the ports read afresh; the controller, the fence, the Route B starter and the
// routes are fakes that record what they were given; the registry and the
// mutation gate are the real ones, and the state directory is a real private
// temporary directory so the recovery record is written on a real file system.
// No provider, window, account, connector or Browser route runs.

function fake<T>(value: unknown): T {
  return value as T;
}

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function privateTemp(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "context-host-")),
  );
  roots.push(root);
  return root;
}

const threadA = "0199c0de-0000-7000-8000-00000000d001";
const threadB = "0199c0de-0000-7000-8000-00000000d002";

type Attempt = Readonly<{ operationId: string; phase: string }>;

function build(
  options: Readonly<{
    root: string;
    registry?: LiveTaskRegistry;
    persist?: () => Promise<void>;
    open?: (taskId: string) => Promise<boolean>;
    relay?: boolean;
    start?: () => Promise<unknown>;
    store?: Partial<{
      load: (binding: ContextBinding) => Promise<unknown>;
      listTaskBindings: () => Promise<unknown>;
      listSummaryAttempts: (binding: ContextBinding) => Promise<Attempt[]>;
      deleteTask: (binding: ContextBinding) => Promise<void>;
    }>;
    fenceReconcile?: () => Promise<void>;
    registryRestored?: boolean;
    storeLoaded?: boolean;
    recoveryFile?: string;
  }>,
) {
  const events: string[] = [];
  const registry = options.registry ?? new LiveTaskRegistry(5);
  const taskMutations = new TaskMutationGate();
  const liveTaskRoutes = new Map<string, ChatGptRoute>();
  const liveTaskConversationUrls = new Map<string, string | null>();
  const state = {
    registryRestored: options.registryRestored ?? true,
    storeLoaded: options.storeLoaded ?? true,
    relay: options.relay ?? false,
  };
  const surface = { id: "route", dispose: vi.fn() };
  const createLiveChatGptRoute = vi.fn((taskId: string, label: string) => {
    events.push(`route:${taskId}:${label}`);
    return fake<ChatGptRoute>(surface);
  });
  const fallbackRoutes: unknown[] = [];
  const createContextSummaryFallbackRoute = vi.fn(
    (binding: ContextBinding, url?: string) => {
      fallbackRoutes.push({ binding, url });
      return fake<ChatGptRoute>({ id: "fallback" });
    },
  );
  const persistLiveTaskState = vi.fn(async () => {
    events.push("persist");
    await options.persist?.();
  });
  const publishTasksState = vi.fn(() => {
    events.push("publish");
  });
  const openLiveTaskSurface = vi.fn(async (taskId: string) => {
    events.push(`open:${taskId}`);
    return options.open ? options.open(taskId) : true;
  });

  const fence = {
    raise: vi.fn(async () => {}),
    lower: vi.fn(async () => {}),
    reconcile: vi.fn(async (_unresolved: unknown) => {
      await options.fenceReconcile?.();
    }),
    release: vi.fn(async () => {}),
    acquireAdmission: vi.fn(async () => ({ admitted: false as const })),
  };
  const createExecutionFence = vi.fn((root: string) => {
    events.push(`fence:${root}`);
    return fake<ExecutionFence>(fence);
  });

  const store = {
    load: vi.fn(
      options.store?.load ??
        (async (): Promise<unknown> => {
          return null;
        }),
    ),
    listTaskBindings: vi.fn(
      options.store?.listTaskBindings ?? (async (): Promise<unknown> => []),
    ),
    listSummaryAttempts: vi.fn(
      options.store?.listSummaryAttempts ?? (async () => []),
    ),
    deleteTask: vi.fn(options.store?.deleteTask ?? (async () => {})),
  };
  const continuity = { id: "continuity" };
  const controller = { store, continuity };
  const controllerOptions: Record<string, unknown>[] = [];
  const createCodexContextController = vi.fn((given: unknown) => {
    controllerOptions.push(given as Record<string, unknown>);
    return fake<ReturnType<ContextHostPorts["createCodexContextController"]>>(
      controller,
    );
  });
  const runtime = {
    owns: vi.fn(() => false),
    close: vi.fn(async () => {}),
    endpoint: { baseUrl: "http://127.0.0.1:1", token: "t" },
    id: "route-b",
  };
  const runtimeStarts: Record<string, unknown>[] = [];
  const startRouteBRuntime = vi.fn(async (given: unknown) => {
    runtimeStarts.push(given as Record<string, unknown>);
    if (options.start) return fake<never>(await options.start());
    return fake<never>(runtime);
  });
  const relayHandle = { openTurn: vi.fn() };
  const routeBTaskSurfaces = { surfaceFor: vi.fn() };

  const ports: ContextHostPorts = {
    statePaths: () => ({
      state: path.join(options.root, "state"),
      summaryFenceRecovery:
        options.recoveryFile ??
        path.join(options.root, "state", "context", "fence-recovery.json"),
      secureMcpLaunch: path.join(options.root, "launch"),
      contextContinuity: path.join(options.root, "continuity"),
    }),
    contextOwnerId: "owner-desktop",
    contextProviderProfileId: "profile-isolated-farol",
    contextModel: "chatgpt",
    taskMutations,
    liveTaskRegistry: registry,
    liveTaskRoutes,
    liveTaskConversationUrls,
    liveTaskStore: () => (state.storeLoaded ? fake<never>({}) : null),
    liveTaskRegistryRestored: () => state.registryRestored,
    routeBTaskSurfaces:
      fake<ContextHostPorts["routeBTaskSurfaces"]>(routeBTaskSurfaces),
    callerRelay: () => (state.relay ? fake<never>(relayHandle) : null),
    persistLiveTaskState,
    publishTasksState,
    openLiveTaskSurface,
    createLiveChatGptRoute,
    createContextSummaryFallbackRoute,
    createExecutionFence,
    createCodexContextController,
    startRouteBRuntime:
      fake<ContextHostPorts["startRouteBRuntime"]>(startRouteBRuntime),
  };
  const host = createContextHost(ports);
  return {
    host,
    ports,
    events,
    registry,
    taskMutations,
    liveTaskRoutes,
    liveTaskConversationUrls,
    state,
    surface,
    fence,
    createExecutionFence,
    store,
    controller,
    controllerOptions,
    createCodexContextController,
    runtime,
    runtimeStarts,
    startRouteBRuntime,
    relayHandle,
    routeBTaskSurfaces,
    createLiveChatGptRoute,
    createContextSummaryFallbackRoute,
    fallbackRoutes,
    persistLiveTaskState,
    publishTasksState,
    openLiveTaskSurface,
  };
}

function task(taskId: string, label: string) {
  return {
    taskId,
    sessionId: taskId,
    turnId: `turn-${taskId}`,
    label,
    provider: "chatgpt" as const,
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle" as const,
  };
}

describe("context binding", () => {
  it("binds the thread to the owner, the profile and the model", async () => {
    const h = build({ root: await privateTemp() });
    expect(h.host.binding("thread-1")).toEqual({
      ownerId: "owner-desktop",
      taskId: "thread-1",
      hostThreadId: "thread-1",
      sessionId: "thread-1",
      providerProfileId: "profile-isolated-farol",
      modelId: "chatgpt",
      mode: "chatgpt",
    });
  });
});

describe("Route B task admission", () => {
  it("admits a thread as a running task, then opens its surface", async () => {
    const h = build({ root: await privateTemp() });
    const result = await h.host.admitRouteBTask(threadA);
    expect(result).toEqual({ ok: true, surface: h.surface });
    expect(h.registry.get(threadA)).toMatchObject({
      taskId: threadA,
      sessionId: threadA,
      label: "Codex task 1",
      provider: "chatgpt",
      requestedModel: "Account default",
      requestedMode: "Account default",
      hasComputer: false,
      pinned: false,
      lifecycle: "running",
    });
    expect(h.liveTaskRoutes.get(threadA)).toBe(h.surface);
    expect(h.liveTaskConversationUrls.get(threadA)).toBeNull();
    // The durable write comes before the route, the publication and the open.
    expect(h.events).toEqual([
      "persist",
      `route:${threadA}:Codex task 1`,
      "publish",
      `open:${threadA}`,
    ]);
    expect(h.taskMutations.inFlight()).toBe(false);
  });

  it("numbers the label past every Codex task label already in use", async () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(task("a", "Codex task 1"));
    registry.admit(task("b", "Codex task 2"));
    registry.admit(task("c", "Codex task 4"));
    const h = build({ root: await privateTemp(), registry });
    await h.host.admitRouteBTask(threadA);
    expect(h.registry.get(threadA)?.label).toBe("Codex task 3");
  });

  it("refuses as busy while another task mutation holds the gate, and touches nothing", async () => {
    const h = build({ root: await privateTemp() });
    const claim = h.taskMutations.tryEnter();
    expect(claim).not.toBeNull();
    await expect(h.host.admitRouteBTask(threadA)).resolves.toEqual({
      ok: false,
      code: "TASK_ROUTE_BUSY",
    });
    expect(h.registry.snapshot().tasks).toEqual([]);
    expect(h.events).toEqual([]);
    // The refused admission leaves the other mutation's claim alone.
    expect(h.taskMutations.inFlight()).toBe(true);
    claim?.release();
    expect(h.taskMutations.inFlight()).toBe(false);
  });

  it("holds the gate for the whole admission", async () => {
    let seen: boolean | null = null;
    const h = build({
      root: await privateTemp(),
      persist: async () => {
        seen = h.taskMutations.inFlight();
      },
    });
    await h.host.admitRouteBTask(threadA);
    expect(seen).toBe(true);
  });

  it("refuses with TASK_STATE_UNAVAILABLE and rolls back when the save fails", async () => {
    const h = build({
      root: await privateTemp(),
      persist: async () => {
        throw new Error("disk");
      },
    });
    await expect(h.host.admitRouteBTask(threadA)).resolves.toEqual({
      ok: false,
      code: "TASK_STATE_UNAVAILABLE",
    });
    expect(h.registry.snapshot().tasks).toEqual([]);
    expect(h.liveTaskRoutes.size).toBe(0);
    expect(h.openLiveTaskSurface).not.toHaveBeenCalled();
    expect(h.taskMutations.inFlight()).toBe(false);
  });

  it("refuses with TASK_CAPACITY_REACHED when the registry is full", async () => {
    const registry = new LiveTaskRegistry(1);
    registry.admit(task("a", "Existing"));
    const h = build({ root: await privateTemp(), registry });
    await expect(h.host.admitRouteBTask(threadA)).resolves.toEqual({
      ok: false,
      code: "TASK_CAPACITY_REACHED",
    });
    expect(h.persistLiveTaskState).not.toHaveBeenCalled();
    expect(h.createLiveChatGptRoute).not.toHaveBeenCalled();
  });

  it("refuses with TASK_ROUTE_UNAVAILABLE for a pending promotion", async () => {
    const guard: PromotionLeaseGuard = {
      acquireForAdmission: async () => null,
    };
    const h = build({
      root: await privateTemp(),
      registry: new LiveTaskRegistry(5, guard),
    });
    await expect(h.host.admitRouteBTask(threadA)).resolves.toEqual({
      ok: false,
      code: "TASK_ROUTE_UNAVAILABLE",
    });
    expect(h.registry.snapshot().tasks).toEqual([]);
    expect(h.createLiveChatGptRoute).not.toHaveBeenCalled();
  });

  it("refuses with TASK_ROUTE_UNAVAILABLE for a thread that is already a task", async () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(task(threadA, "Existing"));
    const h = build({ root: await privateTemp(), registry });
    await expect(h.host.admitRouteBTask(threadA)).resolves.toEqual({
      ok: false,
      code: "TASK_ROUTE_UNAVAILABLE",
    });
    expect(h.createLiveChatGptRoute).not.toHaveBeenCalled();
  });

  it("refuses with TASK_SURFACE_UNREACHABLE when the surface does not open, keeping the admitted task", async () => {
    const h = build({ root: await privateTemp(), open: async () => false });
    await expect(h.host.admitRouteBTask(threadA)).resolves.toEqual({
      ok: false,
      code: "TASK_SURFACE_UNREACHABLE",
    });
    expect(h.registry.get(threadA)).not.toBeNull();
    expect(h.liveTaskRoutes.get(threadA)).toBe(h.surface);
    expect(h.taskMutations.inFlight()).toBe(false);
  });
});

describe("context controller start", () => {
  it("raises the fence on the launch root and builds the controller over the continuity root", async () => {
    const root = await privateTemp();
    const h = build({ root });
    expect(h.host.controller.get()).toBeNull();
    expect(h.host.fence.get()).toBeNull();
    await h.host.initializeCodexContextController();
    expect(h.createExecutionFence).toHaveBeenCalledOnce();
    expect(h.createExecutionFence).toHaveBeenCalledWith(
      path.join(root, "launch"),
    );
    expect(h.host.fence.get()).toBe(h.fence);
    expect(h.host.controller.get()).toBe(h.controller);
    expect(h.controllerOptions).toHaveLength(1);
    expect(h.controllerOptions[0]).toMatchObject({
      ownerId: "owner-desktop",
      providerProfileId: "profile-isolated-farol",
      stateRoot: path.join(root, "continuity"),
    });
    expect(h.controllerOptions[0]?.summaryRoutes).toMatchObject({
      createFallback: h.createContextSummaryFallbackRoute,
    });
  });

  it("maps the summary fence onto the connector fence by task id and operation id", async () => {
    const h = build({ root: await privateTemp() });
    await h.host.initializeCodexContextController();
    const given = h.controllerOptions[0] as unknown as {
      summaryFence: {
        raise(input: unknown): Promise<void>;
        lower(input: unknown): Promise<void>;
      };
    };
    await given.summaryFence.raise({
      operationId: "op-1",
      binding: { taskId: "task-1", other: true },
    });
    await given.summaryFence.lower({
      operationId: "op-1",
      binding: { taskId: "task-1" },
    });
    expect(h.fence.raise).toHaveBeenCalledWith({
      operationId: "op-1",
      taskId: "task-1",
    });
    expect(h.fence.lower).toHaveBeenCalledWith("op-1");
  });

  it("reads retained routes and live tasks afresh, and forwards the fallbacks", async () => {
    const h = build({ root: await privateTemp() });
    await h.host.initializeCodexContextController();
    const given = h.controllerOptions[0] as unknown as {
      liveTask(taskId: string): boolean;
      summaryRoutes: {
        retained(binding: { taskId: string }): unknown;
        createFallback: unknown;
        recoverFallback(binding: unknown, url: string): unknown;
      };
    };
    expect(given.liveTask(threadA)).toBe(false);
    h.registry.admit(task(threadA, "Task"));
    expect(given.liveTask(threadA)).toBe(true);
    expect(given.summaryRoutes.retained({ taskId: threadA })).toBeNull();
    h.liveTaskRoutes.set(threadA, h.surface as unknown as ChatGptRoute);
    expect(given.summaryRoutes.retained({ taskId: threadA })).toBe(h.surface);
    const binding = h.host.binding(threadA);
    given.summaryRoutes.recoverFallback(binding, "https://chatgpt.test/c/1");
    expect(h.fallbackRoutes).toEqual([
      { binding, url: "https://chatgpt.test/c/1" },
    ]);
  });

  it("publishes a changed context of a live task after saving it, and ignores an unknown task", async () => {
    const h = build({ root: await privateTemp() });
    await h.host.initializeCodexContextController();
    const given = h.controllerOptions[0] as unknown as {
      onContextStateChanged(session: unknown): Promise<void>;
    };
    h.registry.admit(task(threadA, "Task"));
    const session = (taskId: string) => ({
      binding: { taskId },
      epoch: 2,
      phase: "blocked",
      blockedCode: "CONTEXT_BLOCKED",
    });
    await given.onContextStateChanged(session(threadB));
    expect(h.events).toEqual([`fence:${h.ports.statePaths().secureMcpLaunch}`]);
    await given.onContextStateChanged(session(threadA));
    expect(h.registry.get(threadA)?.context).toEqual({
      epoch: 2,
      phase: "blocked",
      source: null,
      code: "CONTEXT_BLOCKED",
    });
    expect(h.events.slice(1)).toEqual(["persist", "publish"]);
  });
});

describe("Route B runtime start", () => {
  it("does nothing without a controller", async () => {
    const h = build({ root: await privateTemp() });
    await h.host.initializeRouteBRuntime();
    expect(h.startRouteBRuntime).not.toHaveBeenCalled();
    expect(h.host.routeB.get()).toBeNull();
  });

  it("starts once over the state root, the surfaces and the continuity", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.host.initializeCodexContextController();
    await h.host.initializeRouteBRuntime();
    expect(h.host.routeB.get()).toBe(h.runtime);
    expect(h.runtimeStarts).toHaveLength(1);
    expect(h.runtimeStarts[0]).toEqual({
      stateRoot: path.join(root, "state"),
      surfaces: h.routeBTaskSurfaces,
      compaction: h.controller.continuity,
    });
    // A second start finds the runtime and leaves it alone.
    await h.host.initializeRouteBRuntime();
    expect(h.startRouteBRuntime).toHaveBeenCalledOnce();
    expect(h.host.routeB.get()).toBe(h.runtime);
  });

  it("hands the runtime the relay read at the start when there is one", async () => {
    const h = build({ root: await privateTemp(), relay: true });
    await h.host.initializeCodexContextController();
    await h.host.initializeRouteBRuntime();
    expect(h.runtimeStarts[0]?.relay).toBe(h.relayHandle);
  });

  it("leaves Route B unavailable when the start fails, and does not retry", async () => {
    const h = build({
      root: await privateTemp(),
      start: async () => {
        throw new Error("PORT_IN_USE");
      },
    });
    await h.host.initializeCodexContextController();
    await expect(h.host.initializeRouteBRuntime()).resolves.toBeUndefined();
    expect(h.host.routeB.get()).toBeNull();
    expect(h.startRouteBRuntime).toHaveBeenCalledOnce();
  });
});

describe("restart reconciliation", () => {
  it("does nothing without a controller", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.host.reconcileContextAfterRestart();
    expect(h.persistLiveTaskState).not.toHaveBeenCalled();
    expect(h.store.load).not.toHaveBeenCalled();
    expect(h.host.recovery.get()).toBeNull();
    await expect(
      stat(path.join(root, "state", "context", "fence-recovery.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers the fence from the store and records the result once", async () => {
    const root = await privateTemp();
    const h = build({
      root,
      store: {
        listTaskBindings: async () => [
          { readable: true, binding: { taskId: threadA } },
        ],
        listSummaryAttempts: async () => [
          { operationId: "op-sent", phase: "submitted" },
          { operationId: "op-prepared", phase: "prepared" },
        ],
      },
    });
    h.registry.admit(task(threadA, "Task"));
    await h.host.initializeCodexContextController();
    await h.host.reconcileContextAfterRestart();
    expect(h.fence.reconcile).toHaveBeenCalledOnce();
    expect(h.fence.reconcile).toHaveBeenCalledWith([
      { operationId: "op-sent", taskId: threadA },
    ]);
    expect(h.host.recovery.get()).toEqual({
      status: "reconciled",
      unresolved: 1,
    });
    const file = path.join(root, "state", "context", "fence-recovery.json");
    const written = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect(written).toMatchObject({
      schema: 1,
      status: "reconciled",
      unresolved: 1,
    });
    expect(typeof written.at).toBe("string");
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
  });

  it("keeps every record and records the unreadable store", async () => {
    const root = await privateTemp();
    const h = build({
      root,
      store: {
        listTaskBindings: async () => {
          throw new Error("unreadable");
        },
      },
    });
    await h.host.initializeCodexContextController();
    await h.host.reconcileContextAfterRestart();
    expect(h.fence.reconcile).not.toHaveBeenCalled();
    expect(h.host.recovery.get()).toEqual({
      status: "kept",
      code: "CONTEXT_STORE_UNREADABLE",
    });
    const file = path.join(root, "state", "context", "fence-recovery.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      status: "kept",
      code: "CONTEXT_STORE_UNREADABLE",
    });
  });

  it("holds the connector closed by the sentinel when the fence cannot reconcile", async () => {
    const h = build({
      root: await privateTemp(),
      fenceReconcile: async () => {
        throw new Error("EACCES");
      },
    });
    await h.host.initializeCodexContextController();
    await h.host.reconcileContextAfterRestart();
    expect(h.fence.raise).toHaveBeenCalledOnce();
    expect(h.host.recovery.get()).toEqual({
      status: "kept",
      code: "EXECUTION_FENCE_UNRECONCILED",
      held: true,
    });
  });

  it("keeps the recovery result when it cannot be recorded", async () => {
    const root = await privateTemp();
    const blocker = path.join(root, "blocker");
    await writeFile(blocker, "file");
    const h = build({
      root,
      recoveryFile: path.join(blocker, "sub", "fence-recovery.json"),
    });
    await h.host.initializeCodexContextController();
    await expect(
      h.host.reconcileContextAfterRestart(),
    ).resolves.toBeUndefined();
    expect(h.host.recovery.get()).toEqual({
      status: "reconciled",
      unresolved: 0,
    });
  });

  it("replaces a restored task's context by what the store holds, and saves only a change", async () => {
    const h = build({
      root: await privateTemp(),
      store: {
        load: async (binding) => {
          if (binding.taskId === threadA) {
            return {
              epoch: 3,
              phase: "outcome_unknown",
              blockedCode: "CONTEXT_OUTCOME_UNKNOWN",
              operation: { source: "retained_agent" },
            };
          }
          return null;
        },
      },
    });
    h.registry.admit(task(threadA, "Unknown"));
    h.registry.admit(task(threadB, "Quiet"));
    h.registry.setContext(threadB, {
      epoch: 1,
      phase: "active",
      source: null,
      code: null,
    });
    await h.host.initializeCodexContextController();
    await h.host.reconcileContextAfterRestart();
    expect(h.registry.get(threadA)?.context).toEqual({
      epoch: 3,
      phase: "outcome_unknown",
      source: "retained_agent",
      code: "CONTEXT_OUTCOME_UNKNOWN",
    });
    // A task with no stored session shows none.
    expect(h.registry.get(threadB)?.context).toBeNull();
    expect(h.persistLiveTaskState).toHaveBeenCalledOnce();
    expect(h.publishTasksState).toHaveBeenCalledOnce();
  });

  it("shows unreadable context as blocked, never as the stale copy", async () => {
    const h = build({
      root: await privateTemp(),
      store: {
        load: async (binding) => {
          throw new Error(
            binding.taskId === threadA ? "CONTEXT_SESSION_CORRUPT" : "boom",
          );
        },
      },
    });
    h.registry.admit(task(threadA, "A"));
    h.registry.admit(task(threadB, "B"));
    await h.host.initializeCodexContextController();
    await h.host.reconcileContextAfterRestart();
    expect(h.registry.get(threadA)?.context).toMatchObject({
      phase: "blocked",
      code: "CONTEXT_SESSION_CORRUPT",
    });
    expect(h.registry.get(threadB)?.context).toMatchObject({
      phase: "blocked",
      code: "CONTEXT_STATE_UNREADABLE",
    });
  });

  it("neither saves nor publishes when no context changed", async () => {
    const h = build({ root: await privateTemp() });
    h.registry.admit(task(threadA, "Task"));
    await h.host.initializeCodexContextController();
    await h.host.reconcileContextAfterRestart();
    expect(h.persistLiveTaskState).not.toHaveBeenCalled();
    expect(h.publishTasksState).not.toHaveBeenCalled();
  });

  it("publishes a changed context even when saving it fails", async () => {
    const h = build({
      root: await privateTemp(),
      persist: async () => {
        throw new Error("disk");
      },
      store: {
        load: async () => ({
          epoch: 2,
          phase: "blocked",
          blockedCode: "CONTEXT_BLOCKED",
        }),
      },
    });
    h.registry.admit(task(threadA, "Task"));
    await h.host.initializeCodexContextController();
    await expect(
      h.host.reconcileContextAfterRestart(),
    ).resolves.toBeUndefined();
    expect(h.persistLiveTaskState).toHaveBeenCalledOnce();
    expect(h.publishTasksState).toHaveBeenCalledOnce();
  });

  it("sweeps context a closed task left behind and releases its fence, only for a registry that was read", async () => {
    const bindings = (host: ReturnType<typeof build>["host"]) => [
      { readable: true, binding: host.binding("gone") },
      { readable: true, binding: host.binding(threadA) },
    ];
    const read = build({
      root: await privateTemp(),
      store: { listTaskBindings: async () => bindings(read.host) },
    });
    read.registry.admit(task(threadA, "Live"));
    await read.host.initializeCodexContextController();
    await read.host.reconcileContextAfterRestart();
    expect(read.store.deleteTask).toHaveBeenCalledOnce();
    expect(read.store.deleteTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "gone" }),
    );
    expect(read.fence.release).toHaveBeenCalledWith("gone");

    // An unreadable registry is not an empty one: nothing is swept.
    for (const unread of [
      { storeLoaded: false },
      { registryRestored: false },
    ]) {
      const h = build({
        root: await privateTemp(),
        ...unread,
        store: { listTaskBindings: async () => bindings(h.host) },
      });
      await h.host.initializeCodexContextController();
      await h.host.reconcileContextAfterRestart();
      expect(h.store.deleteTask).not.toHaveBeenCalled();
      expect(h.fence.release).not.toHaveBeenCalled();
    }
  });

  it("recovers the fence after reconciling the contexts and sweeping", async () => {
    const order: string[] = [];
    const h = build({
      root: await privateTemp(),
      store: {
        load: async () => {
          order.push("load");
          return null;
        },
        listTaskBindings: async () => {
          order.push("list");
          return [];
        },
      },
      fenceReconcile: async () => {
        order.push("reconcile");
      },
    });
    h.registry.admit(task(threadA, "Task"));
    await h.host.initializeCodexContextController();
    await h.host.reconcileContextAfterRestart();
    expect(order).toEqual(["load", "list", "list", "reconcile"]);
  });
});

describe("cells", () => {
  it("reflect the state the owner holds and what main writes back", async () => {
    const h = build({ root: await privateTemp() });
    expect(h.host.controller.get()).toBeNull();
    expect(h.host.fence.get()).toBeNull();
    expect(h.host.recovery.get()).toBeNull();
    expect(h.host.routeB.get()).toBeNull();
    await h.host.initializeCodexContextController();
    await h.host.reconcileContextAfterRestart();
    await h.host.initializeRouteBRuntime();
    expect(h.host.controller.get()).toBe(h.controller);
    expect(h.host.fence.get()).toBe(h.fence);
    expect(h.host.recovery.get()).toEqual({
      status: "reconciled",
      unresolved: 0,
    });
    expect(h.host.routeB.get()).toBe(h.runtime);
    // Quit takes the runtime and clears it; a later start then runs again.
    const closing = h.host.routeB.get();
    h.host.routeB.set(null);
    expect(closing).toBe(h.runtime);
    expect(h.host.routeB.get()).toBeNull();
    await h.host.initializeRouteBRuntime();
    expect(h.startRouteBRuntime).toHaveBeenCalledTimes(2);
  });

  it("a second controller start builds a fresh fence and controller over the cells", async () => {
    const h = build({ root: await privateTemp() });
    await h.host.initializeCodexContextController();
    await h.host.initializeCodexContextController();
    expect(h.createExecutionFence).toHaveBeenCalledTimes(2);
    expect(h.createCodexContextController).toHaveBeenCalledTimes(2);
    expect(h.host.controller.get()).toBe(h.controller);
  });
});
