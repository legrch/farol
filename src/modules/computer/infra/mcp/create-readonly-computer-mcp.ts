import {
  parseClaudeCreate,
  parseClaudeStatus,
  type ClaudeTaskRoutePeer,
} from "../peer/claude-task-route-peer";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  TaskEffortSchema,
  TaskNameSchema,
  TaskModelCatalogueViewSchema,
} from "../../../../pkg/owner-config/contract";

import {
  MutableComputerCallResponseSchema,
  type MutableComputerCallRequest,
  type MutableComputerContract,
} from "../../contract/mutable-computer-contract";
import {
  ReadonlyComputerCallResponseSchema,
  type ReadonlyComputerCallRequest,
  type ReadonlyComputerContract,
} from "../../contract/readonly-computer-contract";
import {
  CodexCallerRelayOperationSchema,
  type CodexCallerRelayResponse,
} from "../../../../pkg/caller-relay/protocol";
import type { CodexCallerRelayPort } from "./codex-caller-relay-port";
import type { ExecutionFenceReader } from "./execution-fence";
import type {
  SandboxedWorkspaceShell,
  ShellResponse,
} from "../native/sandboxed-workspace-shell";
import {
  parseProjectResolution,
  parseProjectTasks,
  parseProjectPreference,
  parseProjectPreferenceLookup,
  parseTaskHistory,
  parseTaskTitle,
  parseThreadRuntime,
  parseTaskCreate,
  parseTaskMessage,
  parseTaskStatus,
  parseTaskResult,
  parseTaskObserve,
  parseTaskAdopt,
  type CodexTaskRoutePeer,
} from "../peer/codex-task-route-peer";
import { bootstrapWorkspace } from "./workspace-bootstrap";
import { discoverWorkspaces } from "./workspace-catalogue";
import { PublishedGuidance } from "./published-guidance";
import type {
  SavedChatBridgeOperation,
  SavedChatBridgeResponse,
} from "../../../../pkg/saved-chat-bridge/protocol";

export type ReadonlyComputerMcpBinding = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  participantId: string;
  turnId: string;
  generation: number;
}>;

const IdentifierSchema = z.string().min(1).max(120);
const DispatchIdSchema = z.string().uuid();
const CodexTaskTextSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => !value.includes("\0"))
  .refine((value) => new TextEncoder().encode(value).byteLength <= 8_192);
const CodexTaskCreateInputSchema = z.strictObject({
  key: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  message: CodexTaskTextSchema,
  harness: TaskNameSchema.optional(),
  model: TaskNameSchema.optional(),
  effort: TaskEffortSchema.optional(),
});
const CodexProjectResolveInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  preferredProjectId: IdentifierSchema.optional(),
});
const CodexProjectPreferenceInputSchema = z.strictObject({
  key: z.string().uuid(),
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  operation: z.enum(["remember", "read"]),
});
const CodexProjectTasksInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  scope: z
    .enum(["selected-writer", "canonical-and-selected-writer"])
    .optional(),
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
    .optional(),
});
const CodexTaskReadInputSchema = z.strictObject({
  dispatchId: DispatchIdSchema,
});
const CodexTaskObserveInputSchema = z.strictObject({
  threadId: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
});
const CodexTaskAdoptInputSchema = CodexTaskObserveInputSchema.extend({
  turnId: DispatchIdSchema,
});
const CodexTaskHistoryInputSchema = CodexTaskAdoptInputSchema.extend({
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
    .optional(),
  tail: z.boolean().optional(),
});
const CodexTaskContinueInputSchema = z.strictObject({
  key: DispatchIdSchema,
  dispatchId: DispatchIdSchema,
  message: CodexTaskTextSchema,
});
const CodexTaskMessageInputSchema = z.strictObject({
  key: DispatchIdSchema,
  dispatchId: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  message: CodexTaskTextSchema,
  model: z.string().min(1).max(120),
  reasoningEffort: z.string().min(1).max(40).optional(),
});
const CodexTaskTitleInputSchema = z.strictObject({
  key: DispatchIdSchema,
  dispatchId: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  expectedTitle: z
    .string()
    .max(1000)
    .refine((value) => !value.includes("\0"))
    .nullable(),
  title: z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !value.includes("\0") &&
        new TextEncoder().encode(value).byteLength <= 1000,
    ),
});
const SavedChatCreateInputSchema = z.strictObject({
  key: DispatchIdSchema,
  title: z.string().min(1).max(80),
  firstMessage: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => !value.includes("\0"))
    .refine((value) => new TextEncoder().encode(value).byteLength <= 8192),
});
const SavedChatStatusInputSchema = z.strictObject({
  dispatchId: DispatchIdSchema,
  recheck: z.boolean().optional(),
});

function relativePath(value: string, root: boolean): boolean {
  if (root && value === ".") return true;
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  ) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

const FileRelativePathSchema = z
  .string()
  .refine((value) => relativePath(value, false));
const ScopeRelativePathSchema = z
  .string()
  .refine((value) => relativePath(value, true));
const SearchPatternSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    }),
  );

const ListInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopeRelativePathSchema,
});
const BootstrapInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativeDirectory: ScopeRelativePathSchema,
});
const GuidanceSearchInputSchema = z.strictObject({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(16).optional(),
});
const GuidanceFetchInputSchema = z.strictObject({
  id: z.string().min(1).max(120),
});
// A file over the whole-read ceiling is read window by window. Either field
// asks for a window; the other then takes its default.
const DEFAULT_READ_WINDOW_BYTES = 64 * 1_024;
const ReadInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: FileRelativePathSchema,
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  length: z
    .number()
    .int()
    .min(4)
    .max(256 * 1_024)
    .optional(),
});
const SearchInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopeRelativePathSchema,
  pattern: SearchPatternSchema,
});
const VerificationInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
});
const ConnectorVerificationInputSchema = z.strictObject({
  challenge: z
    .string()
    .min(1)
    .max(160)
    .refine((value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && code >= 33 && code <= 126;
      }),
    ),
  workspaceId: IdentifierSchema,
});
const MutationTextSchema = z
  .string()
  .max(8 * 1_024 * 1_024)
  .refine((value) => !value.includes("\0"));
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const WriteInputSchema = z.strictObject({
  operationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativePath: FileRelativePathSchema,
  content: MutationTextSchema,
  expectedSha256: Sha256Schema.nullable(),
});
const EditInputSchema = z.strictObject({
  operationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativePath: FileRelativePathSchema,
  edits: z
    .array(
      z
        .strictObject({
          oldText: MutationTextSchema.min(1),
          newText: MutationTextSchema,
        })
        .refine((edit) => edit.oldText !== edit.newText),
    )
    .min(1)
    .max(256),
  expectedSha256: Sha256Schema,
});
const ShellStartInputSchema = z.strictObject({
  operationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativeCwd: ScopeRelativePathSchema,
  command: z
    .string()
    .min(1)
    .max(16 * 1024),
  stdin: z
    .string()
    .max(1024 * 1024)
    .optional(),
  timeoutMs: z.number().int().min(1).max(600_000),
  write: z.boolean(),
});
const ShellReadInputSchema = z.strictObject({
  handle: z.string().uuid(),
  stdoutOffset: z.number().int().nonnegative(),
  stderrOffset: z.number().int().nonnegative(),
});
const ShellCancelInputSchema = z.strictObject({ handle: z.string().uuid() });

