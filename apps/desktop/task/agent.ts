import { createHash } from "node:crypto";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import type { CodexAgentWorkspaceProbe } from "../../../src/apps/desktop/codex-agent-workspace-probe";
import type { launchCodexAppServer } from "../../../src/apps/desktop/codex-app-server-process";
import type { probeCodexHost } from "../../../src/apps/desktop/codex-host-probe";
import type { FarolBackedProductAgentRoute } from "../../../src/apps/desktop/foundation-feature-gates";
import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type { runProductAgentAssignment } from "../../../src/apps/desktop/product-agent-assignment";
import {
  productAgentContext,
  productAgentHostContext,
  productAgentInputMatchesContext,
  type ProductAgentContext,
  type ProductAgentHostContext,
} from "../../../src/apps/desktop/product-agent-context";
import {
  persistedProductAgentExpiryVerdict,
  productAgentExpiryRecoveryVerdict,
  productAgentSessionExpiryVerdict,
} from "../../../src/apps/desktop/product-agent-expiry";
import { productAgentOpenRefusal } from "../../../src/apps/desktop/product-agent-open-refusal";
import { ProductAgentSessionReservation } from "../../../src/apps/desktop/product-agent-session-reservation";
import { productAgentSessionKey } from "../../../src/apps/desktop/product-agent-session-key";
import type {
  PrivateProductAgentStore,
  ProductAgentInput,
} from "../../../src/apps/desktop/product-agent-store";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";

// The native Product Agent host: opening and closing its one session, the
// summary the task carries, the two expiry timers, cancellation and the run
// itself. Main keeps every owner, each `let` there is a late getter or a setter
// here, so a change made while an await is pending is seen at the next read.
// The registry, the gate and the reservation are the owners' own objects,
// shared by reference. Process, store and assignment classes are injected, and
// every type is derived from what the injected values already declare; nothing
// here imports a neighbor module. A refusal returns at once and nothing here
// retries: a failed open or run is recorded and reported, never repeated.

type ProductTask = Parameters<LiveTaskRegistry["admitDurable"]>[0];
type ProductTaskAgent = NonNullable<ProductTask["agent"]>;
type RunDependencies = Parameters<typeof runProductAgentAssignment>[3];
type AgentHostPort = RunDependencies["host"];
type Assignments = RunDependencies["assignments"];
type RunReceipt = Extract<
  Awaited<ReturnType<typeof runProductAgentAssignment>>,
  { ok: true }
>["value"];
type Assignment = RunReceipt["assignment"];
type CancelReceipt = Pick<
  RunReceipt,
  "assignment" | "parentDelivery" | "resultRef" | "workspaceEnforcement"
> &
  Readonly<{ assignmentRetention: "durable" | "memory_only" }>;
type Acknowledgement = Readonly<{
  correlation: Assignment["identity"] &
    Readonly<{
      authorityId: string;
      participantId: string;
      role: Assignment["authority"]["role"];
      parentThreadId: string;
      childId: string;
      parentTurnId: string;
      childTurnId: string;
      hostRole: Assignment["hostRole"];
      delegationDigest: string;
    }>;
  parentParticipantId: string;
  resultRef: string;
}>;

export type CodexAppServerClient = Awaited<
  ReturnType<typeof launchCodexAppServer>
>;
type WorkspaceProbe = InstanceType<typeof CodexAgentWorkspaceProbe>;
type ExpiryTimer = NodeJS.Timeout;

export type ProductAgentRoute =
  | Readonly<{ model: "gpt-6-astra"; effort?: "low" }>
  | FarolBackedProductAgentRoute;
type ProductAgentHost = AgentHostPort & Readonly<{ dispose(): void }>;
type ProductAgentHostOptions = Readonly<
  ProductAgentRoute & {
    runtimeRoot: string;
    spawnTimeoutMs: number;
    waitTimeoutMs: number;
    pollIntervalMs: number;
    nonce(): string;
    now(): number;
  }
>;

export type ProductAgentSession<Result> = {
  taskId: string;
  key: string;
  input: ProductAgentInput;
  assignments: Assignments;
  client: CodexAppServerClient;
  host: ProductAgentHost;
  expiryTimer: ExpiryTimer | null;
  cancellation: Promise<Result> | null;
};

