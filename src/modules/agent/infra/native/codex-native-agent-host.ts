import { z } from "zod";
import {
  CHATGPT_MODEL_ID,
  FAROL_PROVIDER_ID,
} from "../../../../pkg/model-route/contract";

import type {
  AgentHost,
  AgentCancelReceipt,
  AgentSpawnReceipt,
  AgentSpawnProgress,
  AgentSpawnRequest,
  AgentRejoin,
  AgentWaitReceipt,
} from "../../app/port/agent-host";
import type { AgentComputer } from "../../app/port/computer";
import type { AgentWorkspaceProbe } from "../../app/port/workspace-probe";
import type { ChildCorrelation } from "../../domain/assignment";
import { canonicalAbsolutePath, compatible, validDuration } from "./grant";
import { baseInstructions, childPrompt, parentPrompt } from "./prompt";
import { computerProof, sha256, workspaceProof } from "./proof";
import { dynamicTools } from "./tools";
import {
  authorityCallSchema,
  boundedId,
  collabItemSchema,
  computerCallSchema,
  computerDynamicToolItemSchema,
  itemCompletedSchema,
  parseHistoryItems,
  threadReadSchema,
  threadStartSchema,
  turnCompletedSchema,
  turnStartSchema,
  workspaceCallSchema,
  workspaceDynamicToolItemSchema,
  type ThreadSnapshot,
} from "./wire";

export type CodexNativeAgentPeer = Readonly<{
  request(
    method: string,
    params: unknown,
    options?: Readonly<{ timeoutMs?: number }>,
  ): Promise<unknown>;
  handleServerRequest(
    method: string,
    handler: (params: unknown) => Promise<unknown>,
  ): () => void;
  handleNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void;
}>;

// The local Farol provider catalogue currently advertises only low effort. This is a
// transport selection, not an assertion about the model observed in ChatGPT.
const selectedRouteSchema = z.discriminatedUnion("model", [
  z.object({
    model: z.literal("gpt-6-astra"),
    effort: z.literal("low").optional(),
  }),
  z.object({
    model: z.literal(CHATGPT_MODEL_ID),
    effort: z.literal("low"),
  }),
]);

export type CodexNativeAgentHostOptions = Readonly<
  z.infer<typeof selectedRouteSchema> & {
    runtimeRoot: string;
    spawnTimeoutMs: number;
    waitTimeoutMs: number;
    pollIntervalMs: number;
    cancelTimeoutMs?: number;
    nonce(): string;
    now(): number;
  }
>;

type ActiveOperation = {
  request: AgentSpawnRequest;
  proof: string;
  parentThreadId: string | null;
  parentTurnId: string | null;
  childId: string | null;
  childTurnId: string | null;
  childPrompt: string;
  delegationDigest: string;
  authorityToolCalls: number;
  workspaceToolCalls: number;
  computerCallIds: Set<string>;
  controller: AbortController;
  fatalCode: string | null;
  resolveSpawn(childId: string): void;
  rejectSpawn(error: Error): void;
  spawned: Promise<string>;
};