const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const LOCAL_RECORD_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const VERIFICATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const CALLER_RELAY_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const CODEX_TASK_CREATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export interface ConnectorVerificationRecorder {
  accepts(challenge: string): boolean;
  record(
    input: Readonly<{
      challenge: string;
      binding: ReadonlyComputerMcpBinding;
      callId: string;
      workspaceId: string;
      entryCount: number;
      truncated: boolean;
    }>,
  ): Promise<
    Readonly<{
      receipt: Readonly<{ challengeSha256: string }>;
      receiptSha256: string;
    }>
  >;
}

export interface DevMcpProofRecorder {
  observe(
    input: Readonly<{
      request: ReadonlyComputerCallRequest;
      response:
        | Readonly<{
            ok: true;
            output: Readonly<{ kind: string; text?: string; bytes?: number }>;
          }>
        | Readonly<{ ok: false; errorCode: string }>;
    }>,
  ): Promise<void>;
}

function failure(code: string): CallToolResult {
  const value = {
    ok: false,
    error: { code, source: "contract", retry: "never" },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

// A summary-only phase is in progress somewhere in the owner's session: no
// Computer tool executes until it is over. The connector transport carries
// no conversation identity, so the fence covers every caller for that
// bounded time rather than admitting a call it cannot attribute.
function fenced(code: string): CallToolResult {
  const value = {
    ok: false,
    error: { code, source: "execution-fence", retry: "later" },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

type ReadRange = Readonly<{ offset: number; length: number }> | undefined;

function sameRange(left: ReadRange, right: ReadRange): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.offset === right.offset && left.length === right.length;
}

function correlationMatches(
  request: ReadonlyComputerCallRequest,
  value: Readonly<{
    ownerId: string;
    sessionId: string;
    taskId: string;
    taskEpoch: number;
    participantId: string;
    turnId: string;
    generation: number;
    callId: string;
    workspaceId: string;
    relativePath: string;
    operation: ReadonlyComputerCallRequest["operation"];
  }>,
): boolean {
  return (
    value.ownerId === request.ownerId &&
    value.sessionId === request.sessionId &&
    value.taskId === request.taskId &&
    value.taskEpoch === request.taskEpoch &&
    value.participantId === request.participantId &&
    value.turnId === request.turnId &&
    value.generation === request.generation &&
    value.callId === request.callId &&
    value.workspaceId === request.workspaceId &&
    value.relativePath === request.operation.relativePath &&
    value.operation.kind === request.operation.kind &&
    value.operation.relativePath === request.operation.relativePath &&
    (value.operation.kind !== "workspace.read" ||
      (request.operation.kind === "workspace.read" &&
        sameRange(value.operation.range, request.operation.range))) &&
    (value.operation.kind !== "workspace.search" ||
      (request.operation.kind === "workspace.search" &&
        value.operation.pattern === request.operation.pattern)) &&
    (value.operation.kind !== "verification.run" ||
      (request.operation.kind === "verification.run" &&
        value.operation.command === request.operation.command))
  );
}

async function execute(
  contract: ReadonlyComputerContract,
  binding: ReadonlyComputerMcpBinding,
  callId: string,
  workspaceId: string,
  operation: ReadonlyComputerCallRequest["operation"],
  signal?: AbortSignal,
  proofRecorder?: DevMcpProofRecorder,
): Promise<CallToolResult> {
  const request: ReadonlyComputerCallRequest = {
    ...binding,
    callId,
    workspaceId,
    operation,
  };
  let response: unknown;
  try {
    response = await contract.execute(request, signal ? { signal } : {});
  } catch {
    return failure("COMPUTER_CONTRACT_UNAVAILABLE");
  }
  const parsed = ReadonlyComputerCallResponseSchema.safeParse(response);
  if (!parsed.success) return failure("COMPUTER_CONTRACT_INVALID");
  if (!parsed.data.ok) {
    if (
      parsed.data.correlation === null ||
      !correlationMatches(request, parsed.data.correlation)
    ) {
      return failure("COMPUTER_CONTRACT_CORRELATION");
    }
    await proofRecorder
      ?.observe({
        request,
        response: { ok: false, errorCode: parsed.data.error.code },
      })
      .catch(() => undefined);
    return {
      content: [{ type: "text", text: JSON.stringify(parsed.data) }],
      structuredContent: { ...parsed.data },
      isError: true,
    };
  }
  const value = parsed.data.value;
  // A page answers a ranged read and only a ranged read: text without one
  // would read as the whole file.
  const outputMatchesOperation =
    (request.operation.kind === "workspace.context" &&
      value.output.kind === "workspace.context") ||
    (request.operation.kind === "workspace.read" &&
      value.output.kind === "workspace.text" &&
      (request.operation.range === undefined) ===
        (value.output.page === undefined)) ||
    (request.operation.kind === "workspace.list" &&
      value.output.kind === "workspace.entries") ||
    (request.operation.kind === "workspace.search" &&
      value.output.kind === "workspace.matches") ||
    (request.operation.kind === "verification.run" &&
      value.output.kind === "workspace.command" &&
      value.output.command === request.operation.command);
  if (!correlationMatches(request, value) || !outputMatchesOperation) {
    return failure("COMPUTER_CONTRACT_CORRELATION");
  }
  await proofRecorder
    ?.observe({ request, response: { ok: true, output: value.output } })
    .catch(() => undefined);
  const structuredContent: Record<string, unknown> = {
    ...value,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value.output) }],
    structuredContent,
  };
}

function mutationCorrelationMatches(
  request: MutableComputerCallRequest,
  value: Readonly<{
    operationId: string;
    ownerId: string;
    sessionId: string;
    taskId: string;
    taskEpoch: number;
    participantId: string;
    turnId: string;
    generation: number;
    callId: string;
    workspaceId: string;
    relativePath: string;
    operation: Readonly<{
      kind: "workspace.edit" | "workspace.write";
      relativePath: string;
      expectedSha256: string | null;
    }>;
  }>,
): boolean {
  return (
    value.operationId === request.operationId &&
    value.ownerId === request.ownerId &&
    value.sessionId === request.sessionId &&
    value.taskId === request.taskId &&
    value.taskEpoch === request.taskEpoch &&
    value.participantId === request.participantId &&
    value.turnId === request.turnId &&
    value.generation === request.generation &&
    value.callId === request.callId &&
    value.workspaceId === request.workspaceId &&
    value.relativePath === request.operation.relativePath &&
    value.operation.kind === request.operation.kind &&
    value.operation.relativePath === request.operation.relativePath &&
    value.operation.expectedSha256 === request.operation.expectedSha256
  );
}

