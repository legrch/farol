import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { unknownCodes } from "./unknowncodes";

it("lists each unknown code once and keeps it classified as unknown", () => {
  expect(unknownCodes.length).toBeGreaterThan(0);
  expect(new Set(unknownCodes).size).toBe(unknownCodes.length);
  for (const code of unknownCodes) {
    expect(mappedOperationOutcome(code), code).toBe("unknown");
  }
});
