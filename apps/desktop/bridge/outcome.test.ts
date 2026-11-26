import { describe, expect, it } from "vitest";
import { encode, explainReadOnlyRefusal } from "./outcome.ts";

describe("encode", () => {
  it("mirrors the value as text and structured content", () => {
    const result = encode({ status: "ok" });
    expect(result.content).toEqual([{ type: "text", text: '{"status":"ok"}' }]);
    expect(result.structuredContent).toEqual({ status: "ok" });
    expect("isError" in result).toBe(false);
  });
  it("marks errors", () => {
    expect(encode({ status: "unknown" }, true).isError).toBe(true);
  });
});

describe("explainReadOnlyRefusal", () => {
  it("adds advice only to the exact read-only refusal", () => {
    const refused = { status: "refused", refusalReason: "workspace_read_only" };
    const out = explainReadOnlyRefusal(refused, "Main", "removed") as {
      message?: string;
    };
    expect(out.message).toContain("Nothing was removed.");
    expect(out.message).toContain("Main");
    expect(explainReadOnlyRefusal(refused, "Main")).toHaveProperty("message");
  });
  it("leaves every other outcome untouched", () => {
    const other = [
      { status: "refused", refusalReason: "path" },
      { status: "unknown", refusalReason: "workspace_read_only" },
      { status: "ok" },
    ];
    for (const value of other)
      expect(explainReadOnlyRefusal(value, "Main")).toBe(value);
  });
});
