import { z } from "zod";
import { validate, validUnicode } from "./wire.ts";

export const IdentifierSchema = z.string().min(1).max(120);
export function relativePath(value: string, root: boolean): boolean {
  if (root && value === ".") return true;
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  )
    return false;
  return value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}
export const ScopePathSchema = z
  .string()
  .refine((value) => relativePath(value, true));
export const ListInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopePathSchema,
});
export const SearchInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopePathSchema,
  pattern: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        validUnicode(value) &&
        Buffer.byteLength(value, "utf8") <= 4096 &&
        !/[\u0000-\u001f\u007f]/u.test(value),
    ),
});
export const BootstrapInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativeDirectory: ScopePathSchema,
});
export const ReadInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: z.string().refine((value) => relativePath(value, false)),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  length: z.number().int().min(4).max(262144).optional(),
});
export const ReadDiagnosticInputSchema = z.strictObject({
  requestId: z.string().uuid(),
  workspaceId: IdentifierSchema,
  relativePath: z.string().refine((value) => relativePath(value, false)),
});
const MutationTextSchema = z
  .string()
  .refine(
    (value) =>
      validUnicode(value) &&
      !value.includes("\0") &&
      Buffer.byteLength(value, "utf8") <= 262144,
  );
export const MutationTargetSchema = {
  operationId: z.string().refine((value) => validate("id", value)),
  workspaceId: IdentifierSchema,
  relativePath: z.string().refine((value) => relativePath(value, false)),
};
export const RemoveInputSchema = z.strictObject({
  ...MutationTargetSchema,
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const ProcessIDSchema = z
  .string()
  .refine((value) => validate("id", value));
export const ProcessTargetSchema = {
  operationId: ProcessIDSchema,
  handle: ProcessIDSchema,
};
export const ProcessOffsetSchema = z
  .number()
  .int()
  .min(0)
  .max(4 * 1024 * 1024);
export const ProcessStartSchema = z.strictObject({
  operationId: ProcessIDSchema,
  workspaceId: IdentifierSchema,
  relativeCwd: ScopePathSchema,
  command: z
    .string()
    .min(1)
    .refine(
      (value) =>
        validUnicode(value) &&
        !value.includes("\0") &&
        Buffer.byteLength(value, "utf8") <= 65536,
    ),
  stdin: z
    .string()
    .refine(
      (value) =>
        validUnicode(value) && Buffer.byteLength(value, "utf8") <= 262144,
    )
    .optional(),
  write: z.boolean(),
});
export const WriteInputSchema = z.strictObject({
  ...MutationTargetSchema,
  content: MutationTextSchema,
  expectedSha256: HashSchema.nullable(),
});
export const EditInputSchema = z.strictObject({
  ...MutationTargetSchema,
  expectedSha256: HashSchema,
  edits: z
    .array(
      z
        .strictObject({
          oldText: MutationTextSchema,
          newText: MutationTextSchema,
        })
        .refine((edit) => edit.oldText !== "" && edit.oldText !== edit.newText),
    )
    .min(1)
    .max(256)
    .refine(
      (edits) =>
        edits.reduce(
          (bytes, edit) =>
            bytes +
            Buffer.byteLength(edit.oldText, "utf8") +
            Buffer.byteLength(edit.newText, "utf8"),
          0,
        ) <= 262144,
    ),
});
export const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
