import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import { LiveTaskRegistry } from "../../src/apps/desktop/live-task-registry";
import type {
  ProductTask,
  ProductTaskLifecycle,
  ProductTasksState,
} from "../../src/modules/chat/contract/product-task";

// Actual helper, lifecycle/persistence callbacks and activity owner with the
// real registry/schema. Route settlements, persistence and host presentation
// ports are controlled: no provider, native disposal or durable acceptance.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
function functionNode(name: string) {
  const node = tree.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
  );
  if (!node || node.type !== "FunctionDeclaration" || !node.body)
    throw new Error("LIVE_SURFACE_FUNCTION_MISSING:" + name);
  return node;
}
function bytes(node: { start?: number | null; end?: number | null }) {
  if (node.start == null || node.end == null)
    throw new Error("LIVE_SURFACE_SOURCE_RANGE_MISSING");
  return source.slice(node.start, node.end);
}
const functions = [
  "openLiveTaskSurface",
  "setLiveTaskLifecycle",
  "surfaceLiveTaskPersistenceFailure",
  "publishTasksState",
  "publishTaskSurfaceStatus",
].map((name) => bytes(functionNode(name)));
const activity = functionNode("createLiveChatGptRoute")
  .body.body.filter((node) => node.type === "VariableDeclaration")
  .flatMap((node) => node.declarations)
  .find(
    (node) =>
      node.id.type === "Identifier" && node.id.name === "recordTaskActivity",
  )?.init;
if (!activity) throw new Error("LIVE_SURFACE_ACTIVITY_CALLBACK_MISSING");
const activitySource = bytes(activity);

