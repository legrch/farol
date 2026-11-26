import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { refusedUpdateCodes } from "./refusedupdate";

it("lists each refused code once and keeps it classified as refused", () => {
  expect(refusedUpdateCodes.length).toBeGreaterThan(0);
  expect(new Set(refusedUpdateCodes).size).toBe(refusedUpdateCodes.length);
  for (const code of refusedUpdateCodes) {
    expect(mappedOperationOutcome(code), code).toBe("refused");
  }
});