export type ProductAgentError =
  | "AGENT_ALREADY_RUNNING"
  | "AGENT_NOT_READY"
  | "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"
  | "AGENT_ASSIGNMENT_FAILED"
  | "AGENT_CANCEL_RACED_COMPLETION"
  | "AGENT_DELIVERY_FAILED"
  | "AGENT_REJOIN_UNAVAILABLE"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_RUNNING"
  | "TASK_STATE_UNAVAILABLE";

const legacyProductAgentCleanupRoute: ProductAgentRoute = {
  model: "gpt-6-astra",
};

export type ProductAgentHostPorts<Result> = Readonly<{
  taskFailure: (error: ProductAgentError) => Result;
  taskSuccess: (taskId: string | null) => Result;
  productAgentEnabled: boolean;
  farolBackedProductAgentRoute: () => FarolBackedProductAgentRoute | null;
  buildIdentity: Readonly<{ buildId: string; version: string }>;
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  productAgentStore: () => PrivateProductAgentStore | null;
  liveTaskRegistry: Pick<LiveTaskRegistry, "get" | "snapshot" | "setAgent">;
  taskMutations: Readonly<{
    inFlight: () => boolean;
    tryEnter: () => Readonly<{ release: () => void }> | null;
  }>;
  authorityTransitions: Pick<AuthorityTransitionReservation, "tryReserve">;
  activeProductAgentSession: () => ProductAgentSession<Result> | null;
  setActiveProductAgentSession: (
    value: ProductAgentSession<Result> | null,
  ) => void;
  persistedProductAgentExpiry: () => Readonly<{
    taskId: string;
    timer: ExpiryTimer;
  }> | null;
  setPersistedProductAgentExpiry: (
    value: Readonly<{ taskId: string; timer: ExpiryTimer }> | null,
  ) => void;
  persistLiveTaskState: () => Promise<void>;
  publishTasksState: () => void;
  statePaths: () => Readonly<{
    codexHostProbe: string;
    codexAgentAssignments: string;
  }>;
  nativeWorkspace: ConstructorParameters<typeof CodexAgentWorkspaceProbe>[1];
  tempPath: () => string;
  codexHostRuntimeRoot: () => Promise<string>;
  codexHostProcessHomePath: () => Promise<string>;
  codexHostHomeOption: () => Promise<Readonly<{ codexHomePath?: string }>>;
  probeCodexHost: typeof probeCodexHost;
  launchCodexAppServer: typeof launchCodexAppServer;
  runProductAgentAssignment: typeof runProductAgentAssignment;
  CodexNativeAgentHost: new (
    client: CodexAppServerClient,
    options: ProductAgentHostOptions,
    workspaceProbe: WorkspaceProbe,
    computer: WorkspaceProbe,
  ) => ProductAgentHost;
  CodexAgentWorkspaceProbe: typeof CodexAgentWorkspaceProbe;
  PrivateAssignmentStore: new (
    input: Readonly<{ root: string }>,
  ) => Assignments;
  CancelAgentAssignment: new (
    host: AgentHostPort,
    assignments: Assignments,
  ) => Readonly<{
    execute(
      identity: Assignment["identity"],
    ): Promise<
      Readonly<{ ok: true; value: CancelReceipt }> | Readonly<{ ok: false }>
    >;
  }>;
  AcknowledgeAgentResult: new (assignments: Assignments) => Readonly<{
    execute(command: Acknowledgement): Promise<
      | Readonly<{
          ok: true;
          value: Readonly<{ parentDelivery: RunReceipt["parentDelivery"] }>;
        }>
      | Readonly<{ ok: false }>
    >;
  }>;
  randomUUID: () => string;
  clock: () => number;
  setTimer: (callback: () => void, delayMs: number) => ExpiryTimer;
  clearTimer: (timer: ExpiryTimer) => void;
}>;