type OpenResult = { status: "opened" | "unreachable" };
type Route = { open(): Promise<OpenResult> };
type Outcome = "opened" | "unreachable" | "rejected";
const taskId = "controlled-thread";
function candidate(
  lifecycle: ProductTaskLifecycle,
  turnId = "turn-one",
): ProductTask {
  return {
    taskId,
    // The re-admission cases below use the conditional Route B identity shape:
    // task/session retain the thread ID, and a new admission has a new turn.
    // Controlled registry admission is not native/provider reachability proof.
    sessionId: taskId,
    turnId,
    label: "Controlled surface",
    provider: "chatgpt",
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function host(lifecycle: ProductTaskLifecycle = "idle") {
  const registry = new LiveTaskRegistry(5);
  expect(registry.admit(candidate(lifecycle)).status).toBe("admitted");
  const pending = deferred<OpenResult>();
  const originalError = new Error("CONTROLLED_ORIGINAL_SURFACE_REJECTION");
  const originalOutcome = pending.promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  let opens = 0;
  const route: Route = {
    open: () => {
      opens++;
      return pending.promise;
    },
  };
  let onSend: ((channel: string) => void) | undefined;
  const sends: { channel: string; value: unknown }[] = [];
  const persisted: ProductTasksState[] = [];
  const presentation: string[] = [];
  const context = {
    taskId,
    liveTaskRegistry: registry,
    liveTaskRoutes: new Map<string, Route>([[taskId, route]]),
    taskSurfaceFailures: new Map([[taskId, "CONTROLLED_SURFACE_FAILURE"]]),
    quitInProgress: false,
    installedUpdateAdmission: false,
    demoMode: false,
    selectedTaskId: taskId,
    window: {
      webContents: {
        send(channel: string, value: unknown) {
          sends.push({ channel, value });
          onSend?.(channel);
        },
      },
    },
    channels: {
      tasksState: "controlled-tasks",
      taskSurfaceState: "controlled-surface",
    },
    persistLiveTaskState: () => {
      persisted.push(registry.snapshot());
      return Promise.resolve();
    },
    applyLayout: () => presentation.push("layout"),
    focusForLayoutAfterRendererCommit: () => presentation.push("focus-port"),
  };
  const api = vm.runInNewContext(
    stripTypeScriptTypes(
      functions.join("\n") +
        "\nconst recordTaskActivity = " +
        activitySource +
        ";\n({open:openLiveTaskSurface, activity:recordTaskActivity, persistenceFailure:surfaceLiveTaskPersistenceFailure});",
    ),
    context,
  ) as {
    open(id: string): Promise<boolean>;
    activity(state: "idle" | "running" | "outcome_unknown"): void;
    persistenceFailure(id: string): void;
  };
  function settle(outcome: Outcome) {
    if (outcome === "rejected") pending.reject(originalError);
    else pending.resolve({ status: outcome });
  }
  function clearObservations() {
    sends.length = 0;
    persisted.length = 0;
    presentation.length = 0;
  }
  return {
    api,
    context,
    registry,
    route,
    pending,
    originalError,
    originalOutcome,
    settle,
    clearObservations,
    sends,
    persisted,
    presentation,
    opens: () => opens,
    onSend: (callback: (channel: string) => void) => {
      onSend = callback;
    },
  };
}

async function expectOriginal(h: ReturnType<typeof host>, outcome: Outcome) {
  const original = await h.originalOutcome;
  if (outcome === "rejected") {
    expect(original.status).toBe("rejected");
    if (original.status === "rejected")
      expect(original.error).toBe(h.originalError);
  } else
    expect(original).toEqual({
      status: "fulfilled",
      value: { status: outcome },
    });
  expect(h.opens()).toBe(1);
}

it.each(
  (
    ["running-activity", "unknown-activity", "persistence-failure"] as const
  ).flatMap((origin) =>
    (["unreachable", "rejected"] as const).map((outcome) => ({
      origin,
      outcome,
    })),
  ),
)(
  "preserves the current $origin obligation after $outcome surface settlement",
  async ({ origin, outcome }) => {
    const h = host();
    const opening = h.api.open(taskId);
    if (origin === "persistence-failure") h.api.persistenceFailure(taskId);
    else
      h.api.activity(
        origin === "running-activity" ? "running" : "outcome_unknown",
      );
    await flush();
    const lifecycle =
      origin === "running-activity" ? "running" : "outcome_unknown";
    expect(h.registry.get(taskId)?.lifecycle).toBe(lifecycle);
    if (lifecycle === "outcome_unknown") {
      h.api.activity("idle");
      expect(h.registry.get(taskId)?.lifecycle).toBe("outcome_unknown");
    }
    h.clearObservations();
    h.settle(outcome);
    expect(await opening).toBe(false);
    await expectOriginal(h, outcome);
    await flush();
    expect(h.registry.get(taskId)?.lifecycle).toBe(lifecycle);
    expect(h.persisted).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    // A later explicit controlled load result is separate surface observation,
    // not replay of an UNKNOWN task or a native/provider retry.
    h.route.open = () => Promise.resolve({ status: "opened" });
    expect(await h.api.open(taskId)).toBe(true);
    expect(h.registry.get(taskId)?.lifecycle).toBe(lifecycle);
  },
);

it.each(["opened", "unreachable", "rejected"] as const)(
  "preserves genuine completed activity resolution before %s settlement",
  async (outcome) => {
    const h = host();
    h.api.activity("running");
    const opening = h.api.open(taskId);
    h.api.activity("idle");
    await flush();
    expect(h.registry.get(taskId)?.lifecycle).toBe("completed");
    h.clearObservations();
    h.settle(outcome);
    expect(await opening).toBe(outcome === "opened");
    await expectOriginal(h, outcome);
    expect(h.registry.get(taskId)?.lifecycle).toBe("completed");
    expect(h.persisted).toHaveLength(0);
  },
);

it.each(["opened", "unreachable", "rejected"] as const)(
  "retains healthy idle surface %s classification",
  async (outcome) => {
    const h = host();
    const opening = h.api.open(taskId);
    h.settle(outcome);
    expect(await opening).toBe(outcome === "opened");
    await expectOriginal(h, outcome);
    expect(h.registry.get(taskId)?.lifecycle).toBe(
      outcome === "opened" ? "idle" : "failed",
    );
    expect(h.persisted).toHaveLength(outcome === "opened" ? 0 : 1);
    expect(h.presentation).toEqual(
      outcome === "opened" ? ["layout", "focus-port"] : [],
    );
  },
);

it("retains healthy failed-to-idle recovery with current shallow-copy registry values", async () => {
  const h = host("failed");
  expect(h.registry.get(taskId)).not.toBe(h.registry.get(taskId));
  const opening = h.api.open(taskId);
  h.registry.rename(taskId, "Updated label");
  h.registry.setPinned(taskId, true);
  h.context.selectedTaskId = "other-task";
  h.settle("opened");
  expect(await opening).toBe(true);
  expect(h.registry.get(taskId)).toMatchObject({
    lifecycle: "idle",
    label: "Updated label",
    pinned: true,
  });
  expect(h.persisted).toHaveLength(1);
  expect(h.context.taskSurfaceFailures.has(taskId)).toBe(false);
  expect(h.sends[0]).toMatchObject({
    channel: "controlled-surface",
    value: { taskId, state: "ready", error: null },
  });
  expect(h.presentation).toEqual(["layout", "focus-port"]);
});

it.each(["quitInProgress", "installedUpdateAdmission"] as const)(
  "refuses new surface dispatch while %s holds admission",
  async (flag) => {
    const h = host();
    h.context[flag] = true;
    expect(await h.api.open(taskId)).toBe(false);
    expect(h.opens()).toBe(0);
    expect(h.persisted).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  },
);

it.each(["route", "task"] as const)(
  "refuses surface dispatch without the current %s owner",
  async (missing) => {
    const h = host();
    if (missing === "route") h.context.liveTaskRoutes.delete(taskId);
    else h.registry.remove(taskId);
    h.settle("opened");
    expect(await h.api.open(taskId)).toBe(false);
    expect(h.opens()).toBe(0);
    expect(h.sends).toHaveLength(0);
    expect(h.presentation).toHaveLength(0);
  },
);

it.each(
  (["removed", "route-replaced", "route-b-readmitted"] as const).flatMap(
    (change) =>
      (["opened", "unreachable", "rejected"] as const).map((outcome) => ({
        change,
        outcome,
      })),
  ),
)(
  "refuses stale $change projection after original $outcome settlement",
  async ({ change, outcome }) => {
    const h = host(outcome === "opened" ? "failed" : "idle");
    const opening = h.api.open(taskId);
    let replacementOpens = 0;
    if (change === "removed") h.registry.remove(taskId);
    else if (change === "route-replaced") {
      h.context.liveTaskRoutes.set(taskId, {
        open: () => {
          replacementOpens++;
          return Promise.resolve({ status: "opened" });
        },
      });
    } else {
      expect(h.registry.remove(taskId)).not.toBeNull();
      expect(
        h.registry.admit(candidate("outcome_unknown", "new-route-b-turn"))
          .status,
      ).toBe("admitted");
    }
    const before = h.registry.snapshot();
    h.settle(outcome);
    expect(await opening).toBe(false);
    await expectOriginal(h, outcome);
    expect(h.registry.snapshot()).toEqual(before);
    expect(h.persisted).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.presentation).toHaveLength(0);
    expect(h.context.taskSurfaceFailures.get(taskId)).toBe(
      "CONTROLLED_SURFACE_FAILURE",
    );
    expect(replacementOpens).toBe(0);
  },
);

it("rechecks current route after a synchronous ready publication replaces it", async () => {
  const h = host("failed");
  const opening = h.api.open(taskId);
  h.onSend((channel) => {
    if (channel === "controlled-surface")
      h.context.liveTaskRoutes.delete(taskId);
  });
  h.settle("opened");
  expect(await opening).toBe(false);
  expect(h.registry.get(taskId)?.lifecycle).toBe("failed");
  expect(h.persisted).toHaveLength(0);
  expect(h.presentation).toHaveLength(0);
  expect(h.sends).toHaveLength(1);
});
