import { describe, expect, it } from "vitest";
import {
  updateBlockMessage,
  updateResultMessage,
} from "../../src/ui/update-block-message";

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

  it.each([
    "UPDATE_ADOPTION_RELEASE_NOT_FOUND",
    "UPDATE_BASELINE_ADOPTION_REQUIRED",
    "UPDATE_ADOPTION_TREE_MISMATCH",
    "UPDATE_ADOPTION_NETWORK_FAILURE",
  ])(
    "shows the specific guidance for a failed %s result, not the generic copy",
    (code) => {
      expect(updateResultMessage("failed", false, code)).toBe(
        updateBlockMessage(code),
      );
      expect(updateResultMessage("failed", false, code)).not.toMatch(
        /did not finish/u,
      );
    },
  );

  it("keeps the generic result copy for every other code", () => {
    expect(updateResultMessage("failed", false, "UPDATE_FAILED")).toMatch(
      /did not finish/u,
    );
    expect(
      updateResultMessage("failed", false, "UPDATE_ADOPTION_RELEASE_MISMATCH"),
    ).toMatch(/did not finish/u);
    expect(
      updateResultMessage("failed", true, "UPDATE_ADOPTION_TREE_MISMATCH"),
    ).toBe(updateBlockMessage("UPDATE_ADOPTION_TREE_MISMATCH"));
    expect(
      updateResultMessage(
        "unavailable",
        false,
        "UPDATE_ADOPTION_TREE_MISMATCH",
      ),
    ).toMatch(/cannot confirm update availability/u);
  });
});
