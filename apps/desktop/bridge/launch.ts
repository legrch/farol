import type { Writable } from "node:stream";
import { BridgeError } from "./errors.ts";
import { safeIdentity, type BackendLifecycleObservation } from "./lifecycle.ts";
import type {
  ProfileLaunchBinding,
  QualifiedProfileLaunch,
} from "./profile.ts";

// Trusted launcher input only, naming the existing native host slot and temp
// parent. Neither field comes from renderer IPC or a read request.
export type NativeCodexReadSelection = Readonly<{
  hostId: "codex";
  trustedTemp: string;
}>;

// Copy only this optional launcher value, without invoking caller accessors.
// Go validates path semantics; this projection issues no Task/native authority.
export function copyNativeCodexReadLaunch(
  launch: object,
): NativeCodexReadSelection | undefined {
  const refuse = (): never => {
    throw new BridgeError("refused", "invalid_codex_read_launch");
  };
  const field = Object.getOwnPropertyDescriptor(launch, "codexRead");
  if (field === undefined) {
    if (Reflect.has(launch, "codexRead")) refuse();
    return undefined;
  }
  if (!Object.hasOwn(field, "value")) refuse();
  const value: unknown = field.value;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return refuse();
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(fields, "hostId") ||
    !Object.hasOwn(fields, "trustedTemp") ||
    !Object.hasOwn(fields.hostId!, "value") ||
    !Object.hasOwn(fields.trustedTemp!, "value") ||
    fields.hostId!.value !== "codex" ||
    typeof fields.trustedTemp!.value !== "string"
  )
    return refuse();
  return Object.freeze({
    hostId: "codex",
    trustedTemp: fields.trustedTemp!.value as string,
  });
}

// The profile qualifier is held for this exact trusted backend lifetime.
export interface NativeCoreLaunch {
  readonly profile: QualifiedProfileLaunch;
  readonly ownerId: string;
  readonly computerId: string;
  readonly storeMode: "create" | "open";
  readonly startupMode?: "normal" | "fresh";
  readonly settingsMutations?: boolean;
  readonly previousHostDrainConfirmed?: boolean;
  readonly hostLifetimeId?: string;
  readonly childLaunchId?: string;
  readonly codexRead?: NativeCodexReadSelection;
  // Produced by the independently verified packaged host. The private Go
  // decoder binds these bytes to this exact profile/build/host/child launch.
  readonly shellMetadata?: Uint8Array;
  readonly onLifecycleObservation?: (
    observation: BackendLifecycleObservation,
  ) => void;
}

// Startup checks that need nothing but the launcher input. Their order
// relative to the other refusals in spawnCore is part of the contract.
export function refuseInvalidStartup(
  native: NativeCoreLaunch | undefined,
): void {
  if (
    native?.startupMode !== undefined &&
    native.startupMode !== "normal" &&
    native.startupMode !== "fresh"
  )
    throw new BridgeError("refused", "invalid_native_launch");
  if (
    native?.startupMode === "fresh" &&
    ((native.storeMode !== "open" && native.storeMode !== "create") ||
      !native.hostLifetimeId ||
      !native.childLaunchId ||
      (native.previousHostDrainConfirmed !== undefined &&
        native.previousHostDrainConfirmed !== false))
  )
    throw new BridgeError("refused", "invalid_recovery_launch");
}

// Shape of the native identifiers, before any profile is consumed.
export function refuseInvalidNative(native: NativeCoreLaunch): void {
  const id = safeIdentity;
  if (
    typeof native.ownerId !== "string" ||
    typeof native.computerId !== "string" ||
    !id.test(native.ownerId) ||
    !id.test(native.computerId) ||
    ((native.hostLifetimeId !== undefined ||
      native.childLaunchId !== undefined) &&
      (typeof native.hostLifetimeId !== "string" ||
        typeof native.childLaunchId !== "string" ||
        !id.test(native.hostLifetimeId) ||
        !id.test(native.childLaunchId))) ||
    (native.storeMode !== "create" && native.storeMode !== "open") ||
    (native.settingsMutations !== undefined &&
      typeof native.settingsMutations !== "boolean")
  )
    throw new BridgeError("refused", "invalid_native_launch");
}

// Arguments that bind the child to the qualified profile and native identity.
export function nativeArguments(
  native: NativeCoreLaunch,
  binding: ProfileLaunchBinding,
): string[] {
  const args = [
    "--profile-root",
    binding.root,
    "--profile-device",
    binding.device,
    "--profile-inode",
    binding.inode,
    "--owner",
    native.ownerId,
    "--computer",
    native.computerId,
    "--home",
    binding.home,
    "--store-mode",
    native.storeMode,
  ];
  if (native.hostLifetimeId !== undefined && native.childLaunchId !== undefined)
    args.push(
      "--host-lifetime",
      native.hostLifetimeId,
      "--child-launch",
      native.childLaunchId,
    );
  return args;
}

// Optional startup flags, appended after the profile arguments.
export function startupArguments(
  native: NativeCoreLaunch | undefined,
  codexRead: NativeCodexReadSelection | undefined,
): string[] {
  const args: string[] = [];
  if (native?.startupMode !== undefined)
    args.push("--startup-mode", native.startupMode);
  if (native?.previousHostDrainConfirmed === true)
    args.push("--previous-host-drain-confirmed");
  if (native?.settingsMutations === true) args.push("--settings-mutations");
  if (codexRead)
    args.push(
      "--codex-read-host",
      codexRead.hostId,
      "--codex-read-temp",
      codexRead.trustedTemp,
    );
  return args;
}

// Private shell metadata, copied so the caller cannot change it after launch.
export function copyShellMetadata(
  native: NativeCoreLaunch | undefined,
): Buffer | undefined {
  if (native?.shellMetadata === undefined) return undefined;
  if (
    !(native.shellMetadata instanceof Uint8Array) ||
    native.shellMetadata.byteLength === 0 ||
    native.shellMetadata.byteLength > 256 * 1024 ||
    native.settingsMutations !== true ||
    native.hostLifetimeId === undefined ||
    native.childLaunchId === undefined
  )
    throw new BridgeError("refused", "invalid_shell_launch_metadata");
  return Buffer.from(native.shellMetadata);
}

// One bounded end/write. A successful callback proves only local pipe delivery;
// the SAME child's subsequent handshake proves it accepted startup. Keep an error
// listener after settlement so a late error never becomes an unhandled exception.
export function writeShellMetadata(
  stream: Writable,
  bytes: Buffer,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed)
        reject(
          new BridgeError("unavailable", "shell_metadata_delivery_failed"),
        );
      else resolve();
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    stream.on("error", () => finish(true));
    stream.once("close", () => finish(true));
    try {
      stream.end(bytes, (error?: Error | null) =>
        finish(error != null || stream.errored != null),
      );
    } catch {
      finish(true);
    }
  });
}
