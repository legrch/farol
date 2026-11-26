import { describe, expect, it } from "vitest";
import { failure, fenced, shellResult } from "./results";

describe("tool results", () => {
  it("builds a never-retry contract failure", () => {
    const value = {
      ok: false,
      error: { code: "X", source: "contract", retry: "never" },
    };
    expect(failure("X")).toEqual({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: true,
    });
  });

  it("builds a retry-later execution fence", () => {
    expect(fenced("Y").structuredContent).toEqual({
      ok: false,
      error: { code: "Y", source: "execution-fence", retry: "later" },
    });
    expect(fenced("Y").isError).toBe(true);
  });

  it("marks only failed shell responses as errors", () => {
    const ok = { ok: true } as never;
    const bad = { ok: false } as never;
    expect(shellResult(ok).isError).toBeUndefined();
    expect(shellResult(bad).isError).toBe(true);
    expect(shellResult(ok).content).toEqual([
      { type: "text", text: JSON.stringify(ok) },
    ]);
  });
});
