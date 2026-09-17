import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import type {
  AgentHost,
  AgentCancelReceipt,
  AgentSpawnReceipt,
  AgentSpawnRequest,
  AgentWaitReceipt,
} from "../../app/port/agent-host";
import type { AgentComputer } from "../../app/port/computer";
import type { AgentWorkspaceProbe } from "../../app/port/workspace-probe";
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
  cancelTimeoutMs?: number;
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
    prompt: z
      .string()
      .max(128 * 1_024)
      .nullable()
      .optional(),
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

const workspaceArgumentsSchema = z.strictObject({
  assignmentId: boundedId,
  authorityId: boundedId,
  participantId: boundedId,
  proof: z.string().regex(/^[a-f0-9]{64}$/u),
});

const relativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => {
    if (value === ".") return true;
    return (
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") &&
      [...value].every((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && code >= 32 && code !== 127;
      })
    );
  });

const computerOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workspace.read"),
    relativePath: relativePathSchema.refine((value) => value !== "."),
  }),
  z.strictObject({
    kind: z.literal("workspace.list"),
    relativePath: relativePathSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace.search"),
    relativePath: relativePathSchema,
    pattern: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) =>
        [...value].every((character) => {
          const code = character.codePointAt(0);
          return code !== undefined && code >= 32 && code !== 127;
        }),
      ),
  }),
  z.strictObject({
    kind: z.literal("verification.run"),
    command: z.enum(["git.status", "git.head"]),
    relativePath: z.literal("."),
  }),
]);

const computerArgumentsSchema = z.strictObject({
  assignmentId: boundedId,
  authorityId: boundedId,
  participantId: boundedId,
  proof: z.string().regex(/^[a-f0-9]{64}$/u),
  workspaceId: boundedId,
  operation: computerOperationSchema,
});

const authorityCallSchema = z.strictObject({
  threadId: boundedId,
  turnId: boundedId,
  callId: boundedId,
  namespace: z.string().nullable().optional(),
  tool: z.literal("farol_agent_authority"),
  arguments: authorityArgumentsSchema,
});

const workspaceCallSchema = z.strictObject({
  threadId: boundedId,
  turnId: boundedId,
  callId: boundedId,
  namespace: z.string().nullable().optional(),
  tool: z.literal("farol_agent_workspace_probe"),
  arguments: workspaceArgumentsSchema,
});

