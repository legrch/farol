import { z } from "zod";

const AuthorityCapabilitySchema = z.enum([
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "verification.run",
  "workspace.write",
]);

const WorkspaceScopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    workspaceId: z.string().min(1).max(120),
    mode: z.literal("subtree"),
    root: z.string().min(1).max(4_096),
    access: z.enum(["read", "write"]),
  }),
  z.strictObject({
    workspaceId: z.string().min(1).max(120),
    mode: z.literal("exact"),
    root: z.string().min(1).max(4_096),
    paths: z.array(z.string().min(1).max(4_096)).min(1).max(256),
    access: z.enum(["read", "write"]),
  }),
]);

const WorkspaceExclusionSchema = z.strictObject({
  workspaceId: z.string().min(1).max(120),
  path: z.string().min(1).max(4_096),
});

const AuthorityNarrowingSchema = z.strictObject({
  workspaces: z.array(WorkspaceScopeSchema).max(64),
  excludedPaths: z.array(WorkspaceExclusionSchema).max(32).optional(),
  capabilities: z.array(AuthorityCapabilitySchema).max(16),
  network: z.enum(["none", "approved"]),
  commands: z.enum(["none", "verification"]),
});

export const ExecutionAuthorityDelegationRequestSchema = z.strictObject({
  ownerId: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(120),
  taskId: z.string().min(1).max(120),
  taskEpoch: z.number().int().nonnegative(),
  parentParticipantId: z.string().min(1).max(120),
  participantId: z.string().min(1).max(120),
  role: z.enum(["agent", "critic"]),
  mutationOwnership: z.enum(["none", "task"]),
  narrowing: AuthorityNarrowingSchema.optional(),
});

const DelegatedAuthoritySchema = z.strictObject({
  authorityId: z.string().min(1).max(120),
  participantId: z.string().min(1).max(120),
  parentParticipantId: z.string().min(1).max(120),
  role: z.enum(["agent", "critic"]),
  mutationOwnership: z.enum(["none", "task"]),
  ownerId: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(120),
  taskId: z.string().min(1).max(120),
  taskEpoch: z.number().int().nonnegative(),
  computerId: z.string().min(1).max(120),
  computerGeneration: z.number().int().nonnegative(),
  workspaces: z.array(WorkspaceScopeSchema).max(64),
  excludedPaths: z.array(WorkspaceExclusionSchema).max(32),
  capabilities: z.array(AuthorityCapabilitySchema).max(16),
  network: z.enum(["none", "approved"]),
  commands: z.enum(["none", "verification"]),
  expiresAt: z.number().finite().nonnegative(),
});

const AuthorityErrorCodeSchema = z.enum([
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
  "AUTHORITY_PARENT_NOT_FOUND",
  "AUTHORITY_PARTICIPANT_CONFLICT",
  "AUTHORITY_STORE_UNAVAILABLE",
  "AUTHORITY_INVALID_REQUEST",
]);

const AuthorityFailureSourceSchema = z.enum([
  "computer-approval",
  "task-admission",
  "task-grant",
  "owner-restriction",
  "role",
  "computer-policy",
  "native-host",
  "authority-store",
  "contract",
]);

export const ExecutionAuthorityDelegationResponseSchema = z.discriminatedUnion(
  "ok",
  [
    z.strictObject({ ok: z.literal(true), value: DelegatedAuthoritySchema }),
    z.strictObject({
      ok: z.literal(false),
      error: z.strictObject({
        code: AuthorityErrorCodeSchema,
        source: AuthorityFailureSourceSchema,
        retry: z.literal("never"),
      }),
    }),
  ],
);

export type ExecutionAuthorityDelegationRequest = z.infer<
  typeof ExecutionAuthorityDelegationRequestSchema
>;
export type ExecutionAuthorityDelegationResponse = z.infer<
  typeof ExecutionAuthorityDelegationResponseSchema
>;

export interface ExecutionAuthorityContract {
  delegate(request: unknown): Promise<ExecutionAuthorityDelegationResponse>;
}
