import { z } from "zod";

export const IdentifierSchema = z.string().min(1).max(120);

export function relativePath(value: string, root: boolean): boolean {
  if (root && value === ".") return true;
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  ) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

export const FileRelativePathSchema = z
  .string()
  .refine((value) => relativePath(value, false));
export const ScopeRelativePathSchema = z
  .string()
  .refine((value) => relativePath(value, true));
export const SearchPatternSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    }),
  );

export const ListInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopeRelativePathSchema,
});
export const BootstrapInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativeDirectory: ScopeRelativePathSchema,
});
export const GuidanceSearchInputSchema = z.strictObject({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(16).optional(),
});
export const GuidanceFetchInputSchema = z.strictObject({
  id: z.string().min(1).max(120),
});
// A file over the whole-read ceiling is read window by window. Either field
// asks for a window; the other then takes its default.
export const DEFAULT_READ_WINDOW_BYTES = 64 * 1_024;
export const ReadInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: FileRelativePathSchema,
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  length: z
    .number()
    .int()
    .min(4)
    .max(256 * 1_024)
    .optional(),
});
export const SearchInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  relativePath: ScopeRelativePathSchema,
  pattern: SearchPatternSchema,
});
export const VerificationInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
});
export const ConnectorVerificationInputSchema = z.strictObject({
  challenge: z
    .string()
    .min(1)
    .max(160)
    .refine((value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && code >= 33 && code <= 126;
      }),
    ),
  workspaceId: IdentifierSchema,
});
export const MutationTextSchema = z
  .string()
  .max(8 * 1_024 * 1_024)
  .refine((value) => !value.includes("\0"));
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const WriteInputSchema = z.strictObject({
  operationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativePath: FileRelativePathSchema,
  content: MutationTextSchema,
  expectedSha256: Sha256Schema.nullable(),
});
export const EditInputSchema = z.strictObject({
  operationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativePath: FileRelativePathSchema,
  edits: z
    .array(
      z
        .strictObject({
          oldText: MutationTextSchema.min(1),
          newText: MutationTextSchema,
        })
        .refine((edit) => edit.oldText !== edit.newText),
    )
    .min(1)
    .max(256),
  expectedSha256: Sha256Schema,
});
export const ShellStartInputSchema = z.strictObject({
  operationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativeCwd: ScopeRelativePathSchema,
  command: z
    .string()
    .min(1)
    .max(16 * 1024),
  stdin: z
    .string()
    .max(1024 * 1024)
    .optional(),
  timeoutMs: z.number().int().min(1).max(600_000),
  write: z.boolean(),
});
export const ShellReadInputSchema = z.strictObject({
  handle: z.string().uuid(),
  stdoutOffset: z.number().int().nonnegative(),
  stderrOffset: z.number().int().nonnegative(),
});
export const ShellCancelInputSchema = z.strictObject({
  handle: z.string().uuid(),
});
