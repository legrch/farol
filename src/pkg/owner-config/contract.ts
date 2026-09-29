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

/** One section of config.json. Runtime grants and credentials stay separate. */
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

// Runtime observations are NOT fields in tasks/config. They are projected only
// into Settings/MCP results and must never rewrite the user's model policy.
export const RuntimeTaskModelSchema = z.strictObject({
  id: z.string().min(1).max(160),
  model: TaskModelSchema.shape.model,
  displayName: z.string().max(240),
  hidden: z.boolean(),
  supportedEfforts: z.array(TaskEffortSchema).max(32).readonly(),
  defaultEffort: TaskEffortSchema.optional(),
});
export const RuntimeTaskCatalogueSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    source: z.literal("model/list"),
    scope: z.string().min(1).max(240),
    observedAt: z.number().int().nonnegative().safe(),
    models: z.array(RuntimeTaskModelSchema).max(2000).readonly(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    code: z.string().min(1).max(120),
  }),
]);
export const TaskModelCatalogueViewSchema = z.strictObject({
  harness: TaskNameSchema,
  catalogue: RuntimeTaskCatalogueSchema,
  configError: z.string().max(120).nullable(),
  configured: z
    .array(
      z.strictObject({
        alias: TaskNameSchema,
        model: TaskModelSchema.shape.model,
        defaultEffort: TaskEffortSchema.optional(),
        available: z.enum(["yes", "no", "unknown"]),
        effortAvailable: z.boolean().nullable(),
      }),
    )
    .max(64),
});
export type TaskModelCatalogueView = z.infer<
  typeof TaskModelCatalogueViewSchema
>;

export function describeTaskModels(
  config: unknown,
  harness: string,
  catalogue: z.infer<typeof RuntimeTaskCatalogueSchema>,
): TaskModelCatalogueView {
  const parsed = TaskExecutionSettingsSchema.safeParse(config);
  const entry =
    parsed.success && Object.hasOwn(parsed.data.harnesses, harness)
      ? parsed.data.harnesses[harness]
      : undefined;
  return {
    harness,
    catalogue,
    configError: entry ? null : "TASK_MODEL_CONFIG_UNAVAILABLE",
    configured: entry
      ? Object.entries(entry.models).map(([alias, configured]) => {
          const actual =
            catalogue.status === "ready"
              ? catalogue.models.find(
                  (model) => model.model === configured.model,
                )
              : undefined;
          return {
            alias,
            ...configured,
            available:
              catalogue.status !== "ready" ? "unknown" : actual ? "yes" : "no",
            effortAvailable:
              catalogue.status !== "ready"
                ? null
                : !actual
                  ? false
                  : configured.defaultEffort === undefined ||
                    actual.supportedEfforts.includes(configured.defaultEffort),
          };
        })
      : [],
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
