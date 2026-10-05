import { randomUUID } from "node:crypto";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BridgeError } from "./client.ts";
import { ComputerBridge, type ComputerCall } from "./computer.ts";
import type { ConnectorVerificationBridge } from "./connector-verification.ts";
import {
  validate,
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
  fence: GoComputerMcpFence;
  lifecycle?: GoComputerMcpLifecycle;
  verification?: Pick<ConnectorVerificationBridge, "verify">;
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
    name: "farol-next-computer",
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
    signal: AbortSignal,
    operation: (call: ComputerCall) => Promise<{ readonly status: string }>,
  ): Promise<CallToolResult> => {
    const call = Object.freeze({
      requestId: randomUUID(),
      context: selectedContext,
    });
    const failure = (status: "refused" | "unknown", code: string) =>
      encode({ ...call, status, code, retry: "never" }, true);
    if (signal.aborted)
      return failure("refused", "computer_mcp_aborted_before_dispatch");
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
      try {
        release?.();
      } catch {
        result = failure(
          dispatched ? "unknown" : "refused",
          "COMPUTER_MCP_STOPPING",
        );
      }
    }
    if (signal.aborted)
      return failure(
        dispatched ? "unknown" : "refused",
        dispatched
          ? "computer_mcp_aborted_after_dispatch"
          : "computer_mcp_aborted_before_dispatch",
      );
    if (await stopping())
      return failure(
        dispatched ? "unknown" : "refused",
        "COMPUTER_MCP_STOPPING",
      );
    if (signal.aborted)
      return failure(
        dispatched ? "unknown" : "refused",
        dispatched
          ? "computer_mcp_aborted_after_dispatch"
          : "computer_mcp_aborted_before_dispatch",
      );
    return result;
  };
  const identity = (call: ComputerCall) => ({
    ...execution,
    callId: call.requestId,
  });

  if (options.verification) {
    const verification = options.verification;
    server.registerTool(
      "farol_next_connector_verify",
      {
        title: "Verify the current Go Computer connector",
        description:
          "Use the owner-visible challenge and exact approved workspace ID. The current Go owner lists that workspace and retains a content-free observation. Repeated observation returns its original receipt without another List. This grants no authority and does not prove writes, shell or provider tasks.",
        inputSchema: z.strictObject({
          challenge: z.string().regex(/^[!-~]{1,160}$/u),
          workspaceId: IdentifierSchema,
        }),
        annotations,
      },
      async ({ challenge, workspaceId }, ctx) =>
        run(ctx.mcpReq.signal, async (call) => ({
          status: "ok",
          requestId: call.requestId,
          context: call.context,
          data: await verification.verify(
            challenge,
            workspaceId,
            call.requestId,
          ),
        })),
    );
  }

  server.registerTool(
    "computer_workspace_catalogue",
    {
      title: "Find available workspaces",
      description:
        "Find exact task-accessible workspace IDs and approved roots in one Go catalogue operation. Call without arguments; do not guess IDs or roots. This bounded catalogue does not read file contents or grant authority. This connector currently supports only catalogue, bootstrap, list and read; search, writes, shell and task tools are unavailable.",
      inputSchema: z.strictObject({}),
      annotations,
    },
    async (_input, ctx) =>
      run(ctx.mcpReq.signal, (call) => bridge.catalogue(identity(call), call)),
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
      run(ctx.mcpReq.signal, (call) =>
        bridge.bootstrap({ ...identity(call), ...input }, call),
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
      run(ctx.mcpReq.signal, (call) =>
        bridge.list({ ...identity(call), ...input }, call),
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
      run(ctx.mcpReq.signal, (call) =>
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
  return server;
}
