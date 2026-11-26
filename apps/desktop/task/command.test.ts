import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import { PrivateLiveTaskStore } from "../../../src/apps/desktop/live-task-store";
import {
  PrivateProductAgentStore,
  ProductAgentInputSchema,
  type ProductAgentInput,
} from "../../../src/apps/desktop/product-agent-store";
import { TaskMutationGate } from "../../../src/apps/desktop/task-mutation-gate";
import type {
  ShellOverlay,
  SurfaceSection,
} from "../../../src/apps/desktop/surface-layout";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  ProductTaskCommandSchema,
  type ProductTask,
} from "../../../src/modules/chat/contract/product-task";
import { createTurnLifecycle } from "./turns";
import {
  createTaskCommands,
  type TaskCommandError,
  type TaskCommandsPorts,
} from "./command";

// The `task.*` command switch over a real registry, a real private Agent
// store in a temporary root and the real command schema. Main's owners are
// scripted: each `let` is a field the ports read afresh and write through the
// setters, and every effect appends to one ordered log. No window, route,
// provider or installed profile runs.
type Result =
  | Readonly<{ ok: true; selectedTaskId: string | null }>
  | Readonly<{ ok: false; error: TaskCommandError }>;
type Ports = TaskCommandsPorts<Result>;
type Route = Ports["liveTaskRoutes"] extends Map<string, infer R> ? R : never;

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-command-"));
  roots.push(root);
  return root;
}

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const COMPUTER_ID = "00000000-0000-4000-8000-000000000010";
const ROOT = "/workspace/approved";
const GENERATION = 7;
const TIMESTAMP = "2026-09-20T12:00:00.000Z";
const EXECUTABLE_SHA = "1".repeat(64);
const SCHEMA_SHA = "3".repeat(64);
const BUILD_ID = "5".repeat(64);
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function readiness() {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown" as const,
    verified: null,
    needsAction: "Complete this step.",
    unavailable: null,
    outcomeUnknown: false,
  };
}

function settingsOf(excludedPaths: string[] = []): ProductSettings {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: COMPUTER_ID,
      generation: GENERATION,
      name: "This Mac",
      workspaces: [
        {
          workspaceId: WORKSPACE_ID,
          root: ROOT,
          label: "Primary",
          access: "read",
          excludedPaths,
        },
      ],
    },
    nativeHosts: {
      generation: 1,
      codex: {
        executablePath: "/usr/local/bin/codex",
        executableSha256: EXECUTABLE_SHA,
        version: "1.0.0",
        protocol: "codex-app-server/v2" as const,
        schemaSha256: SCHEMA_SHA,
        verifiedAt: TIMESTAMP,
        liveVerification: {
          model: "gpt-6-astra" as const,
          executableSha256: EXECUTABLE_SHA,
          schemaSha256: SCHEMA_SHA,
          buildId: BUILD_ID,
          dynamicTool: "farol_ping" as const,
          verifiedAt: TIMESTAMP,
        },
        agentVerification: {
          model: "gpt-6-astra" as const,
          executableSha256: EXECUTABLE_SHA,
          schemaSha256: SCHEMA_SHA,
          buildId: BUILD_ID,
          workspaceId: WORKSPACE_ID,
          computerGeneration: GENERATION,
          transport: "codex-native-agent/spawn-prompt-sha256-v1" as const,
          authorityRole: "agent" as const,
          hostRole: null,
          delegationDigest: "7".repeat(64),
          parentThreadSha256: "8".repeat(64),
          childThreadSha256: "9".repeat(64),
          boundedRunning: true as const,
          modelTurnsSubmitted: 1 as const,
          fallbackAllowed: false as const,
          descendantCount: 0 as const,
          resultRefProtocol: "codex-app-server" as const,
          resultRetention: "durable" as const,
          parentDelivery: "acknowledged" as const,
          workspaceEnforcement: "verified" as const,
          verifiedAt: TIMESTAMP,
        },
      },
    },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: readiness(),
      computer: {
        ...readiness(),
        reachable: "reachable",
        outcomeUnknown: false,
        verified: {
          profile: "farol",
          configRevision: GENERATION,
          workspaceId: WORKSPACE_ID,
          runtimeGeneration: "next-1",
          buildId: BUILD_ID,
          protocol: "next-1",
          verifiedAt: TIMESTAMP,
        },
      },
      connect: readiness(),
      hosts: readiness(),
      verify: readiness(),
    },
  });
}

function task(
  index: number,
  overrides: Partial<ProductTask> = {},
): ProductTask {
  return {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    label: `ChatGPT task ${index}`,
    provider: "chatgpt",
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle",
    ...overrides,
  };
}

