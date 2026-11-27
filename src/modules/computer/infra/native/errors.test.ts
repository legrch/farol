import { describe, expect, it } from "vitest";
import {
  WorkspaceRefusal,
  mapExitCode,
  mutationErrorCode,
  readonlyErrorCode,
} from "./errors";

describe("WorkspaceRefusal", () => {
  it("carries the code as code and message", () => {
    const refusal = new WorkspaceRefusal("WORKSPACE_PATH_REFUSED");
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.code).toBe("WORKSPACE_PATH_REFUSED");
    expect(refusal.message).toBe("WORKSPACE_PATH_REFUSED");
  });
});

describe("mapExitCode", () => {
  it("maps the helper's reviewed exit codes", () => {
    const table: Record<number, string> = {
      20: "WORKSPACE_INVALID_REQUEST",
      21: "WORKSPACE_NOT_FOUND",
      22: "WORKSPACE_PATH_REFUSED",
      23: "WORKSPACE_NOT_A_FILE",
      24: "WORKSPACE_FILE_TOO_LARGE",
      25: "WORKSPACE_RACE_DETECTED",
      26: "WORKSPACE_HELPER_FAILED",
      27: "WORKSPACE_SEARCH_TIMEOUT",
      28: "WORKSPACE_NOT_TEXT",
      29: "WORKSPACE_EDIT_NO_MATCH",
      30: "WORKSPACE_EDIT_NOT_UNIQUE",
      31: "WORKSPACE_EDIT_OVERLAP",
      32: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
      33: "WORKSPACE_ROOT_CHANGED",
    };
    for (const [code, expected] of Object.entries(table)) {
      expect(mapExitCode(Number(code))).toBe(expected);
    }
  });
  it("treats a signal, success and unknown codes as a helper failure", () => {
    expect(mapExitCode(null)).toBe("WORKSPACE_HELPER_FAILED");
    expect(mapExitCode(0)).toBe("WORKSPACE_HELPER_FAILED");
    expect(mapExitCode(1)).toBe("WORKSPACE_HELPER_FAILED");
    expect(mapExitCode(34)).toBe("WORKSPACE_HELPER_FAILED");
  });
});

describe("readonlyErrorCode", () => {
  it("maps interruption and cancellation to a cancelled request", () => {
    expect(readonlyErrorCode("WORKSPACE_REQUEST_INTERRUPTED")).toBe(
      "WORKSPACE_REQUEST_CANCELLED",
    );
    expect(readonlyErrorCode("WORKSPACE_MUTATION_CANCELLED")).toBe(
      "WORKSPACE_REQUEST_CANCELLED",
    );
  });
  it("hides mutation-only outcomes behind a helper failure", () => {
    for (const code of [
      "WORKSPACE_EDIT_NO_MATCH",
      "WORKSPACE_EDIT_NOT_UNIQUE",
      "WORKSPACE_EDIT_OVERLAP",
      "WORKSPACE_MUTATION_CONFLICT",
      "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
    ] as const) {
      expect(readonlyErrorCode(code)).toBe("WORKSPACE_HELPER_FAILED");
    }
  });
  it("passes every other code through", () => {
    expect(readonlyErrorCode("WORKSPACE_NOT_FOUND")).toBe(
      "WORKSPACE_NOT_FOUND",
    );
    expect(readonlyErrorCode("WORKSPACE_PATH_REFUSED")).toBe(
      "WORKSPACE_PATH_REFUSED",
    );
  });
});

describe("mutationErrorCode", () => {
  it("renames a detected race to a conflict", () => {
    expect(mutationErrorCode("WORKSPACE_RACE_DETECTED")).toBe(
      "WORKSPACE_MUTATION_CONFLICT",
    );
  });
  it("treats a failure after the helper started as an unknown outcome", () => {
    for (const code of [
      "WORKSPACE_SEARCH_TIMEOUT",
      "WORKSPACE_HELPER_FAILED",
      "WORKSPACE_COMMAND_FAILED",
      "WORKSPACE_NOT_GIT_REPOSITORY",
      "WORKSPACE_SNAPSHOT_TOO_LARGE",
      "WORKSPACE_REQUEST_INTERRUPTED",
    ] as const) {
      expect(mutationErrorCode(code)).toBe(
        "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
      );
    }
  });
  it("maps a cancelled request to a cancelled mutation", () => {
    expect(mutationErrorCode("WORKSPACE_REQUEST_CANCELLED")).toBe(
      "WORKSPACE_MUTATION_CANCELLED",
    );
  });
  it("passes refusals made before the helper ran through", () => {
    expect(mutationErrorCode("WORKSPACE_PATH_REFUSED")).toBe(
      "WORKSPACE_PATH_REFUSED",
    );
    expect(mutationErrorCode("WORKSPACE_EDIT_NO_MATCH")).toBe(
      "WORKSPACE_EDIT_NO_MATCH",
    );
  });
});
