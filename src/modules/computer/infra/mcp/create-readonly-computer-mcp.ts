import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  ReadonlyComputerCallResponseSchema,
  type ReadonlyComputerCallRequest,
  type ReadonlyComputerContract,
} from "../../contract/readonly-computer-contract";

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
const ReadInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: FileRelativePathSchema,
});
const SearchInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopeRelativePathSchema,
  pattern: SearchPatternSchema,
});

const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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
    value.relativePath === request.operation.relativePath
  );
}

async function execute(
  contract: ReadonlyComputerContract,
  binding: ReadonlyComputerMcpBinding,
  callId: string,
  workspaceId: string,
  operation: ReadonlyComputerCallRequest["operation"],
): Promise<CallToolResult> {
  const request: ReadonlyComputerCallRequest = {
    ...binding,
    callId,
    workspaceId,
    operation,
  };
  let response: unknown;
  try {
    response = await contract.execute(request);
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
    return {
      content: [{ type: "text", text: JSON.stringify(parsed.data) }],
      structuredContent: { ...parsed.data },
      isError: true,
    };
  }
  if (!correlationMatches(request, parsed.data.value)) {
    return failure("COMPUTER_CONTRACT_CORRELATION");
  }
  const structuredContent: Record<string, unknown> = {
    ...parsed.data.value,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(parsed.data.value.output) }],
    structuredContent,
  };
}

export function createReadonlyComputerMcpServer(
  contract: ReadonlyComputerContract,
  binding: ReadonlyComputerMcpBinding,
): McpServer {
  const server = new McpServer({
    name: "farol-next-computer",
    version: "0.1.0-preview.0",
  });

  server.registerTool(
    "computer_workspace_list",
    {
      title: "List approved workspace files",
      description:
        "List one approved workspace directory without granting write, command, or network authority.",
      inputSchema: ListInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ workspaceId, relativePath }, context) =>
      execute(contract, binding, String(context.mcpReq.id), workspaceId, {
        kind: "workspace.list",
        relativePath,
      }),
  );
  server.registerTool(
    "computer_workspace_read",
    {
      title: "Read an approved workspace file",
      description:
        "Read one approved workspace file without granting write, command, or network authority.",
      inputSchema: ReadInputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ workspaceId, relativePath }, context) =>
      execute(contract, binding, String(context.mcpReq.id), workspaceId, {
        kind: "workspace.read",
        relativePath,
      }),
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
    async ({ workspaceId, relativePath, pattern }, context) =>
      execute(contract, binding, String(context.mcpReq.id), workspaceId, {
        kind: "workspace.search",
        relativePath,
        pattern,
      }),
  );

  return server;
}
