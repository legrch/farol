import { z } from "zod";

const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/u);
export const UpdateNoticeSchema = z.strictObject({
  key: z.string().min(1).max(256),
  seen: z.boolean(),
  blockedBy: Code.nullable(),
});
export const InstalledUpdateViewSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("unavailable"), code: Code }),
  z.strictObject({
    phase: z.literal("idle"),
    checkedAt: z.number().nonnegative().nullable(),
    rollbackVersion: z.string().max(128).optional(),
    blockedBy: Code.optional(),
  }),
  z.strictObject({
    phase: z.literal("recovery"),
    version: z.string().max(128),
    blockedBy: Code.nullable(),
  }),
  z.strictObject({ phase: z.literal("checking") }),
  z.strictObject({ phase: z.literal("downloading") }),
  z.strictObject({
    phase: z.literal("available"),
    version: z.string().max(128),
    deferred: z.boolean(),
    notes: z.string().max(4096).optional(),
    notice: UpdateNoticeSchema.optional(),
  }),
  z.strictObject({
    phase: z.literal("ready"),
    version: z.string().max(128),
    deferred: z.boolean(),
    blockedBy: Code.nullable(),
    notes: z.string().max(4096).optional(),
    notice: UpdateNoticeSchema.optional(),
  }),
  z.strictObject({
    phase: z.literal("applying"),
    version: z.string().max(128),
  }),
  z
    .strictObject({
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
    kind: z.literal("notice-seen"),
    noticeKey: z.string().min(1).max(256),
  }),
]);
export type InstalledUpdateCommand = z.infer<
  typeof InstalledUpdateCommandSchema
>;
