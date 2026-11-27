import { describe, expect, it } from "vitest";
import { bindingMatches, transportKey } from "./capture";

const binding = {
  buildId: "build",
  profileId: "profile",
  backendGeneration: "backend",
  runtimeId: "runtime",
  connectorGeneration: "9",
};

describe("capture", () => {
  it("joins the runtime coordinates into one key", () => {
    expect(transportKey(binding, "tunnel")).toBe(
      "profile/backend/runtime/tunnel",
    );
  });

  it("matches only a binding whose every original field holds", () => {
    expect(bindingMatches(binding, { ...binding })).toBe(true);
    expect(bindingMatches(binding, { ...binding, runtimeId: "other" })).toBe(
      false,
    );
    expect(bindingMatches(binding, { ...binding, buildId: "next" })).toBe(
      false,
    );
  });
});
