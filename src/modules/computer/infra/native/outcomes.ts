import type {
  WorkspaceMutationErrorCode,
  WorkspaceMutationResult,
} from "../../app/port/mutable-workspace";
import type {
  ReadonlyWorkspaceErrorCode,
  ReadonlyWorkspaceResult,
} from "../../app/port/readonly-workspace";

// Result builders. Every failure is final: retry is always "never".

export function success(
  value: Extract<ReadonlyWorkspaceResult, { ok: true }>["value"],
): ReadonlyWorkspaceResult {
  return { ok: true, value };
}

export function failure(
  code: ReadonlyWorkspaceErrorCode,
): ReadonlyWorkspaceResult {
  return { ok: false, error: { code, retry: "never" } };
}

export function mutationFailure(
  code: WorkspaceMutationErrorCode,
): WorkspaceMutationResult {
  return { ok: false, error: { code, retry: "never" } };
}
