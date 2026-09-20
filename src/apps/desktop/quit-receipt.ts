import { z } from "zod";

// The private receipt the desktop writes at the end of every quit drain
// (`main.ts`'s `recordQuitReceipt`) and the promotion CLI reads back
// (`tooling/promotion-obligations.mjs`). One module owns the bytes on both
// sides: the writer serializes through `serializeQuitReceipt`, the reader
// validates against `QuitReceiptSchema`, so the two cannot disagree about a
// field again. Before this module existed the desktop wrote `at` and the
// reader's strict schema had no `at`, so every real receipt read as
// MALFORMED and `--apply` was refused for good after the first clean quit.
//
// Plain module by design: no class, no parameter properties, no enum, no
// relative import, so Node's unflagged type stripping can load it from the
// `.mjs` CLI exactly as `product-settings/contract.ts` is loaded today.

export const QUIT_RECEIPT_FILE_NAME = "last-quit.json";

// Bounds the read on both sides. A receipt names at most a few dozen owned
// children by their short registered names; anything larger is not a receipt
// this app wrote, whatever it parses as.
export const MAX_QUIT_RECEIPT_BYTES = 8 * 1_024;
export const MAX_UNCONFIRMED_CHILDREN = 32;
export const MAX_CHILD_NAME_LENGTH = 80;

const canonicalTimestampSchema = z
  .string()
  .max(64)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  });

export const QuitReceiptSchema = z.strictObject({
  schema: z.literal(1),
  // When the drain settled, as the desktop's clock saw it.
  at: canonicalTimestampSchema,
  drained: z.boolean(),
  // Owned children whose exit was not confirmed before the deadline, or
  // whose close failed. Empty exactly when `drained` is true.
  unconfirmed: z
    .array(z.string().min(1).max(MAX_CHILD_NAME_LENGTH))
    .max(MAX_UNCONFIRMED_CHILDREN),
});

export type QuitReceipt = z.infer<typeof QuitReceiptSchema>;

export type QuitReceiptInput = Readonly<{
  drained: boolean;
  unconfirmed: readonly string[];
}>;

export type QuitReceiptParse =
  | Readonly<{ ok: true; receipt: QuitReceipt }>
  | Readonly<{
      ok: false;
      reason: "OVERSIZED" | "CORRUPT" | "UNKNOWN_VERSION" | "MALFORMED";
    }>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The exact bytes the desktop stores: one JSON object, keys in schema order
 * (`schema`, `at`, `drained`, `unconfirmed`), one trailing newline. Refuses
 * an input the schema would not read back, so the writer can never store a
 * receipt the reader then calls malformed.
 */
export function serializeQuitReceipt(
  receipt: QuitReceiptInput,
  at: string,
): string {
  const validated = QuitReceiptSchema.parse({
    schema: 1,
    at,
    drained: receipt.drained,
    unconfirmed: [...receipt.unconfirmed],
  });
  const serialized = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_QUIT_RECEIPT_BYTES) {
    throw new Error("QUIT_RECEIPT_TOO_LARGE");
  }
  return serialized;
}

/**
 * Reads the bytes back with the reasons the promotion reader reports: a
 * schema literal other than 1 on an otherwise plain object is a version this
 * reader does not know; everything else the schema refuses is malformed.
 */
export function parseQuitReceipt(text: string): QuitReceiptParse {
  if (Buffer.byteLength(text, "utf8") > MAX_QUIT_RECEIPT_BYTES) {
    return { ok: false, reason: "OVERSIZED" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "CORRUPT" };
  }
  const parsed = QuitReceiptSchema.safeParse(value);
  if (parsed.success) return { ok: true, receipt: parsed.data };
  if (
    isPlainObject(value) &&
    value["schema"] !== undefined &&
    value["schema"] !== 1
  ) {
    return { ok: false, reason: "UNKNOWN_VERSION" };
  }
  return { ok: false, reason: "MALFORMED" };
}
