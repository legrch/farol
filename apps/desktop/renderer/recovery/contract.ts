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
    computer: z.enum(["available", "unavailable"]),
  }),
]);
export type RecoveryState = z.infer<typeof RecoveryStateSchema>;
export const RecoveryReadRequestSchema = z.strictObject({
  kind: z.enum(["list", "metadata"]),
  workspaceId: z.string().uuid(),
  relativePath: z.string().min(1).max(4096),
});
export type RecoveryReadRequest = z.infer<typeof RecoveryReadRequestSchema>;
const result = z.discriminatedUnion("kind", [
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
