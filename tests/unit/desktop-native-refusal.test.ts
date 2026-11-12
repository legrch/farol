import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validate } from "../../apps/desktop/bridge/wire";
import {
  nativeRefusalReasons,
  normalizeNativeRefusalResponse,
} from "../../apps/desktop/renderer/native-refusal";

// Detached JSON/codec fixtures only; no native process or profile access.
describe("native refusal response diagnostics", () => {
  it("keeps the generated wire and journal reason sets identical", () => {
    const schema = JSON.parse(
      fs.readFileSync("api/desktop/v1/schema.json", "utf8"),
    );
    expect(
      schema.definitions.Outcome.fields.nativeRefusalReason.values,
    ).toEqual(nativeRefusalReasons);
  });
  it.each([
    ...nativeRefusalReasons,
    "future",
    "/outside/private token=PRIVATE-CANARY",
    42,
    null,
    { secret: "PRIVATE-CANARY" },
  ])(
    "normalizes unknown JSON reasons before strict response parsing: %s",
    (reason) => {
      const frame = JSON.parse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "call",
          result: {
            status: "refused",
            requestId: "call",
            operationId: "operation",
            context: { profileId: "profile", backendGeneration: "backend" },
            code: "PROCESS_NATIVE_REFUSED",
            nativeRefusalReason: reason,
          },
        }),
      );
      normalizeNativeRefusalResponse(frame);
      expect(validate("Response", frame)).toBe(true);
      expect(frame.result).toMatchObject({
        status: "refused",
        code: "PROCESS_NATIVE_REFUSED",
        operationId: "operation",
        nativeRefusalReason:
          typeof reason === "string" &&
          nativeRefusalReasons.includes(reason as never)
            ? reason
            : "unclassified",
      });
      expect(JSON.stringify(frame)).not.toContain("PRIVATE-CANARY");
      frame.result.untrusted = "PRIVATE-CANARY";
      expect(validate("Response", frame)).toBe(false);
    },
  );
  it("does not normalize or promote unknown effects", () => {
    const frame = {
      result: {
        status: "unknown",
        code: "PROCESS_OUTCOME_UNKNOWN",
        nativeRefusalReason: "future",
      },
    };
    normalizeNativeRefusalResponse(frame);
    expect(frame.result).toEqual({
      status: "unknown",
      code: "PROCESS_OUTCOME_UNKNOWN",
      nativeRefusalReason: "future",
    });
  });
});
