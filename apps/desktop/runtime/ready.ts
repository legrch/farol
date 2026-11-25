import { z } from "zod";

// The one message a started preview runtime sends its parent. Strict, so an
// unknown field is a refusal; the host parses it with the schema, main only
// carries the inferred type for its own runtime owner.

export const readySchema = z.strictObject({
  kind: z.literal("runtime.ready"),
  identity: z.enum([
    "farol-runtime",
    "farol-dev-runtime",
    "farol-owner-preview-runtime",
  ]),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(32),
  tasks: z.array(
    z.strictObject({
      taskId: z.string(),
      ownerId: z.string(),
      sessionId: z.string(),
      turnId: z.string(),
      generation: z.number().int().nonnegative(),
      label: z.string(),
      hasComputer: z.boolean(),
      readToken: z.string().min(32),
    }),
  ),
  embeddedNode: z.string(),
  embeddedElectron: z.string(),
});

export type RuntimeReady = z.infer<typeof readySchema>;
