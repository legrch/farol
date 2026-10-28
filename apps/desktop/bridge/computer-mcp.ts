import type {
  OperationMetadata,
  OperationsRecorder,
} from "../renderer/operations-contract";
import { observedOperationResult } from "../operations/observe";
import { randomUUID } from "node:crypto";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BridgeError } from "./client.ts";
import { ComputerBridge, type ComputerCall } from "./computer.ts";
import { observeConnectionStatus } from "./connection-status.ts";
import type { ConnectorMutationBridge } from "./connector-mutation.ts";
import type { ConnectorProcessBridge } from "./connector-process.ts";
import type { ConnectorVerificationBridge } from "./connector-verification.ts";
import type { SelectedCodexReadBridge } from "./selected-codex-read.ts";
import {
  validate,
  validUnicode,
  type Context,
  type ComputerConnectorExecution,
} from "./wire.ts";

export type GoComputerMcpLifecycle = Readonly<{
  isStopping(): Promise<boolean>;
  enterHandler(): (() => void) | null;
}>;
export type GoComputerMcpFence = Readonly<{
  acquireAdmission(): Promise<
    | Readonly<{ admitted: false; code: string }>
    | Readonly<{ admitted: true; release(): Promise<void> }>
  >;
}>;
export type GoComputerMcpOptions = Readonly<{
  operations?: OperationsRecorder;
  executionOrigin?: Readonly<{ buildId: string; runtimeId: string }>;
  fence: GoComputerMcpFence;
  lifecycle?: GoComputerMcpLifecycle;
  verification?: Pick<
    ConnectorVerificationBridge,
    "verify" | "verifyCatalogue"
  >;
  connectionStatus?: Pick<ConnectorVerificationBridge, "observe">;
  mutations?: Pick<ConnectorMutationBridge, "write" | "edit" | "read">;
  processes?: Pick<ConnectorProcessBridge, "start" | "read" | "cancel">;
  codexRead?: Pick<SelectedCodexReadBridge, "read">;
  onEffectUnknown?: () => void;
}>;

const IdentifierSchema = z.string().min(1).max(120);
function relativePath(value: string, root: boolean): boolean {
  if (root && value === ".") return true;
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  )
    return false;
  return value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}
const ScopePathSchema = z.string().refine((value) => relativePath(value, true));
const ListInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopePathSchema,
});
const SearchInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopePathSchema,
  pattern: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        validUnicode(value) &&
        Buffer.byteLength(value, "utf8") <= 4096 &&
        !/[\u0000-\u001f\u007f]/u.test(value),
    ),
});
const BootstrapInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativeDirectory: ScopePathSchema,
});
const ReadInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: z.string().refine((value) => relativePath(value, false)),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  length: z.number().int().min(4).max(262144).optional(),
});
const MutationTextSchema = z
  .string()
  .refine(
    (value) =>
      validUnicode(value) &&
      !value.includes("\0") &&
      Buffer.byteLength(value, "utf8") <= 262144,
  );
const MutationTargetSchema = {
  operationId: z.string().refine((value) => validate("id", value)),
  workspaceId: IdentifierSchema,
  relativePath: z.string().refine((value) => relativePath(value, false)),
};
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ProcessIDSchema = z.string().refine((value) => validate("id", value));
const ProcessTargetSchema = {
  operationId: ProcessIDSchema,
  handle: ProcessIDSchema,
};
const ProcessOffsetSchema = z
  .number()
  .int()
  .min(0)
  .max(4 * 1024 * 1024);
