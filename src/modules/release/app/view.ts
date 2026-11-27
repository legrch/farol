import type { InstalledUpdateView } from "../domain/installed-update";
import { updateOutcomeUnresolved } from "../domain/installed-update";

type Failure = Readonly<{
  code: string;
  recoveryRequired?: boolean;
}>;

type Recovered =
  | Readonly<{
      ok: true;
      update: Readonly<{
        manifest: Readonly<{ version: string }>;
        notes?: string;
      }> | null;
      rollbackVersion?: string;
      recoveryVersion?: string;
    }>
  | (Failure & Readonly<{ ok: false }>);

/** Only a known producer refusal before retention can preserve the admitted Ready. */
export function readyPreservedByRefusal(
  failure: Failure,
  knownReady: boolean,
): boolean {
  return (
    knownReady &&
    !failure.recoveryRequired &&
    !updateOutcomeUnresolved(failure.code)
  );
}

/** Failure after a producer or retention step; a replacement can never be known. */
export function preparationFailureView(
  failure: Failure,
  knownReady: boolean,
  rollbackVersion: string | undefined,
): InstalledUpdateView {
  return {
    phase: "failed",
    code: failure.code,
    recoveryRequired: knownReady ? true : (failure.recoveryRequired ?? false),
    ...(!knownReady && !failure.recoveryRequired && rollbackVersion
      ? { rollbackVersion }
      : {}),
  };
}

/** The view that startup recovery publishes, or null when it found nothing. */
export function recoveredView(restored: Recovered): InstalledUpdateView | null {
  if (!restored.ok)
    return {
      phase: "failed",
      code: restored.code,
      recoveryRequired: restored.recoveryRequired ?? true,
    };
  if (restored.recoveryVersion)
    return {
      phase: "recovery",
      version: restored.recoveryVersion,
      blockedBy: null,
    };
  if (restored.update)
    return {
      phase: "ready",
      version: restored.update.manifest.version,
      deferred: true,
      blockedBy: null,
      ...(restored.update.notes ? { notes: restored.update.notes } : {}),
    };
  if (restored.rollbackVersion)
    return {
      phase: "idle",
      checkedAt: null,
      rollbackVersion: restored.rollbackVersion,
    };
  return null;
}

/** The version a restore action targets, or undefined when it is not offered. */
export function restoreTargetVersion(
  previous: InstalledUpdateView,
  action: "recover" | "rollback",
): string | undefined {
  return action === "recover" && previous.phase === "recovery"
    ? previous.version
    : action === "rollback" &&
        (previous.phase === "idle" ||
          (previous.phase === "failed" && !previous.recoveryRequired))
      ? previous.rollbackVersion
      : undefined;
}
