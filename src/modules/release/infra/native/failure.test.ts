import { describe, expect, it } from "vitest";
import { fail, header } from "./failure";

describe("transport failure", () => {
  it("defaults certainty to known and keeps unknown explicit", () => {
    expect(fail("network_failure", "redirect")).toEqual({
      ok: false,
      kind: "network_failure",
      reason: "redirect",
      certainty: "known",
    });
    expect(fail("interrupted", "stage_cleanup", "unknown").certainty).toBe(
      "unknown",
    );
  });

  it("reads only single string header values", () => {
    expect(header("a")).toBe("a");
    expect(header(["a", "b"])).toBeNull();
    expect(header(undefined)).toBeNull();
  });
});
