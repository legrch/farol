import { useState } from "react";
import type { RendererFacade, WindowSnapshot } from "./contract";
import {
  isConfirmedBrowserBlock,
  updateVersionLabel,
} from "./update-eligibility";
import { updateBlockMessage } from "../update-block-message";

// The shell can remount this component while an update changes phase. A
// dismissed popup stays hidden for this window session; the saved update and
// its unresolved operation remain available in Updates and Activity.
const dismissedByFacade = new WeakMap<RendererFacade, Set<string>>();

export function acknowledgeUpdateNotice(facade: RendererFacade): void {
  const snapshot = facade.getSnapshot();
  const update = snapshot.update;
  if (
    !("notice" in update) ||
    !update.notice ||
    update.notice.seen ||
    update.notice.blockedBy ||
    snapshot.status !== "current" ||
    snapshot.intents.update?.state === "pending" ||
    snapshot.intents.update?.state === "unknown" ||
    (update.phase === "failed" && update.code.includes("UNKNOWN")) ||
    (update.phase === "ready" && update.blockedBy?.includes("UNKNOWN"))
  )
    return;
  void facade.update("notice-seen", update.notice.key);
}

/** Local dismissal only hides the popup; Release still owns saved state. */
export function UpdateNotice({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const update = snapshot.update;
  if (
    !("notice" in update) ||
    !update.notice ||
    (dismissedByFacade.get(facade)?.has(update.notice.key) ?? false) ||
    update.notice.key === dismissedKey ||
    update.notice.seen ||
    snapshot.overlay !== "none" ||
    snapshot.sidebar === "overlay" ||
    snapshot.status !== "current" ||
    ((update.phase === "available" || update.phase === "ready") &&
      update.deferred)
  )
    return null;
  const acknowledgementBlocked =
    Boolean(update.notice.blockedBy) ||
    snapshot.intents.update?.state === "pending" ||
    snapshot.intents.update?.state === "unknown" ||
    snapshot.intents["update-notice"]?.state === "pending" ||
    snapshot.intents["update-notice"]?.state === "unknown" ||
    (update.phase === "failed" && update.code.includes("UNKNOWN")) ||
    (update.phase === "ready" &&
      Boolean(update.blockedBy?.includes("UNKNOWN")));
  return (
    <section className="update-notice" aria-label="Update notice" role="status">
      <div>
        <strong>
          {update.phase === "failed"
            ? update.code === "UPDATE_NETWORK_FAILURE"
              ? "Update network request failed"
              : "The update did not finish"
            : `Farol ${updateVersionLabel(update.version)} is ${update.phase === "ready" ? "downloaded" : "available"}`}
        </strong>
        <p>
          {update.phase === "failed"
            ? update.code === "UPDATE_NETWORK_FAILURE"
              ? "Farol couldn't get update data from GitHub. Your installed version is shown in Updates."
              : "Review the update status when you choose."
            : update.phase === "ready"
              ? update.blockedBy && !isConfirmedBrowserBlock(update.blockedBy)
                ? `Installation has not started. ${updateBlockMessage(update.blockedBy)}`
                : "Ready to install. Farol will restart when you choose."
              : "A new version is available when you’re ready."}
        </p>
        <button onClick={() => facade.overlay("update")}>View update</button>
      </div>
      <button
        aria-label="Dismiss update notice"
        onClick={() => {
          let dismissed = dismissedByFacade.get(facade);
          if (!dismissed) {
            dismissed = new Set<string>();
            dismissedByFacade.set(facade, dismissed);
          }
          dismissed.add(update.notice!.key);
          setDismissedKey(update.notice!.key);
          if (!acknowledgementBlocked) acknowledgeUpdateNotice(facade);
        }}
      >
        ×
      </button>
    </section>
  );
}
