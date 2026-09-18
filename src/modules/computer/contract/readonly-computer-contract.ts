import { z } from "zod";

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

const OperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workspace.read"),
    relativePath: FileRelativePathSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace.list"),
    relativePath: ScopeRelativePathSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace.search"),
    relativePath: ScopeRelativePathSchema,
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

export const ReadonlyComputerCallRequestSchema = z.strictObject({
  ownerId: z.string().min(1).max(80),
  sessionId: IdentifierSchema,
  taskId: IdentifierSchema,
  taskEpoch: z.number().int().nonnegative(),
  participantId: IdentifierSchema,
  turnId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  callId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  operation: OperationSchema,
});

const WorkspaceOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workspace.text"),
    text: z.string(),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024),
  }),
  z.strictObject({
    kind: z.literal("workspace.entries"),
    entries: z.array(z.string().min(1).max(256)).max(500),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("workspace.matches"),
    matches: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(4_096),
          line: z.number().int().positive(),
          text: z.string().max(500),
          truncated: z.boolean(),
        }),
      )
      .max(100),
    resultLimited: z.boolean(),
    scanLimited: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("workspace.command"),
    command: z.enum(["git.status", "git.head"]),
    relativePath: z.literal("."),
    exitCode: z.literal(0),
    stdout: z.string().max(64 * 1_024),
    stderr: z.literal(""),
    outputBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1_024),
    network: z.literal("none"),
    coverage: z.enum(["tracked-files-only", "head-commit"]),
    layout: z.enum(["primary", "linked-worktree"]),
  }),
]);

export const ReadonlyComputerCallCorrelationSchema = z.strictObject({
  ownerId: z.string().min(1).max(80),
  sessionId: IdentifierSchema,
  taskId: IdentifierSchema,
  taskEpoch: z.number().int().nonnegative(),
  participantId: IdentifierSchema,
  turnId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  callId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativePath: ScopeRelativePathSchema,
  operation: OperationSchema,
});

const ComputerErrorCodeSchema = z.enum([
  "AUTHORITY_OWNER_MISMATCH",
  "AUTHORITY_TASK_MISMATCH",
  "AUTHORITY_COMPUTER_MISMATCH",
  "AUTHORITY_EXPIRED",
  "AUTHORITY_INFLATION_DENIED",
  "AUTHORITY_CAPABILITY_DENIED",
  "AUTHORITY_PATH_DENIED",
  "AUTHORITY_NETWORK_DENIED",
  "AUTHORITY_COMMAND_DENIED",
  "AUTHORITY_MUTATION_OWNERSHIP_DENIED",
  "WORKSPACE_INVALID_REQUEST",
  "WORKSPACE_HELPER_UNTRUSTED",
  "WORKSPACE_INTERPRETER_UNTRUSTED",
  "WORKSPACE_PATH_REFUSED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_A_FILE",
  "WORKSPACE_FILE_TOO_LARGE",
  "WORKSPACE_RACE_DETECTED",
  "WORKSPACE_SEARCH_TIMEOUT",
  "WORKSPACE_NOT_TEXT",
  "WORKSPACE_HELPER_FAILED",
  "WORKSPACE_COMMAND_UNSUPPORTED",
  "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE",
  "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED",
  "WORKSPACE_COMMAND_CANCELLED",
  "WORKSPACE_COMMAND_TIMEOUT",
  "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
  "WORKSPACE_NOT_GIT_REPOSITORY",
  "WORKSPACE_GIT_HEAD_UNBORN",
  "WORKSPACE_COMMAND_FAILED",
  "COMPUTER_PARTICIPANT_NOT_FOUND",
  "COMPUTER_APPROVAL_NOT_FOUND",
  "COMPUTER_AUTHORITY_STORE_UNAVAILABLE",
  "COMPUTER_APPROVAL_STORE_UNAVAILABLE",
  "COMPUTER_PATH_INVALID",
  "COMPUTER_INVALID_REQUEST",
]);

const FailureSourceSchema = z.enum([
  "computer-approval",
  "task-admission",
  "task-grant",
  "owner-restriction",
  "role",
  "computer-policy",
  "native-host",
  "authority-store",
  "native-workspace",
  "contract",
]);

export const ReadonlyComputerCallResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: ReadonlyComputerCallCorrelationSchema.extend({
      output: WorkspaceOutputSchema,
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    correlation: ReadonlyComputerCallCorrelationSchema.nullable(),
    error: z.strictObject({
      code: ComputerErrorCodeSchema,
      source: FailureSourceSchema,
      retry: z.literal("never"),
    }),
  }),
]);

export type ReadonlyComputerCallRequest = z.infer<
  typeof ReadonlyComputerCallRequestSchema
>;
export type ReadonlyComputerCallResponse = z.infer<
  typeof ReadonlyComputerCallResponseSchema
>;

export type ReadonlyComputerExecutionContext = Readonly<{
  signal?: AbortSignal;
}>;

export interface ReadonlyComputerContract {
  execute(
    request: unknown,
    context?: ReadonlyComputerExecutionContext,
  ): Promise<ReadonlyComputerCallResponse>;
}
