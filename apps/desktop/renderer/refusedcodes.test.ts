import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { refusedCodes } from "./refusedcodes";

it("lists each refused code once and keeps it classified as refused", () => {
  expect(refusedCodes.length).toBeGreaterThan(0);
  expect(new Set(refusedCodes).size).toBe(refusedCodes.length);
  for (const code of refusedCodes) {
    expect(mappedOperationOutcome(code), code).toBe("refused");
  }
});
