import { describe, expect, it } from "vitest";
import { streamedCompactionRequest } from "../../src/apps/desktop/codex-chatgpt-provider";

describe("header-only compaction dispatch", () => {
  it("routes a declared summary to the codec instead of ordinary tool execution", () => {
    const body = { input: [{ role: "user", content: "Synthetic history" }] };
    expect(
      streamedCompactionRequest(
        body,
        JSON.stringify({ request_kind: "compaction" }),
      ),
    ).toBe(true);
    expect(
      streamedCompactionRequest(body, JSON.stringify({ request_kind: "turn" })),
    ).toBe(false);
    expect(streamedCompactionRequest(body, "malformed")).toBe(false);
    expect(
      streamedCompactionRequest(
        { input: "malformed summary history" },
        JSON.stringify({ request_kind: "compaction" }),
      ),
    ).toBe(true);
  });
});
