import type { WorkspaceMutationErrorCode } from "../../app/port/mutable-workspace";
import type { ReadonlyWorkspaceErrorCode } from "../../app/port/readonly-workspace";

// How the adapter names its failures: one internal code set, the helper's exit
// code table, and the mapping onto each public port's own code set.

export type NativeWorkspaceErrorCode =
  | ReadonlyWorkspaceErrorCode
  | WorkspaceMutationErrorCode
  // Internal: the caller aborted after the helper process had started.
  | "WORKSPACE_REQUEST_INTERRUPTED";

export class WorkspaceRefusal extends Error {
  constructor(readonly code: NativeWorkspaceErrorCode) {
    super(code);
  }
}

const EXIT_TO_ERROR = new Map<number, NativeWorkspaceErrorCode>([
  [20, "WORKSPACE_INVALID_REQUEST"],
  [21, "WORKSPACE_NOT_FOUND"],
  [22, "WORKSPACE_PATH_REFUSED"],
  [23, "WORKSPACE_NOT_A_FILE"],
  [24, "WORKSPACE_FILE_TOO_LARGE"],
  [25, "WORKSPACE_RACE_DETECTED"],
  [26, "WORKSPACE_HELPER_FAILED"],
  [27, "WORKSPACE_SEARCH_TIMEOUT"],
  [28, "WORKSPACE_NOT_TEXT"],
  [29, "WORKSPACE_EDIT_NO_MATCH"],
  [30, "WORKSPACE_EDIT_NOT_UNIQUE"],
  [31, "WORKSPACE_EDIT_OVERLAP"],
  [32, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"],
  [33, "WORKSPACE_ROOT_CHANGED"],
]);

export function mapExitCode(code: number | null): NativeWorkspaceErrorCode {
  if (code === null) return "WORKSPACE_HELPER_FAILED";
  return EXIT_TO_ERROR.get(code) ?? "WORKSPACE_HELPER_FAILED";
}

export function readonlyErrorCode(
  code: NativeWorkspaceErrorCode,
): ReadonlyWorkspaceErrorCode {
  switch (code) {
    case "WORKSPACE_REQUEST_INTERRUPTED":
    case "WORKSPACE_MUTATION_CANCELLED":
      return "WORKSPACE_REQUEST_CANCELLED";
    case "WORKSPACE_EDIT_NO_MATCH":
    case "WORKSPACE_EDIT_NOT_UNIQUE":
    case "WORKSPACE_EDIT_OVERLAP":
    case "WORKSPACE_MUTATION_CONFLICT":
    case "WORKSPACE_MUTATION_OUTCOME_UNKNOWN":
      return "WORKSPACE_HELPER_FAILED";
    default:
      return code;
  }
}

export function mutationErrorCode(
  code: NativeWorkspaceErrorCode,
): WorkspaceMutationErrorCode {
  switch (code) {
    case "WORKSPACE_RACE_DETECTED":
      return "WORKSPACE_MUTATION_CONFLICT";
    case "WORKSPACE_SEARCH_TIMEOUT":
    case "WORKSPACE_HELPER_FAILED":
    case "WORKSPACE_COMMAND_UNSUPPORTED":
    case "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE":
    case "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED":
    case "WORKSPACE_COMMAND_CANCELLED":
    case "WORKSPACE_COMMAND_TIMEOUT":
    case "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE":
    case "WORKSPACE_COMMAND_FAILED":
    case "WORKSPACE_NOT_GIT_REPOSITORY":
    case "WORKSPACE_GIT_HEAD_UNBORN":
    case "WORKSPACE_GIT_METADATA_NOT_APPROVED":
    case "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED":
    case "WORKSPACE_TRACKED_LIST_TOO_LARGE":
    case "WORKSPACE_TRACKED_PATH_UNSUPPORTED":
    case "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT":
    case "WORKSPACE_CHANGED_DURING_SNAPSHOT":
    case "WORKSPACE_SNAPSHOT_TOO_LARGE":
    case "WORKSPACE_SNAPSHOT_CROSS_VOLUME":
    case "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED":
    case "WORKSPACE_REQUEST_INTERRUPTED":
      return "WORKSPACE_MUTATION_OUTCOME_UNKNOWN";
    case "WORKSPACE_REQUEST_CANCELLED":
      return "WORKSPACE_MUTATION_CANCELLED";
    default:
      return code;
  }
}
