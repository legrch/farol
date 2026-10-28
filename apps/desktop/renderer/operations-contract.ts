import { z } from "zod";
import {
  operationKinds,
  recordableOperationCodes,
} from "./operations-vocabulary.ts";

export const operationSources = [
  "ChatGPT",
  "Setup",
  "You",
  "Updater",
  "Codex",
] as const;
export const operationOutcomes = [
  "done",
  "refused",
  "failed",
  "unknown",
  "pending",
] as const;
const WorkspaceIdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\p{L}\p{M}\p{N} ._()@-]+$/u);

const unrepresentable = "[unrepresentable]";
// Bound untrusted input before scanning; display limits include the ellipsis.
function ownerText(
  value: unknown,
  limit: number,
  relativePath = false,
): string {
  if (typeof value !== "string" || value.length > 16384) return unrepresentable;
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  if (!text || /\p{Cs}/u.test(text)) return unrepresentable;
  if (
    relativePath &&
    text !== "." &&
    (text.startsWith("/") ||
      text.includes("\\") ||
      text.split("/").some((part) => !part || part === "." || part === ".."))
  )
    return unrepresentable;
  return text.length <= limit
    ? text
    : text.slice(0, limit - 1).replace(/\p{Cs}$/u, "") + "…";
}

export const OperationLabelSchema = z.preprocess(
  (value) => ownerText(value, 160),
  z.string(),
);
export const OperationTargetSchema = z.strictObject({
  workspace: OperationLabelSchema.optional(),
  // Opaque binding to owner configuration; never supplied by operation callers.
  workspaceIdentity: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  relativePath: z
    .preprocess((value) => ownerText(value, 4096, true), z.string())
    .optional(),
  // Command text is never retained, including when reading older records.
  command: z
    .preprocess(
      (value) => (value === "git" ? "git" : "other"),
      z.enum(["git", "other"]),
    )
    .optional(),
  // Unmatched tool-supplied handles have no trusted metadata provenance.
  handle: z.literal("unrecognized").optional(),
  start: z.literal("unknown").optional(),
});
export const OperationMetadataSchema = z.strictObject({
  source: z.enum(operationSources),
  kind: z.enum(operationKinds),
  target: OperationTargetSchema,
});
export const OperationOutcomeSchema = z.enum(operationOutcomes);
export const OperationDurationSchema = z.number().int().nonnegative().safe();
const OperationEntryV1Schema = z.strictObject({
  id: z.string().uuid(),
  at: z.number().int().nonnegative().safe(),
  ...OperationMetadataSchema.shape,
  outcome: OperationOutcomeSchema,
  code: z.enum(recordableOperationCodes).nullable(),
  durationMs: OperationDurationSchema,
  lifecycle: z
    .strictObject({
      id: z.string().uuid(),
      phase: z.enum(["started", "observed"]),
    })
    .optional(),
});
// V2 deliberately carries only bounded identities and observed facts. Command
// text and process output require the separately qualified redaction boundary.
const ExecutionIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
export const OperationReferenceSchema = z.strictObject({
  owner: z.enum(["computer.process", "computer.mutation", "release"]),
  operationId: ExecutionIdentifierSchema,
  buildId: ExecutionIdentifierSchema.max(120),
  runtimeId: ExecutionIdentifierSchema.max(120),
  // Added for host-lifetime observation; older history has no such binding.
  backendGeneration: ExecutionIdentifierSchema.max(120).optional(),
  binding: z.enum(["requested", "accepted"]),
});
export type OperationReference = z.infer<typeof OperationReferenceSchema>;
export type ExecutionReferences = Readonly<{
  operationRef: OperationReference | null;
  subjectRef: OperationReference | null;
}>;
const CleanupSchema = z.enum(["pending", "confirmed", "unverified"]);
// Local-only excerpts arrive from the Go filter; closed states prohibit text
// on withheld/unavailable values. The display boundary checks bytes and control
// characters again and never treats these fields as support-export metadata.
const AuditTextSchema = z
  .string()
  .refine(
    (value) =>
      value.length <= 2048 &&
      new TextEncoder().encode(value).length <= 2048 &&
      !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(
        value.replaceAll("\n", "").replaceAll("\t", ""),
      ),
  );
const AuditExcerptSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("filtered"),
    text: AuditTextSchema.optional(),
  }),
  z.strictObject({
    state: z.literal("filtered-truncated"),
    text: AuditTextSchema,
  }),
  z.strictObject({
    state: z.literal("withheld"),
    reason: z.enum([
      "invalid_utf8",
      "source_too_large",
      "ambiguous_control",
      "inline_body",
      "entry_limit",
    ]),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum([
      "filter_failed",
      "filter_unavailable",
      "source_incomplete",
    ]),
  }),
]);
export const AuditDetailsSchema = z.strictObject({
  command: AuditExcerptSchema,
  stdout: AuditExcerptSchema,
  stderr: AuditExcerptSchema,
});
const OperationEntryV2Schema = OperationEntryV1Schema.extend({
  schema: z.literal("farol.operation/2"),
  // Terminal observations can arrive without a measured duration.
  durationMs: OperationDurationSchema.nullable(),
  operationRef: OperationReferenceSchema.nullable(),
  subjectRef: OperationReferenceSchema.nullable(),
  timing: z
    .strictObject({
      requestedAt: OperationDurationSchema,
      startedAt: OperationDurationSchema.nullable(),
      endedAt: OperationDurationSchema.nullable(),
    })
    .nullable(),
  exit: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("code"),
        value: z.number().int().min(0).max(255),
      }),
      z.strictObject({
        kind: z.literal("signal"),
        value: z.number().int().min(1).max(128),
      }),
    ])
    .nullable(),
  executionFacts: z
    .strictObject({
      rootWaited: z.boolean(),
      outputDrained: z.boolean(),
      groupCleanup: CleanupSchema,
      descendantCleanup: CleanupSchema,
      timedOut: z.boolean(),
      authorityLost: z.boolean(),
    })
    .nullable(),
  auditDetails: AuditDetailsSchema.optional(),
});
// strict V1 prevents unknown future schema versions from being read as V1.
export const OperationEntrySchema = z.union([
  OperationEntryV1Schema,
  OperationEntryV2Schema,
]);
export type OperationEntry = z.infer<typeof OperationEntrySchema>;
/** Adapter workspace values are unresolved IDs, never display labels. The
 * recorder resolves them against owner configuration before any sink sees them. */
export type OperationMetadata = Pick<OperationEntry, "source"> & {
  kind: string;
  target: Omit<
    OperationEntry["target"],
    "command" | "handle" | "workspaceIdentity"
  > & {
    command?: string | undefined;
    handle?: string | undefined;
  };
};
export const OperationWorkspaceLabelsSchema = z
  .array(
    z.strictObject({
      workspaceId: WorkspaceIdentifierSchema,
      label: OperationLabelSchema,
    }),
  )
  .max(128);
export const OperationsDiagnosticsSchema = z.strictObject({
  unmappedCodes: z.number().int().nonnegative().safe().default(0),
  writeFailures: z.number().int().nonnegative().safe(),
  droppedEntries: z.number().int().nonnegative().safe().default(0),
  unrecordedUncertainEntries: z.number().int().nonnegative().safe().default(0),
});
export const OperationsSnapshotSchema = z.strictObject({
  ...OperationsDiagnosticsSchema.shape,
  // Current writer memory only; never recovered from persisted entries.
  activeLifecycleIds: z.array(z.string().uuid()).max(20000).optional(),
  // Current host presentation only; never journal evidence or launch authority.
  connectionChecking: z.boolean().optional(),
  // A bounded read has not finished; cached rows may be stale.
  readPending: z.boolean().optional(),
  // A current segment could not be read completely; historical diagnostics
  // alone do not imply that the present snapshot is incomplete.
  readIncomplete: z.boolean().optional(),
  entries: z.array(OperationEntrySchema).max(20000),
  corruptLines: z.number().int().nonnegative().safe(),
});
export type OperationsSnapshot = z.infer<typeof OperationsSnapshotSchema>;
/** Injected at the adapter which owns the operation. Never accepts payloads.
 * Implementations must be total observers: use createTotalOperationsRecorder
 * at the recorder boundary so no method or finish handle throws or rejects. */
export interface OperationsRecorder {
  beginExecution?(
    metadata: OperationMetadata,
    references: ExecutionReferences,
  ): (
    outcome: OperationEntry["outcome"],
    code: string | null,
    durationMs: number,
  ) => void;
  begin?(
    metadata: OperationMetadata,
  ): (
    outcome: OperationEntry["outcome"],
    code: string | null,
    durationMs: number,
  ) => void;
  record(
    metadata: OperationMetadata,
    outcome: OperationEntry["outcome"],
    code: string | null,
    durationMs: number,
  ): void;
}
