import { z } from "zod";

const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/u);
// Missing projection in a transitional caller must be treated as OFF.
export const AutomaticUpdatePreferenceSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("confirmed"), enabled: z.boolean() }),
  z.strictObject({
    status: z.enum(["blocked", "unknown"]),
    enabled: z.literal(false),
    code: Code,
  }),
]);
export type AutomaticUpdatePreference = z.infer<
  typeof AutomaticUpdatePreferenceSchema
>;
export const AutomaticUpdatePreferenceResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({ status: z.literal("confirmed"), enabled: z.boolean() }),
    z.strictObject({ status: z.enum(["refused", "unknown"]), code: Code }),
  ],
);
export type AutomaticUpdatePreferenceResult = z.infer<
  typeof AutomaticUpdatePreferenceResultSchema
>;
const InstallOnQuitConfirmed = z.strictObject({
  status: z.literal("confirmed"),
  scope: z.literal("install-on-normal-quit"),
  enabled: z.boolean(),
});
export const InstallOnQuitPreferenceSchema = z.discriminatedUnion("status", [
  InstallOnQuitConfirmed,
  z.strictObject({
    status: z.enum(["blocked", "unknown"]),
    enabled: z.literal(false),
    code: Code,
  }),
]);
export type InstallOnQuitPreference = z.infer<
  typeof InstallOnQuitPreferenceSchema
>;
export const InstallOnQuitPreferenceResultSchema = z.discriminatedUnion(
  "status",
  [
    InstallOnQuitConfirmed,
    z.strictObject({ status: z.enum(["refused", "unknown"]), code: Code }),
  ],
);
export type InstallOnQuitPreferenceResult = z.infer<
  typeof InstallOnQuitPreferenceResultSchema
>;
export const NormalQuitUpdateRequestSchema = z.strictObject({
  kind: z.literal("ordinary-quit"),
  deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type NormalQuitUpdateRequest = z.infer<
  typeof NormalQuitUpdateRequestSchema
>;
export const NormalQuitApplyContextSchema =
  NormalQuitUpdateRequestSchema.extend({
    relaunch: z.literal(false),
    requestQuit: z.literal(false),
  });
export type NormalQuitApplyContext = z.infer<
  typeof NormalQuitApplyContextSchema
>;
export const NormalQuitUpdateReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("accepted"), relaunch: z.literal(false) }),
  z.strictObject({
    status: z.enum(["skipped", "blocked", "unknown"]),
    code: Code,
  }),
]);
export type NormalQuitUpdateReceipt = z.infer<
  typeof NormalQuitUpdateReceiptSchema
>;
export const NormalQuitUpdateStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("idle") }),
  z.strictObject({
    status: z.literal("pending"),
    deadlineAt: NormalQuitUpdateRequestSchema.shape.deadlineAt,
  }),
  z.strictObject({
    status: z.literal("settled"),
    deadlineAt: NormalQuitUpdateRequestSchema.shape.deadlineAt,
    receipt: NormalQuitUpdateReceiptSchema,
  }),
]);
export type NormalQuitUpdateState = z.infer<typeof NormalQuitUpdateStateSchema>;
const PreferenceProjection = {
  automaticUpdatePreference: AutomaticUpdatePreferenceSchema.optional(),
  installOnQuitPreference: InstallOnQuitPreferenceSchema.optional(),
};
export const UpdateNoticeSchema = z.strictObject({
  key: z.string().min(1).max(256),
  seen: z.boolean(),
  blockedBy: Code.nullable(),
});
export const InstalledUpdateViewSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...PreferenceProjection,
    phase: z.literal("unavailable"),
    code: Code,
  }),
  z.strictObject({
    ...PreferenceProjection,
    phase: z.literal("idle"),
    checkedAt: z.number().nonnegative().nullable(),
    rollbackVersion: z.string().max(128).optional(),
    blockedBy: Code.optional(),
  }),
  z.strictObject({
    ...PreferenceProjection,
    phase: z.literal("recovery"),
    version: z.string().max(128),
    blockedBy: Code.nullable(),
  }),
  z.strictObject({
    ...PreferenceProjection,
    phase: z.literal("checking"),
  }),
  z.strictObject({
    ...PreferenceProjection,
    phase: z.literal("downloading"),
  }),
  z.strictObject({
    ...PreferenceProjection,
    phase: z.literal("available"),
    version: z.string().max(128),
    deferred: z.boolean(),
    notes: z.string().max(4096).optional(),
    notice: UpdateNoticeSchema.optional(),
  }),
  z.strictObject({
    ...PreferenceProjection,
    phase: z.literal("ready"),
    version: z.string().max(128),
    deferred: z.boolean(),
    blockedBy: Code.nullable(),
    notes: z.string().max(4096).optional(),
    notice: UpdateNoticeSchema.optional(),
  }),
  z.strictObject({
    ...PreferenceProjection,
    phase: z.literal("applying"),
    version: z.string().max(128),
  }),
  z
    .strictObject({
      ...PreferenceProjection,
      phase: z.literal("failed"),
      code: Code,
      recoveryRequired: z.boolean(),
      notice: UpdateNoticeSchema.optional(),
      rollbackVersion: z.string().max(128).optional(),
    })
    .refine(
      (view) => !view.recoveryRequired || view.rollbackVersion === undefined,
    ),
]);
export type InstalledUpdateView = z.infer<typeof InstalledUpdateViewSchema>;

// Only known, transient admission refusals may be cleared by an explicit
// check. The next Restart still has to acquire every live admission fence.
// Unknown browser/release state and unclassified codes remain fail-closed.
const recheckableAdmissionBlocks = new Set([
  "UPDATE_CONNECTOR_ACTIVE",
  "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
  "UPDATE_BROWSER_OPEN",
  "UPDATE_BROWSER_BUSY",
  "UPDATE_BROWSER_DRAFT",
  "UPDATE_WORK_PENDING",
]);

export function canRecheckUpdateAdmission(code: string): boolean {
  return recheckableAdmissionBlocks.has(code);
}

export const InstalledUpdateCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum([
      "status",
      "check",
      "download",
      "skip",
      "later",
      "restart",
      "recover",
      "rollback",
    ]),
  }),
  z.strictObject({
    kind: z.literal("set-automatic-update-preference"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("set-install-on-quit-preference"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("notice-seen"),
    noticeKey: z.string().min(1).max(256),
  }),
]);
export type InstalledUpdateCommand = z.infer<
  typeof InstalledUpdateCommandSchema
>;
