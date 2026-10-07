// Content-free classification for the existing Settings action diagnostics.
// Never persist an exception message, path, payload or an arbitrary error code.
const causes = new Set([
  "computer_publication_unavailable",
  "COMPUTER_AUTHORITY_STORE_UNAVAILABLE",
  "COMPUTER_APPROVAL_STORE_UNAVAILABLE",
  "AUTHORITY_OWNER_MISMATCH",
  "AUTHORITY_COMPUTER_MISMATCH",
  "AUTHORITY_EXPIRED",
  "AUTHORITY_CAPABILITY_DENIED",
  "AUTHORITY_PATH_DENIED",
  "WORKSPACE_PATH_REFUSED",
  "WORKSPACE_ROOT_CHANGED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_RACE_DETECTED",
  "WORKSPACE_HELPER_FAILED",
  "WORKSPACE_REQUEST_CANCELLED",
  "WORKSPACE_INVALID_REQUEST",
  "WORKSPACE_POLICY_TOO_LARGE",
  "crossed_settings_workspace_result",
  "invalid_settings_workspace_result",
  "stale_settings_workspace_result",
  "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
  "COMPUTER_MCP_LIFECYCLE_LOCK_UNSAFE",
  "COMPUTER_MCP_LIFECYCLE_ROOT_UNSAFE",
  "COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE",
  "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
  "COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED",
  "COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED",
  "COMPUTER_MCP_RECONCILIATION_PENDING",
]);
const nativeCodes = new Set([
  "EPERM",
  "EACCES",
  "EAGAIN",
  "EWOULDBLOCK",
  "ENOENT",
  "ENOTDIR",
  "EEXIST",
  "EINVAL",
  "EIO",
  "ENOSPC",
]);
export type ComputerCheckStage =
  | "go-unavailable"
  | "go-settings-list"
  | "root-recheck"
  | "begin-stop"
  | "confirm-stop";

function data(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function computerCheckDiagnostic(
  stage: ComputerCheckStage,
  error: unknown,
) {
  const code = data(error, "code");
  const message =
    typeof code === "string" && causes.has(code)
      ? undefined
      : data(error, "message");
  const cause =
    typeof code === "string" && causes.has(code)
      ? code
      : typeof message === "string" && causes.has(message)
        ? message
        : "UNCLASSIFIED_FAILURE";
  let current = error;
  let nativeCode: string | undefined;
  for (let depth = 0; depth < 4; depth++) {
    const candidate = data(current, "code");
    if (typeof candidate === "string" && nativeCodes.has(candidate)) {
      nativeCode = candidate;
      break;
    }
    current = data(current, "cause");
  }
  return Object.freeze({ stage, cause, ...(nativeCode ? { nativeCode } : {}) });
}

export function reportComputerCheckDiagnostic(
  sink: (event: string, diagnostic: string) => void,
  action: string,
  stage: ComputerCheckStage,
  error: unknown,
): void {
  reportCapturedComputerCheckDiagnostic(
    sink,
    action,
    computerCheckDiagnostic(stage, error),
  );
}

function reportCapturedComputerCheckDiagnostic(
  sink: (event: string, diagnostic: string) => void,
  action: string,
  diagnostic: ReturnType<typeof computerCheckDiagnostic>,
): void {
  try {
    sink(
      "farol.computer-check-refused",
      JSON.stringify({ action, ...diagnostic }),
    );
  } catch {
    // Diagnostics cannot change the original refusal or its outcome.
  }
}

// Capture one immutable closed result before emitting diagnostics. Never read
// the rejected object again: even a descriptor trap can mutate that object.
export function refuseComputerSettingsList(
  error: unknown,
  sink: (event: string, diagnostic: string) => void,
  action?: string,
): { ok: false; code: string } {
  const diagnostic = computerCheckDiagnostic("go-settings-list", error);
  const result = {
    ok: false as const,
    code:
      diagnostic.cause === "UNCLASSIFIED_FAILURE"
        ? "WORKSPACE_READ_FAILED"
        : diagnostic.cause,
  };
  if (action) reportCapturedComputerCheckDiagnostic(sink, action, diagnostic);
  return result;
}