async function executeMutation(
  contract: MutableComputerContract,
  binding: ReadonlyComputerMcpBinding,
  callId: string,
  operationId: string,
  workspaceId: string,
  operation: MutableComputerCallRequest["operation"],
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const request: MutableComputerCallRequest = {
    ...binding,
    callId,
    operationId,
    workspaceId,
    operation,
  };
  let response: unknown;
  try {
    response = await contract.execute(request, signal ? { signal } : {});
  } catch {
    return failure("COMPUTER_CONTRACT_UNAVAILABLE");
  }
  const parsed = MutableComputerCallResponseSchema.safeParse(response);
  if (!parsed.success) return failure("COMPUTER_CONTRACT_INVALID");
  if (!parsed.data.ok) {
    if (
      parsed.data.correlation === null ||
      !mutationCorrelationMatches(request, parsed.data.correlation)
    ) {
      return failure("COMPUTER_CONTRACT_CORRELATION");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(parsed.data) }],
      structuredContent: { ...parsed.data },
      isError: true,
    };
  }
  const value = parsed.data.value;
  const expectedOperation =
    operation.kind === "workspace.write" ? "write" : "edit";
  if (
    !mutationCorrelationMatches(request, value) ||
    value.receipt.operation !== expectedOperation ||
    value.receipt.relativePath !== operation.relativePath
  ) {
    return failure("COMPUTER_CONTRACT_CORRELATION");
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value.receipt) }],
    structuredContent: { ...value },
  };
}

async function executeConnectorVerification(
  contract: ReadonlyComputerContract,
  binding: ReadonlyComputerMcpBinding,
  recorder: ConnectorVerificationRecorder,
  callId: string,
  challenge: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  if (!recorder.accepts(challenge)) {
    return failure("CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH");
  }
  const result = await execute(
    contract,
    binding,
    callId,
    workspaceId,
    {
      kind: "workspace.list",
      relativePath: ".",
    },
    signal,
  );
  if (result.isError) return result;
  const parsed = ReadonlyComputerCallResponseSchema.safeParse({
    ok: true,
    value: result.structuredContent,
  });
  if (
    !parsed.success ||
    !parsed.data.ok ||
    parsed.data.value.output.kind !== "workspace.entries"
  ) {
    return failure("COMPUTER_CONTRACT_INVALID");
  }
  const output = parsed.data.value.output;
  try {
    const recorded = await recorder.record({
      challenge,
      binding,
      callId,
      workspaceId,
      entryCount: output.entries.length,
      truncated: output.truncated,
    });
    const value = {
      ok: true,
      challengeSha256: recorded.receipt.challengeSha256,
      receiptSha256: recorded.receiptSha256,
      workspaceId,
      operation: "workspace.list" as const,
      entryCount: output.entries.length,
      truncated: output.truncated,
      correlation: {
        taskId: binding.taskId,
        participantId: binding.participantId,
        turnId: binding.turnId,
        generation: binding.generation,
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "CONNECTOR_VERIFICATION_ALREADY_RECORDED") {
      return failure("CONNECTOR_VERIFICATION_ALREADY_RECORDED");
    }
    if (code === "CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH") {
      return failure("CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH");
    }
    return failure("CONNECTOR_VERIFICATION_RECEIPT_FAILED");
  }
}

async function executeCallerRelay(
  relay: CodexCallerRelayPort,
  operation: z.infer<typeof CodexCallerRelayOperationSchema>,
): Promise<CallToolResult> {
  let response: CodexCallerRelayResponse;
  try {
    response = await relay.request(operation);
  } catch {
    response = {
      ok: false,
      error: { code: "CALLER_RELAY_UNAVAILABLE", retry: "never" },
    };
  }
  if (!response.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(response) }],
      structuredContent: response,
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          response.operation === "invoke"
            ? response.output
            : JSON.stringify(response.catalogue),
      },
    ],
    structuredContent: response,
  };
}

function shellResult(result: ShellResponse): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: { ...result },
    ...(result.ok ? {} : { isError: true }),
  };
}

