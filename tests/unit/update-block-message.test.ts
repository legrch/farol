import { describe, expect, it } from "vitest";
import { updateBlockMessage } from "../../src/ui/update-block-message";

describe("update block messages", () => {
  it("tells the owner a build without the Go core cannot update itself", () => {
    const message = updateBlockMessage("UPDATE_HELPER_GO_CORE_REQUIRED");
    expect(message).toMatch(/can.t update itself/u);
    expect(message).toMatch(/Install the current Farol build manually/u);
    expect(message).not.toBe(updateBlockMessage("UPDATE_UNKNOWN_CODE"));
  });
});
