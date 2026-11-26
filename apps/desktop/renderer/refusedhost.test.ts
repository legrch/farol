import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { refusedHostCodes } from "./refusedhost";

it("lists each refused code once and keeps it classified as refused", () => {
  expect(refusedHostCodes.length).toBeGreaterThan(0);
  expect(new Set(refusedHostCodes).size).toBe(refusedHostCodes.length);
  for (const code of refusedHostCodes) {
    expect(mappedOperationOutcome(code), code).toBe("refused");
  }
});
