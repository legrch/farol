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
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value === "/" ||
      (value.startsWith("/") && relativePath(value.slice(1), false)),
  );

const MAX_READ_BYTES = 256 * 1_024;

// A window of a file too large to read whole. It spans at least one whole
// UTF-8 character, so every window makes progress, and its offset is any exact
// integer, so every reported `nextOffset` is a valid next request.
const ReadRangeSchema = z.strictObject({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().min(4).max(MAX_READ_BYTES),
});

const OperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workspace.context"),
    relativePath: ScopeRelativePathSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace.read"),
    relativePath: FileRelativePathSchema,
    range: ReadRangeSchema.optional(),
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
  z
    .strictObject({
      kind: z.literal("workspace.context"),
      root: AbsolutePathSchema,
      approvedRoot: z.strictObject({
        path: AbsolutePathSchema,
        device: z.string().regex(/^[0-9]+$/u),
        inode: z.string().regex(/^[0-9]+$/u),
      }),
      scope: z.literal("subtree"),
    })
    .refine(
      (value) =>
        value.root === value.approvedRoot.path ||
        value.root.startsWith(
          value.approvedRoot.path === "/" ? "/" : `${value.approvedRoot.path}/`,
        ),
    ),
  z.strictObject({
    kind: z.literal("workspace.text"),
    text: z.string(),
    bytes: z.number().int().nonnegative().max(MAX_READ_BYTES),
    page: z
      .strictObject({
        offset: z.number().int().nonnegative(),
        size: z.number().int().nonnegative(),
        nextOffset: z.number().int().positive().nullable(),
      })
      .optional(),
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
  "WORKSPACE_POLICY_TOO_LARGE",
  "WORKSPACE_REQUEST_CANCELLED",
  "WORKSPACE_HELPER_UNTRUSTED",
  "WORKSPACE_INTERPRETER_UNTRUSTED",
  "WORKSPACE_PATH_REFUSED",
  "WORKSPACE_ROOT_CHANGED",
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
  "WORKSPACE_GIT_METADATA_NOT_APPROVED",
  "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED",
  "WORKSPACE_TRACKED_LIST_TOO_LARGE",
  "WORKSPACE_TRACKED_PATH_UNSUPPORTED",
  "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT",
  "WORKSPACE_CHANGED_DURING_SNAPSHOT",
  "WORKSPACE_SNAPSHOT_TOO_LARGE",
  "WORKSPACE_SNAPSHOT_CROSS_VOLUME",
  "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED",
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
  "unverified-provenance",
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
