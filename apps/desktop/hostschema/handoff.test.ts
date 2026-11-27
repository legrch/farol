import { describe, expect, it } from "vitest";
import { HANDOFF_SCHEMA_FILES, supportsHandoff } from "./handoff";

describe("host handoff schema set", () => {
  it("lists the fourteen source schemas under v2", () => {
    expect(HANDOFF_SCHEMA_FILES).toHaveLength(14);
    expect(HANDOFF_SCHEMA_FILES.every((name) => name.startsWith("v2/"))).toBe(
      true,
    );
  });

  it("refuses an empty schema set", () => {
    expect(supportsHandoff({}, new Map())).toBe(false);
  });

  it("refuses a client without the handoff request methods", () => {
    const schemas = new Map(
      HANDOFF_SCHEMA_FILES.map((name) => [name, { type: "object" }] as const),
    );
    expect(supportsHandoff({ oneOf: [], definitions: {} }, schemas)).toBe(
      false,
    );
  });
});
