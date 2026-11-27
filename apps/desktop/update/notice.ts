import type { z } from "zod";
import {
  updateOutcomeUnresolved,
  type InstalledUpdateView,
} from "../../../src/modules/release/contract/installed-update";
import type { NoticePreferences } from "./record";

// The pure decisions behind the update notice lane. Each takes the view and the
// preferences the caller already read and answers what the notice should be.
// None reads or writes a record; the caller keeps the serialized write lane, the
// key generator and every refusal that follows an unreadable record.

type Notices = z.infer<typeof NoticePreferences>;
type FailureNotice = NonNullable<Notices["failureNotice"]>;

/** What the updater is told about one notice: its key, whether it was seen, and any block. */
export type NoticeOutcome = Readonly<{
  key: string;
  seen: boolean;
  blockedBy: string | null;
}>;

/** A failure whose outcome is unknown never gets a notice of its own. */
export function noticeUnresolved(
  view: InstalledUpdateView,
): NoticeOutcome | null {
  return view.phase === "failed" && updateOutcomeUnresolved(view.code)
    ? { key: "unconfirmed", seen: false, blockedBy: view.code }
    : null;
}

export type NoticeDecision =
  | Readonly<{ kind: "known"; outcome: NoticeOutcome }>
  | Readonly<{ kind: "failure-new" }>
  | Readonly<{ kind: "not-available" }>;

/**
 * The notice for a view once the preferences were read: an available or ready
 * version keyed by its number, a failure reused within one unresolved streak,
 * a new failure, or a view that carries no notice at all.
 */
export function noticeDecision(input: {
  view: InstalledUpdateView;
  version: string | null;
  reusePreviousFailure: boolean;
  preferences: Notices;
}): NoticeDecision {
  const { view, version, reusePreviousFailure, preferences } = input;
  if (view.phase === "available" || view.phase === "ready")
    return {
      kind: "known",
      outcome: {
        key: `version:${view.version}`,
        seen: preferences.seenVersion === view.version,
        blockedBy: null,
      },
    };
  if (view.phase !== "failed") return { kind: "not-available" };
  // Reuse only within one unresolved failure streak or on restoration.
  // A successful check starts a new streak, even for the same code.
  const previous = preferences.failureNotice;
  if (
    reusePreviousFailure &&
    previous?.code === view.code &&
    (version === null || previous.version === version)
  )
    return {
      kind: "known",
      outcome: { key: previous.key, seen: previous.seen, blockedBy: null },
    };
  return { kind: "failure-new" };
}

/** The record for a failure notice the caller just keyed. */
export function newFailureNotice(
  version: string | null,
  code: string,
  key: string,
): FailureNotice {
  return { version, code, key, seen: false };
}

/**
 * The preferences after the owner saw one notice, or null when the key names
 * neither a plausible version nor the current failure notice.
 */
export function noticeSeenRecord(
  preferences: Notices,
  key: string,
): Notices | null {
  if (key.startsWith("version:")) {
    const version = key.slice("version:".length);
    if (version.length === 0 || version.length > 128) return null;
    return { ...preferences, seenVersion: version };
  }
  if (preferences.failureNotice?.key === key)
    return {
      ...preferences,
      failureNotice: { ...preferences.failureNotice, seen: true },
    };
  return null;
}
