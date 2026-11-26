import { describe, expect, it } from "vitest";
import { guidanceResult, refusalResult, taskResponse } from "./envelope";

describe("tool envelopes", () => {
  it("omits the error flag unless asked", () => {
    const value = { status: "a" };
    expect(taskResponse(value)).toEqual({
      content: [{ type: "text", text: '{"status":"a"}' }],
      structuredContent: value,
    });
    expect(taskResponse(value).isError).toBeUndefined();
    expect(taskResponse(value, true).isError).toBe(true);
  });

  it("keeps the value itself as structured content", () => {
    const value = { status: "a" };
    expect(taskResponse(value).structuredContent).toBe(value);
  });

  it("copies a refusal and always flags it", () => {
    const value = { ok: false };
    const result = refusalResult(value);
    expect(result.structuredContent).toEqual(value);
    expect(result.structuredContent).not.toBe(value);
    expect(result.isError).toBe(true);
  });

  it("flags a guidance answer only when not ok", () => {
    expect(guidanceResult({ ok: true }).isError).toBeUndefined();
    expect(guidanceResult({ ok: false }).isError).toBe(true);
  });
});
