import { z } from "zod";

const CanonicalTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

const CanonicalAbsolutePathSchema = z.string().refine((value) => {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  if (value === "/") return true;
  if (value.endsWith("/")) return false;
  return value.split("/").every((part, index) => {
    if (index === 0) return part === "";
    return part !== "" && part !== "." && part !== "..";
  });
});

const IdentifierSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

export const ProductGeneralSettingsSchema = z.strictObject({
  openAtLaunch: z.enum(["browser", "activity", "settings"]),
  sidebarDefault: z.enum(["full", "rail"]),
  activityDetail: z.enum(["summary", "technical"]),
});

export const ApprovedProductWorkspaceSchema = z
  .strictObject({
    workspaceId: IdentifierSchema,
    root: CanonicalAbsolutePathSchema,
    label: z.string().trim().min(1).max(120),
    access: z.literal("read"),
    excludedPaths: z.array(CanonicalAbsolutePathSchema).max(32),
  })
  .superRefine((workspace, context) => {
    const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
    const unique = new Set(workspace.excludedPaths);
    if (unique.size !== workspace.excludedPaths.length) {
      context.addIssue({ code: "custom", message: "duplicate exclusions" });
    }
    for (const excluded of workspace.excludedPaths) {
      if (excluded !== workspace.root && !excluded.startsWith(prefix)) {
        context.addIssue({ code: "custom", message: "exclusion escapes root" });
      }
    }
  });

export const SetupVerificationSchema = z.strictObject({
  profile: z.string().min(1).max(160),
  configRevision: z.number().int().positive(),
  workspaceId: IdentifierSchema.nullable(),
  runtimeGeneration: z.string().min(1).max(160),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  protocol: z.string().min(1).max(160),
  verifiedAt: CanonicalTimestampSchema,
});

export const SetupReadinessSchema = z.strictObject({
  visited: z.boolean(),
  skipped: z.boolean(),
  configured: z.boolean(),
  reachable: z.enum(["unknown", "reachable", "unreachable"]),
  verified: SetupVerificationSchema.nullable(),
  needsAction: z.string().min(1).max(240).nullable(),
  unavailable: z.string().min(1).max(240).nullable(),
  outcomeUnknown: z.boolean(),
});

export const SetupStepIdSchema = z.enum([
  "chatgpt",
  "computer",
  "connect",
  "hosts",
  "verify",
]);

export const ProductSettingsSchema = z.strictObject({
  schema: z.literal(1),
  revision: z.number().int().positive(),
  general: ProductGeneralSettingsSchema,
  computer: z.strictObject({
    computerId: IdentifierSchema,
    generation: z.number().int().positive(),
    name: z.string().trim().min(1).max(80),
    workspaces: z.array(ApprovedProductWorkspaceSchema).max(64),
  }),
  setup: z.strictObject({
    journey: z
      .strictObject({
        currentStep: SetupStepIdSchema,
        dismissed: z.boolean(),
      })
      .default({ currentStep: "chatgpt", dismissed: false }),
    chatgpt: SetupReadinessSchema,
    computer: SetupReadinessSchema,
    connect: SetupReadinessSchema,
    hosts: SetupReadinessSchema,
    verify: SetupReadinessSchema,
  }),
});

export const ProductConfigurationSnapshotSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("ready"),
      settings: ProductSettingsSchema,
    }),
    z.strictObject({
      status: z.literal("error"),
      error: z.enum([
        "SETTINGS_CORRUPT",
        "SETTINGS_UNSAFE",
        "SETTINGS_READ_FAILED",
      ]),
    }),
  ],
);

export const ProductConfigurationCommandSchema = z.discriminatedUnion("kind", [
  ProductGeneralSettingsSchema.extend({ kind: z.literal("general.update") }),
  z.strictObject({
    kind: z.literal("computer.rename"),
    name: z.string().trim().min(1).max(80),
  }),
  z.strictObject({ kind: z.literal("computer.add-workspace") }),
  z.strictObject({
    kind: z.literal("computer.remove-workspace"),
    workspaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.verify-workspace"),
    workspaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("setup.progress"),
    currentStep: SetupStepIdSchema,
    dismissed: z.boolean(),
  }),
]);

export const ProductConfigurationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    snapshot: ProductConfigurationSnapshotSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum([
      "SETTINGS_UNAVAILABLE",
      "SETTINGS_INPUT_INVALID",
      "SETTINGS_WRITE_FAILED",
      "WORKSPACE_NOT_FOUND",
      "WORKSPACE_PICKER_CANCELLED",
      "WORKSPACE_SELECTION_INVALID",
      "WORKSPACE_VERIFICATION_FAILED",
    ]),
    snapshot: ProductConfigurationSnapshotSchema,
  }),
]);

export type ProductGeneralSettings = z.infer<
  typeof ProductGeneralSettingsSchema
>;
export type ApprovedProductWorkspace = z.infer<
  typeof ApprovedProductWorkspaceSchema
>;
export type SetupStepId = z.infer<typeof SetupStepIdSchema>;
export type ProductSettings = z.infer<typeof ProductSettingsSchema>;
export type ProductConfigurationSnapshot = z.infer<
  typeof ProductConfigurationSnapshotSchema
>;
export type ProductConfigurationCommand = z.infer<
  typeof ProductConfigurationCommandSchema
>;
export type ProductConfigurationResult = z.infer<
  typeof ProductConfigurationResultSchema
>;
