import { describe, expect, it } from "vitest";
import {
  FAROL_MODEL_MAX_BODY_BYTES,
  declaredLengthExceeds,
  parseTurnBody,
} from "./request";

describe("declaredLengthExceeds", () => {
  it("compares only a finite declared length against the bound", () => {
    expect(FAROL_MODEL_MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(declaredLengthExceeds("11", 10)).toBe(true);
    expect(declaredLengthExceeds("10", 10)).toBe(false);
    expect(declaredLengthExceeds(undefined, 10)).toBe(false);
    expect(declaredLengthExceeds("abc", 10)).toBe(false);
  });
});

describe("parseTurnBody", () => {
  it("refuses malformed JSON before looking at the model", () => {
    expect(parseTurnBody("{", "m")).toEqual({ kind: "invalid" });
  });
  it("treats an empty body, a non-object and a wrong model as a mismatch", () => {
    for (const raw of ["", "null", "1", '"s"', '{"model":"x"}', "{}"]) {
      const result = parseTurnBody(raw, "m");
      expect(result.kind).toBe("mismatch");
      if (result.kind === "mismatch") {
        expect(result.detail.expected_model).toBe("m");
        expect(result.detail.message).toBe(
          'This Farol Model endpoint serves only model "m"; the Farol-managed selection in config.toml sets it.',
        );
      }
    }
  });
  it("accepts the served model", () => {
    expect(parseTurnBody('{"model":"m","a":1}', "m")).toEqual({
      kind: "ok",
      parsed: { model: "m", a: 1 },
    });
  });
});
