import { z } from "zod";
import { canonicalJson } from "../../../src/apps/desktop/codex-native-tool-registry";
import { digest } from "./identity";

// The shape of a Responses request the provider accepts, and what binds a
// continuation to the request that began its turn.

export const MAX_TOOLS = 512;

const identitySchema = z
  .object({
    session_id: z.string().min(1).max(160),
    thread_id: z.string().min(1).max(160),
    turn_id: z.string().min(1).max(160),
    root_turn_id: z.string().min(1).max(160),
  })
  .passthrough();

export const responseRequestSchema = z
  .object({
    model: z.string().min(1).max(160),
    stream: z.literal(true),
    store: z.literal(false).optional(),
    input: z.union([z.string(), z.array(z.unknown())]),
    tools: z.array(z.unknown()).max(MAX_TOOLS),
    client_metadata: identitySchema,
    previous_response_id: z.null().optional(),
  })
  .passthrough();

export type ResponseRequest = z.infer<typeof responseRequestSchema>;

export function identityFromRequest(data: ResponseRequest): Readonly<{
  sessionId: string;
  threadId: string;
  turnId: string;
  rootTurnId: string;
}> {
  return {
    sessionId: data.client_metadata.session_id,
    threadId: data.client_metadata.thread_id,
    turnId: data.client_metadata.turn_id,
    rootTurnId: data.client_metadata.root_turn_id,
  };
}

export function bindingFingerprint(data: ResponseRequest): string {
  return digest(
    canonicalJson({
      model: data.model,
      identity: identityFromRequest(data),
    }),
  );
}
