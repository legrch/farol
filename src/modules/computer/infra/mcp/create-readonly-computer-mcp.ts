import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

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
import type { CodexTaskRoutePeer } from "../peer/codex-task-route-peer";

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
const CodexTaskCreateInputSchema = z.strictObject({
  key: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  message: z.string().min(1).max(8_192),
  model: z.string().min(1).max(120),
  reasoningEffort: z.string().min(1).max(40),
});
const CodexTaskReadInputSchema = z.strictObject({
  dispatchId: DispatchIdSchema,
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
): McpServer {
  const server = new McpServer({
    name: "farol-next-computer",
    version: "0.1.0-preview.0",
  });
  // Every tool consults the fence before its contract; an unreadable fence
  // refuses like a raised one.
  const guarded =
    <Arguments extends unknown[]>(
      run: (...arguments_: Arguments) => Promise<CallToolResult>,
    ) =>
    async (...arguments_: Arguments): Promise<CallToolResult> => {
      if (fence) {
        let admission;
        try {
          admission = await fence.admits();
        } catch {
          return fenced("COMPUTER_EXECUTION_FENCE_UNREADABLE");
        }
        if (!admission.admitted) return fenced(admission.code);
      }
      return run(...arguments_);
    };

  if (codexTasks) {
    const taskResponse = (value: object, isError = false): CallToolResult => ({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      ...(isError ? { isError: true } : {}),
    });
    server.registerTool(
      "codex_task_create",
      {
        title: "Create one persistent Codex task",
        description:
          "Start one task in an explicitly approved existing saved project. Supply a new UUID key once; an outcome_unknown result must never trigger a new key or blind retry.",
        inputSchema: CodexTaskCreateInputSchema,
        annotations: CODEX_TASK_CREATE_ANNOTATIONS,
      },
      guarded(async (request) => {
        try {
          const result = await codexTasks.create(request);
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
    server.registerTool(
      "codex_task_status",
      {
        title: "Read persistent Codex task status",
        description:
          "Read the issued task's current turn without starting, resuming or cloning work.",
        inputSchema: CodexTaskReadInputSchema,
        annotations: READONLY_ANNOTATIONS,
      },
      guarded(async ({ dispatchId }) => {
        try {
          const result = await codexTasks.status(dispatchId);
          const publicResult =
            result.status === "known"
              ? {
                  status: "known",
                  dispatchId,
                  turnStatus: result.turnStatus,
                }
              : result;
          return taskResponse(
            publicResult,
            result.status === "outcome_unknown",
          );
        } catch {
          return taskResponse({ status: "outcome_unknown", dispatchId }, true);
        }
      }),
    );
    server.registerTool(
      "codex_task_result",
      {
        title: "Read exact Codex task result",
        description:
          "Read the issued turn's exact final answer after completion; this never creates another turn.",
        inputSchema: CodexTaskReadInputSchema,
        annotations: READONLY_ANNOTATIONS,
      },
      guarded(async ({ dispatchId }) => {
        try {
          const result = await codexTasks.result(dispatchId);
          const publicResult =
            result.status === "completed"
              ? { status: "completed", dispatchId, text: result.text }
              : result.status === "running" ||
                  result.status === "failed" ||
                  result.status === "interrupted"
                ? { status: result.status, dispatchId }
                : result;
          return taskResponse(
            publicResult,
            result.status === "outcome_unknown",
          );
        } catch {
          return taskResponse({ status: "outcome_unknown", dispatchId }, true);
        }
      }),
    );
  }

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
        "Read one approved workspace file without granting write, command, or network authority. A file over 256 KiB is refused as WORKSPACE_FILE_TOO_LARGE when read whole; read it in windows instead by passing offset (a byte offset, starting at 0) and optionally length (bytes, default 65536, at most 262144). A windowed result carries page.nextOffset: pass it as the next offset, and stop when it is null.",
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
      guarded(async (input) =>
        shellResult(
          await shell.start({
            ...input,
            ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          }),
        ),
      ),
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
      guarded(async (input) => shellResult(shell.read(input))),
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
      guarded(async ({ handle }) => shellResult(shell.cancel(handle))),
    );
  }

  return server;
}
