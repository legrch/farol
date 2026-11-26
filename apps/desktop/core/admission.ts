import path from "node:path";
import { BridgeError } from "../bridge/client.ts";

// Pure start-admission predicates. Each throws the exact refusal the host
// used inline, and the host calls them at the same points in the same order.
export function refuseInvalidFreshLaunch(
  startupPurpose: string | undefined,
  previousHostDrainConfirmed: boolean,
): void {
  if (startupPurpose === "fresh" && previousHostDrainConfirmed)
    throw new BridgeError("refused", "invalid_fresh_launch");
}

export function refuseUnconfirmedPreviousDrain(
  startupPurpose: string | undefined,
  previousHostDrainConfirmed: boolean,
): void {
  if (startupPurpose !== "fresh" && previousHostDrainConfirmed !== true)
    throw new BridgeError("refused", "previous_host_drain_unconfirmed");
}

export function refuseInvalidShellSource(
  selectedShell: Readonly<{ watchdogSource: unknown }> | undefined,
): void {
  if (
    selectedShell &&
    (!(selectedShell.watchdogSource instanceof Uint8Array) ||
      selectedShell.watchdogSource.byteLength === 0 ||
      selectedShell.watchdogSource.byteLength > 64 * 1024)
  )
    throw new BridgeError("refused", "invalid_shell_launch_metadata");
}

export function refuseMissingShellResources(
  shellSelected: boolean,
  compiledResources: unknown,
): void {
  if (
    shellSelected &&
    (compiledResources === undefined || compiledResources === null)
  )
    throw new BridgeError("refused", "shell_host_resources_missing");
}

// The Shell bundle must sit exactly three levels above the artifact root.
export function shellAppRoot(artifactRoot: string): string {
  const appRoot = path.resolve(artifactRoot, "../../..");
  if (path.join(appRoot, "Contents/Resources/app") !== artifactRoot)
    throw new BridgeError("refused", "shell_host_layout_mismatch");
  return appRoot;
}
