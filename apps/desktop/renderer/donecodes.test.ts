import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { doneCodes } from "./donecodes";

it("lists each done code once and keeps it classified as done", () => {
  expect(doneCodes.length).toBeGreaterThan(0);
  expect(new Set(doneCodes).size).toBe(doneCodes.length);
  for (const code of doneCodes) {
    expect(mappedOperationOutcome(code), code).toBe("done");
  }
});
