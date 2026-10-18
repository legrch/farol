import { z } from "zod";

// Renderer-safe presentation only. It contains neither bindings nor authority.
export const ConnectionStatusViewSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum([
    "recent_transport",
    "checking",
    "reconnecting",
    "unavailable",
    "unobserved",
    "action_required",
    "stopped",
  ]),
  marker: z.enum(["✓", "…", "↻", "!", "?", "–"]),
  label: z.string().max(160),
  detail: z.string().max(512),
  delivery: z.string().max(256),
  attention: z.boolean(),
});
export type ConnectionStatusView = z.infer<typeof ConnectionStatusViewSchema>;
export const unavailableConnectionStatus: ConnectionStatusView = Object.freeze({
  revision: 0,
  state: "unobserved",
  marker: "?",
  label: "Connection observation unavailable",
  detail:
    "No current server observation. Local readiness alone does not confirm the connection.",
  delivery: "External attachment has not been confirmed.",
  attention: true,
});
