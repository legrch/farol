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
export const OperationEntrySchema = z.strictObject({
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
  entries: z.array(OperationEntrySchema).max(20000),
  corruptLines: z.number().int().nonnegative().safe(),
});
export type OperationsSnapshot = z.infer<typeof OperationsSnapshotSchema>;
/** Injected at the adapter which owns the operation. Never accepts payloads.
 * Implementations must be total observers: use createTotalOperationsRecorder
 * at the recorder boundary so no method or finish handle throws or rejects. */
export interface OperationsRecorder {
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
