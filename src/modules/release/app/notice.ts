import type { InstalledUpdateView } from "../domain/installed-update";
import { updateOutcomeUnresolved } from "../domain/installed-update";

/** Phases whose view carries a notice. */
export function noticeBearing(
  view: InstalledUpdateView,
): view is Extract<
  InstalledUpdateView,
  { phase: "available" | "ready" | "failed" }
> {
  return (
    view.phase === "available" ||
    view.phase === "ready" ||
    view.phase === "failed"
  );
}

/** Phases that supersede an earlier failure's notice. */
export function resolvesFailureNotice(view: InstalledUpdateView): boolean {
  return (
    (view.phase === "idle" && view.checkedAt !== null) ||
    view.phase === "available" ||
    view.phase === "ready"
  );
}

/** The view itself permits acknowledging this key; updater state is checked apart. */
export function noticeAcknowledgeable(
  current: InstalledUpdateView,
  key: string,
): boolean {
  return !(
    !(
      current.phase === "available" ||
      current.phase === "ready" ||
      current.phase === "failed"
    ) ||
    !current.notice ||
    current.notice.key !== key ||
    current.notice.seen ||
    current.notice.blockedBy ||
    (current.phase === "failed" && updateOutcomeUnresolved(current.code)) ||
    (current.phase === "ready" && updateOutcomeUnresolved(current.blockedBy))
  );
}
