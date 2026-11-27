import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type { PrivateLiveTaskStore } from "../../../src/apps/desktop/live-task-store";
import { admitProductAgentRejoin } from "../../../src/apps/desktop/product-agent-rejoin";
import {
  productAgentContext,
  type ProductAgentContext,
} from "../../../src/apps/desktop/product-agent-context";
import { resolveProductAgentScope } from "../../../src/apps/desktop/product-agent-scope";
import type {
  PrivateProductAgentStore,
  ProductAgentInput,
} from "../../../src/apps/desktop/product-agent-store";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { RouteBTaskLifecycle } from "../../../src/apps/desktop/route-b-task-lifecycle";
import type { TurnLifecycle } from "./turns";
import type {
  ShellOverlay,
  SurfaceSection,
} from "../../../src/apps/desktop/surface-layout";

// The `task.*` commands the renderer sends: activate, create, rename, pin,
// close, cancel and the Product Agent start and rejoin. Main keeps every owner,
// the Agent session, the surface and the layout; each `let` there is a late
// getter or a setter here, so a change made while a command awaits is seen at
// the next read. The registry, the two maps, the gate and the lifecycle are the
// owners' own objects, shared by reference. The command is parsed by the
// caller's schema and the result is the caller's type: nothing here knows
// either contract. A refusal returns at once and nothing here retries.

type ProductTask = Parameters<LiveTaskRegistry["admitDurable"]>[0];
type LiveTaskAdmission = Awaited<ReturnType<LiveTaskRegistry["admitDurable"]>>;
type ProductTaskAgent = NonNullable<ProductTask["agent"]>;
type ProductAgentScopeSelection = Parameters<
  typeof resolveProductAgentScope
>[2];

export type TaskCommandError =
  | "TASK_COMMAND_INVALID"
  | "TASKS_UNAVAILABLE"
  | "CHATGPT_CONNECTION_NOT_VERIFIED"
  | "TASK_CAPACITY_REACHED"
  | "TASK_ROUTE_UNAVAILABLE"
  | "TASK_NOT_FOUND"
  | "TASK_SURFACE_UNREACHABLE"
  | "TASK_OPERATION_IN_PROGRESS"
  | "TASK_STATE_UNAVAILABLE"
  | "TASK_NOT_RUNNING"
  | "TASK_CANCEL_FAILED"
  | "TASK_CANCEL_PAGE_CHANGED"
  | "TASK_CANCEL_NOT_YET_BOUND"
  | "AGENT_NOT_READY"
  | "AGENT_SCOPE_INVALID"
  | "AGENT_ALREADY_RUNNING"
  | "AGENT_INPUT_STATE_UNAVAILABLE"
  | "AGENT_ASSIGNMENT_FAILED"
  | "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"
  | "AGENT_CANCEL_RACED_COMPLETION"
  | "AGENT_DELIVERY_FAILED"
  | "AGENT_REJOIN_UNAVAILABLE";

export type TaskCommand =
  | Readonly<{ kind: "task.create-chatgpt" }>
  | Readonly<{ kind: "task.activate"; taskId: string }>
  | Readonly<{ kind: "task.rename"; taskId: string; label: string }>
  | Readonly<{ kind: "task.pin"; taskId: string; pinned: boolean }>
  | Readonly<{ kind: "task.close"; taskId: string }>
  | Readonly<{ kind: "task.cancel"; taskId: string }>
  | Readonly<{
      kind: "task.start-agent";
      taskId: string;
      workspaceId: string;
      objective: string;
      scope: ProductAgentScopeSelection;
    }>
  | Readonly<{ kind: "task.rejoin-agent"; taskId: string }>;

export type TaskCommandParse =
  Readonly<{ success: true; data: TaskCommand }> | Readonly<{ success: false }>;

// What a command does to a route: retitle it and cancel its active turn.
type TaskRoute = Pick<ChatGptRoute, "setTitle" | "cancelActiveTask">;

