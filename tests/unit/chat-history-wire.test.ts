import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  knownMethod,
  requiresOperationID,
  validate,
} from "../../apps/desktop/bridge/wire.ts";

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../api/desktop/v1/fixtures/chat-history.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
describe("read-only historical wire", () => {
  it("preserves original counters without a live handle", () => {
    const r = fixture();
    expect(validate("ChatHistoryResult", r)).toBe(true);
    expect(r.binding.taskEpoch).toBe("9007199254740993");
    expect(r.binding.turnGeneration).toBe("18446744073709551615");
    expect(
      validate("ChatHistoryResult", {
        ...r,
        handle: { handleId: "forged", binding: r.binding },
      }),
    ).toBe(false);
    for (const name of ["chat.history.list", "chat.history.result"]) {
      expect(knownMethod(name)).toBe(true);
      expect(requiresOperationID(name)).toBe(false);
    }
  });
  it.each([0, 32, 33])("bounds a page of %i entries", (n) => {
    const { key, binding, resultId, conversationId } = fixture();
    expect(
      validate("ChatHistoryPage", {
        offset: 0,
        total: n,
        entries: Array.from({ length: n }, () => ({
          key,
          binding,
          resultId,
          conversationId,
        })),
      }),
    ).toBe(n <= 32);
  });
  it.each([
    "x".repeat(8191),
    "x".repeat(8192),
    "x".repeat(8193),
    "☀".repeat(2730) + "xx",
    "☀".repeat(2731),
  ])("bounds exact UTF-8 result bytes", (text) => {
    expect(validate("ChatHistoryResult", { ...fixture(), text })).toBe(
      Buffer.byteLength(text) <= 8192,
    );
  });
  it("refuses out-of-range offsets and request-selected authority", () => {
    for (const v of [
      { offset: 1025 },
      { offset: -1 },
      { offset: 0, ownerId: "other" },
    ])
      expect(validate("ChatHistoryListRequest", v)).toBe(false);
    expect(validate("ChatHistoryListRequest", { offset: 1024 })).toBe(true);
  });
});
