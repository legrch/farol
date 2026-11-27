import { describe, expect, it } from "vitest";
import { serializeRecord } from "./wire";

describe("serializeRecord", () => {
  it("writes one JSON line", () => {
    expect(serializeRecord({ b: 1, a: [2] }, 100, "BIG")).toBe(
      '{"b":1,"a":[2]}\n',
    );
  });

  it("counts the newline and multi-byte characters", () => {
    expect(serializeRecord({}, 3, "BIG")).toBe("{}\n");
    expect(() => serializeRecord({}, 2, "BIG")).toThrow("BIG");
    expect(() => serializeRecord("é", 4, "BIG")).toThrow("BIG");
    expect(serializeRecord("é", 5, "BIG")).toBe('"é"\n');
  });
});
