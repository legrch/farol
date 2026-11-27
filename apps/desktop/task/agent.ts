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
import type { ProductAgentInput } from "../../../src/apps/desktop/product-agent-store";
import {
  acknowledgementCommand,
  cancelReceiptFailure,
  runRefusalFailure,
  runRefusedBeforeSpawn,
  settledReceiptFailure,
} from "./outcome";
import {
  productAgentAssignmentBinding,
  productAgentAssignmentMatches,
  productAgentIdentity,
  productAgentRecordSummary,
  productAgentSummary,
  productAgentUnknownSummary,
  productAgentUnknownSummaryFromTask,
  type AgentHostPort,
  type Assignments,
  type ProductTask,
  type ProductTaskAgent,
} from "./summary";

import type {
  ProductAgentHostPorts,
  ProductAgentRoute,
  ProductAgentSession,
} from "./ports";

export type { ProductAgentError } from "./outcome";
export type {
  CodexAppServerClient,
  ProductAgentHostPorts,
  ProductAgentRoute,
  ProductAgentSession,
} from "./ports";

// The native Product Agent host: opening and closing its one session, the
// summary the task carries, the two expiry timers, cancellation and the run
// itself. Main keeps every owner, each `let` there is a late getter or a setter
// here, so a change made while an await is pending is seen at the next read.
// The registry, the gate and the reservation are the owners' own objects,
// shared by reference. Process, store and assignment classes are injected, and
// every type is derived from what the injected values already declare; nothing
// here imports a neighbor module. A refusal returns at once and nothing here
// retries: a failed open or run is recorded and reported, never repeated.

const legacyProductAgentCleanupRoute: ProductAgentRoute = {
  model: "gpt-6-astra",
};

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

  async function persistProductAgentSummary(
    taskId: string,
    summary: ProductTaskAgent,
  ): Promise<boolean> {
    if (!liveTaskRegistry.setAgent(taskId, summary)) return false;
    await persistLiveTaskState();
    publishTasksState();
    return true;
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
      // A task that is gone has nothing left to record.
      await persistProductAgentSummary(session.taskId, summary);
    } catch {
      // The stop has been answered, so the receipt below says what it did,
      // whether the save worked or not: a refusal would claim the child was
      // not touched. The summary is already in the registry; show it.
      publishTasksState();
    }
    const failure = cancelReceiptFailure(receipt);
    return failure ? taskFailure(failure) : taskSuccess(session.taskId);
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
    const activeSession = activeProductAgentSession();
    // A refusal touches nothing, the expiry that guards this task included.
    if (activeSession && activeSession.taskId !== task.taskId) {
      return taskFailure("AGENT_ALREADY_RUNNING");
    }
    const pendingExpiry = persistedProductAgentExpiry();
    if (pendingExpiry?.taskId === task.taskId) {
      clearTimer(pendingExpiry.timer);
      setPersistedProductAgentExpiry(null);
    }
    if (activeSession) {
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
    if (
      !route ||
      !productAgentInputMatchesContext(input, context, buildIdentity.buildId)
    ) {
      // A new start is already `running`; nothing opened, so it did not run.
      if (admission === "new") {
        await persistProductAgentSummary(
          task.taskId,
          productAgentRecordSummary(input, "failed"),
        ).catch(() => undefined);
      }
      return taskFailure("AGENT_NOT_READY");
    }
    let session: ActiveProductAgentSession;
    try {
      session = await openProductAgentSession(input, context, route);
    } catch (error) {
      const refusal = productAgentOpenRefusal(admission, error);
      if (refusal.record !== "none") {
        await persistProductAgentSummary(
          task.taskId,
          productAgentRecordSummary(input, refusal.record),
        ).catch(() => undefined);
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
      await persistProductAgentSummary(
        task.taskId,
        productAgentUnknownSummary(input),
      ).catch(() => undefined);
      await closeProductAgentSession(session);
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }
    // An error that can come back after a spawn is no refusal: the child may be
    // running, and a `failed` start could be offered again beside it.
    if (
      !result.ok &&
      admission === "new" &&
      !runRefusedBeforeSpawn(result.error.code)
    ) {
      await persistProductAgentSummary(
        task.taskId,
        productAgentUnknownSummary(input),
      ).catch(() => undefined);
      await closeProductAgentSession(session);
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }
    if (!result.ok) {
      const rejoinUnavailable = admission === "rejoin";
      await persistProductAgentSummary(
        task.taskId,
        productAgentRecordSummary(
          input,
          rejoinUnavailable ? "outcome_unknown" : "failed",
        ),
      ).catch(() => undefined);
      await closeProductAgentSession(session);
      return taskFailure(runRefusalFailure(admission));
    }
    const receipt = result.value;
    const summary = productAgentSummary(input, receipt);
    try {
      if (!(await persistProductAgentSummary(task.taskId, summary))) {
        // Nothing tracks the child any more: close its session, and say that
        // what became of it is not known rather than that nothing happened.
        await closeProductAgentSession(session);
        return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
      }
    } catch {
      // The run has been answered, so the receipt below says what it did,
      // whether the save worked or not: a refusal would claim no child was
      // spawned. The summary is already in the registry; show it.
      publishTasksState();
    }
    if (receipt.assignment.phase === "running") {
      return taskSuccess(task.taskId);
    }
    await closeProductAgentSession(session);
    const settledFailure = settledReceiptFailure(receipt);
    if (settledFailure) return taskFailure(settledFailure);
    const acknowledged = await new AcknowledgeAgentResult(assignments).execute(
      acknowledgementCommand(receipt.assignment, receipt.resultRef!),
    );
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
