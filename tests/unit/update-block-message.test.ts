import { describe, expect, it } from "vitest";
import { updateBlockMessage } from "../../src/ui/update-block-message";

describe("update block messages", () => {
  it("tells the owner a build without the Go core cannot update itself", () => {
    const message = updateBlockMessage("UPDATE_HELPER_GO_CORE_REQUIRED");
    expect(message).toMatch(/can.t update itself/u);
    expect(message).toMatch(/Install the current Farol build manually/u);
    expect(message).not.toBe(updateBlockMessage("UPDATE_UNKNOWN_CODE"));
  });

  it("tells a recipient of an unpublished copy where to get Farol", () => {
    for (const code of [
      "UPDATE_BASELINE_ADOPTION_REQUIRED",
      "UPDATE_ADOPTION_RELEASE_NOT_FOUND",
    ])
      expect(updateBlockMessage(code)).toBe(
        "This copy of Farol isn’t a published release, so it can’t update itself. Download Farol from its releases page.",
      );
  });

  it("tells a recipient of a mismatched copy to download it again", () => {
    expect(updateBlockMessage("UPDATE_ADOPTION_TREE_MISMATCH")).toBe(
      "This copy of Farol doesn’t match its published release. Download it again.",
    );
  });

  it("asks for a connection check when the release could not be reached", () => {
    expect(updateBlockMessage("UPDATE_ADOPTION_NETWORK_FAILURE")).toMatch(
      /Check your connection/u,
    );
  });
});
