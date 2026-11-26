import { describe, expect, it } from "vitest";
import { BridgeError } from "./client.ts";
import { trustedSnapshot } from "./snapshot.ts";

describe("trustedSnapshot", () => {
  it("refuses non-objects, arrays and accessors with one stable code", () => {
    const accessor = {};
    Object.defineProperty(accessor, "a", { enumerable: true, get: () => "x" });
    for (const value of [null, "text", [], accessor, { a: 1 }]) {
      try {
        trustedSnapshot("Context", value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(BridgeError);
        expect((error as BridgeError).state).toBe("refused");
        expect((error as BridgeError).code).toBe(
          "invalid_computer_mcp_binding",
        );
      }
    }
  });
  it("refuses a class instance prototype", () => {
    class Holder {}
    expect(() => trustedSnapshot("Context", new Holder())).toThrow(BridgeError);
  });
});
