import { useState } from "react";
import { setupChecklist } from "../../../src/ui/renderer/setup-navigation";
import {
  automaticUpdateAvailable,
  automaticUpdateEnabled,
  updateCheckAllowed,
} from "../../../src/ui/renderer/update-eligibility";
import { Group, Command, type PageProps } from "./page";

export function General({ snapshot, facade, actions }: PageProps) {
  const [checking, setChecking] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const checklist = setupChecklist(snapshot);
  const preference = snapshot.update.automaticUpdatePreference;
  const updateIntent = snapshot.intents["update-automatic-downloads"];
  const quitIntent = snapshot.intents["update-install-on-quit"];
  const preferenceUnknown =
    preference?.status === "unknown" ||
    updateIntent?.state === "unknown" ||
    quitIntent?.state === "unknown";
  return (
    <>
      <h2>General</h2>
      <section className="settings-setup-status" aria-label="Setup status">
        <div>
          <h3>
            {checklist.completed || checklist.ready
              ? "Farol is set up"
              : "Finish setting up Farol"}
          </h3>
          <p className="description">
            Sign-in, workspaces, connection and ChatGPT live in Setup.
          </p>
        </div>
        <button
          type="button"
          className="subtle"
          onClick={() =>
            facade.navigate({ area: "setup", setupStep: "overview" })
          }
        >
          Open Setup
        </button>
      </section>
      <div className="settings-update-controls">
        <Group title="Updates" showTitle={false}>
          <label className="setting-row">
            Install updates automatically
            <input
              type="checkbox"
              aria-label="Install updates automatically"
              checked={
                snapshot.environment === "preview" &&
                automaticUpdateEnabled(snapshot.update)
              }
              disabled={!automaticUpdateAvailable(snapshot)}
              onChange={(event) => {
                if (automaticUpdateAvailable(facade.getSnapshot()))
                  void facade.setAutomaticDownloads(
                    event.currentTarget.checked,
                  );
              }}
            />
          </label>
          {preferenceUnknown ? (
            <p className="description" role="status">
              The update preference could not be confirmed. Wait for its saved
              result before changing it again.
            </p>
          ) : preference?.status !== "confirmed" ? (
            <p className="description">
              The update preference is unavailable in this session.
            </p>
          ) : updateIntent?.state === "refused" ? (
            <p className="description" role="status">
              The update preference could not be saved.
            </p>
          ) : null}
          <div className="setting-row">
            <span>Version</span>
            <span>
              {snapshot.installedVersion?.version ?? "Unavailable"}
              {snapshot.installedVersion?.buildVersion
                ? ` · ${snapshot.installedVersion.buildVersion}`
                : ""}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={
                checking ||
                snapshot.environment !== "preview" ||
                snapshot.status !== "current" ||
                snapshot.runtime !== "ready" ||
                !updateCheckAllowed(snapshot.update) ||
                snapshot.intents.update?.state === "unknown" ||
                snapshot.intents.update?.state === "pending"
              }
              onClick={async () => {
                if (!updateCheckAllowed(facade.getSnapshot().update)) return;
                setChecking(true);
                try {
                  const result = await facade.update("check");
                  setUpdateMessage(
                    result.state === "applied"
                      ? "Update check completed."
                      : result.state === "unknown"
                        ? "The update check could not be confirmed. Do not repeat it."
                        : "The update check could not be completed.",
                  );
                } finally {
                  setChecking(false);
                }
              }}
            >
              {checking ? "Checking…" : "Check for updates"}
            </button>
            <button
              className="subtle"
              onClick={() => facade.overlay("update-recovery")}
            >
              Update recovery…
            </button>
          </div>
          {updateMessage && (
            <p className="description" role="status">
              {updateMessage}
            </p>
          )}
        </Group>
      </div>
      <Group title="Something wrong?">
        <p className="description">
          Save a support file and attach it to a GitHub issue. It holds no
          messages, keys or file contents.
        </p>
        <Command actions={actions} command={{ kind: "support.export" }}>
          Save support file…
        </Command>
      </Group>
    </>
  );
}
