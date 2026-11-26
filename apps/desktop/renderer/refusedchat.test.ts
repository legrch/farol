import { expect, it } from "vitest";
import { mappedOperationOutcome } from "./operation-outcomes";
import { refusedChatCodes } from "./refusedchat";

it("lists each refused code once and keeps it classified as refused", () => {
  expect(refusedChatCodes.length).toBeGreaterThan(0);
  expect(new Set(refusedChatCodes).size).toBe(refusedChatCodes.length);
  for (const code of refusedChatCodes) {
    expect(mappedOperationOutcome(code), code).toBe("refused");
  }
});
