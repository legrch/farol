import { describe, expect, it } from "vitest";
import {
  hasEnumValues,
  hasFieldShapes,
  hasMethod,
  hasRequired,
  hasShape,
  hasThreadItem,
} from "./shape";

describe("host schema shapes", () => {
  it("matches scalar types exactly, including unions", () => {
    expect(hasShape({ type: "string" }, "string")).toBe(true);
    expect(hasShape({ type: ["string", "null"] }, "string|null")).toBe(true);
    expect(hasShape({ type: ["null", "string"] }, "string|null")).toBe(true);
    expect(hasShape({ type: "string" }, "string|null")).toBe(false);
    expect(
      hasShape({ type: ["string", "null", "integer"] }, "string|null"),
    ).toBe(false);
    expect(hasShape("string", "string")).toBe(false);
  });

  it("matches definition references", () => {
    expect(hasShape({ $ref: "#/definitions/Thread" }, "ref:Thread")).toBe(true);
    expect(
      hasShape({ allOf: [{ $ref: "#/definitions/Thread" }] }, "ref:Thread"),
    ).toBe(true);
    expect(hasShape({ $ref: "#/definitions/Other" }, "ref:Thread")).toBe(false);
  });

  it("matches nullable references only with both parts", () => {
    const nullable = {
      anyOf: [{ $ref: "#/definitions/Mode" }, { type: "null" }],
    };
    expect(hasShape(nullable, "nullable-ref:Mode")).toBe(true);
    expect(
      hasShape(
        { anyOf: [{ $ref: "#/definitions/Mode" }] },
        "nullable-ref:Mode",
      ),
    ).toBe(false);
    expect(hasShape(nullable, "nullable-ref:Other")).toBe(false);
  });

  it("matches arrays of a referenced item", () => {
    const list = { type: "array", items: { $ref: "#/definitions/Turn" } };
    expect(hasShape(list, "array:Turn")).toBe(true);
    expect(hasShape(list, "array:Item")).toBe(false);
    expect(hasShape({ type: "string" }, "array:Turn")).toBe(false);
  });

  it("checks every listed field of the named schema", () => {
    const schemas = new Map([
      ["v2/A.json", { properties: { x: { type: "string" } } }],
    ]);
    const field = {
      schema: "v2/A.json",
      path: ["properties", "x"],
      shape: "string",
    };
    expect(hasFieldShapes(schemas, [field])).toBe(true);
    expect(hasFieldShapes(schemas, [{ ...field, shape: "integer" }])).toBe(
      false,
    );
    expect(hasFieldShapes(schemas, [{ ...field, schema: "v2/B.json" }])).toBe(
      false,
    );
  });

  it("finds methods, thread items, enum values and required names", () => {
    expect(
      hasMethod(
        { oneOf: [{ properties: { method: { enum: ["a/b"] } } }] },
        "a/b",
      ),
    ).toBe(true);
    expect(hasMethod({ oneOf: [] }, "a/b")).toBe(false);
    const items = {
      definitions: {
        ThreadItem: { oneOf: [{ properties: { type: { enum: ["note"] } } }] },
      },
    };
    expect(hasThreadItem(items, "note")).toBe(true);
    expect(hasThreadItem(items, "other")).toBe(false);
    expect(hasEnumValues({ type: "string", enum: ["a", "b"] }, "a", "b")).toBe(
      true,
    );
    expect(hasEnumValues({ type: "string", enum: ["a"] }, "a", "b")).toBe(
      false,
    );
    expect(
      hasEnumValues({ oneOf: [{ type: "string", enum: ["a"] }] }, "a"),
    ).toBe(true);
    expect(hasEnumValues({ enum: ["a"] }, "a")).toBe(false);
    expect(hasEnumValues(null, "a")).toBe(false);
    expect(hasRequired({ required: ["a", "b"] }, "a", "b")).toBe(true);
    expect(hasRequired({ required: ["a"] }, "a", "b")).toBe(false);
    expect(hasRequired({}, "a")).toBe(false);
  });
});
