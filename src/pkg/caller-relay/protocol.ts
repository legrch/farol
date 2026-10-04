import { z } from "zod";

export const CALLER_RELAY_PROTOCOL = "farol-next-caller-relay/v1" as const;
export const CALLER_RELAY_MAX_FRAME_BYTES = 768 * 1_024;

const HexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdentifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[0-9A-Za-z._:-]+$/u);
const ToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/u);

export const CodexCallerRelayEndpointSchema = z.strictObject({
  protocol: z.literal(CALLER_RELAY_PROTOCOL),
  socketPath: z.string().min(1).max(4_096),
  token: z
    .string()
    .min(32)
    .max(512)
    .refine((value) => !/[\0\r\n]/u.test(value)),
});

const DescribeOperationSchema = z.strictObject({
  operation: z.literal("describe"),
  ticket: HexDigestSchema,
  binding: HexDigestSchema,
});

const InvokeOperationSchema = z.strictObject({
  operation: z.literal("invoke"),
  ticket: HexDigestSchema,
  binding: HexDigestSchema,
  operationId: IdentifierSchema,
  name: ToolNameSchema,
  namespace: ToolNameSchema.nullable(),
  arguments: z.record(z.string(), z.unknown()),
});

export const CodexCallerRelayOperationSchema = z.discriminatedUnion(
  "operation",
  [DescribeOperationSchema, InvokeOperationSchema],
);

// Private wire receipt is intentionally excluded from the model-callable
// CodexCallerRelayOperationSchema and public response/structuredContent surface.
export const CodexCallerRelayReceiptSchema = z.strictObject({
  operationId: IdentifierSchema,
  binding: HexDigestSchema,
  requestSHA256: HexDigestSchema,
  receiptId: HexDigestSchema,
  outputSHA256: HexDigestSchema,
  outputBytes: z.number().int().min(0).max(CALLER_RELAY_MAX_FRAME_BYTES),
});
const ReceivedRequestSchema = CodexCallerRelayReceiptSchema.extend({
  operation: z.literal("received"),
  ticket: HexDigestSchema,
  token: z.string(),
});

export const CodexCallerRelayRequestSchema = z.discriminatedUnion("operation", [
  DescribeOperationSchema.extend({ token: z.string() }),
  InvokeOperationSchema.extend({ token: z.string() }),
  ReceivedRequestSchema,
]);

const ErrorSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/u),
  retry: z.literal("never"),
});

const ToolDescriptorSchema = z.strictObject({
  name: ToolNameSchema,
  namespace: ToolNameSchema.nullable(),
  description: z.string().nullable(),
  parameters: z.unknown(),
});

const UnsupportedDescriptorSchema = z.strictObject({
  type: ToolNameSchema,
  name: ToolNameSchema.nullable(),
});

const SuccessSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ok: z.literal(true),
    operation: z.literal("describe"),
    catalogue: z.strictObject({
      fingerprint: HexDigestSchema,
      tools: z.array(ToolDescriptorSchema).max(512),
      unsupported: z.array(UnsupportedDescriptorSchema).max(512),
    }),
  }),
  z.strictObject({
    ok: z.literal(true),
    operation: z.literal("invoke"),
    operationId: IdentifierSchema,
    output: z.string().max(512 * 1_024),
  }),
]);

export const CodexCallerRelayResponseSchema = z.union([
  SuccessSchema,
  z.strictObject({ ok: z.literal(false), error: ErrorSchema }),
]);

export type CodexCallerRelayEndpoint = z.infer<
  typeof CodexCallerRelayEndpointSchema
>;
export type CodexCallerRelayOperation = z.infer<
  typeof CodexCallerRelayOperationSchema
>;
export type CodexCallerRelayRequest = z.infer<
  typeof CodexCallerRelayRequestSchema
>;
export type CodexCallerRelayResponse = z.infer<
  typeof CodexCallerRelayResponseSchema
>;

// Only the trusted client/server wire parser sees these private fields. The
// client strips them before returning a CodexCallerRelayResponse to MCP.
export const CodexCallerRelayWireResponseSchema = z.union([
  SuccessSchema.options[1].extend({ receipt: CodexCallerRelayReceiptSchema }),
  z.strictObject({
    ok: z.literal(true),
    operation: z.literal("received"),
    operationId: IdentifierSchema,
    receiptId: HexDigestSchema,
  }),
  CodexCallerRelayResponseSchema,
]);
export type CodexCallerRelayReceipt = z.infer<
  typeof CodexCallerRelayReceiptSchema
>;
export type CodexCallerRelayWireResponse = z.infer<
  typeof CodexCallerRelayWireResponseSchema
>;
