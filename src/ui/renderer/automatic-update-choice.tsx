import { useId } from "react";
import type { RendererFacade, WindowSnapshot } from "./contract";
import {
  automaticUpdateEnabled,
  automaticUpdateAvailable,
} from "./update-eligibility";

export function AutomaticUpdateChoice({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const descriptionId = useId();
  const intent = snapshot.intents["update-automatic-downloads"];
  const quitIntent = snapshot.intents["update-install-on-quit"];
  const preference = snapshot.update.automaticUpdatePreference;
  const unknown =
    intent?.state === "unknown" ||
    quitIntent?.state === "unknown" ||
    preference?.status === "unknown";
  return (
    <div className="automatic-update-choice">
      <label>
        <span>
          <strong>Automatically install updates</strong>
          <span id={descriptionId} className="description">
            Download and install updates when idle.
          </span>
        </span>
        <input
          type="checkbox"
          aria-label="Automatically install updates"
          checked={
            snapshot.environment === "preview" &&
            automaticUpdateEnabled(snapshot.update)
          }
          disabled={!automaticUpdateAvailable(snapshot)}
          aria-describedby={descriptionId}
          onChange={(event) => {
            if (!automaticUpdateAvailable(facade.getSnapshot())) return;
            void facade.setAutomaticDownloads(event.currentTarget.checked);
          }}
        />
      </label>
      {unknown ? (
        <p role="alert">
          Preference outcome is unknown. Do not repeat this change; review
          Diagnostics.
        </p>
      ) : intent?.state === "pending" ? (
        <p role="status">Saving update preference…</p>
      ) : preference?.status !== "confirmed" ? (
        <p role="status">
          Update preference cannot be confirmed in this session.
        </p>
      ) : intent?.state === "refused" ? (
        <p role="status">
          The update preference could not be saved. Review Diagnostics.
        </p>
      ) : null}
    </div>
  );
}