const ProcessStartSchema = z.strictObject({
  operationId: ProcessIDSchema,
  workspaceId: IdentifierSchema,
  relativeCwd: ScopePathSchema,
  command: z
    .string()
    .min(1)
    .refine(
      (value) =>
        validUnicode(value) &&
        !value.includes("\0") &&
        Buffer.byteLength(value, "utf8") <= 65536,
    ),
  stdin: z
    .string()
    .refine(
      (value) =>
        validUnicode(value) && Buffer.byteLength(value, "utf8") <= 262144,
    )
    .optional(),
  write: z.boolean(),
});
const WriteInputSchema = z.strictObject({
  ...MutationTargetSchema,
  content: MutationTextSchema,
  expectedSha256: HashSchema.nullable(),
});
const EditInputSchema = z.strictObject({
  ...MutationTargetSchema,
  expectedSha256: HashSchema,
  edits: z
    .array(
      z
        .strictObject({
          oldText: MutationTextSchema,
          newText: MutationTextSchema,
        })
        .refine((edit) => edit.oldText !== "" && edit.oldText !== edit.newText),
    )
    .min(1)
    .max(256)
    .refine(
      (edits) =>
        edits.reduce(
          (bytes, edit) =>
            bytes +
            Buffer.byteLength(edit.oldText, "utf8") +
            Buffer.byteLength(edit.newText, "utf8"),
          0,
        ) <= 262144,
    ),
});
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// These trusted DTOs contain only strings. Copy data properties without invoking
// accessors, then validate the exact wire shape; no authority is selected here.
function trustedSnapshot<T>(name: string, value: T): T {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw Error("invalid_binding");
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw Error("invalid_binding");
    const copy: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string"
      )
        throw Error("invalid_binding");
      copy[key] = descriptor.value;
    }
    if (!validate(name, copy)) throw Error("invalid_binding");
    return Object.freeze(copy) as T;
  } catch {
    throw new BridgeError("refused", "invalid_computer_mcp_binding");
  }
}

function encode(value: object, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { ...value },
    ...(isError ? { isError: true } : {}),
  };
}

