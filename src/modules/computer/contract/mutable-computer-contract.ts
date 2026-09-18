import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(160);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

function relativePath(value: string): boolean {
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

const FileRelativePathSchema = z.string().refine(relativePath);
const MutationTextSchema = z
  .string()
  .max(8 * 1_024 * 1_024)
  .refine((value) => !value.includes("\0"));
const EditSchema = z
  .strictObject({
    oldText: MutationTextSchema.min(1),
    newText: MutationTextSchema,
  })
  .refine((edit) => edit.oldText !== edit.newText);

export const MutableWorkspaceOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workspace.write"),
    relativePath: FileRelativePathSchema,
    content: MutationTextSchema,
    expectedSha256: Sha256Schema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("workspace.edit"),
    relativePath: FileRelativePathSchema,
    edits: z.array(EditSchema).min(1).max(256),
    expectedSha256: Sha256Schema,
  }),
]);

export const MutableComputerCallRequestSchema = z.strictObject({
  operationId: IdentifierSchema,
  ownerId: z.string().min(1).max(80),
  sessionId: IdentifierSchema,
  taskId: IdentifierSchema,
  taskEpoch: z.number().int().nonnegative(),
  participantId: IdentifierSchema,
  turnId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  callId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  operation: MutableWorkspaceOperationSchema,
});

const MutationSummarySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workspace.write"),
    relativePath: FileRelativePathSchema,
    expectedSha256: Sha256Schema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("workspace.edit"),
    relativePath: FileRelativePathSchema,
    expectedSha256: Sha256Schema,
  }),
]);

const CorrelationSchema = z.strictObject({
  operationId: IdentifierSchema,
  ownerId: z.string().min(1).max(80),
  sessionId: IdentifierSchema,
  taskId: IdentifierSchema,
  taskEpoch: z.number().int().nonnegative(),
  participantId: IdentifierSchema,
  turnId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  callId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativePath: FileRelativePathSchema,
  operation: MutationSummarySchema,
});

const ReceiptSchema = z.strictObject({
  kind: z.literal("workspace.mutation"),
  operation: z.enum(["edit", "write"]),
  relativePath: FileRelativePathSchema,
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1_024 * 1_024),
  replacements: z.number().int().nonnegative().max(256),
  beforeSha256: Sha256Schema.nullable(),
  afterSha256: Sha256Schema,
});

const ErrorCodeSchema = z.enum([
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
  "WORKSPACE_MUTATION_CANCELLED",
  "WORKSPACE_HELPER_UNTRUSTED",
  "WORKSPACE_INTERPRETER_UNTRUSTED",
  "WORKSPACE_PATH_REFUSED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_A_FILE",
  "WORKSPACE_FILE_TOO_LARGE",
  "WORKSPACE_MUTATION_CONFLICT",
  "WORKSPACE_NOT_TEXT",
  "WORKSPACE_EDIT_NO_MATCH",
  "WORKSPACE_EDIT_NOT_UNIQUE",
  "WORKSPACE_EDIT_OVERLAP",
  "WORKSPACE_HELPER_FAILED",
  "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
  "COMPUTER_PARTICIPANT_NOT_FOUND",
  "COMPUTER_APPROVAL_NOT_FOUND",
  "COMPUTER_AUTHORITY_STORE_UNAVAILABLE",
  "COMPUTER_APPROVAL_STORE_UNAVAILABLE",
  "COMPUTER_PATH_INVALID",
  "COMPUTER_MUTATION_OPERATION_CONFLICT",
  "COMPUTER_MUTATION_STORE_UNAVAILABLE",
  "COMPUTER_MUTATION_FINGERPRINT_FAILED",
  "COMPUTER_MUTATION_CORRELATION",
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
  "operation-store",
  "contract",
]);

export const MutableComputerCallResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: CorrelationSchema.extend({
      receipt: ReceiptSchema,
      resultRetention: z.enum(["durable", "memory_only"]),
      redelivered: z.boolean(),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    correlation: CorrelationSchema.nullable(),
    error: z.strictObject({
      code: ErrorCodeSchema,
      source: FailureSourceSchema,
      retry: z.literal("never"),
    }),
  }),
]);

export type MutableComputerCallRequest = z.infer<
  typeof MutableComputerCallRequestSchema
>;
export type MutableComputerCallResponse = z.infer<
  typeof MutableComputerCallResponseSchema
>;

export type MutableComputerExecutionContext = Readonly<{
  signal?: AbortSignal;
}>;

export interface MutableComputerContract {
  execute(
    request: unknown,
    context?: MutableComputerExecutionContext,
  ): Promise<MutableComputerCallResponse>;
}
