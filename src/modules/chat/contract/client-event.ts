import { z } from "zod";

const identity = {
  ownerId: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(80),
  taskId: z.string().min(1).max(80),
  turnId: z.string().min(1).max(80),
  generation: z.number().int().nonnegative(),
  at: z.number().finite(),
};

const phase = z.enum([
  "prepared",
  "submit_activated",
  "running",
  "tool_wait",
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
]);

// A terminal event ends the turn for every consumer, so it may only name a
// phase that is itself terminal.
const terminalPhase = z.enum([
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
]);

export const ClientEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...identity, kind: z.literal("turn.phase"), phase }),
  z.strictObject({
    ...identity,
    kind: z.literal("text.delta"),
    sequence: z.number().int().positive(),
    text: z.string().min(1).max(16_384),
  }),
  z.strictObject({
    ...identity,
    kind: z.literal("computer.requested"),
    callId: z.string().min(1).max(120),
    operation: z.enum([
      "workspace.read",
      "workspace.list",
      "workspace.search",
      "verification.run",
    ]),
  }),
  z.strictObject({
    ...identity,
    kind: z.literal("computer.completed"),
    callId: z.string().min(1).max(120),
  }),
  z.strictObject({
    ...identity,
    kind: z.literal("client.delivery_acknowledged"),
    deliveryId: z.number().int().positive(),
    deliveredKind: z.enum([
      "turn.phase",
      "text.delta",
      "computer.requested",
      "computer.completed",
      "turn.terminal",
    ]),
    phase,
    sequence: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    ...identity,
    kind: z.literal("turn.terminal"),
    phase: terminalPhase,
    code: z.string().min(1).max(120),
  }),
]);

export type ClientEventDto = z.infer<typeof ClientEventSchema>;
