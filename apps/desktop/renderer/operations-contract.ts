import { z } from "zod";

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
const label = z
  .string()
  .max(160)
  .regex(/^[^\x00-\x1f\x7f]*$/u);
export const OperationEntrySchema = z.strictObject({
  id: z.string().uuid(),
  at: z.number().int().nonnegative(),
  source: z.enum(operationSources),
  kind: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._-]+$/u),
  target: z.strictObject({
    workspace: label.optional(),
    relativePath: z
      .string()
      .max(4096)
      .refine(
        (v) =>
          v === "." ||
          (!v.startsWith("/") &&
            !v.includes("\\") &&
            v.split("/").every((s) => s && s !== ".." && s !== ".") &&
            !/[\x00-\x1f\x7f]/u.test(v)),
      )
      .optional(),
    command: z
      .string()
      .max(80)
      .regex(/^[A-Za-z0-9._-]+$/u)
      .optional(),
    handle: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)
      .optional(),
    start: z.literal("unknown").optional(),
  }),
  outcome: z.enum(operationOutcomes),
  code: z
    .string()
    .max(120)
    .regex(/^[A-Za-z0-9._-]+$/u)
    .nullable(),
  durationMs: z.number().int().nonnegative(),
  lifecycle: z
    .strictObject({
      id: z.string().uuid(),
      phase: z.enum(["started", "observed"]),
    })
    .optional(),
});
export type OperationEntry = z.infer<typeof OperationEntrySchema>;
export type OperationMetadata = Pick<
  OperationEntry,
  "source" | "kind" | "target"
>;
export const OperationsDiagnosticsSchema = z.strictObject({
  writeFailures: z.number().int().nonnegative(),
  droppedEntries: z.number().int().nonnegative().default(0),
  unrecordedUncertainEntries: z.number().int().nonnegative().default(0),
});
export const OperationsSnapshotSchema = z.strictObject({
  ...OperationsDiagnosticsSchema.shape,
  entries: z.array(OperationEntrySchema).max(20000),
  corruptLines: z.number().int().nonnegative(),
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
