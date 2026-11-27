import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type {
  CodexContextController,
  createCodexContextController,
} from "../../../src/apps/desktop/codex-context-runtime";
import {
  reconcileTaskContexts,
  toProductTaskContext,
} from "../../../src/apps/desktop/context-task-state";
import type {
  LiveTaskAdmission,
  LiveTaskRegistry,
} from "../../../src/apps/desktop/live-task-registry";
import type { PrivateLiveTaskStore } from "../../../src/apps/desktop/live-task-store";
import type {
  RouteBRuntime,
  RouteBSurfaceAdmission,
  RouteBTaskSurfaces,
  RouteBToolRelay,
  startRouteBRuntime,
} from "../../../src/apps/desktop/route-b-runtime";
import type { startSavedChatBridge } from "../../../src/apps/desktop/saved-chat-bridge";
import {
  recoverSummaryExecutionFence,
  type SummaryFenceRecovery,
  type SummaryFenceRecoveryPorts,
} from "../../../src/apps/desktop/summary-fence-recovery";
import {
  sweepOrphanTaskContexts,
  type deleteTaskContext,
  type TaskExecutionFence,
} from "../../../src/apps/desktop/task-context-cleanup";
import {
  underTaskMutation,
  type TaskMutationGate,
} from "../../../src/apps/desktop/task-mutation-gate";
import { createCell } from "../host/cell";

// The Route B and context-controller host: the first-turn admission of a Codex
// host thread, the private context controller with the connector's execution
// fence, the Route B runtime and the restart reconciliation that brings the
// fence in line with the private context store before any work is admitted.
// The controller, the fence, the last fence recovery and the runtime are read
// or written by main as well (Quit closes the runtime, the connector start
// reads the recovery, the bridge and the task cleanup read the fence), so the
// owner exposes them as cells and main reads and writes through them at the
// same places it always did. Main keeps every other owner; each `let` there is
// a late getter here, and the concrete constructors are ports.

export type ContextBinding = Parameters<typeof deleteTaskContext>[1];

type ProductTask = Parameters<LiveTaskRegistry["admitDurable"]>[0];

// What the controller's summary fence, the restart recovery, the task cleanup
// and the saved-chat bridge each need from the connector's execution fence.
export type ExecutionFence = SummaryFenceRecoveryPorts["fence"] &
  TaskExecutionFence &
  Readonly<{
    lower(operationId: string): Promise<void>;
    acquireAdmission: Parameters<typeof startSavedChatBridge>[1];
  }>;

export type ContextHostPorts = Readonly<{
  statePaths: () => Readonly<{
    state: string;
    summaryFenceRecovery: string;
    secureMcpLaunch: string;
    contextContinuity: string;
  }>;
  contextOwnerId: string;
  contextProviderProfileId: string;
  contextModel: ContextBinding["modelId"];
  taskMutations: TaskMutationGate;
  liveTaskRegistry: LiveTaskRegistry;
  liveTaskRoutes: Map<string, ChatGptRoute>;
  liveTaskConversationUrls: Map<string, string | null>;
  liveTaskStore: () => PrivateLiveTaskStore | null;
  liveTaskRegistryRestored: () => boolean;
  routeBTaskSurfaces: RouteBTaskSurfaces;
  callerRelay: () => RouteBToolRelay | null;
  persistLiveTaskState: () => Promise<void>;
  publishTasksState: () => void;
  openLiveTaskSurface: (taskId: string) => Promise<boolean>;
  createLiveChatGptRoute: (
    taskId: string,
    label: string,
    initialUrl?: string,
  ) => ChatGptRoute;
  createContextSummaryFallbackRoute: (
    binding: ContextBinding,
    recoveredConversationUrl?: string,
  ) => ChatGptRoute;
  createExecutionFence: (root: string) => ExecutionFence;
  createCodexContextController: typeof createCodexContextController;
  startRouteBRuntime: typeof startRouteBRuntime;
}>;

