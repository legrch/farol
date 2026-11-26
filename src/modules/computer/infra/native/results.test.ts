import { describe, expect, it } from "vitest";
import { failure, mutationFailure, success } from "./results";

describe("result builders", () => {
  it("wraps a value as a success", () => {
    const value = { kind: "workspace.entries", entries: [], truncated: false };
    expect(success(value as never)).toEqual({ ok: true, value });
  });
  it("never offers a retry on a failure", () => {
    expect(failure("WORKSPACE_NOT_FOUND")).toEqual({
      ok: false,
      error: { code: "WORKSPACE_NOT_FOUND", retry: "never" },
    });
    expect(mutationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN")).toEqual({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
  });
});