const computerCallSchema = z.strictObject({
  threadId: boundedId,
  turnId: boundedId,
  callId: boundedId,
  namespace: z.string().nullable().optional(),
  tool: z.literal("farol_agent_computer"),
  arguments: computerArgumentsSchema,
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

const workspaceDynamicToolItemSchema = z
  .object({
    id: boundedId,
    type: z.literal("dynamicToolCall"),
    tool: z.literal("farol_agent_workspace_probe"),
    status: z.enum(["inProgress", "completed", "failed"]),
    success: z.boolean().nullable().optional(),
    arguments: workspaceArgumentsSchema,
  })
  .passthrough();

const computerDynamicToolItemSchema = z
  .object({
    id: boundedId,
    type: z.literal("dynamicToolCall"),
    tool: z.literal("farol_agent_computer"),
    status: z.enum(["inProgress", "completed", "failed"]),
    success: z.boolean().nullable().optional(),
    arguments: computerArgumentsSchema,
  })
  .passthrough();

const historyItemSchema = z.union([
  collabItemSchema,
  dynamicToolItemSchema,
  workspaceDynamicToolItemSchema,
  computerDynamicToolItemSchema,
]);

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceProof(
  input: Readonly<{
    assignmentId: string;
    authorityId: string;
    participantId: string;
  }>,
): string {
  return sha256(
    JSON.stringify([
      "farol-agent-workspace-probe-v1",
      input.assignmentId,
      input.authorityId,
      input.participantId,
    ]),
  );
}

function computerProof(
  input: Readonly<{
    assignmentId: string;
    authorityId: string;
    participantId: string;
  }>,
): string {
  return sha256(
    JSON.stringify([
      "farol-agent-computer-v1",
      input.assignmentId,
      input.authorityId,
      input.participantId,
    ]),
  );
}

function assignmentEnvelope(request: AgentSpawnRequest) {
  const identity = request.identity;
  const authority = request.authority;
  return {
    schema: 1,
    kind: "farol_task_grant",
    assignment: {
      assignmentId: identity.assignmentId,
      ownerId: identity.ownerId,
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      taskEpoch: identity.taskEpoch,
      generation: identity.generation,
    },
    authority: {
      authorityId: authority.authorityId,
      participantId: authority.participantId,
      parentParticipantId: authority.parentParticipantId,
      role: authority.role,
      mutationOwnership: authority.mutationOwnership,
      ownerId: authority.ownerId,
      sessionId: authority.sessionId,
      taskId: authority.taskId,
      taskEpoch: authority.taskEpoch,
      computerId: authority.computerId,
      computerGeneration: authority.computerGeneration,
      workspaces: authority.workspaces.map((workspace) =>
        workspace.mode === "subtree"
          ? {
              workspaceId: workspace.workspaceId,
              mode: workspace.mode,
              root: workspace.root,
              access: workspace.access,
            }
          : {
              workspaceId: workspace.workspaceId,
              mode: workspace.mode,
              root: workspace.root,
              paths: [...workspace.paths],
              access: workspace.access,
            },
      ),
      excludedPaths: authority.excludedPaths.map((entry) => ({ ...entry })),
      capabilities: [...authority.capabilities],
      network: authority.network,
      commands: authority.commands,
      expiresAt: authority.expiresAt,
    },
    focus: { initialPaths: [...request.focus.initialPaths] },
  };
}

function childPrompt(request: AgentSpawnRequest): string {
  const identity = request.identity;
  const authority = request.authority;
  const envelope = assignmentEnvelope(request);
  if (request.intent.kind === "product") {
    const operations = request.authority.capabilities.join(", ");
    const exactFilesOnly = request.authority.workspaces.every(
      (workspace) => workspace.mode === "exact",
    );
    const scopeGuidance = exactFilesOnly
      ? "Initial paths are the exact file authority boundary. Do not list, search, or discover any other path."
      : "Initial paths are focus, not the authority boundary. You may discover other relevant files inside a granted subtree without asking for per-file approval.";
    const verificationGuidance = request.authority.capabilities.includes(
      "verification.run",
    )
      ? "verification.run is permitted only through farol_agent_computer and exposes no caller-controlled executable or arguments."
      : "verification.run is not granted for this assignment.";
    return [
      "FAROL_NATIVE_AGENT_TASK_V2",
      JSON.stringify({ ...envelope, objective: request.intent.objective }),
      `Complete this exact owner assignment: ${request.intent.objective}`,
      `For every permitted Farol Computer operation, call farol_agent_computer with assignmentId ${identity.assignmentId}, authorityId ${authority.authorityId}, participantId ${authority.participantId}, and computer proof ${computerProof({ assignmentId: identity.assignmentId, authorityId: authority.authorityId, participantId: authority.participantId })}.`,
      `Use only these operations allowed by the supplied TaskGrant: ${operations}.`,
      scopeGuidance,
      `Do not inspect files directly, run native or arbitrary commands, use the web, create descendants, or call any other tool. ${verificationGuidance}`,
      "Return a concise answer to the owner assignment.",
    ].join("\n");
  }
  return [
    "FAROL_NATIVE_AGENT_TASK_V1",
    JSON.stringify(envelope),
    `Call farol_agent_workspace_probe exactly once with assignmentId ${identity.assignmentId}, authorityId ${authority.authorityId}, participantId ${authority.participantId}, and workspace proof ${workspaceProof({ assignmentId: identity.assignmentId, authorityId: authority.authorityId, participantId: authority.participantId })}.`,
    "This fixed probe may list only the approved focus through Farol Computer and returns no file names or contents.",
    "Do not inspect files directly, run commands, use the web, create descendants, or call any other tool.",
    "Reply only FAROL_NATIVE_AGENT_CHILD_OK.",
  ].join("\n");
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
    "verification.run",
  ]);
  const verificationEnabled =
    authority.capabilities.includes("verification.run");
  const commandsAllowed =
    request.intent.kind === "product"
      ? (authority.commands === "verification" && verificationEnabled) ||
        (authority.commands === "none" && !verificationEnabled)
      : authority.commands === "none" && !verificationEnabled;
  const focusAllowed =
    request.focus.initialPaths.length > 0 &&
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
  const intentAllowed =
    request.intent.kind === "compatibility" ||
    (request.intent.objective.trim().length > 0 &&
      request.intent.objective.length <= 8_000 &&
      !request.intent.objective.includes("\0"));
  return (
    authority.ownerId === request.identity.ownerId &&
    authority.sessionId === request.identity.sessionId &&
    authority.taskId === request.identity.taskId &&
    authority.taskEpoch === request.identity.taskEpoch &&
    authority.mutationOwnership === "none" &&
    authority.network === "none" &&
    commandsAllowed &&
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
    intentAllowed &&
    focusAllowed
  );
}

