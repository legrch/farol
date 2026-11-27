import type {
  AutomaticUpdatePreference,
  AutomaticUpdatePreferenceResult,
  InstallOnQuitPreference,
  InstallOnQuitPreferenceResult,
} from "../domain/installed-update";
import { parseInstallOnQuitPreference } from "../domain/installed-update";

/** Classify an install-on-Quit write ACK against the value that was asked for. */
export function quitWriteResult(
  ack: InstallOnQuitPreferenceResult,
  enabled: boolean,
): InstallOnQuitPreferenceResult {
  const confirmed = parseInstallOnQuitPreference(ack);
  if (confirmed?.status === "confirmed" && confirmed.enabled === enabled)
    return confirmed;
  if (
    ack &&
    (ack.status === "refused" || ack.status === "unknown") &&
    typeof ack.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,100}$/u.test(ack.code) &&
    Object.keys(ack).every((key) => ["status", "code"].includes(key))
  )
    return { status: ack.status, code: ack.code };
  return { status: "unknown", code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH" };
}

/** A confirmed automatic ACK must echo exactly the enabled value and scope. */
export function automaticWriteResult(
  result: AutomaticUpdatePreferenceResult,
  enabled: boolean,
  scope: "download-and-install" | undefined,
): AutomaticUpdatePreferenceResult {
  if (
    result.status === "confirmed" &&
    (result.enabled !== enabled || result.scope !== scope)
  )
    return {
      status: "unknown",
      code: "UPDATE_AUTOMATIC_PREFERENCE_ACK_MISMATCH",
    };
  return result;
}

/** What a settled write leaves behind: the choice, or a fenced non-consent. */
export function settledQuitPreference(
  result: InstallOnQuitPreferenceResult,
): InstallOnQuitPreference {
  return result.status === "confirmed"
    ? result
    : {
        status: result.status === "unknown" ? "unknown" : "blocked",
        enabled: false,
        code: result.code,
      };
}

export function settledAutomaticPreference(
  result: AutomaticUpdatePreferenceResult,
): AutomaticUpdatePreference {
  return result.status === "confirmed"
    ? result
    : {
        status: result.status === "unknown" ? "unknown" : "blocked",
        enabled: false,
        code: result.code,
      };
}
