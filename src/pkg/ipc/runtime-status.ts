import { z } from "zod";

export const RuntimeStatusSchema = z.strictObject({
  state: z.enum(["starting", "ready", "offline", "failed"]),
  error: z.string().nullable(),
  identity: z.string().nullable(),
  embeddedNode: z.string().nullable(),
  embeddedElectron: z.string().nullable(),
});

export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const BrowserRouteStatusSchema = z.strictObject({
  state: z.enum(["loading", "loaded", "failed"]),
});

export type BrowserRouteStatus = z.infer<typeof BrowserRouteStatusSchema>;

export const BrowserHistoryStateSchema = z.strictObject({
  taskId: z.string().max(200),
  back: z.boolean(),
  forward: z.boolean(),
});
export const BrowserHistoryReplySchema = BrowserHistoryStateSchema.extend({
  handled: z.boolean(),
});
