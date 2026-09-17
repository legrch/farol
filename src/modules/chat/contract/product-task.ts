import { z } from "zod";

const ProductTaskIdentifierSchema = z.string().min(1).max(120);
const ProductTaskCapabilityLabelSchema = z.string().trim().min(1).max(120);
const ProductAgentObjectiveSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_000)
  .refine((value) => !value.includes("\0"));
const ProductAgentRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !["*", "?", "[", "]", "{", "}"].some((symbol) =>
        value.includes(symbol),
      ) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );
const ProductAgentExcludedPathsSchema = z
  .array(ProductAgentRelativePathSchema)
  .max(32)
  .refine((paths) => new Set(paths).size === paths.length);

export const ProductAgentScopeSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("workspace"),
    excludedPaths: ProductAgentExcludedPathsSchema,
  }),
  z.strictObject({
    mode: z.literal("subtree"),
    relativeRoot: ProductAgentRelativePathSchema,
    excludedPaths: ProductAgentExcludedPathsSchema,
  }),
  z.strictObject({
    mode: z.literal("exact"),
    relativePaths: z
      .array(ProductAgentRelativePathSchema)
      .min(1)
      .max(32)
      .refine((paths) => new Set(paths).size === paths.length),
  }),
]);

export const ProductTaskLifecycleSchema = z.enum([
  "event_driven",
  "idle",
  "running",
  "cancelled",
  "completed",
  "failed",
  "outcome_unknown",
]);

export const ProductTaskAgentSchema = z.strictObject({
  phase: z.enum([
    "running",
    "completed",
    "cancelled",
    "failed",
    "outcome_unknown",
  ]),
  workspaceId: ProductTaskIdentifierSchema,
  parentDelivery: z.enum(["not_applicable", "pending", "acknowledged"]),
  workspaceEnforcement: z.enum(["not_applicable", "verified"]),
  resultAvailable: z.boolean(),
});

export const ProductTaskContextSchema = z.strictObject({
  epoch: z.number().int().positive(),
  phase: z.enum([
    "active",
    "quiescing",
    "checkpoint_requested",
    "validated",
    "durably_stored",
    "handoff_offered",
    "host_context_confirmed",
    "old_epoch_retired",
    "blocked",
    "outcome_unknown",
  ]),
  source: z.enum(["retained_agent", "canonical_history"]).nullable(),
  code: z.string().min(1).max(160).nullable(),
});

export const ProductTaskSchema = z.strictObject({
  taskId: ProductTaskIdentifierSchema,
  sessionId: ProductTaskIdentifierSchema,
  turnId: ProductTaskIdentifierSchema,
  label: z.string().trim().min(1).max(80),
  provider: z.enum(["fixture", "chatgpt"]),
  requestedModel: ProductTaskCapabilityLabelSchema.nullable(),
  observedModel: ProductTaskCapabilityLabelSchema.nullable(),
  requestedMode: ProductTaskCapabilityLabelSchema.nullable(),
  observedMode: ProductTaskCapabilityLabelSchema.nullable(),
  hasComputer: z.boolean(),
  pinned: z.boolean(),
  lifecycle: ProductTaskLifecycleSchema,
  agent: ProductTaskAgentSchema.nullable().optional(),
  context: ProductTaskContextSchema.nullable().optional(),
});

export const ProductTasksStateSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  tasks: z.array(ProductTaskSchema).max(5),
});

export const ProductTaskCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task.create-chatgpt") }),
  z.strictObject({
    kind: z.literal("task.activate"),
    taskId: ProductTaskIdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("task.rename"),
    taskId: ProductTaskIdentifierSchema,
    label: z.string().trim().min(1).max(80),
  }),
  z.strictObject({
    kind: z.literal("task.pin"),
    taskId: ProductTaskIdentifierSchema,
    pinned: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("task.close"),
    taskId: ProductTaskIdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("task.cancel"),
    taskId: ProductTaskIdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("task.start-agent"),
    taskId: ProductTaskIdentifierSchema,
    workspaceId: ProductTaskIdentifierSchema,
    objective: ProductAgentObjectiveSchema,
    scope: ProductAgentScopeSelectionSchema,
  }),
  z.strictObject({
    kind: z.literal("task.rejoin-agent"),
    taskId: ProductTaskIdentifierSchema,
  }),
]);

export const ProductTaskCommandResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    state: ProductTasksStateSchema,
    selectedTaskId: ProductTaskIdentifierSchema.nullable(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum([
      "TASK_COMMAND_INVALID",
      "TASKS_UNAVAILABLE",
      "CHATGPT_CONNECTION_NOT_VERIFIED",
      "TASK_CAPACITY_REACHED",
      "TASK_ROUTE_UNAVAILABLE",
      "TASK_NOT_FOUND",
      "TASK_SURFACE_UNREACHABLE",
      "TASK_OPERATION_IN_PROGRESS",
      "TASK_STATE_UNAVAILABLE",
      "TASK_NOT_RUNNING",
      "TASK_CANCEL_FAILED",
      "AGENT_NOT_READY",
      "AGENT_SCOPE_INVALID",
      "AGENT_ALREADY_RUNNING",
      "AGENT_INPUT_STATE_UNAVAILABLE",
      "AGENT_ASSIGNMENT_FAILED",
      "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
      "AGENT_CANCEL_RACED_COMPLETION",
      "AGENT_DELIVERY_FAILED",
      "AGENT_REJOIN_UNAVAILABLE",
    ]),
    state: ProductTasksStateSchema,
  }),
]);

export type ProductTask = z.infer<typeof ProductTaskSchema>;
export type ProductAgentScopeSelection = z.infer<
  typeof ProductAgentScopeSelectionSchema
>;
export type ProductTaskLifecycle = z.infer<typeof ProductTaskLifecycleSchema>;
export type ProductTaskAgent = z.infer<typeof ProductTaskAgentSchema>;
export type ProductTaskContext = z.infer<typeof ProductTaskContextSchema>;
export type ProductTasksState = z.infer<typeof ProductTasksStateSchema>;
export type ProductTaskCommand = z.infer<typeof ProductTaskCommandSchema>;
export type ProductTaskCommandResult = z.infer<
  typeof ProductTaskCommandResultSchema
>;