export function createContextHost(ports: ContextHostPorts) {
  const {
    statePaths,
    contextOwnerId,
    contextProviderProfileId,
    contextModel,
    taskMutations,
    liveTaskRegistry,
    liveTaskRoutes,
    liveTaskConversationUrls,
    liveTaskStore,
    liveTaskRegistryRestored,
    routeBTaskSurfaces,
    callerRelay,
    persistLiveTaskState,
    publishTasksState,
    openLiveTaskSurface,
    createLiveChatGptRoute,
    createContextSummaryFallbackRoute,
    createExecutionFence,
    createCodexContextController,
    startRouteBRuntime,
  } = ports;

  const contextController = createCell<CodexContextController | null>(null);
  // The connector's execution fence for summary-only phases, shared with the
  // MCP process through the launch root; it exists once the controller does.
  const executionFence = createCell<ExecutionFence | null>(null);
  // What the last start's fence recovery concluded; the Computer connector is
  // not started while it holds nothing (or never ran).
  const summaryFenceRecovery = createCell<SummaryFenceRecovery | null>(null);
  const routeBRuntime = createCell<RouteBRuntime | null>(null);

  function contextBinding(taskId: string): ContextBinding {
    return {
      ownerId: contextOwnerId,
      taskId,
      hostThreadId: taskId,
      sessionId: taskId,
      providerProfileId: contextProviderProfileId,
      modelId: contextModel,
      mode: "chatgpt",
    };
  }

  // The first turn of a Codex host thread admits its task like a new Browser
  // task: a route, a saved task and an opened surface. The lifecycle above it
  // decides when a thread reaches this path.
  async function admitRouteBTask(
    threadId: string,
  ): Promise<RouteBSurfaceAdmission> {
    // `surfaceFor` read the gate free before it removed this thread's private
    // residue; another task mutation may have claimed it in that gap.
    return underTaskMutation(
      taskMutations,
      () => ({ ok: false, code: "TASK_ROUTE_BUSY" }),
      async () => {
        const before = liveTaskRegistry.snapshot();
        const labels = new Set(
          before.tasks.map((candidate) => candidate.label),
        );
        let ordinal = 1;
        while (labels.has(`Codex task ${ordinal}`)) ordinal += 1;
        const task: ProductTask = {
          taskId: threadId,
          sessionId: threadId,
          turnId: randomUUID(),
          label: `Codex task ${ordinal}`,
          provider: "chatgpt",
          requestedModel: "Account default",
          observedModel: null,
          requestedMode: "Account default",
          observedMode: null,
          hasComputer: false,
          pinned: false,
          lifecycle: "running",
        };
        // S35-03/2: admits and persists under the same cross-process lease a
        // promotion holds, so this cannot land in the gap after a promotion's
        // drain check validated nothing running and before its placement.
        let admitted: LiveTaskAdmission;
        try {
          admitted = await liveTaskRegistry.admitDurable(
            task,
            persistLiveTaskState,
          );
        } catch {
          return { ok: false, code: "TASK_STATE_UNAVAILABLE" };
        }
        if (admitted.status === "capacity") {
          return { ok: false, code: "TASK_CAPACITY_REACHED" };
        }
        if (admitted.status !== "admitted") {
          return { ok: false, code: "TASK_ROUTE_UNAVAILABLE" };
        }
        const route = createLiveChatGptRoute(task.taskId, task.label);
        // Farol submits this thread's turns, so a Cancel binds the turn. The
        // route is Route B, and its epoch advanced, from this admission and
        // before anything opens a page: not from its creation.
        route.admitRouteBTurn();
        liveTaskConversationUrls.set(task.taskId, null);
        liveTaskRoutes.set(task.taskId, route);
        publishTasksState();
        if (!(await openLiveTaskSurface(task.taskId))) {
          return { ok: false, code: "TASK_SURFACE_UNREACHABLE" };
        }
        return { ok: true, surface: route };
      },
    );
  }

  // What the start did with the connector's execution fence, kept privately
  // for diagnostics: whether the store was read and how many summaries it
  // still holds as possibly running.
  async function recordSummaryFenceRecovery(
    recovery: SummaryFenceRecovery,
  ): Promise<void> {
    const file = statePaths().summaryFenceRecovery;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(
      file,
      `${JSON.stringify({ schema: 1, at: new Date().toISOString(), ...recovery })}\n`,
      { mode: 0o600 },
    );
  }

  async function initializeRouteBRuntime(): Promise<void> {
    const controller = contextController.get();
    if (!controller || routeBRuntime.get()) return;
    const relay = callerRelay();
    try {
      routeBRuntime.set(
        await startRouteBRuntime({
          stateRoot: statePaths().state,
          surfaces: routeBTaskSurfaces,
          compaction: controller.continuity,
          ...(relay ? { relay } : {}),
        }),
      );
    } catch {
      // Route B stays unavailable; ordinary Browser tasks are unaffected.
      routeBRuntime.set(null);
    }
  }

  async function initializeCodexContextController(): Promise<void> {
    // While a summary-only phase runs, the connector's Computer tools are
    // fenced through the launch root its MCP process reads. A summary a crash
    // interrupted may still be running on its page, so the fence a previous
    // process raised is never cleared here: reconcileContextAfterRestart
    // brings it in line with the private context store before any work is
    // admitted.
    const fence = createExecutionFence(statePaths().secureMcpLaunch);
    executionFence.set(fence);
    contextController.set(
      createCodexContextController({
        ownerId: contextOwnerId,
        providerProfileId: contextProviderProfileId,
        stateRoot: statePaths().contextContinuity,
        liveTask: (taskId) => liveTaskRegistry.get(taskId) !== null,
        summaryFence: {
          raise: (input) =>
            fence.raise({
              operationId: input.operationId,
              taskId: input.binding.taskId,
            }),
          lower: (input) => fence.lower(input.operationId),
        },
        summaryRoutes: {
          retained: (binding) => liveTaskRoutes.get(binding.taskId) ?? null,
          createFallback: createContextSummaryFallbackRoute,
          recoverFallback: (binding, conversationUrl) =>
            createContextSummaryFallbackRoute(binding, conversationUrl),
        },
        onContextStateChanged: async (session) => {
          if (
            !liveTaskRegistry.setContext(
              session.binding.taskId,
              toProductTaskContext(session),
            )
          ) {
            return;
          }
          await persistLiveTaskState();
          publishTasksState();
        },
      }),
    );
  }

  // Before Route B or IPC can admit work, each restored task's visible context
  // is replaced by what the private context store holds.
  async function reconcileContextAfterRestart(): Promise<void> {
    const controller = contextController.get();
    if (!controller) return;
    const reconciled = await reconcileTaskContexts(
      liveTaskRegistry.snapshot().tasks.map((task) => task.taskId),
      controller.store,
      contextBinding,
    );
    let changed = false;
    for (const entry of reconciled) {
      const current = liveTaskRegistry.get(entry.taskId)?.context ?? null;
      if (isDeepStrictEqual(current, entry.context)) continue;
      changed =
        liveTaskRegistry.setContext(entry.taskId, entry.context) || changed;
    }
    if (changed) {
      await persistLiveTaskState().catch(() => undefined);
      publishTasksState();
    }
    // Context a closed task left behind is removed only when the registry was
    // really read; an unreadable registry sweeps nothing.
    await sweepOrphanTaskContexts(
      controller.store,
      liveTaskStore() && liveTaskRegistryRestored()
        ? {
            status: "loaded",
            taskIds: liveTaskRegistry
              .snapshot()
              .tasks.map((task) => task.taskId),
          }
        : { status: "unavailable" },
      contextBinding,
      executionFence.get() ?? undefined,
    ).catch(() => undefined);
    // A summary a crash interrupted may still be running on its page: only an
    // operation the store proves over, or a task the owner ended, loses its
    // fence; a store that cannot be read keeps every record. This runs before
    // Route B, IPC or the connector can admit work.
    const fence = executionFence.get();
    if (fence) {
      const recovered = await recoverSummaryExecutionFence({
        fence,
        store: controller.store,
      });
      summaryFenceRecovery.set(recovered);
      await recordSummaryFenceRecovery(recovered).catch(() => undefined);
    }
  }

  return {
    controller: contextController,
    fence: executionFence,
    recovery: summaryFenceRecovery,
    routeB: routeBRuntime,
    binding: contextBinding,
    admitRouteBTask,
    initializeCodexContextController,
    reconcileContextAfterRestart,
    initializeRouteBRuntime,
  };
}
