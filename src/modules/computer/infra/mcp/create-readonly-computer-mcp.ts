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
    (value.operation.kind !== "workspace.search" ||
      (request.operation.kind === "workspace.search" &&
        value.operation.pattern === request.operation.pattern))
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
  const value = parsed.data.value;
  const outputMatchesOperation =
    (request.operation.kind === "workspace.read" &&
      value.output.kind === "workspace.text") ||
    (request.operation.kind === "workspace.list" &&
      value.output.kind === "workspace.entries") ||
    (request.operation.kind === "workspace.search" &&
      value.output.kind === "workspace.matches");
  if (!correlationMatches(request, value) || !outputMatchesOperation) {
    return failure("COMPUTER_CONTRACT_CORRELATION");
  }
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
    response = await contract.execute(request);
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

export function createReadonlyComputerMcpServer(
  contract: ReadonlyComputerContract,
  binding: ReadonlyComputerMcpBinding,
  mutableContract?: MutableComputerContract,
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
        ),
    );
  }

  return server;
}
