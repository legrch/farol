import { describe, expect, it } from "vitest";
import { serializeQuitReceipt as serializeFromDrain } from "../../src/apps/desktop/quit-drain";
import {
  MAX_CHILD_NAME_LENGTH,
  MAX_QUIT_RECEIPT_BYTES,
  MAX_UNCONFIRMED_CHILDREN,
  QuitReceiptSchema,
  parseQuitReceipt,
  serializeQuitReceipt,
} from "../../src/apps/desktop/quit-receipt";

const at = "2026-09-20T10:00:00.000Z";

describe("quit receipt contract", () => {
  it("serializes exactly the bytes the desktop already wrote, and reads them back", () => {
    const receipt = { drained: false, unconfirmed: ["route-b", "connector"] };
    const bytes = serializeQuitReceipt(receipt, at);
    // `main.ts`'s former inline expression, byte for byte: the contract
    // changes the reader to match the writer, not the writer's bytes.
    expect(bytes).toBe(`${JSON.stringify({ schema: 1, at, ...receipt })}\n`);
    expect(parseQuitReceipt(bytes)).toEqual({
      ok: true,
      receipt: {
        schema: 1,
        at,
        drained: false,
        unconfirmed: ["route-b", "connector"],
      },
    });
    expect(
      parseQuitReceipt(
        serializeQuitReceipt({ drained: true, unconfirmed: [] }, at),
      ),
    ).toEqual({
      ok: true,
      receipt: { schema: 1, at, drained: true, unconfirmed: [] },
    });
    // What `main.ts` imports through `quit-drain.ts` is this very function.
    expect(serializeFromDrain).toBe(serializeQuitReceipt);
  });

  it("refuses to serialize what the reader would not read back", () => {
    const drained = { drained: true, unconfirmed: [] };
    expect(() =>
      serializeQuitReceipt(drained, "2026-09-20T10:00:00Z"),
    ).toThrow();
    expect(() => serializeQuitReceipt(drained, "not a timestamp")).toThrow();
    expect(() => serializeQuitReceipt(drained, "")).toThrow();
    expect(() =>
      serializeQuitReceipt({ drained: false, unconfirmed: [""] }, at),
    ).toThrow();
    expect(() =>
      serializeQuitReceipt(
        {
          drained: false,
          unconfirmed: ["x".repeat(MAX_CHILD_NAME_LENGTH + 1)],
        },
        at,
      ),
    ).toThrow();
    const names = (count: number) =>
      Array.from({ length: count }, (_, index) => `child-${index}`);
    expect(() =>
      serializeQuitReceipt(
        { drained: false, unconfirmed: names(MAX_UNCONFIRMED_CHILDREN + 1) },
        at,
      ),
    ).toThrow();
    // At the bound it serializes, and stays under the byte bound.
    const largest = serializeQuitReceipt(
      {
        drained: false,
        unconfirmed: Array.from({ length: MAX_UNCONFIRMED_CHILDREN }, () =>
          "n".repeat(MAX_CHILD_NAME_LENGTH),
        ),
      },
      at,
    );
    expect(largest.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(largest)).toBeLessThanOrEqual(
      MAX_QUIT_RECEIPT_BYTES,
    );
  });

  it("classifies what it cannot read the way the promotion reader does", () => {
    expect(parseQuitReceipt("{not json")).toEqual({
      ok: false,
      reason: "CORRUPT",
    });
    expect(
      parseQuitReceipt(
        JSON.stringify({ schema: 2, at, drained: true, unconfirmed: [] }),
      ),
    ).toEqual({ ok: false, reason: "UNKNOWN_VERSION" });
    // The shape the reader used to demand, with no `at`: not a receipt the
    // desktop ever wrote.
    expect(
      parseQuitReceipt(
        JSON.stringify({ schema: 1, drained: true, unconfirmed: [] }),
      ),
    ).toEqual({ ok: false, reason: "MALFORMED" });
    expect(
      parseQuitReceipt(
        JSON.stringify({
          schema: 1,
          at,
          drained: true,
          unconfirmed: [],
          extra: 1,
        }),
      ),
    ).toEqual({ ok: false, reason: "MALFORMED" });
    expect(
      parseQuitReceipt(
        JSON.stringify({
          schema: 1,
          at: "2026-09-20T10:00:00Z",
          drained: true,
          unconfirmed: [],
        }),
      ),
    ).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseQuitReceipt("[]")).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseQuitReceipt("null")).toEqual({
      ok: false,
      reason: "MALFORMED",
    });
    expect(parseQuitReceipt(`${" ".repeat(MAX_QUIT_RECEIPT_BYTES)}{}`)).toEqual(
      { ok: false, reason: "OVERSIZED" },
    );
  });

  it("is strict about every field", () => {
    const valid = { schema: 1, at, drained: true, unconfirmed: [] };
    expect(QuitReceiptSchema.safeParse(valid).success).toBe(true);
    for (const broken of [
      { ...valid, drained: "yes" },
      { ...valid, unconfirmed: [1] },
      { ...valid, at: 1_726_000_000_000 },
      { schema: 1, at, drained: true },
    ]) {
      expect(QuitReceiptSchema.safeParse(broken).success).toBe(false);
    }
  });
});
