import { z } from "zod";
import {
  operationKinds,
  recordableOperationCodes,
} from "./operations-vocabulary";

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
export const OperationLabelSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\p{L}\p{M}\p{N} ._()@-]+$/u);
export const OperationTargetSchema = z.strictObject({
  workspace: OperationLabelSchema.optional(),
  relativePath: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\p{L}\p{M}\p{N} ._()@/-]+$/u)
    .refine(
      (v) =>
        v === "." ||
        (!v.startsWith("/") &&
          v.split("/").every((s) => s && s !== ".." && s !== ".")),
    )
    .optional(),
  command: z.enum(["git", "other"]).optional(),
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
export type OperationMetadata = Pick<OperationEntry, "source"> & {
  kind: string;
  target: Omit<OperationEntry["target"], "command" | "handle"> & {
    command?: string | undefined;
    handle?: string | undefined;
  };
};
export const OperationWorkspaceLabelsSchema = z
  .array(
    z.strictObject({
      workspaceId: OperationLabelSchema,
      label: OperationLabelSchema,
    }),
  )
  .max(128);
export const OperationsDiagnosticsSchema = z.strictObject({
  writeFailures: z.number().int().nonnegative().safe(),
  droppedEntries: z.number().int().nonnegative().safe().default(0),
  unrecordedUncertainEntries: z.number().int().nonnegative().safe().default(0),
});
export const OperationsSnapshotSchema = z.strictObject({
  ...OperationsDiagnosticsSchema.shape,
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