export type TaskCommandsPorts<Result> = Readonly<{
  parseCommand: (value: unknown) => TaskCommandParse;
  taskFailure: (error: TaskCommandError) => Result;
  taskSuccess: (taskId: string | null) => Result;
  desktopAdmission: Readonly<{ closed: () => boolean }>;
  demoMode: boolean;
  taskMutations: Readonly<{
    inFlight: () => boolean;
    tryEnter: () => Readonly<{ release: () => void }> | null;
  }>;
  liveTaskRegistry: Pick<
    LiveTaskRegistry,
    | "get"
    | "snapshot"
    | "rename"
    | "setPinned"
    | "rollback"
    | "setLifecycle"
    | "startAgentDurable"
    | "admitDurable"
  >;
  liveTaskRoutes: Map<string, TaskRoute>;
  liveTaskConversationUrls: Map<string, string | null>;
  selectedTaskId: () => string;
  setSelectedTaskId: (value: string) => void;
  setSection: (value: SurfaceSection) => void;
  setShellOverlay: (value: ShellOverlay) => void;
  setSetupOpen: (value: boolean) => void;
  liveTaskStore: () => PrivateLiveTaskStore | null;
  setLiveTaskStore: (value: PrivateLiveTaskStore | null) => void;
  productAgentEnabled: boolean;
  activeProductAgentSession: () => Readonly<{ taskId: string }> | null;
  persistedProductAgentExpiry: () => Readonly<{
    taskId: string;
    timer: NodeJS.Timeout;
  }> | null;
  setPersistedProductAgentExpiry: (value: null) => void;
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  productAgentStore: () => PrivateProductAgentStore | null;
  chatGptRoute: () => unknown;
  routeBTaskLifecycle: Pick<RouteBTaskLifecycle, "close">;
  turnLifecycle: Pick<TurnLifecycle, "startCancel" | "finishCancel">;
  buildId: string;
  randomUUID: () => string;
  now: () => number;
  applyLayout: () => void;
  publishLayout: () => void;
  publishTasksState: () => void;
  openLiveTaskSurface: (taskId: string) => Promise<boolean>;
  persistLiveTaskState: () => Promise<void>;
  surfaceLiveTaskPersistenceFailure: (taskId: string) => void;
  chatGptTaskAdmissionReady: () => boolean;
  createLiveChatGptRoute: (taskId: string, label: string) => TaskRoute;
  pendingProductAgentTaskId: () => string | null;
  productAgentAssignmentBinding: (input: ProductAgentInput) => string;
  productAgentAssignmentMatches: (
    agent: ProductTaskAgent,
    input: ProductAgentInput,
  ) => boolean;
  productAgentUnknownSummaryFromTask: (
    agent: ProductTaskAgent,
  ) => ProductTaskAgent;
  persistProductAgentSummary: (
    taskId: string,
    summary: ProductTaskAgent,
  ) => Promise<boolean>;
  executeProductAgent: (
    task: ProductTask,
    input: ProductAgentInput,
    context: ProductAgentContext,
    admission: "new" | "rejoin",
  ) => Promise<Result>;
  cancelProductAgentTask: (task: ProductTask) => Promise<Result>;
}>;

