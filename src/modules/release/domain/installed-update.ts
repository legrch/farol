export type UpdateNotice = Readonly<{
  key: string;
  seen: boolean;
  blockedBy: string | null;
}>;

// Observational only: transferred bytes never establish a verified package.
export type UpdateDownloadProgress =
  | Readonly<{
      stage: "transferring";
      receivedBytes: number;
      totalBytes: number;
    }>
  | Readonly<{ stage: "verifying" }>;

type UpdatePhaseView =
  | Readonly<{ phase: "unavailable"; code: string }>
  | Readonly<{
      phase: "idle";
      checkedAt: number | null;
      rollbackVersion?: string;
      blockedBy?: string;
    }>
  | Readonly<{ phase: "recovery"; version: string; blockedBy: string | null }>
  | Readonly<{ phase: "checking" }>
  | Readonly<{ phase: "downloading"; progress?: UpdateDownloadProgress }>
  | Readonly<{
      phase: "available";
      version: string;
      deferred: boolean;
      notes?: string;
      notice?: UpdateNotice;
    }>
  | Readonly<{
      phase: "ready";
      version: string;
      deferred: boolean;
      blockedBy: string | null;
      notes?: string;
      notice?: UpdateNotice;
    }>
  | Readonly<{ phase: "applying"; version: string }>
  | Readonly<{
      phase: "failed";
      code: string;
      recoveryRequired: boolean;
      notice?: UpdateNotice;
      rollbackVersion?: string;
    }>;

// This is a persisted choice, not proof that any automatic release effect ran.
export type AutomaticUpdatePreference =
  | Readonly<{
      status: "confirmed";
      enabled: boolean;
      scope?: "download-and-install" | undefined;
    }>
  | Readonly<{ status: "blocked" | "unknown"; enabled: false; code: string }>;

export type AutomaticUpdatePreferenceResult =
  | Readonly<{
      status: "confirmed";
      enabled: boolean;
      scope?: "download-and-install" | undefined;
    }>
  | Readonly<{ status: "refused" | "unknown"; code: string }>;

// This independent choice never inherits the legacy download-only preference.
export type InstallOnQuitPreference =
  | Readonly<{
      status: "confirmed";
      scope: "install-on-normal-quit";
      enabled: boolean;
    }>
  | Readonly<{ status: "blocked" | "unknown"; enabled: false; code: string }>;

export type InstallOnQuitPreferenceResult =
  | Extract<InstallOnQuitPreference, { status: "confirmed" }>
  | Readonly<{ status: "refused" | "unknown"; code: string }>;

export type NormalQuitUpdateRequest = Readonly<{
  kind: "ordinary-quit";
  // Absolute deadline in the same clock as the existing Quit drain and now().
  deadlineAt: number;
}>;

export type NormalQuitApplyContext = NormalQuitUpdateRequest &
  Readonly<{ relaunch: false; requestQuit: false }>;

export type NormalQuitUpdateReceipt =
  // Accepted means the original helper's bound readiness ACK, never installed.
  | Readonly<{ status: "accepted"; relaunch: false }>
  | Readonly<{ status: "skipped" | "blocked" | "unknown"; code: string }>;

export type NormalQuitUpdateState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "pending"; deadlineAt: number }>
  | Readonly<{
      status: "settled";
      deadlineAt: number;
      receipt: NormalQuitUpdateReceipt;
    }>;

/** Parse only the new consent scope; a legacy boolean/ACK is never consent. */
export function parseInstallOnQuitPreference(
  value: unknown,
): InstallOnQuitPreference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (
    record.status === "confirmed" &&
    record.scope === "install-on-normal-quit" &&
    typeof record.enabled === "boolean" &&
    Object.keys(record).every((key) =>
      ["status", "scope", "enabled"].includes(key),
    )
  )
    return {
      status: "confirmed",
      scope: "install-on-normal-quit",
      enabled: record.enabled,
    };
  if (
    (record.status === "blocked" || record.status === "unknown") &&
    record.enabled === false &&
    typeof record.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,100}$/u.test(record.code) &&
    Object.keys(record).every((key) =>
      ["status", "enabled", "code"].includes(key),
    )
  )
    return { status: record.status, enabled: false, code: record.code };
  return null;
}

export type InstalledUpdateView = UpdatePhaseView &
  Readonly<{
    automaticUpdatePreference?: AutomaticUpdatePreference;
    installOnQuitPreference?: InstallOnQuitPreference;
  }>;
