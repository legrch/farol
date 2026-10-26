import { BridgeError } from "../bridge/client";

type Stage =
  | "host-inputs"
  | "admission"
  | "selection"
  | "processes"
  | "artifact"
  | "resources"
  | "executable"
  | "discovery"
  | "selection-recheck"
  | "preparation";
export type MaintenanceObservation = Readonly<{
  stage: Stage;
  event: "begin" | "end";
  result:
    | "pending"
    | "returned"
    | "refused"
    | "unknown"
    | "unavailable"
    | "unsupported";
  code: string | null;
  monotonicMs: number;
  elapsedMs: number;
}>;
export type MaintenanceObserver = (value: MaintenanceObservation) => void;
const codes = new Set([
  "STARTUP_MAINTENANCE_RECEIPT_UNAVAILABLE",
  "STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED",
  "STARTUP_PRESERVED_SELECTION_INVALID",
  "STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED",
  "STARTUP_PRESERVED_SELECTION_CHANGED",
  "STARTUP_RECOVERY_HOST_UNCONFIRMED",
  "STARTUP_PROMOTION_LEASE_LOST",
  "PRESERVED_RECOVERY_SELECTION_INVALID",
  "PRESERVED_RECOVERY_ROOT_CHANGED",
  "PRESERVED_RECOVERY_STARTUP_LEASE_INVALID",
  "PROMOTION_LEASE_LOST",
  "PRESERVED_RECOVERY_STATE_CHANGED",
  "PRESERVED_RECOVERY_QUIT_SCOPE_CHANGED",
  "PRESERVED_RECOVERY_ARCHIVE_CHANGED",
  "PRESERVED_RECOVERY_WORK_PENDING",
  "PRESERVED_RECOVERY_INTENT_CHANGED",
  "PRESERVED_RECOVERY_MCP_IDLE_UNVERIFIED",
  "CLOSED_COMPUTER_RECOVERY_ROOT_UNSAFE",
  "CLOSED_COMPUTER_RECOVERY_FILE_UNSAFE",
  "CLOSED_COMPUTER_RECOVERY_STATE_CHANGED",
  "CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED",
  "CLOSED_COMPUTER_RECOVERY_WORK_PENDING",
  "CLOSED_COMPUTER_RECOVERY_APP_ACTIVE",
]);
const bridgeCodes = new Set([
  "core_resources_unqualified",
  "core_resources_deadline_expired",
  "core_artifact_changed",
  "invalid_core_artifact",
  "native_profile_storage_invalid",
  "preserved_inspection_selection_invalid",
  "preserved_inspection_launch_unconfirmed",
  "preserved_inspection_unconfirmed",
  "preserved_inspection_cleanup_unconfirmed",
  "preserved_recovery_selection_invalid",
  "preserved_recovery_launch_unconfirmed",
  "preserved_recovery_unconfirmed",
  "preserved_recovery_cleanup_unconfirmed",
]);
const filesystemCodes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "ELOOP",
]);

// A code-shaped message alone is not safe. Only known local codes leave this
// boundary; native paths, child output and arbitrary exception text never do.
export function maintenanceFailureCode(error: unknown): string {
  try {
    if (error instanceof BridgeError) {
      const code = error.code;
      return bridgeCodes.has(code) ? code : "UNCLASSIFIED_BRIDGE_FAILURE";
    }
    const message = error instanceof Error ? error.message : undefined;
    if (typeof message === "string" && codes.has(message)) return message;
    const descriptor =
      error && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    if (
      descriptor &&
      "value" in descriptor &&
      filesystemCodes.has(descriptor.value)
    )
      return `FILESYSTEM_${descriptor.value}`;
  } catch {
    /* Even a hostile exception object must not replace the failure. */
  }
  return "UNCLASSIFIED_MAINTENANCE_FAILURE";
}

// Observe exactly one existing call, preserve its original result/error and
// never turn a diagnostic sink failure into authority, retry or cleanup.
export async function observeMaintenance<T>(
  stage: Stage,
  observer: MaintenanceObserver | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  const started = performance.now();
  const emit = (
    result: MaintenanceObservation["result"],
    code: string | null,
  ) => {
    if (!observer) return;
    const now = performance.now();
    try {
      observer(
        Object.freeze({
          stage,
          event: result === "pending" ? "begin" : "end",
          result,
          code,
          monotonicMs: now,
          elapsedMs: Math.max(0, now - started),
        }),
      );
    } catch {
      /* Observations cannot change the original attempt. */
    }
  };
  emit("pending", null);
  try {
    const value = await run();
    emit("returned", null);
    return value;
  } catch (error) {
    let result: MaintenanceObservation["result"] = "unknown";
    try {
      if (error instanceof BridgeError) {
        const state = error.state;
        if (
          ["unknown", "refused", "unavailable", "unsupported"].includes(state)
        )
          result = state;
      }
    } catch {
      /* Keep unclassified failures unknown. */
    }
    emit(result, maintenanceFailureCode(error));
    throw error;
  }
}
