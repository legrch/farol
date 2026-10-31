import type { WindowSnapshot } from "../../../../src/ui/renderer/contract";
import {
  automaticUpdateAvailable,
  automaticUpdateEnabled,
  confirmedRestartAllowed,
  updateCheckAllowed,
} from "../../../../src/ui/renderer/update-eligibility";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WindowController } from "../../../../src/ui/renderer/controller";
import type { UpdatesOwnerAPI } from "./contract";
import {
  UpdatesCommandSchema,
  UpdatesStateSchema,
  type UpdatesAPI,
  type UpdatesState,
} from "./contract";
import { updateVersionLabel } from "../../../../src/ui/renderer/update-eligibility";
import type { UpdatesProjection } from "./contract";
import {
  UpdateDownloadProgress,
  updateDownloadMessage,
} from "../../../../src/ui/renderer/update-download";
import {
  updateBlockMessage,
  updateResultMessage,
} from "../../../../src/ui/update-block-message";

/** Attach once to the existing shell owner, outside React's mount lifecycle. */
export function attachUpdatesOwner(
  controller: WindowController,
  api: UpdatesOwnerAPI,
): () => void {
  const publish = () =>
    api.publishUpdates?.(projectUpdates(controller.getSnapshot()));
  const unsubscribe = controller.subscribe(publish);
  let lastSequence = 0;
  let disposed = false;
  const stopCommands = api.onUpdatesCommand?.((value) => {
    const parsed = UpdatesCommandSchema.safeParse(value);
    if (disposed || !parsed.success || parsed.data.sequence <= lastSequence)
      return;
    const { sequence, intent } = parsed.data;
    lastSequence = sequence;
    void (async () => {
      // A newer projection may have withdrawn permission since the panel clicked.
      if (projectUpdates(controller.getSnapshot()).allowed[intent.kind]) {
        if (intent.kind === "automatic")
          await controller.setAutomaticDownloads(intent.enabled);
        else if (intent.kind === "recovery")
          controller.overlay("update-recovery");
        else
          await controller.update(
            intent.kind,
            intent.kind === "restart-confirmed" ? intent.version : undefined,
          );
      }
      if (!disposed) {
        publish();
        api.settleUpdates?.({ sequence });
      }
    })().catch(() => {
      // An unclassified relay outcome stays pending in the host. Never replay.
    });
  });
  publish();
  return () => {
    disposed = true;
    unsubscribe();
    stopCommands?.();
  };
}

