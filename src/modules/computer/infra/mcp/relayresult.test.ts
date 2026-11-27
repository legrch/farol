import { describe, expect, it } from "vitest";
import { RELAY_UNAVAILABLE, relayResult } from "./relayresult";

describe("caller relay result", () => {
  it("refuses an unavailable relay as an error", () => {
    const result = relayResult(RELAY_UNAVAILABLE);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBe(RELAY_UNAVAILABLE);
  });

  it("returns an invoke output as plain text", () => {
    const response = { ok: true, operation: "invoke", output: "A" } as never;
    expect(relayResult(response).content).toEqual([
      { type: "text", text: "A" },
    ]);
    expect(relayResult(response).isError).toBeUndefined();
  });

  it("returns a described catalogue as JSON", () => {
    const response = {
      ok: true,
      operation: "describe",
      catalogue: { a: 1 },
    } as never;
    expect(relayResult(response).content).toEqual([
      { type: "text", text: '{"a":1}' },
    ]);
  });
});
