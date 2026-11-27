import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { failedCodes } from "./failedcodes";

it("lists each failed code once and keeps it classified as failed", () => {
  expect(failedCodes.length).toBeGreaterThan(0);
  expect(new Set(failedCodes).size).toBe(failedCodes.length);
  for (const code of failedCodes) {
    expect(mappedOperationOutcome(code), code).toBe("failed");
  }
});
