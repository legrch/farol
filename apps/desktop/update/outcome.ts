import type { z } from "zod";
import { candidateDeferred } from "./stage";
import type { UpdatePreferences } from "./record";

// The closed outcomes and projections the update owner reports for discovery,
// staging and the Skip/Later choices. Each is a value from what the caller
// holds: it reads no record, starts no transfer and decides nothing about
// retrying. An unknown outcome stays unknown in every shape built here.

type Preferences = z.infer<typeof UpdatePreferences>;

/** The staging outcome that fences the owner until startup reconciles it. */
export function stagingUnknown() {
  return {
    ok: false as const,
    code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
    recoveryRequired: true,
  };
}

/** The refusal reported when the Skip/Later record cannot be read. */
export function preferencesUnreadable() {
  return {
    ok: false as const,
    code: "UPDATE_PREFERENCES_UNREADABLE",
    recoveryRequired: true,
  };
}

/** The release channel a build's update channel selects. */
export function releaseChannel(updateChannel: string): "stable" | "owner-beta" {
  return updateChannel === "github-stable" ? "stable" : "owner-beta";
}

/** True when a transport result is a failure whose effect is unknown. */
export function transportUnknown(
  result: Readonly<{ ok: boolean; certainty?: string }>,
): boolean {
  return !result.ok && result.certainty === "unknown";
}

/** What discovery reports for one candidate, or for none. */
export function discoveryView(
  candidate: Readonly<{
    manifest: Readonly<{ version: string; buildId: string }>;
    notes?: string | undefined;
  }> | null,
  declinedBuildId: string | null,
  preferences: Preferences,
) {
  return candidate
    ? {
        ok: true as const,
        available: true as const,
        version: candidate.manifest.version,
        buildId: candidate.manifest.buildId,
        deferred: candidateDeferred({
          buildId: candidate.manifest.buildId,
          version: candidate.manifest.version,
          declinedBuildId,
          deferredVersion: preferences.deferredVersion,
        }),
        ...(candidate.notes ? { notes: candidate.notes } : {}),
      }
    : { ok: true as const, available: false as const };
}

/** The Skip/Later record after the owner skips one release. */
export function skippedPreferences(version: string, buildId: string) {
  return {
    schema: "farol.installed-update-preferences/1",
    skipped: { version, buildId },
    deferredVersion: null,
  };
}

/** The Skip/Later record after the owner defers one release. */
export function deferredPreferences(preferences: Preferences, version: string) {
  return { ...preferences, deferredVersion: version };
}
