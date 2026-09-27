import { z } from "zod";

/** User-facing names, not a list of vendors, roles or model generations. */
export const TaskNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u);

export const TaskEffortSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const TaskModelSchema = z.strictObject({
  model: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9_.\/-]+$/u),
  defaultEffort: TaskEffortSchema.optional(),
});

export const TaskHarnessSchema = z
  .strictObject({
    defaultModel: TaskNameSchema,
    models: z
      .record(TaskNameSchema, TaskModelSchema)
      .refine(
        (models) =>
          Object.keys(models).length > 0 && Object.keys(models).length <= 64,
      ),
  })
  .superRefine((value, context) => {
    if (!Object.hasOwn(value.models, value.defaultModel)) {
      context.addIssue({
        code: "custom",
        path: ["defaultModel"],
        message: "defaultModel must name a configured model",
      });
    }
  });

/** One section of product-settings.json. Runtime grants and credentials stay separate. */
export const TaskExecutionSettingsSchema = z
  .strictObject({
    defaultHarness: TaskNameSchema,
    harnesses: z
      .record(TaskNameSchema, TaskHarnessSchema)
      .refine(
        (harnesses) =>
          Object.keys(harnesses).length > 0 &&
          Object.keys(harnesses).length <= 16,
      ),
  })
  .superRefine((value, context) => {
    if (!Object.hasOwn(value.harnesses, value.defaultHarness)) {
      context.addIssue({
        code: "custom",
        path: ["defaultHarness"],
        message: "defaultHarness must name a configured harness",
      });
    }
  });

export const TaskSelectionRequestSchema = z.strictObject({
  harness: TaskNameSchema.optional(),
  model: TaskNameSchema.optional(),
  effort: TaskEffortSchema.optional(),
});

export const ResolvedTaskModelSchema = z.strictObject({
  harness: TaskNameSchema,
  modelAlias: TaskNameSchema,
  model: TaskModelSchema.shape.model,
  effort: TaskEffortSchema.optional(),
});

export const TaskModelBindingSchema = z.strictObject({
  selection: ResolvedTaskModelSchema,
  configSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type TaskExecutionSettings = z.infer<typeof TaskExecutionSettingsSchema>;
export type TaskSelectionRequest = z.infer<typeof TaskSelectionRequestSchema>;
export type ResolvedTaskModel = Readonly<
  z.infer<typeof ResolvedTaskModelSchema>
>;
export type TaskModelResolution =
  | Readonly<{ status: "ready"; selection: ResolvedTaskModel }>
  | Readonly<{
      status:
        | "config-missing"
        | "config-invalid"
        | "selection-invalid"
        | "harness-missing"
        | "harness-unsupported"
        | "model-missing";
    }>;

/** Config lists choices; only compiled implementations can execute a harness. */
export function resolveTaskModel(
  config: unknown,
  requested: unknown,
  supportedHarnesses: readonly string[],
): TaskModelResolution {
  if (config === undefined || config === null)
    return { status: "config-missing" };
  const parsed = TaskExecutionSettingsSchema.safeParse(config);
  if (!parsed.success) return { status: "config-invalid" };
  const request = TaskSelectionRequestSchema.safeParse(requested);
  if (!request.success) return { status: "selection-invalid" };
  const harness = request.data.harness ?? parsed.data.defaultHarness;
  if (!Object.hasOwn(parsed.data.harnesses, harness))
    return { status: "harness-missing" };
  if (!supportedHarnesses.includes(harness))
    return { status: "harness-unsupported" };
  const entry = parsed.data.harnesses[harness]!;
  const modelAlias = request.data.model ?? entry.defaultModel;
  if (!Object.hasOwn(entry.models, modelAlias))
    return { status: "model-missing" };
  const model = entry.models[modelAlias]!;
  const effort = request.data.effort ?? model.defaultEffort;
  return {
    status: "ready",
    selection: Object.freeze({
      harness,
      modelAlias,
      model: model.model,
      ...(effort === undefined ? {} : { effort }),
    }),
  };
}

/** Stable semantic encoding: whitespace and object-key ordering do not change policy identity. */
export function taskPolicyIdentity(config: TaskExecutionSettings): string {
  return JSON.stringify([
    "farol-task-policy/1",
    config.defaultHarness,
    Object.keys(config.harnesses)
      .sort()
      .map((name) => {
        const harness = config.harnesses[name]!;
        return [
          name,
          harness.defaultModel,
          Object.keys(harness.models)
            .sort()
            .map((alias) => {
              const model = harness.models[alias]!;
              return [alias, model.model, model.defaultEffort ?? null];
            }),
        ];
      }),
  ]);
}
