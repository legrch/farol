import { z } from "zod";

export const ComputerCallRequestSchema = z.strictObject({
  ownerId: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(80),
  taskId: z.string().min(1).max(80),
  turnId: z.string().min(1).max(80),
  generation: z.number().int().nonnegative(),
  callId: z.string().min(1).max(120),
  operation: z.literal("inspect_fixture"),
  target: z.literal("synthetic://workspace/status"),
});

export const ComputerCallOutputSchema = z.strictObject({
  kind: z.literal("synthetic-status"),
  label: z.string().min(1).max(120),
  state: z.literal("ready"),
  receipt: z.string().min(1).max(120),
});

export const ComputerCallResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: z.strictObject({
      ownerId: z.string(),
      sessionId: z.string(),
      taskId: z.string(),
      turnId: z.string(),
      generation: z.number().int().nonnegative(),
      callId: z.string(),
      output: ComputerCallOutputSchema,
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.string(),
      retry: z.enum(["never", "safe"]),
    }),
  }),
]);

export type ComputerCallRequest = z.infer<typeof ComputerCallRequestSchema>;
export type ComputerCallResponse = z.infer<typeof ComputerCallResponseSchema>;

export interface ComputerContract {
  execute(request: unknown): Promise<ComputerCallResponse>;
}
