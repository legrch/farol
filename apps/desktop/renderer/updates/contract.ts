import { z } from "zod";
import { InstalledUpdateViewSchema } from "../../../../src/modules/release/contract/installed-update";

export const updatesChannels = Object.freeze({
  open: "farol:updates:open",
  state: "farol:updates:state",
  projection: "farol:updates:projection",
  intent: "farol:updates:intent",
  command: "farol:updates:command",
  settled: "farol:updates:settled",
  directSettled: "farol:updates:direct-settled",
  close: "farol:updates:close",
});
export const updatesDocumentHash = "#farol-updates";
export function isUpdatesDocument(url: URL): boolean {
  return (
    url.protocol === "file:" &&
    url.hostname === "" &&
    url.pathname.endsWith("/shell.html") &&
    url.search === "" &&
    url.hash === updatesDocumentHash
  );
}

export const UpdatesIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["check", "download", "skip", "later", "recovery"]),
  }),
  z.strictObject({
    kind: z.literal("restart-confirmed"),
    version: z.string().min(1).max(160),
  }),
  z.strictObject({ kind: z.literal("automatic"), enabled: z.boolean() }),
]);
export type UpdatesIntent = z.infer<typeof UpdatesIntentSchema>;
export const UpdatesCommandSchema = z.strictObject({
  sequence: z.number().int().positive(),
  intent: UpdatesIntentSchema,
});
export const UpdatesSettlementSchema = z.strictObject({
  sequence: z.number().int().positive(),
});
export const UpdatesDirectSettlementSchema = z.strictObject({
  operationId: z.string().uuid(),
  outcome: z.enum(["applied", "refused", "unknown"]),
});
export const UpdatesProjectionSchema = z.strictObject({
  update: InstalledUpdateViewSchema,
  installedVersion: z.string().max(160).nullable(),
  outcome: z.enum(["pending", "unknown", "refused", "applied"]).nullable(),
  automaticEnabled: z.boolean(),
  allowed: z.strictObject({
    check: z.boolean(),
    download: z.boolean(),
    skip: z.boolean(),
    later: z.boolean(),
    "restart-confirmed": z.boolean(),
    automatic: z.boolean(),
    recovery: z.boolean(),
  }),
});
export type UpdatesProjection = z.infer<typeof UpdatesProjectionSchema>;
export const UpdatesStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({
    status: z.literal("ready"),
    projection: UpdatesProjectionSchema,
    pending: z.boolean(),
  }),
]);
export type UpdatesState = z.infer<typeof UpdatesStateSchema>;
export type UpdatesAPI = Readonly<{
  state(): Promise<unknown>;
  onState(listener: (value: unknown) => void): () => void;
  intent(value: UpdatesIntent): void;
  close(): void;
}>;
export type UpdatesOwnerAPI = Readonly<{
  openUpdates?(): void;
  publishUpdates?(value: UpdatesProjection): void;
  onUpdatesCommand?(listener: (value: unknown) => void): () => void;
  settleUpdates?(value: { sequence: number }): void;
}>;