export function createTaskCommands<Result>(ports: TaskCommandsPorts<Result>) {
  const {
    parseCommand,
    taskFailure,
    taskSuccess,
    desktopAdmission,
    demoMode,
    taskMutations,
    liveTaskRegistry,
    liveTaskRoutes,
    liveTaskConversationUrls,
    selectedTaskId,
    setSelectedTaskId,
    setSection,
    setShellOverlay,
    setSetupOpen,
    liveTaskStore,
    setLiveTaskStore,
    productAgentEnabled,
    activeProductAgentSession,
    persistedProductAgentExpiry,
    setPersistedProductAgentExpiry,
    configuration,
    productAgentStore,
    chatGptRoute,
    routeBTaskLifecycle,
    turnLifecycle,
    buildId,
    randomUUID,
    now,
    applyLayout,
    publishLayout,
    publishTasksState,
    openLiveTaskSurface,
    persistLiveTaskState,
    surfaceLiveTaskPersistenceFailure,
    chatGptTaskAdmissionReady,
    createLiveChatGptRoute,
    pendingProductAgentTaskId,
    productAgentAssignmentBinding,
    productAgentAssignmentMatches,
    productAgentUnknownSummaryFromTask,
    persistProductAgentSummary,
    executeProductAgent,
    cancelProductAgentTask,
  } = ports;

  function productAgentInput(
    task: ProductTask,
    context: ProductAgentContext,
    objective: string,
    scope: ProductAgentScopeSelection,
  ): ProductAgentInput | null {
    const startedAt = now();
    const resolved = resolveProductAgentScope(
      context.workspace.root,
      context.workspace.excludedPaths,
      scope,
    );
    if (!resolved) return null;
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      assignmentId: randomUUID(),
      authorityId: randomUUID(),
      parentParticipantId: randomUUID(),
      agentParticipantId: randomUUID(),
      taskEpoch: context.settings.computer.generation,
      generation: 1,
      workspaceId: context.workspace.workspaceId,
      ...resolved,
      objective,
      computerGeneration: context.settings.computer.generation,
      executableSha256: context.host.executableSha256,
      schemaSha256: context.host.schemaSha256,
      buildId,
      expiresAt: startedAt + 30 * 60_000,
      createdAt: new Date(startedAt).toISOString(),
    };
  }

  // A Cancel is never queued behind another and never takes another's result.
  // Whatever a Cancel authorizes (the turn, the document, the page) is captured
  // when it is admitted and is only valid for the attempt that captured it, so
  // a request that waited would act on an identity it did not capture. While
  // any task mutation is in flight (a Cancel's own attempt, which holds the
  // gate from its admission to its persisted result, included) `run` therefore
  // refuses at once with `TASK_OPERATION_IN_PROGRESS`: nothing is clicked,
  // nothing is recorded, the task stays as it was, and the owner can ask again
  // when the first attempt has settled. A Cancel's first effect, taking its
  // ticket and calling the route (which captures the page in the same tick),
  // follows its admission with no await between them.
  async function run(value: unknown): Promise<Result> {
    const command = parseCommand(value);
    if (!command.success) return taskFailure("TASK_COMMAND_INVALID");
    if (desktopAdmission.closed())
      return taskFailure("TASK_OPERATION_IN_PROGRESS");
    if (demoMode) {
      return taskFailure("TASKS_UNAVAILABLE");
    }
    if (taskMutations.inFlight()) {
      return taskFailure("TASK_OPERATION_IN_PROGRESS");
    }
    if (command.data.kind === "task.activate") {
      const mutation = taskMutations.tryEnter();
      if (!mutation) return taskFailure("TASK_OPERATION_IN_PROGRESS");
      try {
        if (!liveTaskRegistry.get(command.data.taskId)) {
          return taskFailure("TASK_NOT_FOUND");
        }
        setSelectedTaskId(command.data.taskId);
        setSection("browser");
        setShellOverlay("none");
        applyLayout();
        publishLayout();
        return (await openLiveTaskSurface(command.data.taskId))
          ? taskSuccess(command.data.taskId)
          : taskFailure("TASK_SURFACE_UNREACHABLE");
      } finally {
        mutation.release();
      }
    }
    if (!liveTaskStore()) return taskFailure("TASK_STATE_UNAVAILABLE");
    const mutation = taskMutations.tryEnter();
    if (!mutation) return taskFailure("TASK_OPERATION_IN_PROGRESS");
    const before = liveTaskRegistry.snapshot();
    try {
      if (
        command.data.kind === "task.start-agent" ||
        command.data.kind === "task.rejoin-agent"
      ) {
        if (!productAgentEnabled) {
          return taskFailure("AGENT_NOT_READY");
        }
        const task = liveTaskRegistry.get(command.data.taskId);
        if (!task || task.provider !== "chatgpt") {
          return taskFailure("TASK_NOT_FOUND");
        }
        const activeSession = activeProductAgentSession();
        if (activeSession && activeSession.taskId !== task.taskId) {
          return taskFailure("AGENT_ALREADY_RUNNING");
        }
        const pendingTaskId = pendingProductAgentTaskId();
        if (pendingTaskId && pendingTaskId !== task.taskId) {
          return taskFailure("AGENT_ALREADY_RUNNING");
        }

        let input: ProductAgentInput;
        let context: ProductAgentContext | null;
        if (command.data.kind === "task.start-agent") {
          if (task.agent?.phase === "outcome_unknown") {
            return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
          }
          if (
            task.agent?.phase === "running" ||
            (task.agent?.phase === "completed" &&
              task.agent.parentDelivery !== "acknowledged")
          ) {
            return taskFailure("AGENT_ALREADY_RUNNING");
          }
          const startAgentSnapshot = configuration()?.snapshot();
          context = productAgentContext(
            command.data.workspaceId,
            startAgentSnapshot?.status === "ready"
              ? startAgentSnapshot.settings
              : null,
            productAgentStore(),
            buildId,
          );
          if (!context) return taskFailure("AGENT_NOT_READY");
          const candidate = productAgentInput(
            task,
            context,
            command.data.objective,
            command.data.scope,
          );
          if (!candidate) return taskFailure("AGENT_SCOPE_INVALID");
          input = candidate;
          try {
            await productAgentStore()!.save(input);
          } catch {
            return taskFailure("AGENT_INPUT_STATE_UNAVAILABLE");
          }
          // S35-03/4: starting a native Agent turns this task into the SAME
          // `AGENT_RUNNING` obligation a promotion's drain check refuses on,
          // so it takes the same cross-process lease `admitDurable` does for
          // a brand new task — not only new admission is guarded.
          //
          // S35-TA-1: the leased body is `startAgentDurable`, so a
          // stolen-lease test drives the function this call site calls
          // rather than a copy of it.
          const agentStart = await liveTaskRegistry.startAgentDurable(
            task.taskId,
            {
              assignmentBindingSha256: productAgentAssignmentBinding(input),
              phase: "running",
              workspaceId: input.workspaceId,
              parentDelivery: "not_applicable",
              workspaceEnforcement: "not_applicable",
              resultAvailable: false,
            },
            () => persistLiveTaskState(),
            before,
            () =>
              productAgentStore()!
                .remove(task.taskId)
                .catch(() => undefined),
          );
          if (!agentStart.ok) {
            // A lease a live promotion holds is the one refusal that leaves
            // the Agent input saved: the other two have already compensated.
            if (agentStart.code === "TASK_ROUTE_UNAVAILABLE") {
              await productAgentStore()!
                .remove(task.taskId)
                .catch(() => undefined);
            }
            return taskFailure(agentStart.code);
          }
          publishTasksState();
        } else {
          // S35-TA-11: the admission itself is `admitProductAgentRejoin`, so
          // the one thing that matters here — that the settings are read AFTER
          // the awaited load, not before — is exercised by tests rather than
          // asserted in a comment. `readSettings` is passed as a thunk for
          // exactly that reason: the module, not this call site, decides when
          // it runs.
          const admitted = await admitProductAgentRejoin({
            agent: task.agent,
            loadInput: () => productAgentStore()!.load(task.taskId),
            readSettings: () => {
              const snapshot = configuration()?.snapshot();
              return snapshot?.status === "ready" ? snapshot.settings : null;
            },
            store: productAgentStore(),
            buildId,
            assignmentMatches: productAgentAssignmentMatches,
          });
          if (!admitted.ok) {
            if (admitted.recordUnknownSummary) {
              await persistProductAgentSummary(
                task.taskId,
                productAgentUnknownSummaryFromTask(task.agent!),
              ).catch(() => undefined);
            }
            return taskFailure(admitted.refusal);
          }
          input = admitted.input;
          context = admitted.context;
        }
        return executeProductAgent(
          task,
          input,
          context,
          command.data.kind === "task.rejoin-agent" ? "rejoin" : "new",
        );
      }
      if (command.data.kind === "task.rename") {
        if (!liveTaskRegistry.rename(command.data.taskId, command.data.label)) {
          return taskFailure("TASK_NOT_FOUND");
        }
        try {
          await persistLiveTaskState();
        } catch {
          liveTaskRegistry.rollback(before);
          return taskFailure("TASK_STATE_UNAVAILABLE");
        }
        liveTaskRoutes
          .get(command.data.taskId)
          ?.setTitle(`${command.data.label.trim()} · Farol`);
        publishTasksState();
        return taskSuccess(command.data.taskId);
      }
      if (command.data.kind === "task.pin") {
        if (
          !liveTaskRegistry.setPinned(command.data.taskId, command.data.pinned)
        ) {
          return taskFailure("TASK_NOT_FOUND");
        }
        try {
          await persistLiveTaskState();
        } catch {
          liveTaskRegistry.rollback(before);
          return taskFailure("TASK_STATE_UNAVAILABLE");
        }
        publishTasksState();
        return taskSuccess(command.data.taskId);
      }
      if (command.data.kind === "task.close") {
        const task = liveTaskRegistry.get(command.data.taskId);
        if (
          task?.agent?.phase === "running" ||
          (task?.agent?.phase === "completed" &&
            task.agent.parentDelivery !== "acknowledged")
        ) {
          return taskFailure("AGENT_ALREADY_RUNNING");
        }
        const expiry = persistedProductAgentExpiry();
        if (expiry?.taskId === command.data.taskId) {
          clearTimeout(expiry.timer);
          setPersistedProductAgentExpiry(null);
        }
        const closed = await routeBTaskLifecycle.close(command.data.taskId);
        if (!closed.ok) return taskFailure(closed.code);
        const tasks = liveTaskRegistry.snapshot().tasks;
        setSelectedTaskId(
          selectedTaskId() === command.data.taskId
            ? (tasks[0]?.taskId ?? "")
            : selectedTaskId(),
        );
        setShellOverlay("none");
        publishTasksState();
        applyLayout();
        publishLayout();
        return taskSuccess(selectedTaskId() || null);
      }
      if (command.data.kind === "task.cancel") {
        const task = liveTaskRegistry.get(command.data.taskId);
        if (!task) return taskFailure("TASK_NOT_FOUND");
        if (task.agent?.phase === "running") {
          return cancelProductAgentTask(task);
        }
        if (
          task.agent?.phase === "completed" &&
          task.agent.parentDelivery !== "acknowledged"
        ) {
          return taskFailure("AGENT_ALREADY_RUNNING");
        }
        const route = liveTaskRoutes.get(command.data.taskId);
        if (!route) return taskFailure("TASK_NOT_FOUND");
        // The turn this Cancel is for is taken now, in the tick the route
        // starts its own capture. Nothing is awaited between the admission of
        // this command and here.
        const ticket = turnLifecycle.startCancel(command.data.taskId);
        const result = await route.cancelActiveTask();
        if (result === "not_running") return taskFailure("TASK_NOT_RUNNING");
        // The page is not the one this Cancel is bound to: nothing was
        // clicked, so the task and its record stay exactly as they were.
        if (result === "page_changed") {
          return taskFailure("TASK_CANCEL_PAGE_CHANGED");
        }
        // The turn's own message has not been seen on its conversation yet:
        // nothing was clicked, the task and its record stay as they were, and
        // the owner can ask again.
        if (result === "not_yet_bound") {
          return taskFailure("TASK_CANCEL_NOT_YET_BOUND");
        }
        const lifecycle =
          result === "cancelled" ? "cancelled" : "outcome_unknown";
        // A turn that has settled on its own, or been replaced, keeps what it
        // has: this Cancel's result is reported but not written over it.
        if (turnLifecycle.finishCancel(ticket, lifecycle)) {
          liveTaskRegistry.setLifecycle(command.data.taskId, lifecycle);
          publishTasksState();
          try {
            await persistLiveTaskState();
          } catch {
            setLiveTaskStore(null);
            surfaceLiveTaskPersistenceFailure(command.data.taskId);
            return taskFailure("TASK_STATE_UNAVAILABLE");
          }
        }
        return result === "cancelled"
          ? taskSuccess(command.data.taskId)
          : taskFailure("TASK_CANCEL_FAILED");
      }
      if (!chatGptTaskAdmissionReady()) {
        return taskFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
      }
      if (!chatGptRoute()) return taskFailure("TASK_ROUTE_UNAVAILABLE");

      const labels = new Set(
        liveTaskRegistry.snapshot().tasks.map((candidate) => candidate.label),
      );
      let ordinal = 1;
      while (labels.has(`ChatGPT task ${ordinal}`)) ordinal += 1;
      const task: ProductTask = {
        taskId: randomUUID(),
        sessionId: randomUUID(),
        turnId: randomUUID(),
        label: `ChatGPT task ${ordinal}`,
        provider: "chatgpt",
        requestedModel: "Account default",
        observedModel: null,
        requestedMode: "Account default",
        observedMode: null,
        hasComputer: false,
        pinned: false,
        lifecycle: "idle",
      };
      // S35-03/2: see `admitRouteBTask` above — admits and persists under the
      // same cross-process lease a promotion holds through placement.
      let admitted: LiveTaskAdmission;
      try {
        admitted = await liveTaskRegistry.admitDurable(
          task,
          persistLiveTaskState,
        );
      } catch {
        return taskFailure("TASK_STATE_UNAVAILABLE");
      }
      if (admitted.status === "capacity") {
        return taskFailure("TASK_CAPACITY_REACHED");
      }
      if (admitted.status !== "admitted") {
        return taskFailure("TASK_ROUTE_UNAVAILABLE");
      }
      const route = createLiveChatGptRoute(task.taskId, task.label);
      liveTaskConversationUrls.set(task.taskId, null);
      liveTaskRoutes.set(task.taskId, route);
      setSelectedTaskId(task.taskId);
      setSection("browser");
      setSetupOpen(false);
      setShellOverlay("none");
      publishTasksState();
      publishLayout();
      if (!(await openLiveTaskSurface(task.taskId))) {
        return taskFailure("TASK_SURFACE_UNREACHABLE");
      }
      return taskSuccess(task.taskId);
    } finally {
      mutation.release();
    }
  }

  return { run };
}
