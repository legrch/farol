import type { ReadonlyWorkspaceResult } from "../../app/port/readonly-workspace";
import type { WorkspaceSnapshotErrorCode } from "./workspace-snapshot";

export type CommandFailureCode =
  | "WORKSPACE_COMMAND_UNSUPPORTED"
  | "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE"
  | "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED"
  | "WORKSPACE_COMMAND_CANCELLED"
  | "WORKSPACE_COMMAND_TIMEOUT"
  | "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE"
  | "WORKSPACE_COMMAND_FAILED"
  | "WORKSPACE_NOT_GIT_REPOSITORY"
  | "WORKSPACE_GIT_HEAD_UNBORN"
  | "WORKSPACE_GIT_METADATA_NOT_APPROVED"
  | "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED"
  | "WORKSPACE_ROOT_CHANGED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_PATH_REFUSED"
  | "WORKSPACE_RACE_DETECTED"
  | "WORKSPACE_TRACKED_LIST_TOO_LARGE"
  | "WORKSPACE_TRACKED_PATH_UNSUPPORTED"
  | "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT"
  | "WORKSPACE_CHANGED_DURING_SNAPSHOT"
  | "WORKSPACE_SNAPSHOT_TOO_LARGE"
  | "WORKSPACE_SNAPSHOT_CROSS_VOLUME"
  | "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED"
  | "WORKSPACE_HELPER_FAILED";

export function failure(code: CommandFailureCode): ReadonlyWorkspaceResult {
  return { ok: false, error: { code, retry: "never" } };
}

// Maps a snapshot-layer refusal (EXIT_TO_CODE in workspace-snapshot.ts) onto
// this command's own closed product codes, one for one wherever the refusal
// has a product meaning: the owner's root or a named path moved or was
// refused, the snapshot would be too large or cannot be cloned on this
// volume, the live index moved between the two phases, or the repository's
// layout (unapproved external metadata, an alternates file) is one this
// route does not run over. `SNAPSHOT_HELPER_UNTRUSTED` (the attested
// interpreter or helper bytes failed their own check) is the existing
// executable-untrusted code, which already covers a failed attestation for
// the command itself. Only a malformed request of our own, an invalid
// destination or an internal helper fault -- none of which says anything
// about the owner's repository -- stay on the generic `WORKSPACE_HELPER_FAILED`.
export function snapshotFailureCode(
  code: WorkspaceSnapshotErrorCode,
): CommandFailureCode {
  switch (code) {
    case "SNAPSHOT_ROOT_CHANGED":
      return "WORKSPACE_ROOT_CHANGED";
    case "SNAPSHOT_METADATA_UNAPPROVED":
      return "WORKSPACE_GIT_METADATA_NOT_APPROVED";
    case "SNAPSHOT_ALTERNATES_UNSUPPORTED":
      return "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED";
    case "SNAPSHOT_HELPER_UNTRUSTED":
      return "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED";
    case "SNAPSHOT_NOT_FOUND":
      return "WORKSPACE_NOT_FOUND";
    case "SNAPSHOT_PATH_REFUSED":
      return "WORKSPACE_PATH_REFUSED";
    case "SNAPSHOT_RACE_DETECTED":
      return "WORKSPACE_RACE_DETECTED";
    case "SNAPSHOT_TOO_LARGE":
      return "WORKSPACE_SNAPSHOT_TOO_LARGE";
    case "SNAPSHOT_CROSS_VOLUME":
      return "WORKSPACE_SNAPSHOT_CROSS_VOLUME";
    case "SNAPSHOT_CLONE_UNSUPPORTED":
      return "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED";
    case "SNAPSHOT_INDEX_CHANGED":
      return "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT";
    case "SNAPSHOT_TREE_CHANGED":
      return "WORKSPACE_CHANGED_DURING_SNAPSHOT";
    case "SNAPSHOT_INVALID_REQUEST":
    case "SNAPSHOT_DESTINATION_INVALID":
    case "SNAPSHOT_HELPER_FAILED":
      return "WORKSPACE_HELPER_FAILED";
  }
}
