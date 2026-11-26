import { describe, expect, it } from "vitest";
import { hasRequestMethod } from "./graph";

const params = {
  $schema: "x",
  title: "DemoParams",
  type: "object",
  properties: { a: { $ref: "#/definitions/Inner" } },
  definitions: { Inner: { type: "string" } },
};

function client(embedded: unknown = params, extra: object = {}) {
  const { $schema: _s, title: _t, definitions: _d, ...root } = params;
  void _s;
  void _t;
  void _d;
  return {
    oneOf: [
      {
        type: "object",
        required: ["id", "method", "params"],
        properties: {
          method: { type: "string", enum: ["demo/run"] },
          params: { $ref: "#/definitions/DemoParams" },
        },
        ...extra,
      },
    ],
    definitions: {
      DemoParams: embedded === params ? root : embedded,
      Inner: { type: "string" },
    },
  };
}

describe("host request method graph", () => {
  it("accepts a method whose embedded params match the standalone schema", () => {
    expect(hasRequestMethod(client(), "demo/run", "DemoParams", params)).toBe(
      true,
    );
  });

  it("refuses another method name", () => {
    expect(hasRequestMethod(client(), "demo/other", "DemoParams", params)).toBe(
      false,
    );
  });

  it("refuses a missing required request field", () => {
    const c = client(undefined, { required: ["id", "method"] });
    expect(hasRequestMethod(c, "demo/run", "DemoParams", params)).toBe(false);
  });

  it("refuses embedded params that differ from the standalone schema", () => {
    const drifted = { ...params.properties, a: { type: "number" } };
    const c = client();
    (c.definitions.DemoParams as Record<string, unknown>).properties = drifted;
    expect(hasRequestMethod(c, "demo/run", "DemoParams", params)).toBe(false);
  });

  it("refuses a differing referenced definition", () => {
    const c = client();
    c.definitions.Inner = { type: "number" };
    expect(hasRequestMethod(c, "demo/run", "DemoParams", params)).toBe(false);
  });

  it("refuses a non-local reference and a missing standalone schema", () => {
    const remote = {
      ...params,
      properties: { a: { $ref: "https://example.test/x" } },
    };
    const c = client();
    (c.definitions.DemoParams as Record<string, unknown>).properties =
      remote.properties;
    expect(hasRequestMethod(c, "demo/run", "DemoParams", remote)).toBe(false);
    expect(
      hasRequestMethod(client(), "demo/run", "DemoParams", undefined),
    ).toBe(false);
  });
});
