import { z } from "zod";

export const SAVED_CHAT_BRIDGE_PROTOCOL = "farol-saved-chat/v1" as const;
// A valid 8,192-byte message can expand to six JSON bytes per input byte.
export const SAVED_CHAT_BRIDGE_MAX_FRAME_BYTES = 64 * 1024;

const UuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

export const SavedChatBridgeEndpointSchema = z.strictObject({
  protocol: z.literal(SAVED_CHAT_BRIDGE_PROTOCOL),
  socketPath: z.string().min(1).max(4096),
  token: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const SavedChatBridgeOperationSchema = z.discriminatedUnion(
  "operation",
  [
    z.strictObject({
      operation: z.literal("create"),
      request: z.strictObject({
        key: UuidSchema,
        title: z.string().min(1).max(80),
        firstMessage: z.string().min(1).max(8192),
      }),
    }),
    z.strictObject({
      operation: z.literal("status"),
      dispatchId: UuidSchema,
      recheck: z.boolean(),
    }),
  ],
);

export const SavedChatBridgeRequestSchema = z.discriminatedUnion("operation", [
  SavedChatBridgeOperationSchema.options[0].extend({ token: z.string() }),
  SavedChatBridgeOperationSchema.options[1].extend({ token: z.string() }),
]);

export const SavedChatBridgeResponseSchema = z.union([
  z.strictObject({
    status: z.literal("verified"),
    dispatchId: UuidSchema,
    conversationUrl: z.string().url(),
    titleVerified: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("refused"),
    dispatchId: UuidSchema,
    code: z.string().regex(/^SAVED_CHAT_[A-Z_]{1,80}$/u),
  }),
  z.strictObject({
    status: z.literal("outcome_unknown"),
    dispatchId: UuidSchema,
  }),
  z.strictObject({ status: z.literal("unknown") }),
]);

export type SavedChatBridgeEndpoint = z.infer<
  typeof SavedChatBridgeEndpointSchema
>;
export type SavedChatBridgeOperation = z.infer<
  typeof SavedChatBridgeOperationSchema
>;
export type SavedChatBridgeResponse = z.infer<
  typeof SavedChatBridgeResponseSchema
>;
