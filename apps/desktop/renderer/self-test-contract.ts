import { z } from "zod";

const workspace = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:/-]+$/u);
const operation = z.string().uuid();
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/u)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,15})$/u.test(value) &&
      BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  );
export const SelfTestSelectionSchema = z.strictObject({
  operationId: operation,
  workspaceId: workspace,
  computerGeneration: decimal,
  planVersion: z.enum(["1", "2"]),
});
export const SelfTestCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("history"), workspaceId: workspace }),
  z.strictObject({ kind: z.literal("start"), workspaceId: workspace }),
  z.strictObject({
    kind: z.literal("observe"),
    workspaceId: workspace,
    selection: SelfTestSelectionSchema,
  }),
]);
export type SelfTestCommand = z.infer<typeof SelfTestCommandSchema>;

const token = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/u);
const SelfTestStepSchema = z.strictObject({
  name: z.enum([
    "scratch",
    "write",
    "edit",
    "mutation read",
    "catalogue",
    "bootstrap",
    "list",
    "read",
    "search",
    "cleanup",
    "shell",
    "shell cancel",
    "workspace reads",
    "directory search",
    "git and hooks",
  ]),
  status: z.enum(["pass", "fail", "unknown", "not_tested"]),
  code: token.optional(),
  operationId: token.optional(),
  handle: token.optional(),
  cancelOperationId: token.optional(),
  descendantCleanup: z.enum(["pending", "confirmed", "unverified"]).optional(),
});
const report = z.strictObject({
  operationId: operation,
  workspaceId: workspace,
  computerGeneration: decimal,
  planVersion: z.enum(["1", "2"]).optional(),
  status: z.enum(["partial", "fail", "unknown"]),
  steps: z.array(SelfTestStepSchema).max(16),
});
const observation = z
  .strictObject({
    selection: SelfTestSelectionSchema,
    state: z.enum(["observed", "unknown"]),
    report: report.optional(),
  })
  .refine(
    (value) =>
      !value.report ||
      (value.report.operationId === value.selection.operationId &&
        value.report.workspaceId === value.selection.workspaceId &&
        value.report.computerGeneration ===
          value.selection.computerGeneration &&
        (value.report.planVersion ?? "1") === value.selection.planVersion),
  );
const markerEntry = z.strictObject({
  selection: SelfTestSelectionSchema,
  phase: z.enum(["selected", "settling", "settled"]),
});
const historyEntry = z.strictObject({
  selection: SelfTestSelectionSchema,
  phase: z.enum(["prepared", "completed", "failed", "outcome_unknown"]),
});
const history = z.strictObject({
  markers: z.array(markerEntry).max(256),
  records: z.array(historyEntry).max(256),
  unresolved: z.array(SelfTestSelectionSchema).max(512),
  pending: SelfTestSelectionSchema.optional(),
});
export const SelfTestResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      "SELF_TEST_INVALID_REQUEST",
      "SELF_TEST_UNAVAILABLE",
      "SELF_TEST_START_UNCONFIRMED",
    ]),
    selection: SelfTestSelectionSchema.optional(),
  }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("history"), history }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.enum(["start", "observe"]),
    observation,
  }),
]);
export type SelfTestResponse = z.infer<typeof SelfTestResponseSchema>;
