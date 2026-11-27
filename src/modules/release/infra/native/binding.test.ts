import { describe, expect, it } from "vitest";
import { installedSlotBindingBytes } from "./binding";

const build = (char: string, version: string) => ({
  digest: char.repeat(64),
  version,
  buildId: char.repeat(64),
});
const operation = {
  operationId: "2".repeat(32),
  source: build("a", "1.0.0"),
  target: build("b", "1.1.0"),
};

describe("installedSlotBindingBytes", () => {
  it("emits sorted canonical ASCII bytes", () => {
    const text = installedSlotBindingBytes(operation, "shared").toString(
      "ascii",
    );
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      installLocation: "shared",
      operationId: operation.operationId,
      schema: "farol.installed-operation-slot/1",
      source: operation.source,
      target: operation.target,
    });
    expect(Object.keys(JSON.parse(text))).toEqual([
      "installLocation",
      "operationId",
      "schema",
      "source",
      "target",
    ]);
  });

  it("refuses malformed input", () => {
    for (const bad of [
      () => installedSlotBindingBytes(operation, "other" as never),
      () =>
        installedSlotBindingBytes({ ...operation, operationId: "x" }, "legacy"),
      () =>
        installedSlotBindingBytes(
          { ...operation, source: build("a", "1.0") },
          "legacy",
        ),
    ])
      expect(bad).toThrow("UPDATE_SLOT_BINDING_INVALID");
  });
});
