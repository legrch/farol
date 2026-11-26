import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { pendingCodes } from "./pendingcodes";

it("lists each pending code once and keeps it classified as pending", () => {
  expect(pendingCodes.length).toBeGreaterThan(0);
  expect(new Set(pendingCodes).size).toBe(pendingCodes.length);
  for (const code of pendingCodes) {
    expect(mappedOperationOutcome(code), code).toBe("pending");
  }
});