// The host supplies an already authorized execution and exact backend context.
// ComputerBridge retains wire validation; Go owns policy and all operations.
function operationTarget(input: {
  workspaceId?: string;
  relativePath?: string;
  relativeDirectory?: string;
  relativeCwd?: string;
  command?: string;
}): OperationMetadata["target"] {
  const command = input.command?.trim().split(/\s/u)[0];
  return {
    ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
    ...((input.relativePath ?? input.relativeDirectory ?? input.relativeCwd)
      ? {
          relativePath:
            input.relativePath ?? input.relativeDirectory ?? input.relativeCwd,
        }
      : {}),
    ...(command && /^[A-Za-z0-9._-]{1,80}$/u.test(command) ? { command } : {}),
  };
}
export function createGoComputerMcpServer(
  bridge: ComputerBridge,
  binding: ComputerConnectorExecution,
  context: Context,
  options: GoComputerMcpOptions,
): McpServer {
  const execution = trustedSnapshot("ComputerConnectorExecution", binding);
  const selectedContext = trustedSnapshot("Context", context);
  const fence = options?.fence;
  const lifecycle = options?.lifecycle;
  if (typeof fence?.acquireAdmission !== "function")
    throw new BridgeError("refused", "invalid_computer_mcp_fence");
  const server = new McpServer({
    name: "farol-computer",
    version: "0.1.0-preview.0",
  });
  const stopping = async (): Promise<boolean> => {
    try {
      return lifecycle ? (await lifecycle.isStopping()) !== false : false;
    } catch {
      return true;
    }
  };
  const run = async (
    metadata: OperationMetadata,
    signal: AbortSignal,
    operation: (call: ComputerCall) => Promise<{ readonly status: string }>,
    operationId?: string,
    cancelOperationId?: string,
    effect = false,
  ): Promise<CallToolResult> => {
    const started = performance.now();
    const origin = options.executionOrigin;
    const reference = (id: string) =>
      origin && {
        owner: "computer.process" as const,
        operationId: id,
        buildId: origin.buildId,
        runtimeId: origin.runtimeId,
        binding: "requested" as const,
      };
    const processOperation =
      metadata.kind === "computer_shell_start" ||
      metadata.kind === "computer_shell_read" ||
      metadata.kind === "computer_shell_cancel";
    const references =
      origin && processOperation && operationId
        ? {
            operationRef:
              metadata.kind === "computer_shell_start"
                ? reference(operationId)!
                : cancelOperationId
                  ? reference(cancelOperationId)!
                  : null,
            subjectRef:
              metadata.kind === "computer_shell_start"
                ? null
                : reference(operationId)!,
          }
        : undefined;
    const finish =
      (references &&
        options.operations?.beginExecution?.(metadata, references)) ??
      options.operations?.begin?.(metadata) ??
      ((
        outcome: "done" | "refused" | "failed" | "unknown" | "pending",
        code: string | null,
        durationMs: number,
      ) => options.operations?.record(metadata, outcome, code, durationMs));
    const call = Object.freeze({
      requestId: randomUUID(),
      context: selectedContext,
    });
    const failure = (status: "refused" | "unknown", code: string) =>
      encode(
        {
          ...call,
          ...(operationId === undefined ? {} : { operationId }),
          ...(cancelOperationId === undefined ? {} : { cancelOperationId }),
          status,
          code,
          retry: "never",
        },
        true,
      );
    if (signal.aborted) {
      finish(
        "refused",
        "computer_mcp_aborted_before_dispatch",
        performance.now() - started,
      );
      return failure("refused", "computer_mcp_aborted_before_dispatch");
    }
    let release: (() => void) | null | undefined;
    let releaseAdmission: (() => Promise<void>) | undefined;
    let dispatched = false;
    let result: CallToolResult;
    try {
      release = lifecycle?.enterHandler();
      if ((lifecycle && !release) || (await stopping())) {
        result = failure("refused", "COMPUTER_MCP_STOPPING");
      } else {
        let admission: Awaited<
          ReturnType<GoComputerMcpFence["acquireAdmission"]>
        >;
        try {
          admission = await fence.acquireAdmission();
          if (
            !admission ||
            (admission.admitted !== false && admission.admitted !== true) ||
            (admission.admitted === false &&
              !validate("text", admission.code)) ||
            (admission.admitted === true &&
              typeof admission.release !== "function")
          )
            throw Error("invalid_fence_admission");
        } catch {
          throw new BridgeError(
            "refused",
            "COMPUTER_EXECUTION_FENCE_UNREADABLE",
          );
        }
        if (!admission.admitted) {
          result = failure("refused", admission.code);
        } else {
          releaseAdmission = () => admission.release();
          if (await stopping()) {
            result = failure("refused", "COMPUTER_MCP_STOPPING");
          } else if (signal.aborted) {
            result = failure("refused", "computer_mcp_aborted_before_dispatch");
          } else {
            dispatched = true;
            const response = await operation(call);
            result = encode(response, response.status !== "ok");
          }
        }
      }
    } catch (error) {
      // Bridge-returned classified outcomes remain intact. An unexpected throw
      // after dispatch has no proven outcome and must not be retried.
      result =
        error instanceof BridgeError && validate("text", error.code)
          ? encode(
              {
                ...call,
                ...(operationId === undefined ? {} : { operationId }),
                ...(cancelOperationId === undefined
                  ? {}
                  : { cancelOperationId }),
                status: error.state,
                code: error.code,
                retry: "never",
              },
              true,
            )
          : failure(
              dispatched ? "unknown" : "refused",
              "computer_mcp_handler_failed",
            );
    } finally {
      try {
        await releaseAdmission?.();
      } catch {
        result = failure(
          dispatched ? "unknown" : "refused",
          "COMPUTER_EXECUTION_FENCE_RELEASE_FAILED",
        );
      }
      // The original handler remains active through final outcome classification.
      // A returned wire reply can still become UNKNOWN at this adapter boundary.
      const finalStopping = await stopping();
      if (signal.aborted || finalStopping)
        result = failure(
          dispatched ? "unknown" : "refused",
          signal.aborted
            ? dispatched
              ? "computer_mcp_aborted_after_dispatch"
              : "computer_mcp_aborted_before_dispatch"
            : "COMPUTER_MCP_STOPPING",
        );
      const retainUnknown = () => {
        const content = result.structuredContent;
        if (
          effect &&
          dispatched &&
          content !== null &&
          typeof content === "object" &&
          "status" in content &&
          content.status === "unknown"
        )
          options.onEffectUnknown?.();
      };
      retainUnknown();
      try {
        release?.();
      } catch {
        result = failure(
          dispatched ? "unknown" : "refused",
          "COMPUTER_MCP_STOPPING",
        );
        retainUnknown();
      }
    }
    const recorded = observedOperationResult(
      metadata.kind,
      result.structuredContent,
    );
    finish(recorded.outcome, recorded.code, performance.now() - started);
    return result;
  };
  const identity = (call: ComputerCall) => ({
    ...execution,
    callId: call.requestId,
  });

  if (options.connectionStatus) {
    const observation = Object.freeze({
      observe: options.connectionStatus.observe.bind(options.connectionStatus),
    });
    const exposure = Object.freeze({
      workspaceMutations: Boolean(options.mutations),
      processes: Boolean(options.processes),
    });
    server.registerTool(
      "computer_connection_status",
      {
        title: "Check the current Farol connection",
        description:
          "Use for a general Farol test or connection check. No challenge is needed. Observes current Go authorization and its retained attachment proof, without another verification List, workspace file read, command or credential change. Registered tools are not proof that their operations were tested. A refusal must not be treated as a healthy connection.",
        inputSchema: z.strictObject({}),
        annotations,
      },
      async (_input, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "computer_connection_status",
            target: operationTarget({}), // Connection-wide status has no workspace, path or command.
          },
          ctx.mcpReq.signal,
          async (call) => ({
            status: "ok",
            requestId: call.requestId,
            context: call.context,
            data: await observeConnectionStatus(observation, exposure),
          }),
        ),
    );
  }
  if (options.verification) {
    const verification = options.verification;
    server.registerTool(
      "farol_connector_verify_catalogue",
      {
        title: "Verify Farol without workspace access",
        description:
          "Setup verification only when no workspace is configured. Use the exact current owner-visible challenge. Go checks an explicitly empty catalogue without file or command access. A completed attempt returns its original receipt. Never invent a challenge, use as a fallback, or resend after refusal or UNKNOWN. For a general connection test use computer_connection_status.",
        inputSchema: z.strictObject({
          challenge: z.string().regex(/^[!-~]{1,160}$/u),
        }),
        annotations,
      },
      async ({ challenge }, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "farol_connector_verify_catalogue",
            target: operationTarget({}), // Empty-catalogue verification has no workspace, path or command.
          },
          ctx.mcpReq.signal,
          async (call) => ({
            status: "ok",
            requestId: call.requestId,
            context: call.context,
            data: await verification.verifyCatalogue(challenge, call.requestId),
          }),
        ),
    );
    server.registerTool(
      "farol_connector_verify",
      {
        title: "Verify the current Go Computer connector",
        description:
          "Setup verification only: use the current owner-visible request with its exact challenge and workspace ID. Never invent a challenge or reuse one from a different connection. For a general test, use computer_connection_status if listed, otherwise catalogue; do not guess verification inputs. A matching completed verification returns its original receipt without another List. After refusal or UNKNOWN, do not resend. This grants no authority and proves no write, Shell or provider task.",
        inputSchema: z.strictObject({
          challenge: z.string().regex(/^[!-~]{1,160}$/u),
          workspaceId: IdentifierSchema,
        }),
        annotations,
      },
      async ({ challenge, workspaceId }, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "farol_connector_verify",
            target: operationTarget({ workspaceId }),
          },
          ctx.mcpReq.signal,
          async (call) => ({
            status: "ok",
            requestId: call.requestId,
            context: call.context,
            data: await verification.verify(
              challenge,
              workspaceId,
              call.requestId,
            ),
          }),
        ),
    );
  }

  if (options.mutations) {
    const mutations = options.mutations;
    const effectAnnotations = {
      ...annotations,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    };
    server.registerTool(
      "computer_workspace_write",
      {
        title: "Write an approved workspace file",
        description:
          "Write through the selected Go owner. Supply a new operationId; never retry an effect. expectedSha256=null is create-only; replacement requires the exact preimage hash. Content is bounded to 256 KiB of UTF-8. UNKNOWN returns operationId for computer_mutation_read. memory_only is not durable publication.",
        inputSchema: WriteInputSchema,
        annotations: effectAnnotations,
      },
      async ({ operationId, expectedSha256, ...input }, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "computer_workspace_write",
            target: operationTarget(input),
          },
          ctx.mcpReq.signal,
          (call) =>
            mutations.write(
              {
                ...input,
                ...(expectedSha256 === null
                  ? {}
                  : { expectedSHA256: expectedSha256 }),
              },
              operationId,
              call,
            ),
          operationId,
          undefined,
          true,
        ),
    );
    server.registerTool(
      "computer_workspace_edit",
      {
        title: "Edit an approved workspace file",
        description:
          "Apply 1 to 256 exact unique text replacements through the selected Go owner with the exact expectedSha256. Supply a new operationId; never retry an effect. Total edit text is bounded to 256 KiB of UTF-8. UNKNOWN returns operationId for computer_mutation_read. memory_only is not durable publication.",
        inputSchema: EditInputSchema,
        annotations: effectAnnotations,
      },
      async ({ operationId, expectedSha256, ...input }, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "computer_workspace_edit",
            target: operationTarget(input),
          },
          ctx.mcpReq.signal,
          (call) =>
            mutations.edit(
              { ...input, expectedSHA256: expectedSha256 },
              operationId,
              call,
            ),
          operationId,
          undefined,
          true,
        ),
    );
    server.registerTool(
      "computer_mutation_read",
      {
        title: "Read a retained workspace mutation",
        description:
          "Read one existing operationId and exact workspace/path through the selected Go owner without executing or retrying the mutation. Original origin and publication remain unchanged, including after reconnect. memory_only is not durable publication.",
        inputSchema: z.strictObject(MutationTargetSchema),
        annotations,
      },
      async (input, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "computer_mutation_read",
            target: operationTarget(input),
          },
          ctx.mcpReq.signal,
          (call) => mutations.read(input, call),
          input.operationId,
        ),
    );
  }

  if (options.processes) {
    const processes = options.processes;
    // Server-local observation metadata only; never retains command arguments or I/O.
    const starts = new Map<
      string,
      { target: OperationMetadata["target"]; handle?: string }
    >();
    const processTarget = (input: {
      operationId: string;
      handle: string;
    }): OperationMetadata["target"] => {
      const start = starts.get(input.operationId);
      return start &&
        (start.handle === undefined || start.handle === input.handle)
        ? { ...start.target }
        : { handle: input.handle, start: "unknown" };
    };
    const effectAnnotations = {
      ...annotations,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    };
    server.registerTool(
      "computer_shell_start",
      {
        title: "Start an approved workspace command",
        description:
          "Start once through the selected Go process owner. Supply a new stable operationId, exact workspaceId, relativeCwd and explicit write flag. The original Go deadline is fixed; request timeouts do not extend it. UNKNOWN must never be retried with the same or another ID. No executable, environment, root or extra permissions can be supplied here.",
        inputSchema: ProcessStartSchema,
        annotations: effectAnnotations,
      },
      async ({ operationId, stdin, ...input }, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "computer_shell_start",
            target: operationTarget(input),
          },
          ctx.mcpReq.signal,
          async (call) => {
            let start = starts.get(operationId);
            const first = start === undefined;
            if (!start) {
              // Bound retention; evicted or previous-connection starts stay explicitly unknown.
              if (starts.size >= 1024)
                starts.delete(starts.keys().next().value!);
              start = { target: operationTarget(input) };
              starts.set(operationId, start);
            }
            const forgetRefused = () => {
              if (first && starts.get(operationId) === start)
                starts.delete(operationId);
            };
            try {
              const result = await processes.start(
                { ...input, ...(stdin === undefined ? {} : { stdin }) },
                operationId,
                call,
              );
              if (result.status === "refused") forgetRefused();
              // Never let a repeated operation ID relabel the original start.
              else if (first && result.data) start.handle = result.data.handle;
              return result;
            } catch (error) {
              if (error instanceof BridgeError && error.state === "refused")
                forgetRefused();
              throw error;
            }
          },
          operationId,
          undefined,
          true,
        ),
    );
    server.registerTool(
      "computer_shell_read",
      {
        title: "Read an owned command result",
        description:
          "Observe the exact original operationId and handle through Go, including after an admitted reconnect. stdout/stderr are canonical base64 byte windows, at most 64 KiB each. Offsets are bytes; omitted offsets start at zero. Root exit, group cleanup and descendant cleanup remain separate facts. Terminal observation alone does not prove durable publication. Reading never starts, cancels or restores a child.",
        inputSchema: z.strictObject({
          ...ProcessTargetSchema,
          stdoutOffset: ProcessOffsetSchema.optional(),
          stderrOffset: ProcessOffsetSchema.optional(),
        }),
        annotations,
      },
      async ({ stdoutOffset, stderrOffset, ...input }, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "computer_shell_read",
            target: processTarget(input),
          },
          ctx.mcpReq.signal,
          (call) =>
            processes.read(
              {
                ...input,
                stdoutOffset: String(stdoutOffset ?? 0),
                stderrOffset: String(stderrOffset ?? 0),
              },
              call,
            ),
          input.operationId,
        ),
    );
    server.registerTool(
      "computer_shell_cancel",
      {
        title: "Request cancellation of an owned command",
        description:
          "Request cleanup of the same live command owned by this connector lifetime. Keep original operationId and handle; supply a distinct new cancelOperationId. The reply is a cancellation ACK, not terminal or cleanup proof. Read the original handle for actual facts. A reconnect permits observation but does not restore control; UNKNOWN cancellation is never retried.",
        inputSchema: z
          .strictObject({
            ...ProcessTargetSchema,
            cancelOperationId: ProcessIDSchema,
          })
          .refine((value) => value.cancelOperationId !== value.operationId),
        annotations: effectAnnotations,
      },
      async ({ cancelOperationId, ...input }, ctx) =>
        run(
          {
            source: "ChatGPT",
            kind: "computer_shell_cancel",
            target: processTarget(input),
          },
          ctx.mcpReq.signal,
          (call) => processes.cancel(input, cancelOperationId, call),
          input.operationId,
          cancelOperationId,
          true,
        ),
    );
  }

  if (options.codexRead) {
    const reader = options.codexRead;
    server.registerTool(
      "codex_selected_thread_read",
      {
        title: "Read the selected Codex turn",
        description:
          "Read stored provider history for the exact owner-selected Codex thread and turn. No target IDs are accepted. Result text is opt-in and bounded to 64 KiB; provider history is non-atomic and is not a retained Farol Task result. This read grants no create, continue, adoption or active control.",
        inputSchema: z.strictObject({ includeResult: z.boolean().optional() }),
        annotations,
      },
      async (input, ctx) =>
        run(
          {
            source: "Codex",
            kind: "codex_selected_thread_read",
            target: operationTarget({}), // Selected provider history exposes no workspace, path or command target.
          },
          ctx.mcpReq.signal,
          async () => ({
            status: "ok",
            data: await reader.read(
              input.includeResult === undefined
                ? {}
                : { includeResult: input.includeResult },
            ),
          }),
        ),
    );
  }

  server.registerTool(
    "computer_workspace_catalogue",
    {
      title: "Find available workspaces",
      description: `Find exact task-accessible workspace IDs and approved roots in one Go catalogue operation. Call without arguments; do not guess IDs or roots. This bounded catalogue does not read file contents or grant authority. ${options.mutations ? "This connector supports catalogue, bootstrap, list, read, search and bounded mutations." : "This connector supports catalogue, bootstrap, list, read and search; writes are unavailable."} ${options.processes ? "Shell start/read/cancel uses the same Go owner." : "Shell tools are unavailable."} ${options.codexRead ? "The selected Codex turn has a read-only history tool." : "Task tools are unavailable."}`,
      inputSchema: z.strictObject({}),
      annotations,
    },
    async (_input, ctx) =>
      run(
        {
          source: "ChatGPT",
          kind: "computer_workspace_catalogue",
          target: operationTarget({}), // Discovery spans the catalogue rather than one workspace target.
        },
        ctx.mcpReq.signal,
        (call) => bridge.catalogue(identity(call), call),
      ),
  );
  server.registerTool(
    "computer_workspace_bootstrap",
    {
      title: "Discover approved workspace instructions",
      description:
        "Read applicable root-to-directory AGENTS.md in one Go bootstrap operation under existing authority. Returns approved root identity, scope, precedence, coverage and explicit missing/unavailable instructions. complete=false means instruction coverage is partial. Instructions never grant authority; this does not inspect unrelated descendants or ancestors outside the approved scope.",
      inputSchema: BootstrapInputSchema,
      annotations,
    },
    async (input, ctx) =>
      run(
        {
          source: "ChatGPT",
          kind: "computer_workspace_bootstrap",
          target: operationTarget(input),
        },
        ctx.mcpReq.signal,
        (call) => bridge.bootstrap({ ...identity(call), ...input }, call),
      ),
  );
  server.registerTool(
    "computer_workspace_list",
    {
      title: "List approved workspace files",
      description:
        "List one approved directory through Go, bounded to 500 entries. truncated=true is a partial listing, including when entries is empty. No recursive search, writes, commands or authority grants.",
      inputSchema: ListInputSchema,
      annotations,
    },
    async (input, ctx) =>
      run(
        {
          source: "ChatGPT",
          kind: "computer_workspace_list",
          target: operationTarget(input),
        },
        ctx.mcpReq.signal,
        (call) => bridge.list({ ...identity(call), ...input }, call),
      ),
  );
  server.registerTool(
    "computer_workspace_read",
    {
      title: "Read an approved workspace file",
      description:
        "Read one approved text file through Go. Whole reads are bounded to 256 KiB and include a raw-byte sha256. Either offset or length requests a byte window: offset defaults to 0, length to 65536, with length from 4 to 262144. Window page offsets and sizes are decimal strings; absent page.nextOffset means the last page. A window has no whole-file digest. No writes, shell or additional authority. Request abort suppresses disclosure but does not prove backend cancellation.",
      inputSchema: ReadInputSchema,
      annotations,
    },
    async ({ workspaceId, relativePath, offset, length }, ctx) =>
      run(
        {
          source: "ChatGPT",
          kind: "computer_workspace_read",
          target: operationTarget({ workspaceId, relativePath }),
        },
        ctx.mcpReq.signal,
        (call) =>
          bridge.read(
            {
              ...identity(call),
              workspaceId,
              relativePath,
              // The current wire uses a uint64 decimal offset and uint32 length.
              ...(offset === undefined && length === undefined
                ? {}
                : {
                    range: {
                      offset: String(offset ?? 0),
                      length: length ?? 65536,
                    },
                  }),
            },
            call,
          ),
      ),
  );
  server.registerTool(
    "computer_workspace_search",
    {
      title: "Search approved workspace text",
      description:
        "Search text in one approved workspace subtree through the selected Go owner. Accepts a conservative RE2 subset, not full Python regex: Python-only constructs and shorthand escapes such as \\w, \\d, \\s and \\b are refused as WORKSPACE_INVALID_REQUEST, with no fallback. Patterns are bounded to 4096 UTF-8 bytes. Returns at most 100 matches with workspace-relative paths, one-based decimal-string line numbers and excerpts of at most 500 Unicode scalars. Per-match truncated, resultLimited and scanLimited are independent; empty limited results do not prove absence or complete coverage. No writes, commands, network or additional authority. Request abort suppresses disclosure but does not prove backend cancellation.",
      inputSchema: SearchInputSchema,
      annotations,
    },
    async (input, ctx) =>
      run(
        {
          source: "ChatGPT",
          kind: "computer_workspace_search",
          target: operationTarget(input),
        },
        ctx.mcpReq.signal,
        (call) => bridge.search({ ...identity(call), ...input }, call),
      ),
  );
  return server;
}