function error(code: string): Error {
  return new Error(code);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout<Value>(
  promise: Promise<Value>,
  milliseconds: number,
  code: string,
): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(error(code)), milliseconds);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sameCorrelation(
  left: ChildCorrelation,
  right: ChildCorrelation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class CodexNativeAgentHost implements AgentHost {
  private active: ActiveOperation | null = null;
  private handlersInstalled = false;
  private removers: (() => void)[] = [];

  constructor(
    private readonly peer: CodexNativeAgentPeer,
    private readonly options: CodexNativeAgentHostOptions,
    private readonly workspaceProbe: AgentWorkspaceProbe,
    private readonly computer?: AgentComputer,
  ) {
    if (
      !selectedRouteSchema.safeParse(options).success ||
      typeof options.runtimeRoot !== "string" ||
      !canonicalAbsolutePath(options.runtimeRoot) ||
      typeof options.nonce !== "function" ||
      typeof options.now !== "function" ||
      !validDuration(options.spawnTimeoutMs) ||
      !validDuration(options.waitTimeoutMs) ||
      !validDuration(options.pollIntervalMs) ||
      (options.cancelTimeoutMs !== undefined &&
        !validDuration(options.cancelTimeoutMs))
    ) {
      throw error("CODEX_AGENT_OPTIONS_INVALID");
    }
    this.options = Object.freeze({ ...options });
  }

  async spawn(
    request: AgentSpawnRequest,
    progress?: AgentSpawnProgress,
  ): Promise<AgentSpawnReceipt> {
    if (
      this.active ||
      (request.intent.kind === "product" && !this.computer) ||
      !compatible(request, this.options.now(), this.options.runtimeRoot)
    ) {
      return { status: "failed", code: "AGENT_SPAWN_REJECTED" };
    }
    const proof = this.options.nonce();
    if (!/^[a-z0-9-]{1,200}$/u.test(proof)) {
      return { status: "failed", code: "AGENT_SPAWN_REJECTED" };
    }
    this.installHandlers();
    let resolveSpawn!: (childId: string) => void;
    let rejectSpawn!: (cause: Error) => void;
    const spawned = new Promise<string>((resolve, reject) => {
      resolveSpawn = resolve;
      rejectSpawn = reject;
    });
    const exactChildPrompt = childPrompt(request);
    const operation: ActiveOperation = {
      request,
      proof,
      parentThreadId: null,
      parentTurnId: null,
      childId: null,
      childTurnId: null,
      childPrompt: exactChildPrompt,
      delegationDigest: sha256(exactChildPrompt),
      authorityToolCalls: 0,
      workspaceToolCalls: 0,
      computerCallIds: new Set(),
      controller: new AbortController(),
      fatalCode: null,
      resolveSpawn,
      rejectSpawn,
      spawned,
    };
    this.active = operation;
    let turnSubmitted = false;
    try {
      const parent = threadStartSchema.safeParse(
        await this.peer.request("thread/start", {
          model: this.options.model,
          ...(this.options.model === CHATGPT_MODEL_ID
            ? { modelProvider: FAROL_PROVIDER_ID }
            : {}),
          allowProviderModelFallback: false,
          cwd: this.options.runtimeRoot,
          sandbox: "read-only",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          ephemeral: false,
          historyMode: "paginated",
          runtimeWorkspaceRoots: [],
          selectedCapabilityRoots: [],
          environments: [],
          dynamicTools: dynamicTools(request),
          baseInstructions: baseInstructions(request),
        }),
      );
      if (
        !parent.success ||
        parent.data.thread.parentThreadId != null ||
        parent.data.model !== this.options.model ||
        (this.options.model === CHATGPT_MODEL_ID &&
          parent.data.thread.modelProvider !== FAROL_PROVIDER_ID)
      ) {
        throw error("CODEX_AGENT_PROTOCOL_INVALID");
      }
      operation.parentThreadId = parent.data.thread.id;
      // Recorded before any model turn: a crash from here on leaves a
      // lineage that can be observed instead of a bare unknown.
      await progress?.lineage({
        parentThreadId: operation.parentThreadId,
        parentTurnId: null,
        childId: null,
      });

      turnSubmitted = true;
      const started = turnStartSchema.safeParse(
        await this.peer.request("turn/start", {
          threadId: operation.parentThreadId,
          effort: this.options.effort ?? "low",
          input: [
            {
              type: "text",
              text: this.parentPrompt(request, proof, operation.childPrompt),
            },
          ],
        }),
      );
      if (!started.success) throw error("CODEX_AGENT_PROTOCOL_INVALID");
      operation.parentTurnId = started.data.turn.id;
      await progress
        ?.lineage({
          parentThreadId: operation.parentThreadId,
          parentTurnId: operation.parentTurnId,
          childId: null,
        })
        .catch(() => undefined);

      const childId = await withTimeout(
        operation.spawned,
        this.options.spawnTimeoutMs,
        "CODEX_AGENT_SPAWN_TIMEOUT",
      );
      if (operation.fatalCode) throw error(operation.fatalCode);
      await progress
        ?.lineage({
          parentThreadId: operation.parentThreadId,
          parentTurnId: operation.parentTurnId,
          childId,
        })
        .catch(() => undefined);
      const child = await this.readThread(childId).catch(() => null);
      if (
        !child ||
        child.parentThreadId !== operation.parentThreadId ||
        !this.matchesRetainedRoute(child)
      ) {
        throw error("CODEX_AGENT_LINEAGE_INVALID");
      }
      if (child.turns.length !== 1) {
        throw error("CODEX_AGENT_CHILD_TURN_INVALID");
      }
      operation.childTurnId = child.turns[0]!.id;
      const correlation: ChildCorrelation = {
        ...request.identity,
        authorityId: request.authority.authorityId,
        participantId: request.authority.participantId,
        role: request.authority.role,
        parentThreadId: operation.parentThreadId,
        childId,
        parentTurnId: operation.parentTurnId,
        childTurnId: operation.childTurnId,
        hostRole: child.agentRole ?? null,
        delegationDigest: operation.delegationDigest,
      };
      return { status: "started", correlation, authorityProof: proof };
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      this.active = null;
      if (turnSubmitted && code !== "AGENT_SPAWN_REJECTED") {
        return { status: "outcome_unknown", code: "AGENT_SPAWN_ACK_LOST" };
      }
      return { status: "failed", code: "AGENT_SPAWN_REJECTED" };
    }
  }

  async wait(
    correlation: ChildCorrelation,
    rejoin?: AgentRejoin,
  ): Promise<AgentWaitReceipt> {
    if (
      !this.active &&
      rejoin &&
      this.options.model !== CHATGPT_MODEL_ID &&
      !this.attach(correlation, rejoin)
    ) {
      return {
        status: "outcome_unknown",
        correlation,
        code: "AGENT_WAIT_ACK_LOST",
      };
    }
    if (this.active) {
      const activeCorrelation: ChildCorrelation = {
        ...this.active.request.identity,
        authorityId: this.active.request.authority.authorityId,
        participantId: this.active.request.authority.participantId,
        role: this.active.request.authority.role,
        parentThreadId: this.active.parentThreadId ?? "",
        childId: this.active.childId ?? "",
        parentTurnId: this.active.parentTurnId ?? "",
        childTurnId: this.active.childTurnId ?? "",
        hostRole: correlation.hostRole,
        delegationDigest: this.active.delegationDigest,
      };
      if (!sameCorrelation(activeCorrelation, correlation)) {
        return {
          status: "outcome_unknown",
          correlation,
          code: "AGENT_WAIT_ACK_LOST",
        };
      }
    }

    const deadline = Date.now() + this.options.waitTimeoutMs;
    for (;;) {
      if (this.active?.fatalCode) {
        return {
          status: "outcome_unknown",
          correlation,
          code: "AGENT_WAIT_ACK_LOST",
        };
      }
      const remainingReadBudgetMs = deadline - Date.now();
      if (remainingReadBudgetMs <= 0) {
        return { status: "running", correlation };
      }
      let child: ThreadSnapshot;
      let parent: ThreadSnapshot;
      try {
        [child, parent] = await Promise.all([
          this.readThread(correlation.childId, remainingReadBudgetMs),
          this.readThread(correlation.parentThreadId, remainingReadBudgetMs),
        ]);
      } catch {
        if (Date.now() >= deadline) {
          return { status: "running", correlation };
        }
        // Not being able to read the threads says nothing about the child.
        return { status: "unobserved", correlation };
      }
      const observed = this.observeCompletion(correlation, child, parent);
      // Neutral-route recovery must validate durable route evidence before
      // installing handlers that can serve the retained child's authority.
      if (
        observed !== "invalid" &&
        !this.active &&
        rejoin &&
        !this.attach(correlation, rejoin)
      ) {
        return {
          status: "outcome_unknown",
          correlation,
          code: "AGENT_WAIT_ACK_LOST",
        };
      }
      if (observed === "completed") {
        const completedTurn = child.turns.find(
          (turn) => turn.id === correlation.childTurnId,
        );
        if (!completedTurn) {
          return {
            status: "outcome_unknown",
            correlation,
            code: "AGENT_WAIT_ACK_LOST",
          };
        }
        return {
          status: "completed",
          correlation,
          resultRef: `codex-app-server://thread/${correlation.childId}/turn/${completedTurn.id}`,
          workspaceEnforcement: "verified",
        };
      }
      if (observed === "failed" || observed === "interrupted") {
        return {
          status: "failed",
          correlation,
          code: "AGENT_CHILD_FAILED",
        };
      }
      if (observed === "invalid") {
        return {
          status: "outcome_unknown",
          correlation,
          code: "AGENT_WAIT_ACK_LOST",
        };
      }
      const remainingPollBudgetMs = deadline - Date.now();
      if (remainingPollBudgetMs <= 0) {
        return { status: "running", correlation };
      }
      await sleep(Math.min(this.options.pollIntervalMs, remainingPollBudgetMs));
    }
  }

  async cancel(correlation: ChildCorrelation): Promise<AgentCancelReceipt> {
    if (this.active) {
      const activeCorrelation: ChildCorrelation = {
        ...this.active.request.identity,
        authorityId: this.active.request.authority.authorityId,
        participantId: this.active.request.authority.participantId,
        role: this.active.request.authority.role,
        parentThreadId: this.active.parentThreadId ?? "",
        childId: this.active.childId ?? "",
        parentTurnId: this.active.parentTurnId ?? "",
        childTurnId: this.active.childTurnId ?? "",
        hostRole: correlation.hostRole,
        delegationDigest: this.active.delegationDigest,
      };
      if (!sameCorrelation(activeCorrelation, correlation)) {
        return {
          status: "outcome_unknown",
          correlation,
          code: "AGENT_WAIT_ACK_LOST",
        };
      }
      this.active.controller.abort();
    }

    let child: ThreadSnapshot;
    let parent: ThreadSnapshot;
    try {
      [child, parent] = await Promise.all([
        this.readThread(correlation.childId),
        this.readThread(correlation.parentThreadId),
      ]);
    } catch {
      return {
        status: "outcome_unknown",
        correlation,
        code: "AGENT_WAIT_ACK_LOST",
      };
    }
    const before = this.observeCompletion(correlation, child, parent);
    if (before === "completed") {
      return this.completedReceipt(correlation, child);
    }
    if (before === "failed") {
      return { status: "failed", correlation, code: "AGENT_CHILD_FAILED" };
    }
    if (before === "invalid") {
      return {
        status: "outcome_unknown",
        correlation,
        code: "AGENT_WAIT_ACK_LOST",
      };
    }

    const childTurn = child.turns.find(
      (turn) => turn.id === correlation.childTurnId,
    );
    const parentTurn = parent.turns.find(
      (turn) => turn.id === correlation.parentTurnId,
    );
    if (!childTurn || !parentTurn) {
      return {
        status: "outcome_unknown",
        correlation,
        code: "AGENT_WAIT_ACK_LOST",
      };
    }
    const targets = [
      {
        threadId: child.id,
        turnId: childTurn.id,
        status: childTurn.status,
      },
      {
        threadId: parent.id,
        turnId: parentTurn.id,
        status: parentTurn.status,
      },
    ];
    try {
      for (const { threadId, turnId, status } of targets) {
        if (status === "inProgress") {
          await this.peer.request("turn/interrupt", { threadId, turnId });
        }
      }
    } catch {
      return {
        status: "outcome_unknown",
        correlation,
        code: "AGENT_WAIT_ACK_LOST",
      };
    }

    const deadline = Date.now() + (this.options.cancelTimeoutMs ?? 5_000);
    for (;;) {
      try {
        [child, parent] = await Promise.all([
          this.readThread(correlation.childId),
          this.readThread(correlation.parentThreadId),
        ]);
      } catch {
        return {
          status: "outcome_unknown",
          correlation,
          code: "AGENT_WAIT_ACK_LOST",
        };
      }
      const observed = this.observeCompletion(correlation, child, parent);
      if (observed === "invalid") {
        return {
          status: "outcome_unknown",
          correlation,
          code: "AGENT_WAIT_ACK_LOST",
        };
      }
      if (observed === "completed") {
        return this.completedReceipt(correlation, child);
      }
      const snapshots = new Map([
        [child.id, child],
        [parent.id, parent],
      ]);
      const statuses = targets.map(
        (target) =>
          snapshots
            .get(target.threadId)
            ?.turns.find((turn) => turn.id === target.turnId)?.status,
      );
      const stopped = statuses.every(
        (status) => status === "interrupted" || status === "completed",
      );
      if (stopped && statuses.some((status) => status === "interrupted")) {
        this.active = null;
        return { status: "cancelled", correlation };
      }
      if (observed === "failed") {
        return { status: "failed", correlation, code: "AGENT_CHILD_FAILED" };
      }
      if (Date.now() >= deadline) {
        return {
          status: "outcome_unknown",
          correlation,
          code: "AGENT_WAIT_ACK_LOST",
        };
      }
      await sleep(this.options.pollIntervalMs);
    }
  }

  // Takes over a child this host did not spawn, for example after a restart:
  // the current request must reproduce the recorded delegation exactly, then
  // the same handlers serve the child's calls under that request's authority
  // and the retained proof accepts the parent's confirmation.  Nothing is
  // spawned or resubmitted.
  private attach(correlation: ChildCorrelation, rejoin: AgentRejoin): boolean {
    const request = rejoin.request;
    const authority = request.authority;
    const exactChildPrompt = childPrompt(request);
    if (
      request.identity.assignmentId !== correlation.assignmentId ||
      request.identity.ownerId !== correlation.ownerId ||
      request.identity.sessionId !== correlation.sessionId ||
      request.identity.taskId !== correlation.taskId ||
      request.identity.taskEpoch !== correlation.taskEpoch ||
      request.identity.generation !== correlation.generation ||
      authority.authorityId !== correlation.authorityId ||
      authority.participantId !== correlation.participantId ||
      authority.role !== correlation.role ||
      (request.intent.kind === "product" && !this.computer) ||
      !/^[a-z0-9-]{1,200}$/u.test(rejoin.authorityProof) ||
      !compatible(request, this.options.now(), this.options.runtimeRoot) ||
      sha256(exactChildPrompt) !== correlation.delegationDigest
    ) {
      return false;
    }
    this.installHandlers();
    this.active = {
      request,
      proof: rejoin.authorityProof,
      parentThreadId: correlation.parentThreadId,
      parentTurnId: correlation.parentTurnId,
      childId: correlation.childId,
      childTurnId: correlation.childTurnId,
      childPrompt: exactChildPrompt,
      delegationDigest: correlation.delegationDigest,
      authorityToolCalls: 0,
      workspaceToolCalls: 0,
      computerCallIds: new Set(),
      controller: new AbortController(),
      fatalCode: null,
      resolveSpawn: () => undefined,
      rejectSpawn: () => undefined,
      spawned: Promise.resolve(correlation.childId),
    };
    return true;
  }

  dispose(): void {
    this.active?.controller.abort();
    for (const remove of this.removers.splice(0)) remove();
    this.handlersInstalled = false;
    this.active = null;
  }

  private installHandlers(): void {
    if (this.handlersInstalled) return;
    this.handlersInstalled = true;
    this.removers.push(
      this.peer.handleServerRequest("item/tool/call", async (params) =>
        this.handleToolCall(params),
      ),
      this.peer.handleNotification("item/completed", (params) =>
        this.handleItemCompleted(params),
      ),
      this.peer.handleNotification("turn/completed", (params) =>
        this.handleTurnCompleted(params),
      ),
    );
  }

  private async handleToolCall(params: unknown): Promise<unknown> {
    if (
      params !== null &&
      typeof params === "object" &&
      "tool" in params &&
      params.tool === "farol_agent_workspace_probe"
    ) {
      return this.handleWorkspaceCall(params);
    }
    if (
      params !== null &&
      typeof params === "object" &&
      "tool" in params &&
      params.tool === "farol_agent_computer"
    ) {
      return this.handleComputerCall(params);
    }
    return this.handleAuthorityCall(params);
  }

  private handleAuthorityCall(params: unknown): unknown {
    const operation = this.active;
    const parsed = authorityCallSchema.safeParse(params);
    if (!operation || !parsed.success || !operation.parentThreadId) {
      throw this.fail("CODEX_AGENT_AUTHORITY_CORRELATION");
    }
    const call = parsed.data;
    const authority = operation.request.authority;
    if (
      call.threadId !== operation.parentThreadId ||
      operation.parentTurnId === null ||
      call.turnId !== operation.parentTurnId ||
      operation.childId === null ||
      operation.authorityToolCalls !== 0 ||
      call.arguments.assignmentId !== operation.request.identity.assignmentId ||
      call.arguments.authorityId !== authority.authorityId ||
      call.arguments.participantId !== authority.participantId ||
      call.arguments.role !== authority.role ||
      call.arguments.proof !== operation.proof
    ) {
      throw this.fail("CODEX_AGENT_AUTHORITY_CORRELATION");
    }
    operation.authorityToolCalls += 1;
    return {
      success: true,
      contentItems: [{ type: "inputText", text: "FAROL_AGENT_AUTHORITY_OK" }],
    };
  }

  private async handleWorkspaceCall(params: unknown): Promise<unknown> {
    const operation = this.active;
    const parsed = workspaceCallSchema.safeParse(params);
    if (
      !operation ||
      operation.request.intent.kind !== "compatibility" ||
      !parsed.success ||
      !operation.childId ||
      !operation.childTurnId
    ) {
      throw this.fail("CODEX_AGENT_WORKSPACE_CORRELATION");
    }
    const call = parsed.data;
    const authority = operation.request.authority;
    const expectedProof = workspaceProof({
      assignmentId: operation.request.identity.assignmentId,
      authorityId: authority.authorityId,
      participantId: authority.participantId,
    });
    if (
      call.threadId !== operation.childId ||
      call.turnId !== operation.childTurnId ||
      operation.workspaceToolCalls !== 0 ||
      call.arguments.assignmentId !== operation.request.identity.assignmentId ||
      call.arguments.authorityId !== authority.authorityId ||
      call.arguments.participantId !== authority.participantId ||
      call.arguments.proof !== expectedProof
    ) {
      throw this.fail("CODEX_AGENT_WORKSPACE_CORRELATION");
    }
    operation.workspaceToolCalls += 1;
    let receipt;
    try {
      receipt = await this.workspaceProbe.verify({
        identity: operation.request.identity,
        authority,
        focusPath: operation.request.focus.initialPaths[0]!,
        threadId: call.threadId,
        turnId: call.turnId,
        callId: call.callId,
      });
    } catch {
      throw this.fail("CODEX_AGENT_WORKSPACE_PROBE_FAILED");
    }
    if (receipt.status !== "verified") {
      throw this.fail("CODEX_AGENT_WORKSPACE_PROBE_FAILED");
    }
    return {
      success: true,
      contentItems: [{ type: "inputText", text: "FAROL_AGENT_WORKSPACE_OK" }],
    };
  }

  private async handleComputerCall(params: unknown): Promise<unknown> {
    const operation = this.active;
    const parsed = computerCallSchema.safeParse(params);
    if (
      !operation ||
      operation.request.intent.kind !== "product" ||
      !this.computer ||
      !parsed.success ||
      !operation.childId ||
      !operation.childTurnId
    ) {
      throw this.fail("CODEX_AGENT_COMPUTER_CORRELATION");
    }
    const call = parsed.data;
    const authority = operation.request.authority;
    const expectedProof = computerProof({
      assignmentId: operation.request.identity.assignmentId,
      authorityId: authority.authorityId,
      participantId: authority.participantId,
    });
    if (
      call.threadId !== operation.childId ||
      call.turnId !== operation.childTurnId ||
      operation.computerCallIds.size >= 32 ||
      operation.computerCallIds.has(call.callId) ||
      call.arguments.assignmentId !== operation.request.identity.assignmentId ||
      call.arguments.authorityId !== authority.authorityId ||
      call.arguments.participantId !== authority.participantId ||
      call.arguments.proof !== expectedProof
    ) {
      throw this.fail("CODEX_AGENT_COMPUTER_CORRELATION");
    }
    operation.computerCallIds.add(call.callId);
    let receipt;
    try {
      receipt = await this.computer.execute({
        identity: operation.request.identity,
        authority,
        workspaceId: call.arguments.workspaceId,
        operation: call.arguments.operation,
        threadId: call.threadId,
        turnId: call.turnId,
        callId: call.callId,
        signal: operation.controller.signal,
      });
    } catch {
      throw this.fail("CODEX_AGENT_COMPUTER_FAILED");
    }
    if (receipt.status === "failed") {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              status: "denied",
              code: receipt.code,
              source: receipt.source,
              retry: receipt.retry,
            }),
          },
        ],
      };
    }
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            status: "completed",
            output: receipt.output,
          }),
        },
      ],
    };
  }

  private handleItemCompleted(params: unknown): void {
    const operation = this.active;
    const parsed = itemCompletedSchema.safeParse(params);
    if (!operation || !parsed.success || !operation.parentThreadId) return;
    const event = parsed.data;
    if (event.threadId !== operation.parentThreadId) return;
    if (operation.parentTurnId && event.turnId !== operation.parentTurnId) {
      this.fail("CODEX_AGENT_PARENT_CORRELATION");
      return;
    }
    const item = event.item;
    if (item.senderThreadId !== operation.parentThreadId) {
      this.fail("CODEX_AGENT_PARENT_CORRELATION");
      return;
    }
    if (item.tool === "spawnAgent") {
      if (
        item.status !== "completed" ||
        item.receiverThreadIds.length !== 1 ||
        !this.matchesCollabModel(item.model) ||
        item.prompt !== operation.childPrompt ||
        sha256(item.prompt) !== operation.delegationDigest
      ) {
        this.fail("CODEX_AGENT_SPAWN_CORRELATION");
        return;
      }
      const [childId] = item.receiverThreadIds;
      if (
        !childId ||
        (operation.childId !== null && operation.childId !== childId)
      ) {
        this.fail("CODEX_AGENT_SPAWN_CORRELATION");
        return;
      }
      operation.childId = childId;
      operation.resolveSpawn(childId);
      return;
    }
    if (
      item.tool === "wait" &&
      (item.status !== "completed" ||
        item.receiverThreadIds.length !== 1 ||
        item.receiverThreadIds[0] !== operation.childId)
    ) {
      this.fail("CODEX_AGENT_WAIT_CORRELATION");
    }
  }

  private handleTurnCompleted(params: unknown): void {
    const operation = this.active;
    const parsed = turnCompletedSchema.safeParse(params);
    if (!operation || !parsed.success) return;
    if (
      parsed.data.threadId === operation.parentThreadId &&
      operation.parentTurnId &&
      parsed.data.turn.id !== operation.parentTurnId
    ) {
      this.fail("CODEX_AGENT_PARENT_CORRELATION");
      return;
    }
    if (
      parsed.data.threadId === operation.childId &&
      operation.childTurnId &&
      parsed.data.turn.id !== operation.childTurnId
    ) {
      this.fail("CODEX_AGENT_CHILD_CORRELATION");
    }
  }

  private fail(code: string): Error {
    const failure = error(code);
    if (this.active && !this.active.fatalCode) {
      this.active.fatalCode = code;
      this.active.rejectSpawn(failure);
    }
    return failure;
  }

  private async readThread(
    threadId: string,
    timeoutMs?: number,
  ): Promise<ThreadSnapshot> {
    const parsed = threadReadSchema.safeParse(
      await this.peer.request(
        "thread/read",
        {
          threadId,
          includeTurns: true,
        },
        timeoutMs === undefined ? undefined : { timeoutMs },
      ),
    );
    if (!parsed.success || parsed.data.thread.id !== threadId) {
      throw error("CODEX_AGENT_THREAD_INVALID");
    }
    return parsed.data.thread;
  }

  private completedReceipt(
    correlation: ChildCorrelation,
    child: ThreadSnapshot,
  ): Extract<AgentCancelReceipt, Readonly<{ status: "completed" }>> {
    const completedTurn = child.turns.find(
      (turn) => turn.id === correlation.childTurnId,
    );
    if (!completedTurn || completedTurn.status !== "completed") {
      throw error("CODEX_AGENT_THREAD_INVALID");
    }
    return {
      status: "completed",
      correlation,
      resultRef: `codex-app-server://thread/${correlation.childId}/turn/${completedTurn.id}`,
      workspaceEnforcement: "verified",
    };
  }

  private matchesCollabModel(model: unknown): boolean {
    return (
      model === this.options.model ||
      (this.options.model === "gpt-6-astra" && model == null)
    );
  }

  private matchesRetainedRoute(thread: ThreadSnapshot): boolean {
    // Legacy snapshots may omit model metadata. The neutral route has no such
    // compatibility exemption: alias and provider must both be retained.
    return this.options.model === CHATGPT_MODEL_ID
      ? thread.model === this.options.model &&
          thread.modelProvider === FAROL_PROVIDER_ID
      : this.matchesCollabModel(thread.model);
  }

  private observeCompletion(
    correlation: ChildCorrelation,
    child: ThreadSnapshot,
    parent: ThreadSnapshot,
  ): "running" | "completed" | "interrupted" | "failed" | "invalid" {
    const source = z
      .object({
        subAgent: z.object({
          thread_spawn: z.object({
            parent_thread_id: boundedId,
            depth: z.number().int().positive(),
            agent_role: z.string().nullable().optional(),
          }),
        }),
      })
      .safeParse(child.source);
    const childTurn = child.turns.find(
      (turn) => turn.id === correlation.childTurnId,
    );
    const parentTurn = parent.turns.find(
      (turn) => turn.id === correlation.parentTurnId,
    );
    if (
      child.id !== correlation.childId ||
      child.parentThreadId !== correlation.parentThreadId ||
      parent.id !== correlation.parentThreadId ||
      parent.parentThreadId != null ||
      !this.matchesRetainedRoute(child) ||
      !this.matchesRetainedRoute(parent) ||
      !childTurn ||
      !parentTurn ||
      !source.success ||
      source.data.subAgent.thread_spawn.parent_thread_id !==
        correlation.parentThreadId ||
      (correlation.hostRole !== null &&
        (child.agentRole !== correlation.hostRole ||
          (source.data.subAgent.thread_spawn.agent_role != null &&
            source.data.subAgent.thread_spawn.agent_role !==
              correlation.hostRole)))
    ) {
      return "invalid";
    }
    const childItems = childTurn.items;
    const parentItems = parseHistoryItems(parentTurn);
    const invalidSpawnRoute = parentTurn.items.some((candidate) => {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        !("type" in candidate) ||
        candidate.type !== "collabAgentToolCall" ||
        !("tool" in candidate) ||
        candidate.tool !== "spawnAgent"
      )
        return false;
      const parsed = collabItemSchema.safeParse(candidate);
      return !parsed.success || !this.matchesCollabModel(parsed.data.model);
    });
    if (invalidSpawnRoute) return "invalid";
    const authorityCalls = parentItems.filter(
      (item) =>
        item.type === "dynamicToolCall" &&
        item.tool === "farol_agent_authority" &&
        item.status === "completed" &&
        item.success === true &&
        item.arguments.assignmentId === correlation.assignmentId &&
        item.arguments.authorityId === correlation.authorityId &&
        item.arguments.participantId === correlation.participantId &&
        item.arguments.role === correlation.role,
    );
    const spawnItems = parentItems.filter(
      (item) =>
        item.type === "collabAgentToolCall" &&
        item.tool === "spawnAgent" &&
        item.status === "completed" &&
        item.senderThreadId === correlation.parentThreadId &&
        item.receiverThreadIds.length === 1 &&
        item.receiverThreadIds[0] === correlation.childId &&
        typeof item.prompt === "string" &&
        sha256(item.prompt) === correlation.delegationDigest,
    );
    const waitItems = parentItems.filter(
      (item) =>
        item.type === "collabAgentToolCall" &&
        item.tool === "wait" &&
        item.status === "completed" &&
        item.senderThreadId === correlation.parentThreadId &&
        item.receiverThreadIds.length === 1 &&
        item.receiverThreadIds[0] === correlation.childId,
    );
    if (this.options.model === CHATGPT_MODEL_ID && spawnItems.length !== 1) {
      return "invalid";
    }
    const durablePrompt = spawnItems[0]?.prompt;
    const durableIntent =
      typeof durablePrompt === "string" &&
      durablePrompt.startsWith("FAROL_NATIVE_AGENT_TASK_V1\n")
        ? "compatibility"
        : typeof durablePrompt === "string" &&
            durablePrompt.startsWith("FAROL_NATIVE_AGENT_TASK_V2\n")
          ? "product"
          : null;
    const activeIntent =
      this.active &&
      this.active.parentThreadId === correlation.parentThreadId &&
      this.active.childId === correlation.childId &&
      this.active.parentTurnId === correlation.parentTurnId &&
      this.active.childTurnId === correlation.childTurnId
        ? this.active.request.intent.kind
        : null;
    const intent = activeIntent ?? durableIntent;
    if (activeIntent && durableIntent && activeIntent !== durableIntent) {
      return "invalid";
    }
    const childWorkspaceCalls = childItems.flatMap((candidate) => {
      const parsed = workspaceDynamicToolItemSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
    const childComputerCalls = childItems.flatMap((candidate) => {
      const parsed = computerDynamicToolItemSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
    const passiveChildItems = new Set([
      "agentMessage",
      "plan",
      "reasoning",
      "userMessage",
    ]);
    const expectedChildTool =
      intent === "compatibility"
        ? "farol_agent_workspace_probe"
        : intent === "product"
          ? "farol_agent_computer"
          : null;
    const forbiddenChildTool = childItems.some((candidate) => {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        !("type" in candidate) ||
        typeof candidate.type !== "string"
      ) {
        return true;
      }
      if (passiveChildItems.has(candidate.type)) return false;
      return !(
        candidate.type === "dynamicToolCall" &&
        "tool" in candidate &&
        candidate.tool === expectedChildTool
      );
    });
    const expectedWorkspaceProof = workspaceProof({
      assignmentId: correlation.assignmentId,
      authorityId: correlation.authorityId,
      participantId: correlation.participantId,
    });
    const expectedComputerProof = computerProof({
      assignmentId: correlation.assignmentId,
      authorityId: correlation.authorityId,
      participantId: correlation.participantId,
    });
    // A tool call still in progress is ordinary running work while its turn
    // has not completed; a completed turn must hold only settled calls.  The
    // call's correlation and proof are checked in every state.
    const settledOrRunning = (
      item: Readonly<{ status: string; success?: boolean | null | undefined }>,
      requireSuccess: boolean,
    ): boolean =>
      item.status === "completed"
        ? requireSuccess
          ? item.success === true
          : typeof item.success === "boolean"
        : item.status === "inProgress" && childTurn.status !== "completed";
    if (
      forbiddenChildTool ||
      childWorkspaceCalls.length > 1 ||
      childComputerCalls.length > 32 ||
      new Set(childComputerCalls.map((item) => item.id)).size !==
        childComputerCalls.length ||
      childWorkspaceCalls.some(
        (item) =>
          !settledOrRunning(item, true) ||
          item.arguments.assignmentId !== correlation.assignmentId ||
          item.arguments.authorityId !== correlation.authorityId ||
          item.arguments.participantId !== correlation.participantId ||
          item.arguments.proof !== expectedWorkspaceProof,
      ) ||
      childComputerCalls.some(
        (item) =>
          !settledOrRunning(item, false) ||
          item.arguments.assignmentId !== correlation.assignmentId ||
          item.arguments.authorityId !== correlation.authorityId ||
          item.arguments.participantId !== correlation.participantId ||
          item.arguments.proof !== expectedComputerProof,
      )
    ) {
      return "invalid";
    }
    const childInterrupted = childTurn.status === "interrupted";
    const parentInterrupted = parentTurn.status === "interrupted";
    if (childInterrupted || parentInterrupted) return "interrupted";
    const childFailed = childTurn.status === "failed";
    const parentFailed = parentTurn.status === "failed";
    if (
      childFailed ||
      parentFailed ||
      child.status.type === "systemError" ||
      parent.status.type === "systemError"
    ) {
      return "failed";
    }
    const childCompleted = childTurn.status === "completed";
    const parentCompleted = parentTurn.status === "completed";
    if (!childCompleted || !parentCompleted) return "running";
    const spawnIndex = parentItems.indexOf(spawnItems[0]!);
    const waitIndex = parentItems.indexOf(waitItems.at(-1)!);
    const authorityIndex = parentItems.indexOf(authorityCalls[0]!);
    const childEvidenceComplete =
      intent === "compatibility"
        ? childWorkspaceCalls.length === 1 && childComputerCalls.length === 0
        : intent === "product"
          ? childWorkspaceCalls.length === 0 &&
            childComputerCalls.length > 0 &&
            childComputerCalls.some((item) => item.success === true)
          : false;
    return authorityCalls.length === 1 &&
      childEvidenceComplete &&
      spawnItems.length === 1 &&
      waitItems.length >= 1 &&
      spawnIndex >= 0 &&
      waitIndex > spawnIndex &&
      authorityIndex > waitIndex
      ? "completed"
      : "invalid";
  }

  private parentPrompt(
    request: AgentSpawnRequest,
    proof: string,
    exactChildPrompt: string,
  ): string {
    return parentPrompt(request, proof, exactChildPrompt, this.options.model);
  }
}
