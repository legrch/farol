import { z } from "zod";

// Decimal strings are deliberate: JavaScript numbers lose precision above 2^53.
// Limit length before converting to BigInt even if a caller supplies untrusted
// oversized input. No normalization, defaults, or implicit number conversion.
const canonicalUnsignedDecimal = (maximum: bigint, allowZero: boolean) => {
  const maxDigits = maximum.toString().length;
  return z
    .string()
    .max(maxDigits)
    .refine((value) => {
      if (
        value.length === 0 ||
        value.length > maxDigits ||
        !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
        (!allowZero && value === "0")
      )
        return false;
      return BigInt(value) <= maximum;
    });
};

const canonicalVolumeUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000");

// Use exactly the existing Settings validators for owner IDs, approved paths,
// timestamps and digests. This only parses persisted, untrusted evidence;
// neither parsing nor a matching tuple establishes Computer authority.
export function workspaceContinuitySchema(
  identifier: z.ZodType<string>,
  absolutePath: z.ZodType<string>,
  timestamp: z.ZodType<string>,
  sha256: z.ZodType<string>,
) {
  return z.strictObject({
    schema: z.literal("farol.workspace-continuity/1"),
    computerId: identifier,
    workspaceId: identifier,
    root: absolutePath,
    filesystem: z.literal("apfs"),
    volumeUuid: canonicalVolumeUuid,
    fileId: canonicalUnsignedDecimal(18_446_744_073_709_551_615n, false),
    birthSeconds: canonicalUnsignedDecimal(9_223_372_036_854_775_807n, true),
    birthNanoseconds: canonicalUnsignedDecimal(999_999_999n, true),
    enrollment: z.strictObject({
      operationId: identifier,
      selectedAt: timestamp,
      policySha256: sha256,
    }),
  });
}