function agentOf(
  phase: "running" | "completed" | "outcome_unknown" | "cancelled",
  parentDelivery:
    "not_applicable" | "pending" | "acknowledged" = "not_applicable",
): NonNullable<ProductTask["agent"]> {
  return {
    assignmentBindingSha256: "a".repeat(64),
    phase,
    workspaceId: WORKSPACE_ID,
    parentDelivery,
    workspaceEnforcement: "verified",
    resultAvailable: parentDelivery === "pending",
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

const start = (taskId: string, extra: Record<string, unknown> = {}) => ({
  kind: "task.start-agent",
  taskId,
  workspaceId: WORKSPACE_ID,
  objective: "Find the marker.",
  scope: { mode: "workspace", excludedPaths: [] },
  ...extra,
});

async function build(
  options: Readonly<{
    tasks?: ProductTask[];
    withStore?: boolean;
    overrides?: Partial<Ports>;
  }> = {},
) {
  const events: string[] = [];
  const registry = new LiveTaskRegistry(5);
  for (const seeded of options.tasks ?? [])
    expect(registry.admit(seeded).status).toBe("admitted");
  const agentStore = new PrivateProductAgentStore({
    root: path.join(await temporaryRoot(), "agent"),
  });
  const routes = new Map<string, Route>();
  const conversationUrls = new Map<string, string | null>();
  const gate = new TaskMutationGate();
  const state = {
    selected: options.tasks?.[0]?.taskId ?? "",
    section: "settings" as SurfaceSection,
    overlay: "task-menu" as ShellOverlay,
    setupOpen: true,
    store:
      (options.withStore ?? true)
        ? new PrivateLiveTaskStore({ root: await temporaryRoot() })
        : (null as PrivateLiveTaskStore | null),
    expiry: null as Readonly<{ taskId: string; timer: NodeJS.Timeout }> | null,
    session: null as Readonly<{ taskId: string }> | null,
    settings: settingsOf() as ProductSettings | null,
    admissionClosed: false,
    admissionReady: true,
    route: {} as unknown,
    pending: null as string | null,
    persistFails: false,
    surfaceOpens: true,
    assignmentMatches: true,
    agentStore: agentStore as PrivateProductAgentStore | null,
  };
  const log = (event: string) => events.push(event);
  const fakeRoute = (id: string): Route => ({
    setTitle: (title) => log(`title:${id}:${title}`),
    cancelActiveTask: vi.fn(async () => "cancelled" as const),
  });
  // The real turn lifecycle: the route's `settled` writes the registry, as in
  // main, and a thread's turn is admitted through `turns.surfaces`.
  // The route's page-turn epoch: its admission of a thread's turn advances it.
  const epochs = new Map<string, number>();
  const turns = createTurnLifecycle({
    surfaceFor: async (threadId) => {
      epochs.set(threadId, (epochs.get(threadId) ?? 0) + 1);
      return { ok: true, surface: fakeRoute("thread") as never };
    },
    apply: (taskId, lifecycle) => {
      log(`settled:${lifecycle}`);
      registry.setLifecycle(taskId, lifecycle);
    },
    epoch: (taskId) => epochs.get(taskId) ?? 0,
  });
  const ports: Ports = {
    parseCommand: (value) => ProductTaskCommandSchema.safeParse(value),
    taskFailure: (error) => ({ ok: false, error }),
    taskSuccess: (taskId) => ({ ok: true, selectedTaskId: taskId }),
    desktopAdmission: {
      closed: () => {
        log("admission");
        return state.admissionClosed;
      },
    },
    demoMode: false,
    taskMutations: gate,
    liveTaskRegistry: registry,
    liveTaskRoutes: routes,
    liveTaskConversationUrls: conversationUrls,
    selectedTaskId: () => state.selected,
    setSelectedTaskId: (value) => {
      log(`selected:${value}`);
      state.selected = value;
    },
    setSection: (value) => {
      log(`section:${value}`);
      state.section = value;
    },
    setShellOverlay: (value) => {
      log(`overlay:${value}`);
      state.overlay = value;
    },
    setSetupOpen: (value) => {
      log(`setup:${value}`);
      state.setupOpen = value;
    },
    liveTaskStore: () => state.store,
    setLiveTaskStore: (value) => {
      log(`store:${value === null ? "null" : "set"}`);
      state.store = value;
    },
    productAgentEnabled: true,
    activeProductAgentSession: () => state.session,
    persistedProductAgentExpiry: () => state.expiry,
    setPersistedProductAgentExpiry: (value) => {
      log("expiry:null");
      state.expiry = value;
    },
    configuration: () => ({
      snapshot: () => {
        log("snapshot");
        return state.settings
          ? { status: "ready", settings: state.settings }
          : { status: "error", error: "SETTINGS_READ_FAILED" };
      },
    }),
    productAgentStore: () => state.agentStore,
    chatGptRoute: () => state.route,
    turnLifecycle: turns,
    routeBTaskLifecycle: {
      close: async (taskId) => {
        log(`close:${taskId}`);
        registry.remove(taskId);
        return { ok: true, contextDeletion: "deleted", agentInput: "removed" };
      },
    },
    buildId: BUILD_ID,
    randomUUID,
    now: () => NOW,
    applyLayout: () => log("applyLayout"),
    publishLayout: () => log("publishLayout"),
    publishTasksState: () => log("publishTasks"),
    openLiveTaskSurface: async (taskId) => {
      log(`open:${taskId}`);
      return state.surfaceOpens;
    },
    persistLiveTaskState: async () => {
      log("persist");
      if (state.persistFails) throw new Error("PERSIST_FAILED");
    },
    surfaceLiveTaskPersistenceFailure: (taskId) => log(`surface:${taskId}`),
    chatGptTaskAdmissionReady: () => state.admissionReady,
    createLiveChatGptRoute: (taskId, label) => {
      log(`route:${label}`);
      return fakeRoute(taskId);
    },
    pendingProductAgentTaskId: () => state.pending,
    productAgentAssignmentBinding: () => "b".repeat(64),
    productAgentAssignmentMatches: () => state.assignmentMatches,
    productAgentUnknownSummaryFromTask: (agent) => ({
      ...agent,
      phase: "outcome_unknown",
      parentDelivery: "not_applicable",
      resultAvailable: false,
    }),
    persistProductAgentSummary: async (taskId, summary) => {
      log(`summary:${taskId}:${summary.phase}`);
      return true;
    },
    executeProductAgent: async (target, input, context, admission) => {
      log(`execute:${admission}:${target.taskId}:${input.workspaceId}`);
      expect(context.workspace.workspaceId).toBe(WORKSPACE_ID);
      return { ok: true, selectedTaskId: target.taskId };
    },
    cancelProductAgentTask: async (target) => {
      log(`cancel-agent:${target.taskId}`);
      return { ok: true, selectedTaskId: target.taskId };
    },
    ...options.overrides,
  };
  const commands = createTaskCommands<Result>(ports);
  const failure = (error: TaskCommandError) => ({ ok: false, error });
  return {
    commands,
    events,
    registry,
    routes,
    conversationUrls,
    gate,
    state,
    agentStore,
    turns,
    failure,
    run: (value: unknown) => commands.run(value),
  };
}

describe("the refusal guards at the top", () => {
  it("refuses an invalid command before it reads anything else", async () => {
    const h = await build();
    expect(await h.run({ kind: "task.nothing" })).toEqual(
      h.failure("TASK_COMMAND_INVALID"),
    );
    expect(await h.run(null)).toEqual(h.failure("TASK_COMMAND_INVALID"));
    expect(h.events).toEqual([]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("checks admission, then demo mode, then a mutation in flight, in that order", async () => {
    const claimed = new TaskMutationGate();
    claimed.tryEnter();
    const command = { kind: "task.create-chatgpt" };
    const all = await build({
      overrides: { demoMode: true, taskMutations: claimed },
    });
    all.state.admissionClosed = true;
    expect(await all.run(command)).toEqual(
      all.failure("TASK_OPERATION_IN_PROGRESS"),
    );
    all.state.admissionClosed = false;
    expect(await all.run(command)).toEqual(all.failure("TASKS_UNAVAILABLE"));
    const busy = await build({ overrides: { taskMutations: claimed } });
    expect(await busy.run(command)).toEqual(
      busy.failure("TASK_OPERATION_IN_PROGRESS"),
    );
    expect(busy.events).toEqual(["admission"]);
  });

  it("never claims the gate for a refusal made before it", async () => {
    const h = await build({ overrides: { demoMode: true } });
    const tryEnter = vi.spyOn(h.gate, "tryEnter");
    await h.run({ kind: "task.create-chatgpt" });
    expect(tryEnter).not.toHaveBeenCalled();
  });

  it("refuses a command that needs the store when the store is gone, without claiming the gate", async () => {
    const h = await build({ withStore: false, tasks: [task(1)] });
    const tryEnter = vi.spyOn(h.gate, "tryEnter");
    for (const command of [
      { kind: "task.create-chatgpt" },
      { kind: "task.pin", taskId: "x", pinned: true },
      { kind: "task.cancel", taskId: "x" },
    ])
      expect(await h.run(command)).toEqual(h.failure("TASK_STATE_UNAVAILABLE"));
    expect(tryEnter).not.toHaveBeenCalled();
  });

  it("refuses when the claim itself is lost between the check and the entry", async () => {
    const lost = {
      inFlight: () => false,
      tryEnter: () => null,
    };
    const h = await build({
      tasks: [task(1)],
      overrides: { taskMutations: lost },
    });
    const id = h.state.selected;
    for (const command of [
      { kind: "task.activate", taskId: id },
      { kind: "task.rename", taskId: id, label: "x" },
      { kind: "task.create-chatgpt" },
    ])
      expect(await h.run(command)).toEqual(
        h.failure("TASK_OPERATION_IN_PROGRESS"),
      );
    expect(h.events.filter((event) => event !== "admission")).toEqual([]);
  });
});

describe("task.activate", () => {
  it("refuses an unknown task and frees the gate", async () => {
    const h = await build({ withStore: false });
    expect(await h.run({ kind: "task.activate", taskId: "nope" })).toEqual(
      h.failure("TASK_NOT_FOUND"),
    );
    expect(h.gate.inFlight()).toBe(false);
    expect(h.state.section).toBe("settings");
  });

  it("selects the task, shows the browser, clears the overlay and opens its surface in order", async () => {
    const [first, second] = [task(1), task(2)];
    const h = await build({ tasks: [first, second], withStore: false });
    expect(
      await h.run({ kind: "task.activate", taskId: second.taskId }),
    ).toEqual({ ok: true, selectedTaskId: second.taskId });
    expect(h.state).toMatchObject({
      selected: second.taskId,
      section: "browser",
      overlay: "none",
    });
    expect(h.events).toEqual([
      "admission",
      `selected:${second.taskId}`,
      "section:browser",
      "overlay:none",
      "applyLayout",
      "publishLayout",
      `open:${second.taskId}`,
    ]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("reports an unreachable surface after the selection has already moved", async () => {
    const [first, second] = [task(1), task(2)];
    const h = await build({ tasks: [first, second], withStore: false });
    h.state.surfaceOpens = false;
    expect(
      await h.run({ kind: "task.activate", taskId: second.taskId }),
    ).toEqual(h.failure("TASK_SURFACE_UNREACHABLE"));
    expect(h.state.selected).toBe(second.taskId);
    expect(h.events).toContain(`open:${second.taskId}`);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("holds the gate while the surface opens and frees it when opening throws", async () => {
    const only = task(1);
    const opening = deferred<boolean>();
    let heldWhileOpening = false;
    const h = await build({
      tasks: [only],
      withStore: false,
      overrides: {
        openLiveTaskSurface: async () => {
          heldWhileOpening = true;
          return opening.promise;
        },
      },
    });
    const pending = h.run({ kind: "task.activate", taskId: only.taskId });
    await vi.waitFor(() => expect(heldWhileOpening).toBe(true));
    expect(h.gate.inFlight()).toBe(true);
    opening.resolve(true);
    await pending;
    expect(h.gate.inFlight()).toBe(false);

    const throwing = await build({
      tasks: [only],
      withStore: false,
      overrides: {
        openLiveTaskSurface: async () => {
          throw new Error("SURFACE_THREW");
        },
      },
    });
    await expect(
      throwing.run({ kind: "task.activate", taskId: only.taskId }),
    ).rejects.toThrow("SURFACE_THREW");
    expect(throwing.gate.inFlight()).toBe(false);
  });
});

describe("task.rename and task.pin", () => {
  it("rename refuses an unknown task before saving anything", async () => {
    const h = await build();
    expect(
      await h.run({ kind: "task.rename", taskId: "nope", label: "New" }),
    ).toEqual(h.failure("TASK_NOT_FOUND"));
    expect(h.events).toEqual(["admission"]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("rename saves, retitles the live route with the trimmed label and publishes", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    h.routes.set(only.taskId, {
      setTitle: (title) => h.events.push(`title:${title}`),
      cancelActiveTask: async () => "cancelled",
    });
    expect(
      await h.run({
        kind: "task.rename",
        taskId: only.taskId,
        label: "  Renamed  ",
      }),
    ).toEqual({ ok: true, selectedTaskId: only.taskId });
    expect(h.registry.get(only.taskId)?.label).toBe("Renamed");
    expect(h.events).toEqual([
      "admission",
      "persist",
      "title:Renamed · Farol",
      "publishTasks",
    ]);
  });

  it("rename succeeds for a task that has no live route", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    expect(
      await h.run({ kind: "task.rename", taskId: only.taskId, label: "Quiet" }),
    ).toEqual({ ok: true, selectedTaskId: only.taskId });
    expect(h.events).toEqual(["admission", "persist", "publishTasks"]);
  });

  it("rename rolls the registry back and publishes nothing when the save fails", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    h.state.persistFails = true;
    h.routes.set(only.taskId, {
      setTitle: () => h.events.push("title"),
      cancelActiveTask: async () => "cancelled",
    });
    expect(
      await h.run({ kind: "task.rename", taskId: only.taskId, label: "Lost" }),
    ).toEqual(h.failure("TASK_STATE_UNAVAILABLE"));
    expect(h.registry.get(only.taskId)?.label).toBe("ChatGPT task 1");
    expect(h.events).toEqual(["admission", "persist"]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("pin refuses an unknown task", async () => {
    const h = await build();
    expect(
      await h.run({ kind: "task.pin", taskId: "nope", pinned: true }),
    ).toEqual(h.failure("TASK_NOT_FOUND"));
    expect(h.events).toEqual(["admission"]);
  });

  it("pin saves and publishes", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    expect(
      await h.run({ kind: "task.pin", taskId: only.taskId, pinned: true }),
    ).toEqual({ ok: true, selectedTaskId: only.taskId });
    expect(h.registry.get(only.taskId)?.pinned).toBe(true);
    expect(h.events).toEqual(["admission", "persist", "publishTasks"]);
  });

  it("pin rolls the registry back when the save fails", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    h.state.persistFails = true;
    expect(
      await h.run({ kind: "task.pin", taskId: only.taskId, pinned: true }),
    ).toEqual(h.failure("TASK_STATE_UNAVAILABLE"));
    expect(h.registry.get(only.taskId)?.pinned).toBe(false);
    expect(h.events).toEqual(["admission", "persist"]);
  });
});

describe("task.close", () => {
  it.each([
    ["running", agentOf("running")],
    ["completed and not yet acknowledged", agentOf("completed", "pending")],
  ])("refuses a task whose agent is %s", async (_name, agent) => {
    const only = task(1, { agent });
    const h = await build({ tasks: [only] });
    expect(await h.run({ kind: "task.close", taskId: only.taskId })).toEqual(
      h.failure("AGENT_ALREADY_RUNNING"),
    );
    expect(h.events).toEqual(["admission"]);
    expect(h.registry.get(only.taskId)).not.toBeNull();
    expect(h.gate.inFlight()).toBe(false);
  });

  it("closes a completed, acknowledged agent's task", async () => {
    const only = task(1, { agent: agentOf("completed", "acknowledged") });
    const h = await build({ tasks: [only] });
    expect((await h.run({ kind: "task.close", taskId: only.taskId })).ok).toBe(
      true,
    );
  });

  it("returns the lifecycle's own refusal and leaves the selection alone", async () => {
    const [first, second] = [task(1), task(2)];
    const h = await build({
      tasks: [first, second],
      overrides: {
        routeBTaskLifecycle: {
          close: async () => ({
            ok: false,
            code: "TASK_OPERATION_IN_PROGRESS",
          }),
        },
      },
    });
    expect(await h.run({ kind: "task.close", taskId: first.taskId })).toEqual(
      h.failure("TASK_OPERATION_IN_PROGRESS"),
    );
    expect(h.state.selected).toBe(first.taskId);
    expect(h.events).toEqual(["admission"]);
  });

  it("selects the first remaining task when the selected one closes, then re-lays out", async () => {
    const [first, second] = [task(1), task(2)];
    const h = await build({ tasks: [first, second] });
    expect(await h.run({ kind: "task.close", taskId: first.taskId })).toEqual({
      ok: true,
      selectedTaskId: second.taskId,
    });
    expect(h.events).toEqual([
      "admission",
      `close:${first.taskId}`,
      `selected:${second.taskId}`,
      "overlay:none",
      "publishTasks",
      "applyLayout",
      "publishLayout",
    ]);
    expect(h.state.overlay).toBe("none");
  });

  it("clears the selection and reports null when the last task closes", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    expect(await h.run({ kind: "task.close", taskId: only.taskId })).toEqual({
      ok: true,
      selectedTaskId: null,
    });
    expect(h.state.selected).toBe("");
  });

  it("keeps the selection when another task closes", async () => {
    const [first, second] = [task(1), task(2)];
    const h = await build({ tasks: [first, second] });
    expect(await h.run({ kind: "task.close", taskId: second.taskId })).toEqual({
      ok: true,
      selectedTaskId: first.taskId,
    });
    expect(h.state.selected).toBe(first.taskId);
  });

  it("cancels the persisted expiry of the closing task only, through the setter", async () => {
    const [first, second] = [task(1), task(2)];
    const timer = setTimeout(() => undefined, 60_000);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      const own = await build({ tasks: [first, second] });
      own.state.expiry = { taskId: second.taskId, timer };
      await own.run({ kind: "task.close", taskId: second.taskId });
      expect(clear).toHaveBeenCalledWith(timer);
      expect(own.state.expiry).toBeNull();
      expect(own.events).toContain("expiry:null");

      clear.mockClear();
      const other = await build({ tasks: [first, second] });
      other.state.expiry = { taskId: first.taskId, timer };
      await other.run({ kind: "task.close", taskId: second.taskId });
      expect(clear).not.toHaveBeenCalledWith(timer);
      expect(other.state.expiry).toEqual({ taskId: first.taskId, timer });
    } finally {
      clearTimeout(timer);
    }
  });

  it("reads the selection after the awaited close, not before", async () => {
    const [first, second] = [task(1), task(2)];
    const closing = deferred();
    const h = await build({
      tasks: [first, second],
      overrides: {
        routeBTaskLifecycle: {
          close: async () => {
            await closing.promise;
            return {
              ok: true,
              contextDeletion: "deleted",
              agentInput: "removed",
            };
          },
        },
      },
    });
    const pending = h.run({ kind: "task.close", taskId: first.taskId });
    await vi.waitFor(() => expect(h.events).toContain("admission"));
    h.state.selected = second.taskId;
    h.registry.remove(first.taskId);
    closing.resolve();
    expect(await pending).toEqual({ ok: true, selectedTaskId: second.taskId });
    expect(h.state.selected).toBe(second.taskId);
  });
});

describe("task.cancel", () => {
  it("refuses an unknown task", async () => {
    const h = await build();
    expect(await h.run({ kind: "task.cancel", taskId: "nope" })).toEqual(
      h.failure("TASK_NOT_FOUND"),
    );
  });

  it("hands a running agent to the Agent cancellation and does nothing else", async () => {
    const only = task(1, { agent: agentOf("running") });
    const h = await build({ tasks: [only] });
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual({
      ok: true,
      selectedTaskId: only.taskId,
    });
    expect(h.events).toEqual(["admission", `cancel-agent:${only.taskId}`]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("refuses a completed agent the parent has not taken", async () => {
    const only = task(1, { agent: agentOf("completed", "pending") });
    const h = await build({ tasks: [only] });
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
      h.failure("AGENT_ALREADY_RUNNING"),
    );
  });

  it("refuses a task with no live route", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
      h.failure("TASK_NOT_FOUND"),
    );
  });

  it("reports a turn that is not running without touching the registry", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    h.routes.set(only.taskId, {
      setTitle: () => undefined,
      cancelActiveTask: async () => "not_running",
    });
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
      h.failure("TASK_NOT_RUNNING"),
    );
    expect(h.events).toEqual(["admission"]);
    expect(h.registry.get(only.taskId)?.lifecycle).toBe("idle");
  });

  it("reports a page that changed as a refusal, with nothing recorded, published or saved", async () => {
    const only = task(1, { lifecycle: "running" });
    const h = await build({ tasks: [only] });
    h.routes.set(only.taskId, {
      setTitle: () => undefined,
      cancelActiveTask: async () => "page_changed",
    });
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
      h.failure("TASK_CANCEL_PAGE_CHANGED"),
    );
    expect(h.events).toEqual(["admission"]);
    expect(h.registry.get(only.taskId)?.lifecycle).toBe("running");
    expect(h.gate.inFlight()).toBe(false);
  });

  it("answers a second Cancel of the same task with the first one's result, cancelling once", async () => {
    const only = task(1, { lifecycle: "running" });
    const h = await build({ tasks: [only] });
    const stopping = deferred<"cancelled">();
    const cancelActiveTask = vi.fn(() => stopping.promise);
    h.routes.set(only.taskId, { setTitle: () => undefined, cancelActiveTask });
    const first = h.run({ kind: "task.cancel", taskId: only.taskId });
    const second = h.run({ kind: "task.cancel", taskId: only.taskId });
    stopping.resolve("cancelled");
    const expected = { ok: true, selectedTaskId: only.taskId };
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect(cancelActiveTask).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event === "persist")).toHaveLength(1);
    // Once finished, a later Cancel is a new one.
    await h.run({ kind: "task.cancel", taskId: only.taskId });
    expect(cancelActiveTask).toHaveBeenCalledTimes(2);
  });

  describe("against a Codex thread's own turn settling", () => {
    // A thread's turn is admitted, cancelled and settled through the real turn
    // lifecycle. What differs per case is only the order the route reports in.
    async function thread(
      cancelActiveTask: (
        h: Awaited<ReturnType<typeof build>>,
      ) => Promise<"cancelled" | "outcome_unknown">,
    ) {
      const only = task(1, { lifecycle: "running" });
      const h = await build({ tasks: [only] });
      h.routes.set(only.taskId, {
        setTitle: () => undefined,
        cancelActiveTask: () => cancelActiveTask(h),
      });
      await h.turns.surfaces.surfaceFor(only.taskId);
      h.events.length = 0;
      const settle = (state: "completed" | "outcome_unknown") =>
        h.turns.surfaces.settled?.(only.taskId, state);
      return { h, only, settle };
    }

    it("keeps a cancelled turn cancelled when it settles afterwards", async () => {
      const { h, only, settle } = await thread(async () => "cancelled");
      expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
        { ok: true, selectedTaskId: only.taskId },
      );
      await settle("outcome_unknown");
      expect(h.registry.get(only.taskId)?.lifecycle).toBe("cancelled");
      expect(h.events).toEqual(["admission", "publishTasks", "persist"]);
    });

    it("ends cancelled when the aborted turn settles before the stop is confirmed", async () => {
      const { h, only, settle } = await thread(async (target) => {
        await settle("outcome_unknown");
        expect(target.registry.get(only.taskId)?.lifecycle).toBe(
          "outcome_unknown",
        );
        return "cancelled";
      });
      expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
        { ok: true, selectedTaskId: only.taskId },
      );
      expect(h.registry.get(only.taskId)?.lifecycle).toBe("cancelled");
      await settle("outcome_unknown");
      expect(h.registry.get(only.taskId)?.lifecycle).toBe("cancelled");
    });

    it("does not overwrite a turn that settled on its own with an unknown Cancel", async () => {
      const { h, only, settle } = await thread(async () => {
        await settle("completed");
        return "outcome_unknown";
      });
      expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
        h.failure("TASK_CANCEL_FAILED"),
      );
      expect(h.registry.get(only.taskId)?.lifecycle).toBe("idle");
      expect(h.events).toEqual(["admission", "settled:idle"]);
    });

    it("writes nothing for a turn that the next one has replaced, and settles the next normally", async () => {
      const { h, only, settle } = await thread(async (target) => {
        await settle("completed");
        await target.turns.surfaces.surfaceFor(only.taskId);
        return "cancelled";
      });
      expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
        { ok: true, selectedTaskId: only.taskId },
      );
      expect(h.registry.get(only.taskId)?.lifecycle).toBe("idle");
      expect(h.events).toEqual(["admission", "settled:idle"]);
      await settle("outcome_unknown");
      expect(h.registry.get(only.taskId)?.lifecycle).toBe("outcome_unknown");
    });

    it("writes nothing for a Cancel that started with no turn once a turn was admitted", async () => {
      const only = task(1, { lifecycle: "running" });
      const h = await build({ tasks: [only] });
      h.routes.set(only.taskId, {
        setTitle: () => undefined,
        cancelActiveTask: async () => {
          // The Codex host starts a turn while the Cancel runs.
          await h.turns.surfaces.surfaceFor(only.taskId);
          return "cancelled";
        },
      });
      h.events.length = 0;
      expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
        { ok: true, selectedTaskId: only.taskId },
      );
      expect(h.registry.get(only.taskId)?.lifecycle).toBe("running");
      expect(h.events).toEqual(["admission"]);
    });

    it("settles the turn after a cancelled one as usual", async () => {
      const { h, only, settle } = await thread(async () => "cancelled");
      await h.run({ kind: "task.cancel", taskId: only.taskId });
      await settle("outcome_unknown");
      await h.turns.surfaces.surfaceFor(only.taskId);
      await settle("completed");
      expect(h.registry.get(only.taskId)?.lifecycle).toBe("idle");
    });
  });

  it("records a cancelled turn, publishes and saves", async () => {
    const only = task(1, { lifecycle: "event_driven" });
    const h = await build({ tasks: [only] });
    h.routes.set(only.taskId, {
      setTitle: () => undefined,
      cancelActiveTask: async () => "cancelled",
    });
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual({
      ok: true,
      selectedTaskId: only.taskId,
    });
    expect(h.registry.get(only.taskId)?.lifecycle).toBe("cancelled");
    expect(h.events).toEqual(["admission", "publishTasks", "persist"]);
  });

  it("records an unknown outcome as a failed cancel", async () => {
    const only = task(1, { lifecycle: "event_driven" });
    const h = await build({ tasks: [only] });
    h.routes.set(only.taskId, {
      setTitle: () => undefined,
      cancelActiveTask: async () => "outcome_unknown",
    });
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
      h.failure("TASK_CANCEL_FAILED"),
    );
    expect(h.registry.get(only.taskId)?.lifecycle).toBe("outcome_unknown");
  });

  it("drops the store through its setter and surfaces the failure when the save fails", async () => {
    const only = task(1, { lifecycle: "event_driven" });
    const h = await build({ tasks: [only] });
    h.state.persistFails = true;
    h.routes.set(only.taskId, {
      setTitle: () => undefined,
      cancelActiveTask: async () => "cancelled",
    });
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
      h.failure("TASK_STATE_UNAVAILABLE"),
    );
    expect(h.state.store).toBeNull();
    expect(h.events).toEqual([
      "admission",
      "publishTasks",
      "persist",
      "store:null",
      `surface:${only.taskId}`,
    ]);
    // A later command now sees the store gone.
    expect(await h.run({ kind: "task.cancel", taskId: only.taskId })).toEqual(
      h.failure("TASK_STATE_UNAVAILABLE"),
    );
  });
});

