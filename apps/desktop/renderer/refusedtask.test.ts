import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { refusedTaskCodes } from "./refusedtask";

it("lists each refused code once and keeps it classified as refused", () => {
  expect(refusedTaskCodes.length).toBeGreaterThan(0);
  expect(new Set(refusedTaskCodes).size).toBe(refusedTaskCodes.length);
  for (const code of refusedTaskCodes) {
    expect(mappedOperationOutcome(code), code).toBe("refused");
  }
});