export function createReadonlyComputerMcpServer(
  contract: ReadonlyComputerContract,
  binding: ReadonlyComputerMcpBinding,
  mutableContract?: MutableComputerContract,
  connectorVerification?: ConnectorVerificationRecorder,
  callerRelay?: CodexCallerRelayPort,
  fence?: ExecutionFenceReader,
  devMcpProof?: DevMcpProofRecorder,
  codexTasks?: CodexTaskRoutePeer,
  shell?: SandboxedWorkspaceShell,
  lifecycle?: Readonly<{
    isStopping(): Promise<boolean>;
    enterHandler(): (() => void) | null;
  }>,
  savedChat?: Readonly<{
    request(
      operation: SavedChatBridgeOperation,
    ): Promise<SavedChatBridgeResponse>;
  }>,
  claudeTasks?: ClaudeTaskRoutePeer,
  workspaceCatalogueIds?: readonly string[],
): McpServer {
  const server = new McpServer({
    name: "farol-next-computer",
    version: "0.1.0-preview.0",
  });
  // Keep unresolved leases reachable: a failed group-cleanup proof must not
  // silently reopen summary admission while this connector still runs.
  const unverifiedShellLeases = new Set<
    Extract<
      Awaited<ReturnType<NonNullable<typeof fence>["acquireAdmission"]>>,
      { admitted: true }
    >
  >();
  const leasedShellHandles = new Set<string>();
  // Every tool holds the shared admission lock through its contract. A
  // summary's exclusive raise either follows completed work or refuses.
  const tracked =
    <Arguments extends unknown[]>(
      run: (...arguments_: Arguments) => Promise<CallToolResult>,
    ) =>
    async (...arguments_: Arguments): Promise<CallToolResult> => {
      const release = lifecycle?.enterHandler();
      if (lifecycle && !release) return fenced("COMPUTER_MCP_STOPPING");
      try {
        return await run(...arguments_);
      } finally {
        release?.();
      }
    };
  const guarded = <Arguments extends unknown[]>(
    run: (...arguments_: Arguments) => Promise<CallToolResult>,
    afterRelease?: (...arguments_: Arguments) => CallToolResult | null,
  ) =>
    tracked(async (...arguments_: Arguments): Promise<CallToolResult> => {
      if (lifecycle && (await lifecycle.isStopping().catch(() => true)))
        return fenced("COMPUTER_MCP_STOPPING");
      if (!fence) {
        const result = await run(...arguments_);
        return afterRelease?.(...arguments_) ?? result;
      }
      let admission;
      try {
        admission = await fence.acquireAdmission();
      } catch {
        return fenced("COMPUTER_EXECUTION_FENCE_UNREADABLE");
      }
      if (!admission.admitted) return fenced(admission.code);
      let result: CallToolResult;
      try {
        if (lifecycle && (await lifecycle.isStopping().catch(() => true)))
          return fenced("COMPUTER_MCP_STOPPING");
        result = await run(...arguments_);
      } finally {
        await admission.release();
      }
      return afterRelease?.(...arguments_) ?? result;
    });

  const taskResponse = (value: object, isError = false): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  });
  const codexReadAdmitted = (signal: AbortSignal): boolean => {
    try {
      return (
        !signal.aborted &&
        (codexTasks?.isReadAdmitted === undefined ||
          codexTasks.isReadAdmitted({ signal }) === true)
      );
    } catch {
      return false;
    }
  };
  if (claudeTasks) {
    server.registerTool(
      "claude_task_create",
      {
        title: "Dispatch one approved Claude print session",
        description:
          "Fixture-qualified sandboxed host only. One UUID key, exact approved target and tasks.harnesses alias. Process startup is not a terminal result or native UI visibility. An unknown acknowledgement never permits another create or a fresh key. No implicit Codex fallback, permission bypass, automatic approval or live qualification.",
        inputSchema: CodexTaskCreateInputSchema,
        annotations: CODEX_TASK_CREATE_ANNOTATIONS,
      },
      guarded(async (request) => {
        try {
          const result = parseClaudeCreate(
            await claudeTasks.create(request),
            request.key,
          );
          return taskResponse(result, result.status !== "dispatched");
        } catch {
          return taskResponse(
            {
              status: "outcome_unknown",
              dispatchId: request.key.toLowerCase(),
            },
            true,
          );
        }
      }),
    );
    server.registerTool(
      "claude_task_status",
      {
        title: "Read one Claude dispatch receipt",
        description:
          "Read the exact local session/process or recorded terminal result. No spawn, resume, continuation or permission grant. Native visibility remains not-qualified. Restart without a recorded terminal result is outcome_unknown, never authority to relaunch.",
        inputSchema: CodexTaskReadInputSchema,
        annotations: READONLY_ANNOTATIONS,
      },
      guarded(async (request) => {
        try {
          const result = parseClaudeStatus(
            await claudeTasks.status(request.dispatchId),
            request.dispatchId,
          );
          return taskResponse(
            result,
            result.status === "refused" || result.status === "outcome_unknown",
          );
        } catch {
          return taskResponse(
            {
              status: "outcome_unknown",
              dispatchId: request.dispatchId.toLowerCase(),
            },
            true,
          );
        }
      }),
    );
  }

  if (savedChat) {
    const result = (value: object, isError: boolean): CallToolResult => ({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      ...(isError ? { isError: true } : {}),
    });
    server.registerTool(
      "chatgpt_chat_create",
      {
        title: "Create one saved ChatGPT chat",
        description:
          "Send exactly one first message in a normal saved ChatGPT chat through the isolated Farol Browser. Use one UUID key. Unknown outcomes must be checked by status, never retried with another key. A verified URL requires a fresh reopen and history proof; title verification is separate.",
        inputSchema: SavedChatCreateInputSchema,
        annotations: CALLER_RELAY_ANNOTATIONS,
      },
      guarded(async (request) => {
        try {
          const response = await savedChat.request({
            operation: "create",
            request,
          });
          const safe =
            response.status === "unknown" || response.dispatchId !== request.key
              ? { status: "outcome_unknown", dispatchId: request.key }
              : response;
          return result(safe, safe.status !== "verified");
        } catch {
          return result(
            { status: "outcome_unknown", dispatchId: request.key },
            true,
          );
        }
      }),
    );
    server.registerTool(
      "chatgpt_chat_status",
      {
        title: "Read one saved ChatGPT handoff",
        description:
          "Read the exact dispatch. Optional recheck uses a fresh read-only Browser surface for a previously recorded candidate URL; it never sends again.",
        inputSchema: SavedChatStatusInputSchema,
        annotations: READONLY_ANNOTATIONS,
      },
      guarded(async ({ dispatchId, recheck }) => {
        try {
          const response = await savedChat.request({
            operation: "status",
            dispatchId,
            recheck: recheck === true,
          });
          if (
            response.status !== "unknown" &&
            response.dispatchId !== dispatchId
          )
            return result({ status: "outcome_unknown", dispatchId }, true);
          return result(response, response.status === "outcome_unknown");
        } catch {
          return result({ status: "outcome_unknown", dispatchId }, true);
        }
      }),
    );
  }

  if (codexTasks) {
    if (
      codexTasks.projectPreferenceLookupEnabled === true &&
      codexTasks.lookupProjectPreference
    )
      server.registerTool(
        "codex_project_preferred",
        {
          title: "Read the latest recorded exact saved project choice",
          description:
            "Look up the last fully published local preference for the approved physical canonical repository without a UUID input. The selected sealed project must still match a fresh complete catalogue. Missing, stale, interrupted or corrupt selection never chooses a replacement. Old handle replay never becomes latest. No project/task creation, resume, inference, permission grant or preference mutation. This is a bounded non-atomic read, not automatic project selection.",
          inputSchema: z.strictObject({
            workspaceId: IdentifierSchema,
            projectId: IdentifierSchema,
          }),
          annotations: READONLY_ANNOTATIONS,
        },
        guarded(async (request, context) => {
          try {
            const result = parseProjectPreferenceLookup(
              await codexTasks.lookupProjectPreference!(request, {
                signal: context.mcpReq.signal,
              }),
              request,
            );
            return taskResponse(
              result,
              result.status !== "resolved" && result.status !== "missing",
            );
          } catch {
            return taskResponse(
              {
                status: "unavailable",
                ...request,
                code: "HANDOFF_PROJECT_PREFERENCE_LOOKUP_UNAVAILABLE",
              },
              true,
            );
          }
        }),
      );

    if (
      codexTasks.projectPreferenceEnabled === true &&
      codexTasks.projectPreference
    )
      server.registerTool(
        "codex_project_preference",
        {
          title: "Remember or read one exact saved project preference",
          description:
            "Remember an explicit saved project already selected in the sealed task admission using one immutable UUID handle, or revalidate that handle. The physical canonical repository is distinct from writer cwd. A fresh bounded non-atomic catalogue validates every use. This does not select another project, alter host permissions, create a project/task, change model or control a thread. Stale choice has no fallback. After unknown publication, read the same handle; never blindly resend or replace it with a new key.",
          inputSchema: CodexProjectPreferenceInputSchema,
          annotations: LOCAL_RECORD_ANNOTATIONS,
        },
        guarded(async (request, context) => {
          try {
            const result = parseProjectPreference(
              await codexTasks.projectPreference!(request, {
                signal: context.mcpReq.signal,
              }),
              request,
            );
            return taskResponse(
              result,
              !["remembered", "resolved"].includes(result.status),
            );
          } catch {
            return taskResponse(
              {
                status:
                  request.operation === "remember"
                    ? "outcome_unknown"
                    : "unavailable",
                key: request.key,
                workspaceId: request.workspaceId,
                projectId: request.projectId,
                code: "HANDOFF_PROJECT_PREFERENCE_UNAVAILABLE",
              },
              true,
            );
          }
        }),
      );
    if (codexTasks.projectTasksEnabled === true && codexTasks.discoverTasks)
      server.registerTool(
        "codex_project_tasks",
        {
          title: "Read stored task metadata for exact approved roots",
          description:
            "Read one stored, non-atomic metadata page in the exact approved saved project and writer cwd, with a separate sealed discovery grant. Up to 50 rows/32 KiB title/model text. No prompt preview or transcript. configuredModel is configuration metadata, not per-turn execution proof. Scope defaults to selected-writer. canonical-and-selected-writer requires a separate sealed opt-in and queries only the exact physical canonical checkout plus selected writer; root paths cannot be supplied by the caller. This does not cover additional writers, automatically select/adopt a thread, observe/resume/fork/start work or grant control. Follow nextCursor explicitly; complete applies only to an unpaginated terminal page.",
          inputSchema: CodexProjectTasksInputSchema,
          annotations: READONLY_ANNOTATIONS,
        },
        guarded(async (request, context) => {
          try {
            const result = parseProjectTasks(
              await codexTasks.discoverTasks!(request, {
                signal: context.mcpReq.signal,
              }),
              request,
            );
            return taskResponse(result, result.status !== "tasks");
          } catch {
            return taskResponse(
              {
                status: "unavailable",
                workspaceId: request.workspaceId,
                projectId: request.projectId,
                code: "HANDOFF_PROJECT_TASKS_UNAVAILABLE",
              },
              true,
            );
          }
        }),
      );
    if (codexTasks.resolveProject)
      server.registerTool(
        "codex_project_resolve",
        {
          title: "Resolve the approved saved Codex project",
          description:
            "Read a bounded saved-project catalogue for the approved canonical repository separately from writer cwd. Reports resolved, missing, ambiguous, stale_preference or unavailable explicitly; incomplete scans never prove absence. The sealed task grant's exact project ID remains the selection. This does not create a project, save a preference or start/resume/fork a task.",
          inputSchema: CodexProjectResolveInputSchema,
          annotations: READONLY_ANNOTATIONS,
        },
        guarded(async (request, context) => {
          try {
            const value = parseProjectResolution(
              await codexTasks.resolveProject!(request, {
                signal: context.mcpReq.signal,
              }),
              request.workspaceId,
            );
            return taskResponse(
              value,
              value.status === "refused" || value.status === "unavailable",
            );
          } catch {
            return taskResponse(
              {
                status: "refused",
                workspaceId: request.workspaceId,
                code: "HANDOFF_PROJECT_RESOLVE_UNAVAILABLE",
              },
              true,
            );
          }
        }),
      );
    if (codexTasks.observeEnabled === true && codexTasks.observe)
      server.registerTool(
        "codex_task_observe",
        {
          title: "Observe one selected Codex task",
          description:
            "Read only the exact owner-selected thread in the approved saved project and physical workspace. This never starts, resumes, forks or controls a task; repeat the same read to refresh. Turns are bounded to one page and hasMoreTurns reports truncation. threadRuntime is a separate, non-atomic thread-wide snapshot; waiting flags never grant approval/control or prove that this issued turn is waiting.",
          inputSchema: CodexTaskObserveInputSchema,
          annotations: READONLY_ANNOTATIONS,
        },
        guarded(
          async (request, context) => {
            try {
              const result = parseTaskObserve(
                await codexTasks.observe!(request, {
                  signal: context.mcpReq.signal,
                }),
                request.threadId,
              );
              if (result.status !== "observed")
                return taskResponse(result, true);
              const threadRuntime = parseThreadRuntime(result.threadRuntime);
              if (!threadRuntime)
                return taskResponse(
                  { status: "outcome_unknown", threadId: request.threadId },
                  true,
                );
              return taskResponse({ ...result, threadRuntime }, false);
            } catch {
              return taskResponse(
                { status: "outcome_unknown", threadId: request.threadId },
                true,
              );
            }
          },
          (_request, context) =>
            codexReadAdmitted(context.mcpReq.signal)
              ? null
              : taskResponse(
                  { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" },
                  true,
                ),
        ),
      );
    if (codexTasks.observeEnabled === true && codexTasks.history)
      server.registerTool(
        "codex_task_history",
        {
          title: "Read stored history of one selected Codex turn",
          description:
            "Read or tail one text-only page (50 items, 32 KiB text) from the exact owner-selected thread and verified turn. Stored, non-atomic history is not live task state. Reasoning, tool payloads and non-text content are omitted explicitly. nextCursor reports more items; complete is true only for an unpaginated terminal page. This never starts/resumes/forks/adopts a task or makes it controllable.",
          inputSchema: CodexTaskHistoryInputSchema,
          annotations: READONLY_ANNOTATIONS,
        },
        guarded(async (request, context) => {
          try {
            const result = parseTaskHistory(
              await codexTasks.history!(request, {
                signal: context.mcpReq.signal,
              }),
              request,
            );
            return taskResponse(result, result.status !== "history");
          } catch {
            return taskResponse(
              {
                status: "unavailable",
                threadId: request.threadId,
                turnId: request.turnId,
                code: "HANDOFF_HISTORY_UNAVAILABLE",
              },
              true,
            );
          }
        }),
      );
    if (codexTasks.observeEnabled === true && codexTasks.adopt)
      server.registerTool(
        "codex_task_adopt",
        {
          title: "Keep a read-only handle to one selected Codex turn",
          description:
            "Record the exact verified turn of the owner-selected native task for later status/result reads. This makes no provider mutation and never starts, resumes, forks or controls work. A repeated call for the same thread and turn returns the same handle; an unknown record must not be reinterpreted as another turn.",
          inputSchema: CodexTaskAdoptInputSchema,
          annotations: LOCAL_RECORD_ANNOTATIONS,
        },
        guarded(async (request) => {
          try {
            const result = parseTaskAdopt(
              await codexTasks.adopt!(request),
              request.turnId,
            );
            return taskResponse(result, result.status !== "adopted");
          } catch {
            return taskResponse(
              { status: "outcome_unknown", dispatchId: request.turnId },
              true,
            );
          }
        }),
      );
    if (codexTasks.models)
      server.registerTool(
        "codex_task_models",
        {
          title: "Read configured and runtime Codex models",
          description:
            "Compare configured aliases with model/list from the selected runtime. Display cache lasts at most 60 seconds; fresh=true refreshes it. No task or inference is started. Availability is a catalogue observation, not a quota guarantee.",
          inputSchema: z.strictObject({ fresh: z.boolean().optional() }),
          annotations: READONLY_ANNOTATIONS,
        },
        guarded(
          async ({ fresh }, context) => {
            const signal = context.mcpReq.signal;
            if (!codexReadAdmitted(signal))
              return taskResponse(
                {
                  status: "unavailable",
                  code: "HANDOFF_TASK_ADMISSION_DENIED",
                },
                true,
              );
            try {
              const parsed = TaskModelCatalogueViewSchema.safeParse(
                await codexTasks.models!(fresh ?? false, { signal }),
              );
              if (!codexReadAdmitted(signal))
                return taskResponse(
                  {
                    status: "unavailable",
                    code: "HANDOFF_TASK_ADMISSION_DENIED",
                  },
                  true,
                );
              if (!parsed.success)
                return taskResponse(
                  { status: "unavailable", code: "TASK_MODEL_CATALOG_INVALID" },
                  true,
                );
              return taskResponse(
                parsed.data,
                parsed.data.catalogue.status !== "ready",
              );
            } catch {
              return taskResponse(
                {
                  status: "unavailable",
                  code: "TASK_MODEL_CATALOG_UNAVAILABLE",
                },
                true,
              );
            }
          },
          (_input, context) =>
            codexReadAdmitted(context.mcpReq.signal)
              ? null
              : taskResponse(
                  {
                    status: "unavailable",
                    code: "HANDOFF_TASK_ADMISSION_DENIED",
                  },
                  true,
                ),
        ),
      );
    server.registerTool(
      "codex_task_create",
      {
        title: "Create one persistent Codex task",
        description:
          "Start one task in an approved saved project. Omit harness/model/effort for configured defaults; model names a configured alias. Message limit: 8,192 UTF-8 bytes without NUL. Supply one UUID key; never retry an unknown outcome with a fresh key.",
        inputSchema: CodexTaskCreateInputSchema,
        annotations: CODEX_TASK_CREATE_ANNOTATIONS,
      },
      guarded(async (request, context) => {
        try {
          const result = parseTaskCreate(
            await codexTasks.create(request, { signal: context.mcpReq.signal }),
            request.key,
          );
          const publicResult =
            result.status === "dispatched"
              ? { status: "dispatched", dispatchId: result.dispatchId }
              : result;
          return taskResponse(
            publicResult,
            result.status === "refused" || result.status === "outcome_unknown",
          );
        } catch {
          return taskResponse(
            { status: "outcome_unknown", dispatchId: request.key },
            true,
          );
        }
      }),
    );
    if (codexTasks.controlCapabilities?.title === true && codexTasks.title)
      server.registerTool(
        "codex_task_title",
        {
          title: "Update one issued Codex task name",
          description:
            "Update the exact Farol-created dispatch's name once, with expectedTitle preflight and fresh readback. This is not an atomic native compare-and-set. A recorded replay proves the historical update only, not the current title. A title_changed result made no mutation. Unknown acknowledgement/readback must never be retried with a new key. Adopted owner tasks remain read-only.",
          inputSchema: CodexTaskTitleInputSchema,
          annotations: CODEX_TASK_CREATE_ANNOTATIONS,
        },
        guarded(async (request, context) => {
          try {
            const result = parseTaskTitle(
              await codexTasks.title!(request, {
                signal: context.mcpReq.signal,
              }),
              request,
            );
            return taskResponse(
              result,
              result.status !== "renamed" && result.status !== "recorded",
            );
          } catch {
            return taskResponse(
              { status: "outcome_unknown", dispatchId: request.dispatchId },
              true,
            );
          }
        }),
      );
    if (codexTasks.controlCapabilities?.message === true)
      server.registerTool(
        "codex_task_message",
        {
          title: "Steer one active Codex task turn",
          description:
            "Send at most one message to this issued dispatch's exact active turn. Supply a new UUID key once. An outcome_unknown must never be retried with a different key.",
          inputSchema: CodexTaskMessageInputSchema,
          annotations: CODEX_TASK_CREATE_ANNOTATIONS,
        },
        guarded(async (request) => {
          try {
            const result = parseTaskMessage(
              await codexTasks.message(request),
              request.dispatchId,
            );
            return taskResponse(
              result.status === "steered"
                ? { status: "steered", dispatchId: result.dispatchId }
                : result,
              result.status === "refused" ||
                result.status === "outcome_unknown",
            );
          } catch {
            return taskResponse(
              { status: "outcome_unknown", dispatchId: request.dispatchId },
              true,
            );
          }
        }),
      );
    if (
      codexTasks.controlCapabilities?.continue === true &&
      codexTasks.continue
    )
      server.registerTool(
        "codex_task_continue",
        {
          title: "Continue the exact persistent Codex task",
          description:
            "Start one new turn in the issued thread only after its parent is verified as the latest completed turn. Supply a fresh UUID key once; never retry an unknown outcome with a different key.",
          inputSchema: CodexTaskContinueInputSchema,
          annotations: CODEX_TASK_CREATE_ANNOTATIONS,
        },
        guarded(async (request, context) => {
          try {
            const result = parseTaskCreate(
              await codexTasks.continue!(request, {
                signal: context.mcpReq.signal,
              }),
              request.key,
            );
            return taskResponse(
              result.status === "dispatched"
                ? { status: "dispatched", dispatchId: result.dispatchId }
                : result,
              result.status === "refused" ||
                result.status === "outcome_unknown",
            );
          } catch {
            return taskResponse(
              { status: "outcome_unknown", dispatchId: request.key },
              true,
            );
          }
        }),
      );
    server.registerTool(
      "codex_task_status",
      {
        title: "Read persistent Codex task status",
        description:
          "Read the issued task's current turn without starting, resuming or cloning work. threadRuntime is a separate non-atomic thread-wide snapshot: waitingOnApproval/waitingOnUserInput do not identify a pending request or grant control. Unavailable is not idle.",
        inputSchema: CodexTaskReadInputSchema,
        annotations: READONLY_ANNOTATIONS,
      },
      guarded(
        async ({ dispatchId }, context) => {
          try {
            const result = parseTaskStatus(
              await codexTasks.status(dispatchId, {
                signal: context.mcpReq.signal,
              }),
              dispatchId,
            );
            const threadRuntime =
              result.status === "known"
                ? parseThreadRuntime(result.threadRuntime)
                : null;
            if (result.status === "known" && !threadRuntime)
              return taskResponse(
                { status: "outcome_unknown", dispatchId },
                true,
              );
            const publicResult =
              result.status === "known"
                ? {
                    status: "known",
                    dispatchId,
                    turnStatus: result.turnStatus,
                    threadRuntime,
                  }
                : result;
            return taskResponse(
              publicResult,
              result.status === "outcome_unknown",
            );
          } catch {
            return taskResponse(
              { status: "outcome_unknown", dispatchId },
              true,
            );
          }
        },
        ({ dispatchId }, context) =>
          codexReadAdmitted(context.mcpReq.signal)
            ? null
            : taskResponse({ status: "outcome_unknown", dispatchId }, true),
      ),
    );
    server.registerTool(
      "codex_task_result",
      {
        title: "Read exact Codex task result",
        description:
          "Read the issued turn's exact final answer after completion; this never creates another turn. A running turn includes separate threadRuntime; thread-wide waiting flags do not identify or authorize an approval for this turn.",
        inputSchema: CodexTaskReadInputSchema,
        annotations: READONLY_ANNOTATIONS,
      },
      guarded(
        async ({ dispatchId }, context) => {
          try {
            const result = parseTaskResult(
              await codexTasks.result(dispatchId, {
                signal: context.mcpReq.signal,
              }),
              dispatchId,
            );
            const threadRuntime =
              result.status === "running"
                ? parseThreadRuntime(result.threadRuntime)
                : null;
            if (result.status === "running" && !threadRuntime)
              return taskResponse(
                { status: "outcome_unknown", dispatchId },
                true,
              );
            const publicResult =
              result.status === "completed"
                ? { status: "completed", dispatchId, text: result.text }
                : result.status === "running"
                  ? { status: result.status, dispatchId, threadRuntime }
                  : result.status === "failed" ||
                      result.status === "interrupted"
                    ? { status: result.status, dispatchId }
                    : result;
            return taskResponse(
              publicResult,
              result.status === "outcome_unknown",
            );
          } catch {
            return taskResponse(
              { status: "outcome_unknown", dispatchId },
              true,
            );
          }
        },
        ({ dispatchId }, context) =>
          codexReadAdmitted(context.mcpReq.signal)
            ? null
            : taskResponse({ status: "outcome_unknown", dispatchId }, true),
      ),
    );
  }

  if (workspaceCatalogueIds !== undefined) {
    const workspaceIds = [...workspaceCatalogueIds];
    server.registerTool(
      "computer_workspace_catalogue",
      {
        title: "Find available workspaces",
        description:
          "Find current task-accessible folder roots and exact workspace IDs before using file tools. Call without arguments; do not guess IDs from folder names or paths. Uses existing authority and physical-root checks. Does not read file contents or grant permissions.",
        inputSchema: z.strictObject({}),
        annotations: READONLY_ANNOTATIONS,
      },
      guarded(async (_arguments, context) =>
        discoverWorkspaces(workspaceIds, (workspaceId, operation) =>
          execute(
            contract,
            binding,
            String(context.mcpReq.id),
            workspaceId,
            operation,
            context.mcpReq.signal,
          ),
        ),
      ),
    );
  }
  server.registerTool(
    "computer_workspace_bootstrap",
    {
      title: "Discover approved workspace instructions",
      description:
        "Read applicable root-to-directory AGENTS.md through current workspace authority. Returns selected scope and approved physical root identity, precedence and explicit missing/unavailable instructions. Does not inspect ancestors outside the task scope or other descendants; unavailable instructions make complete false. Instructions never grant additional authority.",
      inputSchema: BootstrapInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    guarded(async ({ workspaceId, relativeDirectory }, context) =>
      bootstrapWorkspace(relativeDirectory, (operation) =>
        execute(
          contract,
          binding,
          String(context.mcpReq.id),
          workspaceId,
          operation,
          context.mcpReq.signal,
        ),
      ),
    ),
  );
  const guidance = new PublishedGuidance();
  const guidanceResult = (
    value:
      | ReturnType<PublishedGuidance["search"]>
      | ReturnType<PublishedGuidance["fetch"]>,
  ): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(value.ok ? {} : { isError: true }),
  });
  server.registerTool(
    "computer_guidance_search",
    {
      title: "Search published Computer guidance",
      description:
        "Search the sealed package guidance manifest. Returns only published IDs and references, not owner files or instructions. resultLimited reports a bounded result; an unavailable catalogue is explicit.",
      inputSchema: GuidanceSearchInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    guarded(async ({ query, limit }) =>
      guidanceResult(guidance.search(query, limit)),
    ),
  );
  server.registerTool(
    "computer_guidance_fetch",
    {
      title: "Read published Computer guidance",
      description:
        "Fetch one manifest-listed guidance ID. Arbitrary file paths and invented IDs are unavailable; this cannot grant workspace authority.",
      inputSchema: GuidanceFetchInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    guarded(async ({ id }) => guidanceResult(guidance.fetch(id))),
  );
  server.registerTool(
    "computer_workspace_list",
    {
      title: "List approved workspace files",
      description:
        "List one approved workspace directory without granting write, command, or network authority.",
      inputSchema: ListInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    guarded(async ({ workspaceId, relativePath }, context) =>
      execute(
        contract,
        binding,
        String(context.mcpReq.id),
        workspaceId,
        {
          kind: "workspace.list",
          relativePath,
        },
        context.mcpReq.signal,
      ),
    ),
  );
  server.registerTool(
    "computer_workspace_read",
    {
      title: "Read an approved workspace file",
      description:
        "Read one approved workspace file without granting write, command, or network authority. A full read returns text, bytes, and sha256 over all original raw bytes (including BOM and line endings); use sha256 as the expectedSha256 precondition for a guarded edit. Windows return required page metadata and never a whole-file sha256. A file over 256 KiB is refused as WORKSPACE_FILE_TOO_LARGE when read whole; read it in windows instead by passing offset (a byte offset, starting at 0) and optionally length (bytes, default 65536, at most 262144). A windowed result carries page.nextOffset: pass it as the next offset, and stop when it is null.",
      inputSchema: ReadInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    guarded(async ({ workspaceId, relativePath, offset, length }, context) =>
      execute(
        contract,
        binding,
        String(context.mcpReq.id),
        workspaceId,
        {
          kind: "workspace.read",
          relativePath,
          ...(offset === undefined && length === undefined
            ? {}
            : {
                range: {
                  offset: offset ?? 0,
                  length: length ?? DEFAULT_READ_WINDOW_BYTES,
                },
              }),
        },
        context.mcpReq.signal,
        devMcpProof,
      ),
    ),
  );
  server.registerTool(
    "computer_workspace_search",
    {
      title: "Search approved workspace text",
      description:
        "Search plain text in one approved workspace subtree without granting write, command, or network authority.",
      inputSchema: SearchInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    guarded(async ({ workspaceId, relativePath, pattern }, context) =>
      execute(
        contract,
        binding,
        String(context.mcpReq.id),
        workspaceId,
        {
          kind: "workspace.search",
          relativePath,
          pattern,
        },
        context.mcpReq.signal,
      ),
    ),
  );
  server.registerTool(
    "computer_workspace_git_status",
    {
      title: "Inspect approved workspace Git status",
      description:
        "Run the fixed no-network Git status verifier at one approved workspace root. Git never reads the workspace folder itself: it runs over a private point-in-time clone of the repository metadata and of the tracked files, taken at one instant, so the result describes the workspace as it was at that instant: any change to a tracked file while the clone is being taken refuses the command (WORKSPACE_CHANGED_DURING_SNAPSHOT) rather than reporting a mixture of two instants. Coverage is tracked files only: untracked files are not examined and submodules are ignored, so a short status is not proof of a clean workspace; a tracked file that is missing from the working tree is reported as deleted. Paths under the workspace's excluded prefixes are absent from both the clone and the output. Output is rendered as plain `XY path` lines under a `## branch` header, without quoting. The result names this coverage and whether the root is a linked worktree. No executable, arguments, path, environment, or network access can be supplied by the caller.",
      inputSchema: VerificationInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    guarded(async ({ workspaceId }, context) =>
      execute(
        contract,
        binding,
        String(context.mcpReq.id),
        workspaceId,
        {
          kind: "verification.run",
          command: "git.status",
          relativePath: ".",
        },
        context.mcpReq.signal,
      ),
    ),
  );
  server.registerTool(
    "computer_workspace_git_head",
    {
      title: "Read approved workspace Git HEAD",
      description:
        "Read the exact Git HEAD commit at one approved workspace root through a fixed no-network verifier. Git never reads the workspace folder itself: it runs over a private point-in-time clone of the repository metadata taken at one instant. A repository without commits is reported as WORKSPACE_GIT_HEAD_UNBORN and a root without Git as WORKSPACE_NOT_GIT_REPOSITORY. No executable, arguments, path, environment, or network access can be supplied by the caller.",
      inputSchema: VerificationInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    guarded(async ({ workspaceId }, context) =>
      execute(
        contract,
        binding,
        String(context.mcpReq.id),
        workspaceId,
        {
          kind: "verification.run",
          command: "git.head",
          relativePath: ".",
        },
        context.mcpReq.signal,
      ),
    ),
  );

  if (connectorVerification) {
    server.registerTool(
      "farol_next_connector_verify",
      {
        title: "Verify the Farol Next Computer connector",
        description:
          "Consume one owner-visible challenge, list one approved workspace root through the current Computer TaskGrant, and retain only a content-free correlation receipt.",
        inputSchema: ConnectorVerificationInputSchema,
        annotations: VERIFICATION_ANNOTATIONS,
      },
      guarded(async ({ challenge, workspaceId }, context) =>
        executeConnectorVerification(
          contract,
          binding,
          connectorVerification,
          String(context.mcpReq.id),
          challenge,
          workspaceId,
          context.mcpReq.signal,
        ),
      ),
    );
  }

  if (callerRelay) {
    server.registerTool(
      "farol_next_caller_tools",
      {
        title: "Use the active Codex task's native tools",
        description:
          "Describe or invoke only the exact native host tools bound to one opaque Farol Next turn ticket. The relay validates the current host schema, turn binding, stable operation ID, and at-most-once delivery before the host can execute anything.",
        inputSchema: CodexCallerRelayOperationSchema,
        annotations: CALLER_RELAY_ANNOTATIONS,
      },
      guarded(async (operation) => executeCallerRelay(callerRelay, operation)),
    );
  }

  if (mutableContract) {
    server.registerTool(
      "computer_workspace_write",
      {
        title: "Write an approved workspace file",
        description:
          "Create or atomically replace one file under explicit write authority. Requires a stable operation ID and an exact source digest; an uncertain result must not be retried with a new ID.",
        inputSchema: WriteInputSchema,
        annotations: MUTATION_ANNOTATIONS,
      },
      guarded(
        async (
          { operationId, workspaceId, relativePath, content, expectedSha256 },
          context,
        ) =>
          executeMutation(
            mutableContract,
            binding,
            String(context.mcpReq.id),
            operationId,
            workspaceId,
            {
              kind: "workspace.write",
              relativePath,
              content,
              expectedSha256,
            },
            context.mcpReq.signal,
          ),
      ),
    );
    server.registerTool(
      "computer_workspace_edit",
      {
        title: "Edit an approved workspace file",
        description:
          "Apply unique bounded text replacements under explicit write authority. Requires a stable operation ID and exact source digest; an uncertain result must not be retried with a new ID.",
        inputSchema: EditInputSchema,
        annotations: MUTATION_ANNOTATIONS,
      },
      guarded(
        async (
          { operationId, workspaceId, relativePath, edits, expectedSha256 },
          context,
        ) =>
          executeMutation(
            mutableContract,
            binding,
            String(context.mcpReq.id),
            operationId,
            workspaceId,
            {
              kind: "workspace.edit",
              relativePath,
              edits,
              expectedSha256,
            },
            context.mcpReq.signal,
          ),
      ),
    );
  }

  if (shell) {
    server.registerTool(
      "computer_shell_start",
      {
        title: "Start a sandboxed workspace command",
        description:
          "Run an ordinary command inside approved workspaces under the native OS sandbox. Use a stable operationId; an unknown start outcome must not be repeated with a new ID. write=false grants read-only workspace access.",
        inputSchema: ShellStartInputSchema,
        annotations: MUTATION_ANNOTATIONS,
      },
      tracked(async (input, context) => {
        if (lifecycle && (await lifecycle.isStopping().catch(() => true)))
          return fenced("COMPUTER_MCP_STOPPING");
        let admission;
        try {
          admission = await fence?.acquireAdmission();
        } catch {
          return fenced("COMPUTER_EXECUTION_FENCE_UNREADABLE");
        }
        if (admission && !admission.admitted) return fenced(admission.code);
        let transferred = false;
        let reservedShell = false;
        try {
          if (lifecycle && (await lifecycle.isStopping().catch(() => true)))
            return fenced("COMPUTER_MCP_STOPPING");
          const result = await shell.start(
            {
              ...input,
              ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
            },
            context.mcpReq.signal,
            async () => {
              if (lifecycle && (await lifecycle.isStopping().catch(() => true)))
                return false;
              if (!fence) return true;
              try {
                return (await fence.admits()).admitted;
              } catch {
                return false;
              }
            },
            admission?.admitted ? admission.fd : undefined,
            fence
              ? async () => {
                  await fence.reserveShell(input.operationId);
                  reservedShell = true;
                }
              : undefined,
          );
          // A refusal returned by start() is known to precede spawn. Clear
          // its durable fence marker while still holding admission; a thrown
          // or unknown outcome must retain both marker and lease instead.
          if (!result.ok && reservedShell && fence) {
            await fence.clearShell(input.operationId);
            reservedShell = false;
          }
          if (
            result.ok &&
            result.value.state === "running" &&
            admission?.admitted &&
            !leasedShellHandles.has(result.value.handle)
          ) {
            const lease = admission;
            leasedShellHandles.add(result.value.handle);
            transferred = true;
            const terminalCleanup = shell
              .waitForTerminal(result.value.handle)
              .then(async (cleanup) => {
                if (cleanup !== "confirmed") {
                  fence?.quarantineShell(input.operationId);
                  unverifiedShellLeases.add(lease);
                  throw new Error("SHELL_GROUP_CLEANUP_UNVERIFIED");
                }
                if (fence) await fence.clearShell(input.operationId);
                await lease.release();
                leasedShellHandles.delete(result.value.handle);
              })
              .catch((error: unknown) => {
                fence?.quarantineShell(input.operationId);
                unverifiedShellLeases.add(lease);
                throw error;
              });
            shell.trackTerminalCleanup(terminalCleanup);
          }
          return shellResult(result);
        } finally {
          if (reservedShell && !transferred && admission?.admitted) {
            fence?.quarantineShell(input.operationId);
            unverifiedShellLeases.add(admission);
            transferred = true;
          }
          if (!transferred && admission?.admitted) await admission.release();
        }
      }),
    );
    server.registerTool(
      "computer_shell_read",
      {
        title: "Read a workspace command result",
        description:
          "Read bounded stdout/stderr and the root command's actual exit code or signal. groupCleanup confirms only the owned process group; detachedCleanup remains unverified.",
        inputSchema: ShellReadInputSchema,
        annotations: READONLY_ANNOTATIONS,
      },
      guarded(async (input) => shellResult(await shell.readAdmitted(input))),
    );
    server.registerTool(
      "computer_shell_cancel",
      {
        title: "Cancel an owned workspace command",
        description:
          "Request TERM then KILL for the supplied command's process group. Read the handle for actual exit and group-cleanup status; detached descendants are not covered.",
        inputSchema: ShellCancelInputSchema,
        annotations: MUTATION_ANNOTATIONS,
      },
      tracked(async ({ handle }) => shellResult(shell.cancel(handle))),
    );
  }

  return server;
}
