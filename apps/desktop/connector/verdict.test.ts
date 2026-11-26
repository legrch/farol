import { describe, expect, it } from "vitest";
import { transportVerdict } from "./verdict";

const seen = (state: string, runtimeGeneration = "tunnel") => ({
  state,
  runtimeGeneration,
});

describe("transportVerdict", () => {
  it("reads the health sample when nothing terminal was seen", () => {
    expect(transportVerdict(null, "tunnel", true)).toBe("healthy");
    expect(transportVerdict(null, "tunnel", false)).toBe("unreachable");
  });

  it("reports a known exit even when health looked fine", () => {
    expect(transportVerdict(seen("exited"), "tunnel", true)).toBe("exited");
  });

  it("never turns an unknown outcome into unreachable or exited", () => {
    expect(transportVerdict(seen("outcome_unknown"), "tunnel", false)).toBe(
      "unknown",
    );
    expect(transportVerdict(seen("exited", "other"), "tunnel", false)).toBe(
      "unknown",
    );
  });
});