export function UpdatesWindow({ api }: { api: UpdatesAPI }) {
  const [state, setState] = useState<UpdatesState>({ status: "unavailable" });
  useEffect(() => {
    let active = true;
    let revision = 0;
    const adopt = (value: unknown) => {
      const parsed = UpdatesStateSchema.safeParse(value);
      if (active)
        setState(parsed.success ? parsed.data : { status: "unavailable" });
    };
    const stop = api.onState((value) => {
      revision++;
      adopt(value);
    });
    const atRead = revision;
    void api
      .state()
      .then((value) => {
        if (revision === atRead) adopt(value);
      })
      .catch(() => {
        if (revision === atRead) adopt(null);
      });
    return () => {
      active = false;
      stop();
    };
  }, [api]);
  const projection = state.status === "ready" ? state.projection : null;
  const update = projection?.update;
  const disabled = (kind: keyof NonNullable<typeof projection>["allowed"]) =>
    state.status !== "ready" ||
    state.pending ||
    !state.projection.allowed[kind];
  const release = update?.phase === "available" || update?.phase === "ready";
  const title = !update
    ? "Updates unavailable"
    : projection?.outcome === "unknown"
      ? "Update status unconfirmed"
      : update.phase === "available"
        ? "A new version is available"
        : update.phase === "ready"
          ? "Ready to install"
          : update.phase === "checking"
            ? "Checking for updates"
            : update.phase === "downloading"
              ? "Downloading update"
              : update.phase === "applying"
                ? "Restarting to update"
                : update.phase === "recovery"
                  ? "Update needs recovery"
                  : update.phase === "failed"
                    ? "The update did not finish"
                    : update.phase === "unavailable"
                      ? "Updates unavailable"
                      : update.phase === "idle" && update.checkedAt !== null
                        ? "You’re up to date"
                        : "Farol Updates";
  return (
    <main
      className="desktop native-updates"
      data-theme="system"
      aria-label="Farol Updates"
    >
      <h1>{title}</h1>
      <div role="status" aria-live="polite">
        {!update ? (
          <p>
            The update owner is unavailable. Return to Farol to inspect the
            retained operation.
          </p>
        ) : release ? (
          <p>
            Farol {updateVersionLabel(update.version)} is{" "}
            {update.phase === "ready"
              ? "ready to install"
              : "available to download"}
            .
          </p>
        ) : update.phase === "failed" ? (
          <p>
            {updateResultMessage(
              "failed",
              update.recoveryRequired,
              update.code,
            )}
          </p>
        ) : update.phase === "unavailable" ? (
          <p>
            {update.code === "UPDATE_NOT_INSTALLED"
              ? "Update checks are available in an installed Farol."
              : updateResultMessage("unavailable", false, update.code)}
          </p>
        ) : update.phase === "downloading" ? (
          <>
            <p>{updateDownloadMessage(update)}</p>
            <UpdateDownloadProgress update={update} />
          </>
        ) : update.phase === "recovery" ? (
          <p>
            Review the existing recovery operation in Farol before continuing.
          </p>
        ) : update.phase === "idle" && update.checkedAt === null ? (
          <p>Update availability has not been checked.</p>
        ) : null}
      </div>
      {projection?.installedVersion && (
        <p className="description">
          Installed version {projection.installedVersion}
        </p>
      )}
      {state.status === "ready" && state.pending && (
        <p role="status">
          {update?.phase === "applying"
            ? "Farol is preparing the update and will restart when ready."
            : "You can close this window. The update will continue in the background."}
        </p>
      )}
      {projection?.outcome === "unknown" && (
        <p role="alert">
          Outcome unknown. Inspect the retained operation; do not repeat this
          action.
        </p>
      )}
      {release && update.notes && (
        <details className="update-release">
          <summary>What’s new</summary>
          <p className="update-notes">{update.notes}</p>
        </details>
      )}
      {update && "blockedBy" in update && update.blockedBy && (
        <p role="status">{updateBlockMessage(update.blockedBy)}</p>
      )}
      {projection && (
        <div className="automatic-update-choice">
          <label>
            <span>
              <strong>Automatically install updates</strong>
              <span className="description">
                Download and install updates when idle.
              </span>
            </span>
            <input
              type="checkbox"
              aria-label="Automatically install updates"
              checked={projection.automaticEnabled}
              disabled={disabled("automatic")}
              onChange={(event) =>
                api.intent({
                  kind: "automatic",
                  enabled: event.currentTarget.checked,
                })
              }
            />
          </label>
        </div>
      )}
      {update?.phase === "ready" && (
        <p>
          Farol will close open ChatGPT sessions and interrupt work before
          restarting.
        </p>
      )}
      <div className="native-updates-actions">
        {release && (
          <>
            {update.phase === "available" && (
              <button
                disabled={disabled("skip")}
                onClick={() => api.intent({ kind: "skip" })}
              >
                Skip This Version
              </button>
            )}
            <button
              disabled={disabled("later")}
              onClick={() => api.intent({ kind: "later" })}
            >
              Remind Me Later
            </button>
            {update.phase === "available" ? (
              <button
                className="primary"
                disabled={disabled("download")}
                onClick={() => api.intent({ kind: "download" })}
              >
                Download Update
              </button>
            ) : (
              <button
                className="primary"
                disabled={disabled("restart-confirmed")}
                onClick={() =>
                  api.intent({
                    kind: "restart-confirmed",
                    version: update.version,
                  })
                }
              >
                Install and Relaunch
              </button>
            )}
          </>
        )}
        {update &&
          !release &&
          update.phase !== "downloading" &&
          update.phase !== "applying" && (
            <button
              disabled={disabled("check")}
              onClick={() => api.intent({ kind: "check" })}
            >
              Check for Updates
            </button>
          )}
        {update &&
          (update.phase === "recovery" ||
            (update.phase === "failed" && update.recoveryRequired)) && (
            <button
              disabled={disabled("recovery")}
              onClick={() => {
                api.intent({ kind: "recovery" });
                api.close();
              }}
            >
              Review Recovery in Farol
            </button>
          )}
        <button onClick={() => api.close()}>Done</button>
      </div>
    </main>
  );
}

export function startUpdatesWindow(): void {
  const host = document.getElementById("root");
  if (!host) throw new Error("RENDERER_ROOT_MISSING");
  document.title = "Farol Updates";
  document.body.classList.add("native-updates-document");
  const api = (window as unknown as { farolUpdates: UpdatesAPI }).farolUpdates;
  const root = createRoot(host);
  root.render(<UpdatesWindow api={api} />);
  window.addEventListener("pagehide", () => root.unmount(), { once: true });
}

/** Select only updater facts; no settings, activity, tasks or transcript leaves the shell. */
export function projectUpdates(snapshot: WindowSnapshot): UpdatesProjection {
  const update = snapshot.update;
  const intents = [
    "update",
    "update-notice",
    "update-automatic-downloads",
    "update-install-on-quit",
  ].map((key) => snapshot.intents[key]);
  const unknown =
    intents.some((intent) => intent?.state === "unknown") ||
    (update.phase === "failed" && update.code.includes("UNKNOWN"));
  const pending = intents.some((intent) => intent?.state === "pending");
  const current =
    snapshot.status === "current" &&
    !unknown &&
    !pending &&
    update.phase !== "applying";
  const release = update.phase === "available" || update.phase === "ready";
  return {
    update,
    installedVersion: snapshot.installedVersion?.version ?? null,
    outcome: unknown
      ? "unknown"
      : pending
        ? "pending"
        : (snapshot.intents.update?.state ?? null),
    automaticEnabled: automaticUpdateEnabled(update),
    allowed: {
      check:
        current &&
        snapshot.environment === "preview" &&
        snapshot.runtime === "ready" &&
        updateCheckAllowed(update),
      download: current && update.phase === "available",
      skip: current && update.phase === "available",
      later: current && release && !update.deferred,
      "restart-confirmed": current && confirmedRestartAllowed(update),
      automatic: current && automaticUpdateAvailable(snapshot),
      // Recovery remains owned by the existing shell surface and its guards.
      recovery: update.phase !== "applying",
    },
  };
}