function parseHistoryItems(turn: z.infer<typeof historyTurnSchema>) {
  return turn.items.flatMap((candidate) => {
    const parsed = historyItemSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function authorityDynamicTool() {
  return {
    type: "function",
    name: "farol_agent_authority",
    description:
      "Confirm the exact Farol assignment authority after the parent waited for the correlated native child.",
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
  };
}

function workspaceProbeDynamicTool() {
  return {
    type: "function",
    name: "farol_agent_workspace_probe",
    description:
      "Run one fixed content-free Farol Computer workspace enforcement probe for the correlated native child.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignmentId: { type: "string" },
        authorityId: { type: "string" },
        participantId: { type: "string" },
        proof: { type: "string" },
      },
      required: ["assignmentId", "authorityId", "participantId", "proof"],
    },
  };
}

function agentComputerDynamicTool() {
  return {
    type: "function",
    name: "farol_agent_computer",
    description:
      "List, search, read, or run a fixed no-network verification in an approved Farol Computer workspace under the exact inherited TaskGrant.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignmentId: { type: "string" },
        authorityId: { type: "string" },
        participantId: { type: "string" },
        proof: { type: "string" },
        workspaceId: { type: "string" },
        operation: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { const: "workspace.read" },
                relativePath: { type: "string" },
              },
              required: ["kind", "relativePath"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { const: "workspace.list" },
                relativePath: { type: "string" },
              },
              required: ["kind", "relativePath"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { const: "workspace.search" },
                relativePath: { type: "string" },
                pattern: { type: "string" },
              },
              required: ["kind", "relativePath", "pattern"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { const: "verification.run" },
                command: { enum: ["git.status", "git.head"] },
                relativePath: { const: "." },
              },
              required: ["kind", "command", "relativePath"],
            },
          ],
        },
      },
      required: [
        "assignmentId",
        "authorityId",
        "participantId",
        "proof",
        "workspaceId",
        "operation",
      ],
    },
  };
}

function dynamicTools(request: AgentSpawnRequest) {
  return [
    authorityDynamicTool(),
    request.intent.kind === "compatibility"
      ? workspaceProbeDynamicTool()
      : agentComputerDynamicTool(),
  ];
}

function baseInstructions(request: AgentSpawnRequest): string {
  return request.intent.kind === "compatibility"
    ? "This is a bounded Farol compatibility assignment. Neither parent nor child may inspect files directly, run commands, or use the web. A spawned child must not create descendants and may call only farol_agent_workspace_probe exactly once. Only the root thread may spawn one child and later call farol_agent_authority."
    : "This is a bounded Farol product assignment. The root thread may spawn exactly one child and must wait for that same child before calling farol_agent_authority. The child must not create descendants and may call only farol_agent_computer. Neither thread may inspect workspaces directly, run native or arbitrary commands, or use the web. Any permitted fixed verification runs only through farol_agent_computer under the inherited TaskGrant.";
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
      !canonicalAbsolutePath(options.runtimeRoot) ||
      !validDuration(options.spawnTimeoutMs) ||
      !validDuration(options.waitTimeoutMs) ||
      !validDuration(options.pollIntervalMs) ||
      (options.cancelTimeoutMs !== undefined &&
        !validDuration(options.cancelTimeoutMs))
    ) {
      throw error("CODEX_AGENT_OPTIONS_INVALID");
    }
  }

  async spawn(request: AgentSpawnRequest): Promise<AgentSpawnReceipt> {
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
              text: this.parentPrompt(request, proof, operation.childPrompt),
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
      if (Date.now() >= deadline) return { status: "running", correlation };
      await sleep(this.options.pollIntervalMs);
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
        (item.model != null && item.model !== this.options.model) ||
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
    if (
      forbiddenChildTool ||
      childWorkspaceCalls.length > 1 ||
      childComputerCalls.length > 32 ||
      new Set(childComputerCalls.map((item) => item.id)).size !==
        childComputerCalls.length ||
      childWorkspaceCalls.some(
        (item) =>
          item.status !== "completed" ||
          item.success !== true ||
          item.arguments.assignmentId !== correlation.assignmentId ||
          item.arguments.authorityId !== correlation.authorityId ||
          item.arguments.participantId !== correlation.participantId ||
          item.arguments.proof !== expectedWorkspaceProof,
      ) ||
      childComputerCalls.some(
        (item) =>
          item.status !== "completed" ||
          typeof item.success !== "boolean" ||
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
    return [
      "Use the native collaboration tools to spawn exactly one child, then wait for that same child to finish.",
      `The Farol responsibility role is ${request.authority.role}.`,
      "Set the child's prompt to exactly the text between the markers, byte-for-byte, without either marker or any additional text.",
      "FAROL_CHILD_PROMPT_BEGIN",
      exactChildPrompt,
      "FAROL_CHILD_PROMPT_END",
      "After that exact child completes, wait for it.",
      `Then you, the parent, must call farol_agent_authority exactly once with assignmentId ${request.identity.assignmentId}, authorityId ${request.authority.authorityId}, participantId ${request.authority.participantId}, role ${request.authority.role}, and proof ${proof}.`,
      "After FAROL_AGENT_AUTHORITY_OK, reply only FAROL_NATIVE_AGENT_OK.",
    ].join("\n");
  }
}
