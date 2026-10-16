import { z } from "zod";

// A renderer projection only. No saved configuration, credential, publication,
// participant, process handle or normal desktop action crosses this boundary.
const folder = z.strictObject({
  workspaceId: z.string().uuid(),
  label: z.string().max(160),
  root: z.string().max(4096),
});
export const RecoveryStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("settings_unavailable") }),
  z.strictObject({ status: z.literal("closing") }),
  z.strictObject({
    status: z.literal("ready"),
    revision: z.number().int().nonnegative(),
    folders: z.array(folder).max(128),
    computer: z.enum(["starting", "available", "unavailable"]),
    archive: z.enum(["starting", "available", "unavailable"]),
  }),
]);
export type RecoveryState = z.infer<typeof RecoveryStateSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const cursor = z.string().regex(/^(?:[a-f0-9]{64})?$/u);
const text = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .regex(/^[^\p{Cs}]*$/u)
    .refine((value) => new TextEncoder().encode(value).length <= bytes);
const id = text(120)
  .min(1)
  .regex(/^[^\x00-\x20\x7f]+$/u);
export const RecoveryArchiveEntrySchema = z.strictObject({
  key: digest,
  digest,
  backendGeneration: id,
  operationId: id,
  resultId: id,
  conversationId: text(256).regex(/^[^\x00-\x20\x7f]*$/u),
  recordedOutcome: z.enum([
    "completed",
    "refused",
    "failed",
    "cancelled",
    "unknown",
  ]),
  bytes: z.number().int().min(0).max(8192),
});
export type RecoveryArchiveEntry = z.infer<typeof RecoveryArchiveEntrySchema>;
export const RecoveryReadRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["list", "metadata"]),
    workspaceId: z.string().uuid(),
    relativePath: z.string().min(1).max(4096),
  }),
  z.strictObject({ kind: z.literal("archive-list"), after: cursor }),
  z.strictObject({ kind: z.literal("archive-read"), key: digest, digest }),
]);
export type RecoveryReadRequest = z.infer<typeof RecoveryReadRequestSchema>;
const result = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("archive-list"),
    observation: z.literal("stored_unconfirmed"),
    after: cursor,
    entries: z.array(RecoveryArchiveEntrySchema).max(32),
    next: cursor,
    unresolved: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("archive-read"),
    observation: z.literal("stored_unconfirmed"),
    summary: RecoveryArchiveEntrySchema,
    text: text(8192),
  }),
  z.strictObject({
    kind: z.literal("list"),
    relativePath: z.string().min(1).max(4096),
    entries: z.array(z.string().max(256)).max(500),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("metadata"),
    relativePath: z.string().min(1).max(4096),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
]);
export const RecoveryReadResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), data: result }),
  z.strictObject({ status: z.enum(["refused", "unavailable", "unknown"]) }),
]);
export type RecoveryReadResult = z.infer<typeof RecoveryReadResultSchema>;
export type StartupRecoveryAPI = Readonly<{
  state(): Promise<unknown>;
  read(request: unknown): Promise<unknown>;
  quit(): void;
}>;
export const recoveryChannels = Object.freeze({
  state: "farol:startup-recovery:state",
  read: "farol:startup-recovery:read",
  quit: "farol:startup-recovery:quit",
});
