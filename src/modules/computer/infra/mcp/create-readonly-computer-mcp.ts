import {
  parseClaudeCreate,
  parseClaudeStatus,
  type ClaudeTaskRoutePeer,
} from "../peer/claude-task-route-peer";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TaskModelCatalogueViewSchema } from "../../../../pkg/owner-config/contract";

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
import type { SandboxedWorkspaceShell } from "../native/sandboxed-workspace-shell";
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
import {
  CALLER_RELAY_ANNOTATIONS,
  CODEX_TASK_CREATE_ANNOTATIONS,
  LOCAL_RECORD_ANNOTATIONS,
  MUTATION_ANNOTATIONS,
  READONLY_ANNOTATIONS,
  VERIFICATION_ANNOTATIONS,
} from "./annotations";
import { correlationMatches, mutationCorrelationMatches } from "./correlation";
import {
  BootstrapInputSchema,
  ConnectorVerificationInputSchema,
  EditInputSchema,
  GuidanceFetchInputSchema,
  GuidanceSearchInputSchema,
  IdentifierSchema,
  ListInputSchema,
  ReadInputSchema,
  SearchInputSchema,
  ShellCancelInputSchema,
  ShellReadInputSchema,
  ShellStartInputSchema,
  VerificationInputSchema,
  WriteInputSchema,
} from "./fileinput";
import { failure, fenced, shellResult } from "./results";
import { guidanceResult, refusalResult, taskResponse } from "./envelope";
import {
  admissionRefused,
  admissionUnavailable,
  catalogueUnavailable,
  historyUnavailable,
  lookupUnavailable,
  observeUnknown,
  preferenceUnavailable,
  resolveRefused,
  tasksUnavailable,
} from "./fallbacks";
import {
  gitOperation,
  listOperation,
  readOperation,
  searchOperation,
} from "./operations";
import { mutationReceiptMatches, readonlyOutputMatches } from "./outputmatch";
import {
  connectorReceiptValue,
  connectorRecordFailureCode,
} from "./connectorvalue";
import { RELAY_UNAVAILABLE, relayResult } from "./relayresult";
import {
  workspaceVerificationRefusal,
  workspaceVerificationRequest,
} from "./workspacecheck";
import {
  isRefusedOrUnknown,
  publicDispatch,
  publicResult,
  publicStatus,
  publicSteer,
  safeChatCreate,
  unknownOutcome,
} from "./projections";
import {
  CodexProjectPreferenceInputSchema,
  CodexProjectResolveInputSchema,
  CodexProjectTasksInputSchema,
  CodexTaskAdoptInputSchema,
  CodexTaskContinueInputSchema,
  CodexTaskCreateInputSchema,
  CodexTaskHistoryInputSchema,
  CodexTaskMessageInputSchema,
  CodexTaskObserveInputSchema,
  CodexTaskReadInputSchema,
  CodexTaskTitleInputSchema,
  SavedChatCreateInputSchema,
  SavedChatStatusInputSchema,
} from "./taskinput";
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
    return refusalResult(parsed.data);
  }
  const value = parsed.data.value;
  if (
    !correlationMatches(request, value) ||
    !readonlyOutputMatches(request.operation, value.output)
  ) {
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
    return refusalResult(parsed.data);
  }
  const value = parsed.data.value;
  if (
    !mutationCorrelationMatches(request, value) ||
    !mutationReceiptMatches(operation, value.receipt)
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
    const value = connectorReceiptValue({
      recorded,
      binding,
      workspaceId,
      entryCount: output.entries.length,
      truncated: output.truncated,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    };
  } catch (error) {
    return failure(connectorRecordFailureCode(error));
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
    response = RELAY_UNAVAILABLE;
  }
  return relayResult(response);
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
    name: "farol-computer",
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
    const result = taskResponse;
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
          const safe = safeChatCreate(response, request.key);
          return result(safe, safe.status !== "verified");
        } catch {
          return result(unknownOutcome(request.key), true);
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
            return result(unknownOutcome(dispatchId), true);
          return result(response, response.status === "outcome_unknown");
        } catch {
          return result(unknownOutcome(dispatchId), true);
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
            return taskResponse(lookupUnavailable(request), true);
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
            return taskResponse(preferenceUnavailable(request), true);
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
            return taskResponse(tasksUnavailable(request), true);
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
            return taskResponse(resolveRefused(request.workspaceId), true);
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
                return taskResponse(observeUnknown(request.threadId), true);
              return taskResponse({ ...result, threadRuntime }, false);
            } catch {
              return taskResponse(observeUnknown(request.threadId), true);
            }
          },
          (_request, context) =>
            codexReadAdmitted(context.mcpReq.signal)
              ? null
              : taskResponse(admissionRefused(), true),
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
            return taskResponse(historyUnavailable(request), true);
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
            return taskResponse(unknownOutcome(request.turnId), true);
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
              return taskResponse(admissionUnavailable(), true);
            try {
              const parsed = TaskModelCatalogueViewSchema.safeParse(
                await codexTasks.models!(fresh ?? false, { signal }),
              );
              if (!codexReadAdmitted(signal))
                return taskResponse(admissionUnavailable(), true);
              if (!parsed.success)
                return taskResponse(
                  catalogueUnavailable("TASK_MODEL_CATALOG_INVALID"),
                  true,
                );
              return taskResponse(
                parsed.data,
                parsed.data.catalogue.status !== "ready",
              );
            } catch {
              return taskResponse(
                catalogueUnavailable("TASK_MODEL_CATALOG_UNAVAILABLE"),
                true,
              );
            }
          },
          (_input, context) =>
            codexReadAdmitted(context.mcpReq.signal)
              ? null
              : taskResponse(admissionUnavailable(), true),
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
          return taskResponse(
            publicDispatch(result),
            isRefusedOrUnknown(result.status),
          );
        } catch {
          return taskResponse(unknownOutcome(request.key), true);
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
            return taskResponse(unknownOutcome(request.dispatchId), true);
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
              publicSteer(result),
              isRefusedOrUnknown(result.status),
            );
          } catch {
            return taskResponse(unknownOutcome(request.dispatchId), true);
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
              publicDispatch(result),
              isRefusedOrUnknown(result.status),
            );
          } catch {
            return taskResponse(unknownOutcome(request.key), true);
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
              return taskResponse(unknownOutcome(dispatchId), true);
            return taskResponse(
              publicStatus(result, dispatchId, threadRuntime),
              result.status === "outcome_unknown",
            );
          } catch {
            return taskResponse(unknownOutcome(dispatchId), true);
          }
        },
        ({ dispatchId }, context) =>
          codexReadAdmitted(context.mcpReq.signal)
            ? null
            : taskResponse(unknownOutcome(dispatchId), true),
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
              return taskResponse(unknownOutcome(dispatchId), true);
            return taskResponse(
              publicResult(result, dispatchId, threadRuntime),
              result.status === "outcome_unknown",
            );
          } catch {
            return taskResponse(unknownOutcome(dispatchId), true);
          }
        },
        ({ dispatchId }, context) =>
          codexReadAdmitted(context.mcpReq.signal)
            ? null
            : taskResponse(unknownOutcome(dispatchId), true),
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
        discoverWorkspaces(
          workspaceIds,
          (workspaceId, operation) =>
            execute(
              contract,
              binding,
              String(context.mcpReq.id),
              workspaceId,
              operation,
              context.mcpReq.signal,
            ),
          async (entries) => {
            if (!contract.verifyWorkspaces)
              return failure("COMPUTER_CONTRACT_UNAVAILABLE");
            let verified;
            try {
              verified = await contract.verifyWorkspaces(
                workspaceVerificationRequest(
                  binding,
                  String(context.mcpReq.id),
                  entries,
                ),
                context.mcpReq.signal ? { signal: context.mcpReq.signal } : {},
              );
            } catch {
              return failure("COMPUTER_CONTRACT_UNAVAILABLE");
            }
            if (verified.ok) return null;
            return workspaceVerificationRefusal(verified);
          },
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
        listOperation(relativePath),
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
        readOperation(relativePath, offset, length),
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
        searchOperation(relativePath, pattern),
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
        gitOperation("git.status"),
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
        gitOperation("git.head"),
        context.mcpReq.signal,
      ),
    ),
  );

  if (connectorVerification) {
    server.registerTool(
      "farol_connector_verify",
      {
        title: "Verify the Farol Computer connector",
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
      "farol_host_tools",
      {
        title: "Use the active Codex task's native tools",
        description:
          "Describe or invoke only the exact native host tools bound to one opaque Farol turn ticket. The relay validates the current host schema, turn binding, stable operation ID, and at-most-once delivery before the host can execute anything.",
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