export function createProductAgentHost<Result>(
  ports: ProductAgentHostPorts<Result>,
) {
  const {
    taskFailure,
    taskSuccess,
    productAgentEnabled,
    farolBackedProductAgentRoute,
    buildIdentity,
    configuration,
    productAgentStore,
    liveTaskRegistry,
    taskMutations,
    authorityTransitions,
    activeProductAgentSession,
    setActiveProductAgentSession,
    persistedProductAgentExpiry,
    setPersistedProductAgentExpiry,
    persistLiveTaskState,
    publishTasksState,
    statePaths,
    nativeWorkspace,
    tempPath,
    codexHostRuntimeRoot,
    codexHostProcessHomePath,
    codexHostHomeOption,
    probeCodexHost,
    launchCodexAppServer,
    runProductAgentAssignment,
    CodexNativeAgentHost,
    CodexAgentWorkspaceProbe,
    PrivateAssignmentStore,
    CancelAgentAssignment,
    AcknowledgeAgentResult,
    randomUUID,
    clock,
    setTimer,
    clearTimer,
  } = ports;

  type ActiveProductAgentSession = ProductAgentSession<Result>;

  const productAgentSessionReservation =
    new ProductAgentSessionReservation<ActiveProductAgentSession>();

  function productAgentCapabilityAvailable(): boolean {
    if (!productAgentEnabled) return false;
    const snapshot = configuration()?.snapshot();
    if (snapshot?.status !== "ready") return false;
    const workspaceId = snapshot.settings.setup.computer.verified?.workspaceId;
    return workspaceId
      ? productAgentContext(
          workspaceId,
          snapshot.settings,
          productAgentStore(),
          buildIdentity.buildId,
        ) !== null
      : false;
  }

  async function openProductAgentSession(
    input: ProductAgentInput,
    context: ProductAgentHostContext,
    route: ProductAgentRoute,
    scheduleExpiry = true,
  ): Promise<ActiveProductAgentSession> {
    const key = productAgentSessionKey(input, scheduleExpiry);
    const active = activeProductAgentSession();
    if (active) {
      if (active.taskId === input.taskId && active.key === key) {
        return active;
      }
      throw new Error("PRODUCT_AGENT_SESSION_BUSY");
    }
    return productAgentSessionReservation.open(key, async () => {
      // Same reservation as the native check: from the settings this session
      // was admitted with until it is active; stale settings are refused.
      const agentAdmission = authorityTransitions.tryReserve("agent-admission");
      if (!agentAdmission) throw new Error("AUTHORITY_CHANGE_IN_PROGRESS");
      try {
        return await openAdmittedProductAgentSession(
          input,
          context,
          route,
          key,
          scheduleExpiry,
        );
      } finally {
        agentAdmission.release();
      }
    });
  }

  async function openAdmittedProductAgentSession(
    input: ProductAgentInput,
    context: ProductAgentHostContext,
    route: ProductAgentRoute,
    key: string,
    scheduleExpiry: boolean,
  ): Promise<ActiveProductAgentSession> {
    {
      const current = configuration()?.snapshot();
      if (
        current?.status !== "ready" ||
        current.settings.revision !== context.settings.revision
      ) {
        throw new Error("AUTHORITY_CHANGE_IN_PROGRESS");
      }
      const active = activeProductAgentSession();
      if (active) {
        if (active.taskId === input.taskId && active.key === key) {
          return active;
        }
        throw new Error("PRODUCT_AGENT_SESSION_BUSY");
      }
      const probe = await probeCodexHost({
        executablePath: context.host.executablePath,
        scratchRoot: statePaths().codexHostProbe,
      });
      if (
        probe.executableSha256 !== input.executableSha256 ||
        probe.schemaSha256 !== input.schemaSha256 ||
        probe.version !== context.host.version ||
        probe.protocol !== context.host.protocol
      ) {
        throw new Error("PRODUCT_AGENT_HOST_CHANGED");
      }
      const runtimeRoot = await codexHostRuntimeRoot();
      const client = await launchCodexAppServer({
        executablePath: context.host.executablePath,
        cwd: runtimeRoot,
        homePath: await codexHostProcessHomePath(),
        tempPath: tempPath(),
        clientVersion: buildIdentity.version,
        toolProfile: "native-agent",
        ...(await codexHostHomeOption()),
      });
      try {
        const computer = new CodexAgentWorkspaceProbe(
          context.settings,
          nativeWorkspace,
          () => clock(),
        );
        const host = new CodexNativeAgentHost(
          client,
          {
            ...route,
            runtimeRoot,
            spawnTimeoutMs: 120_000,
            waitTimeoutMs: 250,
            pollIntervalMs: 25,
            nonce: randomUUID,
            now: () => clock(),
          },
          computer,
          computer,
        );
        const session: ActiveProductAgentSession = {
          taskId: input.taskId,
          key,
          input,
          assignments: new PrivateAssignmentStore({
            root: statePaths().codexAgentAssignments,
          }),
          client,
          host,
          expiryTimer: null,
          cancellation: null,
        };
        setActiveProductAgentSession(session);
        if (scheduleExpiry) armProductAgentExpiry(session);
        return session;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    }
  }

  async function closeProductAgentSession(
    session: ActiveProductAgentSession,
  ): Promise<boolean> {
    if (session.expiryTimer) {
      clearTimer(session.expiryTimer);
      session.expiryTimer = null;
    }
    session.host.dispose();
    let closed = true;
    try {
      await session.client.close();
    } catch {
      closed = false;
    } finally {
      if (activeProductAgentSession() === session) {
        setActiveProductAgentSession(null);
      }
    }
    return closed;
  }

  function productAgentSummary(
    input: ProductAgentInput,
    receipt: Pick<
      RunReceipt,
      "assignment" | "parentDelivery" | "resultRef" | "workspaceEnforcement"
    > &
      Partial<Pick<RunReceipt, "observation">>,
  ): ProductTaskAgent {
    const phase = receipt.assignment.phase;
    if (phase === "prepared") {
      throw new Error("PRODUCT_AGENT_STATE_INVALID");
    }
    return {
      assignmentBindingSha256: productAgentAssignmentBinding(input),
      phase,
      workspaceId: input.workspaceId,
      parentDelivery: receipt.parentDelivery,
      workspaceEnforcement: receipt.workspaceEnforcement ?? "not_applicable",
      resultAvailable: receipt.resultRef !== null,
      ...(phase === "running" && receipt.observation === "unavailable"
        ? { observation: "unavailable" as const }
        : {}),
    };
  }

  async function persistProductAgentSummary(
    taskId: string,
    summary: ProductTaskAgent,
  ): Promise<boolean> {
    if (!liveTaskRegistry.setAgent(taskId, summary)) return false;
    await persistLiveTaskState();
    publishTasksState();
    return true;
  }

  function productAgentIdentity(input: ProductAgentInput) {
    return {
      assignmentId: input.assignmentId,
      ownerId: "owner-desktop",
      sessionId: input.sessionId,
      taskId: input.taskId,
      taskEpoch: input.taskEpoch,
      generation: input.generation,
    };
  }

  function productAgentUnknownSummary(
    input: ProductAgentInput,
  ): ProductTaskAgent {
    return {
      assignmentBindingSha256: productAgentAssignmentBinding(input),
      phase: "outcome_unknown",
      workspaceId: input.workspaceId,
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
    };
  }

  function productAgentUnknownSummaryFromTask(
    agent: ProductTaskAgent,
  ): ProductTaskAgent {
    return {
      ...(agent.assignmentBindingSha256
        ? { assignmentBindingSha256: agent.assignmentBindingSha256 }
        : {}),
      phase: "outcome_unknown",
      workspaceId: agent.workspaceId,
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
    };
  }

  function productAgentAssignmentBinding(input: ProductAgentInput): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          "farol-product-agent-binding-v1",
          input.taskId,
          input.sessionId,
          input.assignmentId,
        ]),
      )
      .digest("hex");
  }

  function productAgentAssignmentMatches(
    agent: ProductTaskAgent,
    input: ProductAgentInput,
  ): boolean {
    return (
      agent.assignmentBindingSha256 !== undefined &&
      agent.assignmentBindingSha256 === productAgentAssignmentBinding(input)
    );
  }

  function armProductAgentExpiry(
    session: ActiveProductAgentSession,
    delayOverride?: number,
  ): void {
    const pendingExpiry = persistedProductAgentExpiry();
    if (pendingExpiry?.taskId === session.taskId) {
      clearTimer(pendingExpiry.timer);
      setPersistedProductAgentExpiry(null);
    }
    if (session.expiryTimer) clearTimer(session.expiryTimer);
    session.expiryTimer = setTimer(
      () => {
        session.expiryTimer = null;
        const now = clock();
        const verdict = productAgentSessionExpiryVerdict({
          sessionIsActive: activeProductAgentSession() === session,
          taskPhase: liveTaskRegistry.get(session.taskId)?.agent?.phase,
          mutationInFlight: taskMutations.inFlight(),
          now,
        });
        if (verdict.action === "noop") return;
        if (verdict.action === "reschedule") {
          armProductAgentExpiry(session, verdict.atMs - now);
          return;
        }
        const mutation = taskMutations.tryEnter();
        if (!mutation) {
          armProductAgentExpiry(session, 0);
          return;
        }
        void cancelProductAgentSession(session).finally(() => {
          mutation.release();
        });
      },
      delayOverride ?? Math.max(0, session.input.expiresAt - clock()),
    );
    session.expiryTimer.unref?.();
  }

  function schedulePersistedProductAgentExpiry(
    taskId: string,
    input: ProductAgentInput,
    delayOverride?: number,
  ): void {
    const pendingExpiry = persistedProductAgentExpiry();
    if (pendingExpiry) {
      clearTimer(pendingExpiry.timer);
      setPersistedProductAgentExpiry(null);
    }
    const timer = setTimer(
      () => {
        setPersistedProductAgentExpiry(null);
        const task = liveTaskRegistry.get(taskId);
        const now = clock();
        const verdict = persistedProductAgentExpiryVerdict({
          taskPhase: task?.agent?.phase,
          mutationInFlight: taskMutations.inFlight(),
          now,
        });
        if (verdict.action === "noop") return;
        if (verdict.action === "reschedule") {
          schedulePersistedProductAgentExpiry(
            taskId,
            input,
            verdict.atMs - now,
          );
          return;
        }
        // Unreachable in practice: `verdict.action === "expire"` only when
        // `taskPhase === "running"`, which requires `task` to exist. The
        // check narrows `task` for TypeScript rather than adding a new branch.
        if (!task) return;
        const mutation = taskMutations.tryEnter();
        if (!mutation) {
          schedulePersistedProductAgentExpiry(taskId, input, 0);
          return;
        }
        void cancelProductAgentTask(task).finally(() => {
          mutation.release();
        });
      },
      delayOverride ?? Math.max(0, input.expiresAt - clock()),
    );
    timer.unref?.();
    setPersistedProductAgentExpiry({ taskId, timer });
  }

  async function recoverProductAgentExpiry(): Promise<void> {
    const task = liveTaskRegistry
      .snapshot()
      .tasks.find((candidate) => candidate.agent?.phase === "running");
    let input: ProductAgentInput | null = null;
    const store = productAgentStore();
    if (task && store) {
      try {
        input = await store.load(task.taskId);
      } catch {
        input = null;
      }
    }
    const now = clock();
    const verdict = productAgentExpiryRecoveryVerdict({
      hasRunningTask: task !== undefined,
      storeAvailable: productAgentStore() !== null,
      input,
      assignmentMatches:
        task !== undefined && input !== null
          ? productAgentAssignmentMatches(task.agent!, input)
          : false,
      now,
    });
    if (verdict.action === "noop") return;
    // Both remaining branches (`unknown` and `reschedule`) are only ever
    // produced when `hasRunningTask` was true, which requires `task` to
    // exist. The check narrows `task` for TypeScript rather than adding a new
    // branch.
    if (!task) return;
    if (verdict.action === "unknown") {
      await persistProductAgentSummary(
        task.taskId,
        productAgentUnknownSummaryFromTask(task.agent!),
      ).catch(() => undefined);
      return;
    }
    schedulePersistedProductAgentExpiry(
      task.taskId,
      input!,
      verdict.atMs - now,
    );
  }

  async function performProductAgentCancellation(
    session: ActiveProductAgentSession,
  ): Promise<Result> {
    const cancelled = await new CancelAgentAssignment(
      session.host,
      session.assignments,
    ).execute(productAgentIdentity(session.input));
    const closed = await closeProductAgentSession(session);
    if (!cancelled.ok || !closed) {
      await persistProductAgentSummary(
        session.taskId,
        productAgentUnknownSummary(session.input),
      ).catch(() => undefined);
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }
    const receipt = cancelled.value;
    const summary =
      receipt.assignmentRetention === "durable"
        ? productAgentSummary(session.input, receipt)
        : productAgentUnknownSummary(session.input);
    try {
      if (!(await persistProductAgentSummary(session.taskId, summary))) {
        return taskFailure("TASK_NOT_FOUND");
      }
    } catch {
      return taskFailure("TASK_STATE_UNAVAILABLE");
    }
    if (receipt.assignmentRetention !== "durable") {
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }
    if (receipt.assignment.phase === "cancelled") {
      return taskSuccess(session.taskId);
    }
    if (receipt.assignment.phase === "completed") {
      return taskFailure("AGENT_CANCEL_RACED_COMPLETION");
    }
    if (receipt.assignment.phase === "failed") {
      return taskFailure("AGENT_ASSIGNMENT_FAILED");
    }
    return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
  }

  function cancelProductAgentSession(
    session: ActiveProductAgentSession,
  ): Promise<Result> {
    if (session.cancellation) return session.cancellation;
    const cancellation = performProductAgentCancellation(session).finally(
      () => {
        if (session.cancellation === cancellation) session.cancellation = null;
      },
    );
    session.cancellation = cancellation;
    return cancellation;
  }

  const unavailableProductAgentHost: AgentHostPort = {
    async spawn() {
      throw new Error("PRODUCT_AGENT_HOST_UNAVAILABLE");
    },
    async wait() {
      throw new Error("PRODUCT_AGENT_HOST_UNAVAILABLE");
    },
    async cancel() {
      throw new Error("PRODUCT_AGENT_HOST_UNAVAILABLE");
    },
  };

  async function tombstoneUnavailableProductAgent(
    input: ProductAgentInput,
    assignments: Assignments,
  ): Promise<Result> {
    await new CancelAgentAssignment(
      unavailableProductAgentHost,
      assignments,
    ).execute(productAgentIdentity(input));
    await persistProductAgentSummary(
      input.taskId,
      productAgentUnknownSummary(input),
    ).catch(() => undefined);
    return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
  }

  async function cancelProductAgentTask(task: ProductTask): Promise<Result> {
    const runningAgent = task.agent?.phase === "running" ? task.agent : null;
    if (!runningAgent) return taskFailure("TASK_NOT_RUNNING");
    const pendingExpiry = persistedProductAgentExpiry();
    if (pendingExpiry?.taskId === task.taskId) {
      clearTimer(pendingExpiry.timer);
      setPersistedProductAgentExpiry(null);
    }
    const activeSession = activeProductAgentSession();
    if (activeSession) {
      if (activeSession.taskId !== task.taskId) {
        return taskFailure("AGENT_ALREADY_RUNNING");
      }
      if (!productAgentAssignmentMatches(runningAgent, activeSession.input)) {
        await persistProductAgentSummary(
          task.taskId,
          productAgentUnknownSummaryFromTask(runningAgent),
        ).catch(() => undefined);
        await closeProductAgentSession(activeProductAgentSession()!);
        return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
      }
      return cancelProductAgentSession(activeSession);
    }

    let input: ProductAgentInput | null;
    try {
      input = (await productAgentStore()?.load(task.taskId)) ?? null;
    } catch {
      await persistProductAgentSummary(
        task.taskId,
        productAgentUnknownSummaryFromTask(runningAgent),
      ).catch(() => undefined);
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }
    if (!input || !productAgentAssignmentMatches(runningAgent, input)) {
      await persistProductAgentSummary(
        task.taskId,
        productAgentUnknownSummaryFromTask(runningAgent),
      ).catch(() => undefined);
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }

    const assignments = new PrivateAssignmentStore({
      root: statePaths().codexAgentAssignments,
    });
    const hostContextSnapshot = configuration()?.snapshot();
    const context = productAgentHostContext(
      input,
      hostContextSnapshot?.status === "ready"
        ? hostContextSnapshot.settings
        : null,
      buildIdentity.buildId,
    );
    if (!context) return tombstoneUnavailableProductAgent(input, assignments);
    let session: ActiveProductAgentSession;
    try {
      // Existing Astra-backed assignments may only use this route for bounded
      // cancellation and cleanup; new work can use only the qualified route
      // selected by `farolBackedProductAgentRoute` above.
      session = await openProductAgentSession(
        input,
        context,
        legacyProductAgentCleanupRoute,
        false,
      );
    } catch {
      return tombstoneUnavailableProductAgent(input, assignments);
    }
    return cancelProductAgentSession(session);
  }

  async function executeProductAgent(
    task: ProductTask,
    input: ProductAgentInput,
    context: ProductAgentContext,
    admission: "new" | "rejoin",
  ): Promise<Result> {
    const route = farolBackedProductAgentRoute();
    if (!route) return taskFailure("AGENT_NOT_READY");
    if (
      !productAgentInputMatchesContext(input, context, buildIdentity.buildId)
    ) {
      return taskFailure("AGENT_NOT_READY");
    }
    let session: ActiveProductAgentSession;
    try {
      session = await openProductAgentSession(input, context, route);
    } catch (error) {
      const refusal = productAgentOpenRefusal(admission, error);
      if (refusal.record !== "none") {
        await persistProductAgentSummary(task.taskId, {
          assignmentBindingSha256: productAgentAssignmentBinding(input),
          phase: refusal.record,
          workspaceId: input.workspaceId,
          parentDelivery: "not_applicable",
          workspaceEnforcement: "not_applicable",
          resultAvailable: false,
        }).catch(() => undefined);
      }
      return taskFailure(refusal.failure);
    }
    const assignments = session.assignments;
    let result;
    try {
      result = await runProductAgentAssignment(
        context.settings,
        task,
        input,
        {
          host: session.host,
          assignments,
          now: () => clock(),
        },
        admission,
      );
    } catch {
      await persistProductAgentSummary(task.taskId, {
        assignmentBindingSha256: productAgentAssignmentBinding(input),
        phase: "outcome_unknown",
        workspaceId: input.workspaceId,
        parentDelivery: "not_applicable",
        workspaceEnforcement: "not_applicable",
        resultAvailable: false,
      }).catch(() => undefined);
      await closeProductAgentSession(session);
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }
    if (!result.ok) {
      const rejoinUnavailable = admission === "rejoin";
      await persistProductAgentSummary(task.taskId, {
        assignmentBindingSha256: productAgentAssignmentBinding(input),
        phase: rejoinUnavailable ? "outcome_unknown" : "failed",
        workspaceId: input.workspaceId,
        parentDelivery: "not_applicable",
        workspaceEnforcement: "not_applicable",
        resultAvailable: false,
      }).catch(() => undefined);
      await closeProductAgentSession(session);
      return taskFailure(
        rejoinUnavailable
          ? "AGENT_REJOIN_UNAVAILABLE"
          : "AGENT_ASSIGNMENT_FAILED",
      );
    }
    const receipt = result.value;
    const summary = productAgentSummary(input, receipt);
    try {
      if (!(await persistProductAgentSummary(task.taskId, summary))) {
        await closeProductAgentSession(session);
        return taskFailure("TASK_NOT_FOUND");
      }
    } catch {
      return taskFailure("TASK_STATE_UNAVAILABLE");
    }
    if (receipt.assignment.phase === "running") {
      return taskSuccess(task.taskId);
    }
    await closeProductAgentSession(session);
    if (receipt.assignment.phase === "outcome_unknown") {
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }
    if (receipt.assignment.phase === "failed" || !receipt.resultRef) {
      return taskFailure("AGENT_ASSIGNMENT_FAILED");
    }
    const assignment = receipt.assignment;
    const acknowledged = await new AcknowledgeAgentResult(assignments).execute({
      correlation: {
        ...assignment.identity,
        authorityId: assignment.authority.authorityId,
        participantId: assignment.authority.participantId,
        role: assignment.authority.role,
        parentThreadId: assignment.parentThreadId!,
        childId: assignment.childId!,
        parentTurnId: assignment.parentTurnId!,
        childTurnId: assignment.childTurnId!,
        hostRole: assignment.hostRole,
        delegationDigest: assignment.delegationDigest!,
      },
      parentParticipantId: assignment.authority.parentParticipantId,
      resultRef: receipt.resultRef,
    });
    if (!acknowledged.ok) return taskFailure("AGENT_DELIVERY_FAILED");
    try {
      await persistProductAgentSummary(
        task.taskId,
        productAgentSummary(input, {
          ...receipt,
          parentDelivery: acknowledged.value.parentDelivery,
        }),
      );
    } catch {
      return taskFailure("AGENT_DELIVERY_FAILED");
    }
    return taskSuccess(task.taskId);
  }

  return {
    productAgentCapabilityAvailable,
    openProductAgentSession,
    closeProductAgentSession,
    productAgentSummary,
    persistProductAgentSummary,
    productAgentUnknownSummary,
    productAgentUnknownSummaryFromTask,
    productAgentAssignmentBinding,
    productAgentAssignmentMatches,
    armProductAgentExpiry,
    schedulePersistedProductAgentExpiry,
    recoverProductAgentExpiry,
    cancelProductAgentSession,
    cancelProductAgentTask,
    executeProductAgent,
  };
}
