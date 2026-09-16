import path from "node:path";
import { z } from "zod";

import type {
  AgentHost,
  AgentSpawnReceipt,
  AgentSpawnRequest,
  AgentWaitReceipt,
} from "../../app/port/agent-host";
import type { ChildCorrelation } from "../../domain/assignment";

export type CodexNativeAgentPeer = Readonly<{
  request(method: string, params: unknown): Promise<unknown>;
  handleServerRequest(
    method: string,
    handler: (params: unknown) => Promise<unknown>,
  ): () => void;
  handleNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void;
}>;

export type CodexNativeAgentHostOptions = Readonly<{
  model: "gpt-6-astra";
  runtimeRoot: string;
  spawnTimeoutMs: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  nonce(): string;
  now(): number;
}>;

const boundedId = z.string().min(1).max(200);

const threadStartSchema = z
  .object({
    model: z.literal("gpt-6-astra"),
    thread: z
      .object({
        id: boundedId,
        parentThreadId: boundedId.nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const turnStartSchema = z
  .object({
    turn: z
      .object({
        id: boundedId,
        status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      })
      .passthrough(),
  })
  .passthrough();

const collabItemSchema = z
  .object({
    id: boundedId,
    type: z.literal("collabAgentToolCall"),
    tool: z.enum([
      "spawnAgent",
      "sendInput",
      "resumeAgent",
      "wait",
      "closeAgent",
      "sendMessage",
      "followupTask",
      "interruptAgent",
      "listAgents",
    ]),
    status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
    senderThreadId: boundedId,
    receiverThreadIds: z.array(boundedId).max(16),
    agentsStates: z.record(z.string(), z.unknown()),
    model: z.string().nullable().optional(),
  })
  .passthrough();

const itemCompletedSchema = z
  .object({
    threadId: boundedId,
    turnId: boundedId,
    item: collabItemSchema,
  })
  .passthrough();

const turnCompletedSchema = z
  .object({
    threadId: boundedId,
    turn: z
      .object({
        id: boundedId,
        status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      })
      .passthrough(),
  })
  .passthrough();

const authorityArgumentsSchema = z.strictObject({
  assignmentId: boundedId,
  authorityId: boundedId,
  participantId: boundedId,
  role: z.enum(["agent", "critic"]),
  proof: z.string().min(1).max(200),
});

const authorityCallSchema = z.strictObject({
  threadId: boundedId,
  turnId: boundedId,
  callId: boundedId,
  namespace: z.string().nullable().optional(),
  tool: z.literal("farol_agent_authority"),
  arguments: authorityArgumentsSchema,
});

const dynamicToolItemSchema = z
  .object({
    id: boundedId,
    type: z.literal("dynamicToolCall"),
    tool: z.literal("farol_agent_authority"),
    status: z.enum(["inProgress", "completed", "failed"]),
    success: z.boolean().nullable().optional(),
    arguments: authorityArgumentsSchema,
  })
  .passthrough();

const historyItemSchema = z.union([collabItemSchema, dynamicToolItemSchema]);

const historyTurnSchema = z
  .object({
    id: boundedId,
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    items: z.array(z.unknown()),
  })
  .passthrough();

const threadReadSchema = z
  .object({
    thread: z
      .object({
        id: boundedId,
        parentThreadId: boundedId.nullable().optional(),
        agentRole: z.string().min(1).max(200).nullable().optional(),
        source: z.unknown(),
        status: z
          .object({
            type: z.enum(["notLoaded", "idle", "systemError", "active"]),
          })
          .passthrough(),
        turns: z.array(historyTurnSchema),
      })
      .passthrough(),
  })
  .passthrough();

type ThreadSnapshot = z.infer<typeof threadReadSchema>["thread"];

type ActiveOperation = {
  request: AgentSpawnRequest;
  proof: string;
  parentThreadId: string | null;
  parentTurnId: string | null;
  childId: string | null;
  authorityToolChildId: string | null;
  authorityToolCalls: number;
  fatalCode: string | null;
  resolveSpawn(childId: string): void;
  rejectSpawn(error: Error): void;
  spawned: Promise<string>;
};

function error(code: string): Error {
  return new Error(code);
}

function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalAbsolutePath(value: string): boolean {
  if (
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    (value.length > 1 && value.endsWith(path.sep))
  ) {
    return false;
  }
  const normalized = path.normalize(value);
  return normalized === value && !value.split(path.sep).includes("..");
}

function within(root: string, candidate: string): boolean {
  return (
    canonicalAbsolutePath(root) &&
    canonicalAbsolutePath(candidate) &&
    (candidate === root || candidate.startsWith(`${root}${path.sep}`))
  );
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

function compatible(
  request: AgentSpawnRequest,
  now: number,
  runtimeRoot: string,
): boolean {
  const authority = request.authority;
  const permittedCapabilities = new Set([
    "workspace.list",
    "workspace.read",
    "workspace.search",
  ]);
  const focusAllowed =
    request.focus.initialPaths.length <= 256 &&
    new Set(request.focus.initialPaths).size ===
      request.focus.initialPaths.length &&
    request.focus.initialPaths.every(
      (candidate) =>
        canonicalAbsolutePath(candidate) &&
        authority.workspaces.some((workspace) => {
          const inside = within(workspace.root, candidate);
          const selected =
            workspace.mode === "subtree" || workspace.paths.includes(candidate);
          const excluded = authority.excludedPaths.some(
            (entry) =>
              entry.workspaceId === workspace.workspaceId &&
              within(entry.path, candidate),
          );
          return inside && selected && !excluded;
        }),
    );
  return (
    authority.ownerId === request.identity.ownerId &&
    authority.sessionId === request.identity.sessionId &&
    authority.taskId === request.identity.taskId &&
    authority.taskEpoch === request.identity.taskEpoch &&
    authority.mutationOwnership === "none" &&
    authority.network === "none" &&
    authority.commands === "none" &&
    authority.expiresAt >= now &&
    authority.workspaces.length > 0 &&
    authority.workspaces.every(
      (workspace) =>
        canonicalAbsolutePath(workspace.root) &&
        !within(workspace.root, runtimeRoot) &&
        !within(runtimeRoot, workspace.root) &&
        (workspace.mode === "subtree" ||
          workspace.paths.every(
            (candidate) =>
              canonicalAbsolutePath(candidate) &&
              within(workspace.root, candidate),
          )),
    ) &&
    authority.excludedPaths.every(
      (entry) =>
        canonicalAbsolutePath(entry.path) &&
        authority.workspaces.some(
          (workspace) =>
            workspace.workspaceId === entry.workspaceId &&
            within(workspace.root, entry.path),
        ),
    ) &&
    authority.workspaces.every((workspace) => workspace.access === "read") &&
    authority.capabilities.every((capability) =>
      permittedCapabilities.has(capability),
    ) &&
    focusAllowed
  );
}

function parseHistoryItems(turn: z.infer<typeof historyTurnSchema>) {
  return turn.items.flatMap((candidate) => {
    const parsed = historyItemSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

export class CodexNativeAgentHost implements AgentHost {
  private active: ActiveOperation | null = null;
  private handlersInstalled = false;
  private removers: (() => void)[] = [];

  constructor(
    private readonly peer: CodexNativeAgentPeer,
    private readonly options: CodexNativeAgentHostOptions,
  ) {
    if (
      !canonicalAbsolutePath(options.runtimeRoot) ||
      !validDuration(options.spawnTimeoutMs) ||
      !validDuration(options.waitTimeoutMs) ||
      !validDuration(options.pollIntervalMs)
    ) {
      throw error("CODEX_AGENT_OPTIONS_INVALID");
    }
  }

  async spawn(request: AgentSpawnRequest): Promise<AgentSpawnReceipt> {
    if (
      this.active ||
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
    const operation: ActiveOperation = {
      request,
      proof,
      parentThreadId: null,
      parentTurnId: null,
      childId: null,
      authorityToolChildId: null,
      authorityToolCalls: 0,
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
          dynamicTools: [
            {
              type: "function",
              name: "farol_agent_authority",
              description:
                "Confirm the exact Farol assignment authority carried by this child without reading workspace content.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  assignmentId: { type: "string" },
                  authorityId: { type: "string" },
                  participantId: { type: "string" },
                  role: { type: "string", enum: ["agent", "critic"] },
                  proof: { type: "string" },
                },
                required: [
                  "assignmentId",
                  "authorityId",
                  "participantId",
                  "role",
                  "proof",
                ],
              },
            },
          ],
          baseInstructions:
            "This Farol compatibility assignment must use exactly one native child. Neither parent nor child may inspect files, run commands, use the web, or call any dynamic tool except the child's one farol_agent_authority call.",
        }),
      );
      if (
        !parent.success ||
        parent.data.thread.parentThreadId != null ||
        parent.data.model !== this.options.model
      ) {
        throw error("CODEX_AGENT_PROTOCOL_INVALID");
      }
      operation.parentThreadId = parent.data.thread.id;

      turnSubmitted = true;
      const started = turnStartSchema.safeParse(
        await this.peer.request("turn/start", {
          threadId: operation.parentThreadId,
          effort: "low",
          input: [
            {
              type: "text",
              text: this.parentPrompt(request, proof),
            },
          ],
        }),
      );
      if (!started.success) throw error("CODEX_AGENT_PROTOCOL_INVALID");
      operation.parentTurnId = started.data.turn.id;

      const childId = await withTimeout(
        operation.spawned,
        this.options.spawnTimeoutMs,
        "CODEX_AGENT_SPAWN_TIMEOUT",
      );
      if (operation.fatalCode) throw error(operation.fatalCode);
      const child = await this.readThread(childId).catch(() => null);
      if (child?.parentThreadId !== operation.parentThreadId) {
        throw error("CODEX_AGENT_LINEAGE_INVALID");
      }
      const correlation: ChildCorrelation = {
        ...request.identity,
        authorityId: request.authority.authorityId,
        participantId: request.authority.participantId,
        role: request.authority.role,
        parentThreadId: operation.parentThreadId,
        childId,
        hostRole: child.agentRole ?? null,
      };
      return { status: "started", correlation };
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      this.active = null;
      if (turnSubmitted && code !== "AGENT_SPAWN_REJECTED") {
        return { status: "outcome_unknown", code: "AGENT_SPAWN_ACK_LOST" };
      }
      return { status: "failed", code: "AGENT_SPAWN_REJECTED" };
    }
  }

  async wait(correlation: ChildCorrelation): Promise<AgentWaitReceipt> {
    if (this.active) {
      const activeCorrelation: ChildCorrelation = {
        ...this.active.request.identity,
        authorityId: this.active.request.authority.authorityId,
        participantId: this.active.request.authority.participantId,
        role: this.active.request.authority.role,
        parentThreadId: this.active.parentThreadId ?? "",
        childId: this.active.childId ?? "",
        hostRole: correlation.hostRole,
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
      const observed = this.observeCompletion(correlation, child, parent);
      if (observed === "completed") {
        const completedTurn = [...child.turns]
          .reverse()
          .find((turn) => turn.status === "completed");
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
        };
      }
      if (observed === "failed") {
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
      if (Date.now() >= deadline) return { status: "running", correlation };
      await sleep(this.options.pollIntervalMs);
    }
  }

  dispose(): void {
    for (const remove of this.removers.splice(0)) remove();
    this.handlersInstalled = false;
    this.active = null;
  }

  private installHandlers(): void {
    if (this.handlersInstalled) return;
    this.handlersInstalled = true;
    this.removers.push(
      this.peer.handleServerRequest("item/tool/call", async (params) =>
        this.handleAuthorityCall(params),
      ),
      this.peer.handleNotification("item/completed", (params) =>
        this.handleItemCompleted(params),
      ),
      this.peer.handleNotification("turn/completed", (params) =>
        this.handleTurnCompleted(params),
      ),
    );
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
      call.threadId === operation.parentThreadId ||
      (operation.childId !== null && call.threadId !== operation.childId) ||
      (operation.authorityToolChildId !== null &&
        call.threadId !== operation.authorityToolChildId) ||
      operation.authorityToolCalls !== 0 ||
      call.arguments.assignmentId !== operation.request.identity.assignmentId ||
      call.arguments.authorityId !== authority.authorityId ||
      call.arguments.participantId !== authority.participantId ||
      call.arguments.role !== authority.role ||
      call.arguments.proof !== operation.proof
    ) {
      throw this.fail("CODEX_AGENT_AUTHORITY_CORRELATION");
    }
    operation.authorityToolChildId = call.threadId;
    operation.authorityToolCalls += 1;
    return {
      success: true,
      contentItems: [{ type: "inputText", text: "FAROL_AGENT_AUTHORITY_OK" }],
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
        (item.model != null && item.model !== this.options.model)
      ) {
        this.fail("CODEX_AGENT_SPAWN_CORRELATION");
        return;
      }
      const [childId] = item.receiverThreadIds;
      if (
        !childId ||
        (operation.childId !== null && operation.childId !== childId) ||
        (operation.authorityToolChildId !== null &&
          operation.authorityToolChildId !== childId)
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

  private async readThread(threadId: string): Promise<ThreadSnapshot> {
    const parsed = threadReadSchema.safeParse(
      await this.peer.request("thread/read", {
        threadId,
        includeTurns: true,
      }),
    );
    if (!parsed.success || parsed.data.thread.id !== threadId) {
      throw error("CODEX_AGENT_THREAD_INVALID");
    }
    return parsed.data.thread;
  }

  private observeCompletion(
    correlation: ChildCorrelation,
    child: ThreadSnapshot,
    parent: ThreadSnapshot,
  ): "running" | "completed" | "failed" | "invalid" {
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
    if (
      child.id !== correlation.childId ||
      child.parentThreadId !== correlation.parentThreadId ||
      parent.id !== correlation.parentThreadId ||
      parent.parentThreadId != null ||
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
    const childFailed = child.turns.some(
      (turn) => turn.status === "failed" || turn.status === "interrupted",
    );
    const parentFailed = parent.turns.some(
      (turn) => turn.status === "failed" || turn.status === "interrupted",
    );
    if (
      childFailed ||
      parentFailed ||
      child.status.type === "systemError" ||
      parent.status.type === "systemError"
    ) {
      return "failed";
    }
    const childCompleted = child.turns.some(
      (turn) => turn.status === "completed",
    );
    const parentCompleted = parent.turns.some(
      (turn) => turn.status === "completed",
    );
    const authorityCalls = child.turns
      .flatMap(parseHistoryItems)
      .filter(
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
    const parentItems = parent.turns.flatMap(parseHistoryItems);
    const spawnItems = parentItems.filter(
      (item) =>
        item.type === "collabAgentToolCall" &&
        item.tool === "spawnAgent" &&
        item.status === "completed" &&
        item.senderThreadId === correlation.parentThreadId &&
        item.receiverThreadIds.length === 1 &&
        item.receiverThreadIds[0] === correlation.childId,
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
    if (!childCompleted || !parentCompleted) return "running";
    return authorityCalls.length === 1 &&
      spawnItems.length === 1 &&
      waitItems.length >= 1
      ? "completed"
      : "invalid";
  }

  private parentPrompt(request: AgentSpawnRequest, proof: string): string {
    return [
      "Use the native collaboration tools to spawn exactly one child, then wait for that same child to finish.",
      `The Farol responsibility role is ${request.authority.role}.`,
      "The child must not inspect files, run commands, use the web, or call any other tool.",
      `Tell the child to call farol_agent_authority exactly once with assignmentId ${request.identity.assignmentId}, authorityId ${request.authority.authorityId}, participantId ${request.authority.participantId}, role ${request.authority.role}, and proof ${proof}.`,
      `Initial focus paths are starting evidence only: ${JSON.stringify(request.focus.initialPaths)}.`,
      "After the child returns FAROL_AGENT_AUTHORITY_OK, wait for it and reply only FAROL_NATIVE_AGENT_OK.",
    ].join("\n");
  }
}
