import { z } from "zod";

const ProductTaskIdentifierSchema = z.string().min(1).max(120);
const ProductTaskCapabilityLabelSchema = z.string().trim().min(1).max(120);

export const ProductTaskLifecycleSchema = z.enum([
  "event_driven",
  "idle",
  "running",
  "completed",
  "failed",
  "outcome_unknown",
]);

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
]);

export const ProductTaskCommandResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    state: ProductTasksStateSchema,
    selectedTaskId: ProductTaskIdentifierSchema,
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
    ]),
    state: ProductTasksStateSchema,
  }),
]);

export type ProductTask = z.infer<typeof ProductTaskSchema>;
export type ProductTaskLifecycle = z.infer<typeof ProductTaskLifecycleSchema>;
export type ProductTasksState = z.infer<typeof ProductTasksStateSchema>;
export type ProductTaskCommand = z.infer<typeof ProductTaskCommandSchema>;
export type ProductTaskCommandResult = z.infer<
  typeof ProductTaskCommandResultSchema
>;
