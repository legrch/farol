import path from "node:path";
import type { EmptyRecoverySelectionInput } from "../bridge/empty-recovery-child";

const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const DEV_NAMES = ["Farol Dev", "Farol DEV"];
const INSTALLED_NAME = "io.github.legrch.farol";

// Pure selection-shape admission for each closed-recovery entry. A refusal is a
// plain classified error before any lease, profile or child effect.
export function isSha256(value: string): boolean {
  return SHA256.test(value);
}

export function isOperationId(value: string): boolean {
  return OPERATION_ID.test(value);
}

export function assertClosedSelection(
  input: EmptyRecoverySelectionInput,
): void {
  if (
    input.Interrupted !== undefined ||
    input.UnacknowledgedDev !== undefined ||
    input.InstalledEmpty !== undefined ||
    input.InstalledPreserved !== undefined ||
    input.Preserved !== undefined
  )
    throw Error("EMPTY_CHAT_RECOVERY_SELECTION_INVALID");
}

export function assertInterruptedSelection(
  input: EmptyRecoverySelectionInput,
  expectedQuitSha256: string,
  userData: string,
): void {
  if (
    !input.Interrupted ||
    input.UnacknowledgedDev !== undefined ||
    input.InstalledEmpty !== undefined ||
    input.InstalledPreserved !== undefined ||
    input.Preserved !== undefined ||
    !SHA256.test(expectedQuitSha256) ||
    !DEV_NAMES.includes(path.basename(userData))
  )
    throw Error("INTERRUPTED_CHAT_RECOVERY_SELECTION_INVALID");
}

export function assertUnacknowledgedDevSelection(
  input: EmptyRecoverySelectionInput,
  expectedQuitSha256: string,
  userData: string,
): void {
  if (
    input.Interrupted !== undefined ||
    input.UnacknowledgedDev !== true ||
    input.InstalledEmpty !== undefined ||
    input.InstalledPreserved !== undefined ||
    input.Preserved !== undefined ||
    !SHA256.test(expectedQuitSha256) ||
    !DEV_NAMES.includes(path.basename(userData))
  )
    throw Error("UNACKNOWLEDGED_DEV_RECOVERY_SELECTION_INVALID");
}

export function assertInstalledEmptySelection(
  input: EmptyRecoverySelectionInput,
  expectedQuitSha256: string,
  userData: string,
): void {
  if (
    input.InstalledEmpty !== true ||
    input.InstalledPreserved !== undefined ||
    input.Preserved !== undefined ||
    input.UnacknowledgedDev !== undefined ||
    input.Interrupted !== undefined ||
    input.Mutations.length !== 0 ||
    !SHA256.test(expectedQuitSha256) ||
    path.basename(userData) !== INSTALLED_NAME
  )
    throw Error("INSTALLED_EMPTY_RECOVERY_SELECTION_INVALID");
}

export function assertInstalledPreservedSelection(
  input: EmptyRecoverySelectionInput,
  expectedQuitSha256: string,
  userData: string,
): void {
  if (
    input.InstalledPreserved !== true ||
    input.InstalledEmpty !== undefined ||
    input.UnacknowledgedDev !== undefined ||
    input.Interrupted !== undefined ||
    input.Mutations.length !== 0 ||
    !Array.isArray(input.Preserved) ||
    input.Preserved.length < 1 ||
    input.Preserved.length > 128 ||
    !SHA256.test(expectedQuitSha256) ||
    path.basename(userData) !== INSTALLED_NAME
  )
    throw Error("INSTALLED_PRESERVED_RECOVERY_SELECTION_INVALID");
}
