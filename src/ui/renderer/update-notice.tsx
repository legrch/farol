import type { RendererFacade, WindowSnapshot } from "./contract";
import { updateBlockMessage } from "../update-block-message";

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

/** Release owns persistence; this component holds no dismissal authority. */
export function UpdateNotice({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const update = snapshot.update;
  if (
    !("notice" in update) ||
    !update.notice ||
    update.notice.seen ||
    snapshot.overlay !== "none" ||
    snapshot.sidebar === "overlay" ||
    snapshot.status !== "current" ||
    ((update.phase === "available" || update.phase === "ready") &&
      update.deferred)
  )
    return null;
  const disabled =
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
            ? "The update did not finish"
            : `Farol ${update.version} is ${update.phase === "ready" ? "downloaded" : "available"}`}
        </strong>
        <p>
          {update.phase === "failed"
            ? "Review the update status when you choose."
            : update.phase === "ready"
              ? update.blockedBy
                ? `Installation has not started. ${updateBlockMessage(update.blockedBy)}`
                : "Downloaded, not installed. Restart & Update when you choose; your work continues."
              : "A new version is available when you’re ready."}
        </p>
        <button onClick={() => facade.overlay("update")}>View update</button>
      </div>
      <button
        aria-label="Dismiss update notice"
        disabled={disabled}
        onClick={() => acknowledgeUpdateNotice(facade)}
      >
        ×
      </button>
    </section>
  );
}
