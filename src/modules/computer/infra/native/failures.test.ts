import { describe, expect, it } from "vitest";
import { failure, snapshotFailureCode } from "./failures";

describe("failure", () => {
  it("builds a never-retry refusal", () => {
    expect(failure("WORKSPACE_COMMAND_TIMEOUT")).toEqual({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_TIMEOUT", retry: "never" },
    });
  });
});

describe("snapshotFailureCode", () => {
  it("maps every snapshot refusal onto its product code", () => {
    const expected = {
      SNAPSHOT_ROOT_CHANGED: "WORKSPACE_ROOT_CHANGED",
      SNAPSHOT_METADATA_UNAPPROVED: "WORKSPACE_GIT_METADATA_NOT_APPROVED",
      SNAPSHOT_ALTERNATES_UNSUPPORTED: "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED",
      SNAPSHOT_HELPER_UNTRUSTED: "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED",
      SNAPSHOT_NOT_FOUND: "WORKSPACE_NOT_FOUND",
      SNAPSHOT_PATH_REFUSED: "WORKSPACE_PATH_REFUSED",
      SNAPSHOT_RACE_DETECTED: "WORKSPACE_RACE_DETECTED",
      SNAPSHOT_TOO_LARGE: "WORKSPACE_SNAPSHOT_TOO_LARGE",
      SNAPSHOT_CROSS_VOLUME: "WORKSPACE_SNAPSHOT_CROSS_VOLUME",
      SNAPSHOT_CLONE_UNSUPPORTED: "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED",
      SNAPSHOT_INDEX_CHANGED: "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT",
      SNAPSHOT_TREE_CHANGED: "WORKSPACE_CHANGED_DURING_SNAPSHOT",
      SNAPSHOT_INVALID_REQUEST: "WORKSPACE_HELPER_FAILED",
      SNAPSHOT_DESTINATION_INVALID: "WORKSPACE_HELPER_FAILED",
      SNAPSHOT_HELPER_FAILED: "WORKSPACE_HELPER_FAILED",
    } as const;
    for (const [code, product] of Object.entries(expected)) {
      expect(snapshotFailureCode(code as keyof typeof expected), code).toBe(
        product,
      );
    }
  });
});