describe("task.create-chatgpt", () => {
  it("refuses an unverified ChatGPT connection, then a missing route", async () => {
    const h = await build();
    h.state.admissionReady = false;
    expect(await h.run({ kind: "task.create-chatgpt" })).toEqual(
      h.failure("CHATGPT_CONNECTION_NOT_VERIFIED"),
    );
    h.state.admissionReady = true;
    h.state.route = null;
    expect(await h.run({ kind: "task.create-chatgpt" })).toEqual(
      h.failure("TASK_ROUTE_UNAVAILABLE"),
    );
    expect(h.registry.snapshot().tasks).toEqual([]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("admits a task under the first free ordinal and opens it as the selection", async () => {
    const h = await build({
      tasks: [task(1), task(3)],
    });
    const result = await h.run({ kind: "task.create-chatgpt" });
    const created = h.registry
      .snapshot()
      .tasks.find((candidate) => candidate.label === "ChatGPT task 2");
    expect(created).toMatchObject({
      provider: "chatgpt",
      requestedModel: "Account default",
      requestedMode: "Account default",
      observedModel: null,
      observedMode: null,
      hasComputer: false,
      pinned: false,
      lifecycle: "idle",
    });
    expect(result).toEqual({ ok: true, selectedTaskId: created?.taskId });
    expect(h.conversationUrls.get(created!.taskId)).toBeNull();
    expect(h.routes.has(created!.taskId)).toBe(true);
    expect(h.state).toMatchObject({
      selected: created!.taskId,
      section: "browser",
      setupOpen: false,
      overlay: "none",
    });
    expect(h.events).toEqual([
      "admission",
      "persist",
      "route:ChatGPT task 2",
      `selected:${created!.taskId}`,
      "section:browser",
      "setup:false",
      "overlay:none",
      "publishTasks",
      "publishLayout",
      `open:${created!.taskId}`,
    ]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("keeps the created task when its surface is unreachable", async () => {
    const h = await build();
    h.state.surfaceOpens = false;
    const result = await h.run({ kind: "task.create-chatgpt" });
    expect(result).toEqual(h.failure("TASK_SURFACE_UNREACHABLE"));
    const [created] = h.registry.snapshot().tasks;
    expect(created?.label).toBe("ChatGPT task 1");
    expect(h.state.selected).toBe(created?.taskId);
    expect(h.routes.has(created!.taskId)).toBe(true);
  });

  it("reports the capacity and creates no route", async () => {
    const full = [1, 2, 3, 4, 5].map((index) => task(index));
    const h = await build({ tasks: full });
    expect(await h.run({ kind: "task.create-chatgpt" })).toEqual(
      h.failure("TASK_CAPACITY_REACHED"),
    );
    expect(h.routes.size).toBe(0);
    expect(h.events.some((event) => event.startsWith("route:"))).toBe(false);
  });

  it("refuses with an unavailable route when a promotion holds the lease", async () => {
    const h = await build();
    vi.spyOn(h.registry, "admitDurable").mockResolvedValueOnce({
      status: "promotion_pending",
    });
    expect(await h.run({ kind: "task.create-chatgpt" })).toEqual(
      h.failure("TASK_ROUTE_UNAVAILABLE"),
    );
    expect(h.routes.size).toBe(0);
  });

  it("returns a failed save as unavailable state with the admission rolled back", async () => {
    const h = await build();
    h.state.persistFails = true;
    expect(await h.run({ kind: "task.create-chatgpt" })).toEqual(
      h.failure("TASK_STATE_UNAVAILABLE"),
    );
    expect(h.registry.snapshot().tasks).toEqual([]);
    expect(h.routes.size).toBe(0);
    expect(h.state.selected).toBe("");
    expect(h.gate.inFlight()).toBe(false);
  });
});

describe("task.start-agent", () => {
  it("is refused while the Agent route is off", async () => {
    const only = task(1);
    const h = await build({
      tasks: [only],
      overrides: { productAgentEnabled: false },
    });
    expect(await h.run(start(only.taskId))).toEqual(
      h.failure("AGENT_NOT_READY"),
    );
    expect(h.events).toEqual(["admission"]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("refuses an unknown task and a task that is not a ChatGPT task", async () => {
    const fixture = task(1, { provider: "fixture" });
    const h = await build({ tasks: [fixture] });
    expect(await h.run(start("nope"))).toEqual(h.failure("TASK_NOT_FOUND"));
    expect(await h.run(start(fixture.taskId))).toEqual(
      h.failure("TASK_NOT_FOUND"),
    );
  });

  it("refuses while another task's session or pending agent is live, but not its own", async () => {
    const [first, second] = [task(1), task(2)];
    const h = await build({ tasks: [first, second] });
    h.state.session = { taskId: second.taskId };
    expect(await h.run(start(first.taskId))).toEqual(
      h.failure("AGENT_ALREADY_RUNNING"),
    );
    h.state.session = null;
    h.state.pending = second.taskId;
    expect(await h.run(start(first.taskId))).toEqual(
      h.failure("AGENT_ALREADY_RUNNING"),
    );
    // The same task's own pending agent is not a conflict.
    h.state.pending = first.taskId;
    h.state.session = { taskId: first.taskId };
    expect((await h.run(start(first.taskId))).ok).toBe(true);
  });

  it("refuses an unknown outcome and an agent that is running or undelivered", async () => {
    const cases: [
      string,
      NonNullable<ProductTask["agent"]>,
      TaskCommandError,
    ][] = [
      [
        "outcome unknown",
        agentOf("outcome_unknown"),
        "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
      ],
      ["running", agentOf("running"), "AGENT_ALREADY_RUNNING"],
      ["undelivered", agentOf("completed", "pending"), "AGENT_ALREADY_RUNNING"],
    ];
    for (const [, agent, error] of cases) {
      const only = task(1, { agent });
      const h = await build({ tasks: [only] });
      expect(await h.run(start(only.taskId))).toEqual(h.failure(error));
      expect(h.state.settings).not.toBeNull();
      expect(h.events).toEqual(["admission"]);
    }
  });

  it("refuses when the configuration is not ready or no context matches", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    h.state.settings = null;
    expect(await h.run(start(only.taskId))).toEqual(
      h.failure("AGENT_NOT_READY"),
    );
    h.state.settings = settingsOf();
    expect(
      await h.run(start(only.taskId, { workspaceId: "other-workspace" })),
    ).toEqual(h.failure("AGENT_NOT_READY"));
    h.state.agentStore = null;
    expect(await h.run(start(only.taskId))).toEqual(
      h.failure("AGENT_NOT_READY"),
    );
  });

  it("refuses a scope that falls inside an excluded path", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    h.state.settings = settingsOf([`${ROOT}/secret`]);
    expect(
      await h.run(
        start(only.taskId, {
          scope: { mode: "subtree", relativeRoot: "secret", excludedPaths: [] },
        }),
      ),
    ).toEqual(h.failure("AGENT_SCOPE_INVALID"));
    expect(await h.agentStore.load(only.taskId)).toBeNull();
  });

  it("builds, saves, marks the task running, publishes and executes a new agent", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    const result = await h.run(start(only.taskId));
    expect(result).toEqual({ ok: true, selectedTaskId: only.taskId });
    const saved = await h.agentStore.load(only.taskId);
    expect(saved).toMatchObject({
      taskId: only.taskId,
      sessionId: only.sessionId,
      workspaceId: WORKSPACE_ID,
      scope: { mode: "subtree", root: ROOT },
      objective: "Find the marker.",
      taskEpoch: GENERATION,
      computerGeneration: GENERATION,
      generation: 1,
      executableSha256: EXECUTABLE_SHA,
      schemaSha256: SCHEMA_SHA,
      buildId: BUILD_ID,
      expiresAt: NOW + 30 * 60_000,
      createdAt: new Date(NOW).toISOString(),
    } satisfies Partial<ProductAgentInput>);
    expect(ProductAgentInputSchema.safeParse(saved).success).toBe(true);
    const ids = new Set([
      saved?.assignmentId,
      saved?.authorityId,
      saved?.parentParticipantId,
      saved?.agentParticipantId,
    ]);
    expect(ids.size).toBe(4);
    expect(h.registry.get(only.taskId)?.agent).toEqual({
      assignmentBindingSha256: "b".repeat(64),
      phase: "running",
      workspaceId: WORKSPACE_ID,
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
    });
    expect(h.events).toEqual([
      "admission",
      "snapshot",
      "persist",
      "publishTasks",
      `execute:new:${only.taskId}:${WORKSPACE_ID}`,
    ]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("samples the configuration before the awaited save", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    const save = vi.spyOn(h.agentStore, "save");
    save.mockImplementationOnce(async () => {
      h.events.push("save");
    });
    await h.run(start(only.taskId));
    expect(h.events.indexOf("snapshot")).toBeLessThan(h.events.indexOf("save"));
  });

  it("returns a failed input save as unavailable input state and marks nothing", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    vi.spyOn(h.agentStore, "save").mockRejectedValueOnce(new Error("SAVE"));
    expect(await h.run(start(only.taskId))).toEqual(
      h.failure("AGENT_INPUT_STATE_UNAVAILABLE"),
    );
    expect(h.registry.get(only.taskId)?.agent ?? null).toBeNull();
    expect(h.events).toEqual(["admission", "snapshot"]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("removes the saved input and rolls back when the durable mark fails to save", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    h.state.persistFails = true;
    expect(await h.run(start(only.taskId))).toEqual(
      h.failure("TASK_STATE_UNAVAILABLE"),
    );
    expect(h.registry.get(only.taskId)?.agent ?? null).toBeNull();
    expect(await h.agentStore.load(only.taskId)).toBeNull();
    expect(h.events).not.toContain("publishTasks");
  });

  it("removes the saved input itself when a promotion holds the lease", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    vi.spyOn(h.registry, "startAgentDurable").mockResolvedValueOnce({
      ok: false,
      code: "TASK_ROUTE_UNAVAILABLE",
    });
    expect(await h.run(start(only.taskId))).toEqual(
      h.failure("TASK_ROUTE_UNAVAILABLE"),
    );
    expect(await h.agentStore.load(only.taskId)).toBeNull();
  });

  it("leaves the saved input for a refusal that already compensated", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    vi.spyOn(h.registry, "startAgentDurable").mockResolvedValueOnce({
      ok: false,
      code: "TASK_NOT_FOUND",
    });
    expect(await h.run(start(only.taskId))).toEqual(
      h.failure("TASK_NOT_FOUND"),
    );
    expect(await h.agentStore.load(only.taskId)).not.toBeNull();
  });
});

describe("task.rejoin-agent", () => {
  async function stored(
    only: ProductTask,
    h: Awaited<ReturnType<typeof build>>,
  ) {
    await h.agentStore.save(
      ProductAgentInputSchema.parse({
        taskId: only.taskId,
        sessionId: only.sessionId,
        assignmentId: "assignment-1",
        authorityId: "authority-1",
        parentParticipantId: "main-1",
        agentParticipantId: "agent-1",
        taskEpoch: 0,
        generation: 1,
        workspaceId: WORKSPACE_ID,
        scope: { mode: "subtree", root: ROOT },
        excludedPaths: [],
        objective: "Find the marker.",
        computerGeneration: GENERATION,
        executableSha256: EXECUTABLE_SHA,
        schemaSha256: SCHEMA_SHA,
        buildId: BUILD_ID,
        expiresAt: NOW + 60_000,
        createdAt: TIMESTAMP,
      }),
    );
  }

  it("refuses a task that has no agent to rejoin", async () => {
    const only = task(1);
    const h = await build({ tasks: [only] });
    expect(
      await h.run({ kind: "task.rejoin-agent", taskId: only.taskId }),
    ).toEqual(h.failure("AGENT_REJOIN_UNAVAILABLE"));
    expect(h.events).toEqual(["admission"]);
  });

  it("is refused while the Agent route is off, and for another task's session", async () => {
    const [first, second] = [task(1, { agent: agentOf("running") }), task(2)];
    const off = await build({
      tasks: [first],
      overrides: { productAgentEnabled: false },
    });
    expect(
      await off.run({ kind: "task.rejoin-agent", taskId: first.taskId }),
    ).toEqual(off.failure("AGENT_NOT_READY"));
    const busy = await build({ tasks: [first, second] });
    busy.state.session = { taskId: second.taskId };
    expect(
      await busy.run({ kind: "task.rejoin-agent", taskId: first.taskId }),
    ).toEqual(busy.failure("AGENT_ALREADY_RUNNING"));
  });

  it("executes a rejoin from the stored input and a fresh configuration", async () => {
    const only = task(1, { agent: agentOf("running") });
    const h = await build({ tasks: [only] });
    await stored(only, h);
    expect(
      await h.run({ kind: "task.rejoin-agent", taskId: only.taskId }),
    ).toEqual({ ok: true, selectedTaskId: only.taskId });
    expect(h.events).toEqual([
      "admission",
      "snapshot",
      `execute:rejoin:${only.taskId}:${WORKSPACE_ID}`,
    ]);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("reads the configuration after the awaited load, not before", async () => {
    const only = task(1, { agent: agentOf("running") });
    const h = await build({ tasks: [only] });
    await stored(only, h);
    const real = h.agentStore.load.bind(h.agentStore);
    vi.spyOn(h.agentStore, "load").mockImplementationOnce(async (taskId) => {
      const input = await real(taskId);
      h.events.push("loaded");
      h.state.settings = null;
      return input;
    });
    expect(
      await h.run({ kind: "task.rejoin-agent", taskId: only.taskId }),
    ).toEqual(h.failure("AGENT_NOT_READY"));
    expect(h.events).toEqual(["admission", "loaded", "snapshot"]);
  });

  it("refuses a missing input and an unreadable one without recording anything", async () => {
    const only = task(1, { agent: agentOf("running") });
    const h = await build({ tasks: [only] });
    expect(
      await h.run({ kind: "task.rejoin-agent", taskId: only.taskId }),
    ).toEqual(h.failure("AGENT_REJOIN_UNAVAILABLE"));
    vi.spyOn(h.agentStore, "load").mockRejectedValueOnce(new Error("LOAD"));
    expect(
      await h.run({ kind: "task.rejoin-agent", taskId: only.taskId }),
    ).toEqual(h.failure("AGENT_INPUT_STATE_UNAVAILABLE"));
    expect(h.events.some((event) => event.startsWith("summary:"))).toBe(false);
  });

  it("records an unknown summary when the stored input is not this agent's", async () => {
    const only = task(1, { agent: agentOf("running") });
    const h = await build({ tasks: [only] });
    await stored(only, h);
    h.state.assignmentMatches = false;
    expect(
      await h.run({ kind: "task.rejoin-agent", taskId: only.taskId }),
    ).toEqual(h.failure("AGENT_REJOIN_UNAVAILABLE"));
    expect(h.events).toEqual([
      "admission",
      `summary:${only.taskId}:outcome_unknown`,
    ]);
  });

  it("still refuses when recording that summary fails", async () => {
    const only = task(1, { agent: agentOf("running") });
    const h = await build({
      tasks: [only],
      overrides: {
        persistProductAgentSummary: async () => {
          throw new Error("SUMMARY");
        },
      },
    });
    await stored(only, h);
    h.state.assignmentMatches = false;
    expect(
      await h.run({ kind: "task.rejoin-agent", taskId: only.taskId }),
    ).toEqual(h.failure("AGENT_REJOIN_UNAVAILABLE"));
    expect(h.gate.inFlight()).toBe(false);
  });
});
