import type {
  AutomaticUpdatePreference,
  InstallOnQuitPreference,
  InstalledUpdateView,
  NormalQuitUpdateReceipt,
} from "../domain/installed-update";
import { updateOutcomeUnresolved } from "../domain/installed-update";

/** A request is exactly the ordinary Quit kind and a safe absolute deadline. */
export function quitRequestValid(request: unknown): boolean {
  const candidate = request as {
    kind?: unknown;
    deadlineAt?: unknown;
  } | null;
  return (
    !!candidate &&
    candidate.kind === "ordinary-quit" &&
    Number.isSafeInteger(candidate.deadlineAt) &&
    (candidate.deadlineAt as number) >= 0 &&
    Object.keys(candidate).every((key) => ["kind", "deadlineAt"].includes(key))
  );
}

/** Null means consent is confirmed and enabled; otherwise the receipt to return. */
export function quitConsentReceipt(
  automatic: AutomaticUpdatePreference,
  automaticPortPresent: boolean,
  quit: InstallOnQuitPreference,
): NormalQuitUpdateReceipt | null {
  // The unified choice supersedes the legacy separate Quit checkbox.
  if (automaticPortPresent && automatic.status !== "confirmed")
    return { status: automatic.status, code: automatic.code };
  const preference =
    automatic.status === "confirmed" &&
    automatic.scope === "download-and-install"
      ? automatic
      : quit;
  if (preference.status !== "confirmed")
    return { status: preference.status, code: preference.code };
  if (!preference.enabled)
    return { status: "skipped", code: "UPDATE_QUIT_NOT_OPTED_IN" };
  return null;
}

/** Null means the view holds a retained, unblocked Ready package. */
export function quitViewReceipt(
  view: InstalledUpdateView,
  hasReady: boolean,
): NormalQuitUpdateReceipt | null {
  if (view.phase === "failed" && view.recoveryRequired)
    return {
      status: updateOutcomeUnresolved(view.code) ? "unknown" : "blocked",
      code: view.code,
    };
  if (view.phase === "recovery")
    return { status: "blocked", code: "UPDATE_RECOVERY_REQUIRED" };
  if (view.phase !== "ready" || !hasReady)
    return { status: "skipped", code: "UPDATE_PACKAGE_NOT_READY" };
  if (view.blockedBy !== null)
    return {
      status: updateOutcomeUnresolved(view.blockedBy) ? "unknown" : "blocked",
      code: view.blockedBy,
    };
  return null;
}

export type QuitHandoffClass =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "refused"; status: "blocked" | "unknown"; code: string }>
  | null;

/** Only the exact accepted shape or a well-formed refusal is understood. */
export function classifyQuitHandoff(
  outcome: Readonly<{ status: string; code?: string }> | null | undefined,
): QuitHandoffClass {
  if (
    outcome &&
    outcome.status === "accepted" &&
    Object.keys(outcome).length === 1
  )
    return { kind: "accepted" };
  if (
    outcome &&
    (outcome.status === "blocked" || outcome.status === "unknown") &&
    typeof outcome.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,100}$/u.test(outcome.code) &&
    Object.keys(outcome).every((key) => ["status", "code"].includes(key))
  )
    return { kind: "refused", status: outcome.status, code: outcome.code };
  return null;
}
