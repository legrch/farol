import { z } from "zod";

// What the conversation may report while a turn streams: a visible item or a
// text delta, each bounded. The turn checks order and totals itself.

export const visibleItemSchema = z.strictObject({
  sequence: z.number().int().positive(),
  id: z.string().min(1).max(256),
  channel: z.enum(["answer", "commentary", "status"]),
  text: z
    .string()
    .min(1)
    .max(256 * 1_024),
});

export const textDeltaSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  delta: z
    .string()
    .min(1)
    .max(256 * 1_024),
  text: z
    .string()
    .min(1)
    .max(256 * 1_024),
  observedCharacters: z
    .number()
    .int()
    .positive()
    .max(256 * 1_024),
});
