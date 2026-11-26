import { useEffect, useRef } from "react";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { AutomaticUpdateChoice } from "../../../src/ui/renderer/automatic-update-choice";
import { acknowledgeUpdateNotice } from "../../../src/ui/renderer/update-notice";
import {
  confirmedRestartAllowed,
  isConfirmedBrowserBlock,
  updateVersionLabel,
} from "../../../src/ui/renderer/update-eligibility";
import {
  UpdateDownloadProgress,
  updateDownloadMessage,
} from "../../../src/ui/renderer/update-download";
import {
  updateBlockMessage,
  updateResultMessage,
} from "../../../src/ui/update-block-message";
import { retainedSetupIntents } from "./intents";
import { unresolvedActions } from "./unresolved-actions";
import { Overlay } from "./overlay";

const updateSheetTitles: Record<WindowSnapshot["update"]["phase"], string> = {
  available: "Update available",
  ready: "Ready to install",
  failed: "The update did not finish",
  recovery: "Update needs attention",
  checking: "Checking for updates",
  downloading: "Downloading update",
  applying: "Restarting to update",
  unavailable: "Updates unavailable",
  idle: "Update status",
};
export function Update({
  snapshot,
  facade,
  recoveryMode = false,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  recoveryMode?: boolean;
}) {
  const update = snapshot.update;
  const intent = snapshot.intents.update;
  const safeAction = useRef<HTMLButtonElement>(null);
  const progressStatus = useRef<HTMLParagraphElement>(null);
  const noticeKey = "notice" in update ? update.notice?.key : undefined;
  useEffect(() => {
    if (!recoveryMode && noticeKey) acknowledgeUpdateNotice(facade);
  }, [facade, noticeKey, recoveryMode]);
  const disabled =
    snapshot.status !== "current" ||
    intent?.state === "pending" ||
    intent?.state === "unknown";
  const recovery =
    update.phase === "recovery" ||
    (update.phase === "failed" && update.recoveryRequired);
  const rollbackVersion =
    recoveryMode &&
    (update.phase === "idle" ||
      (update.phase === "failed" && !update.recoveryRequired))
      ? update.rollbackVersion
      : undefined;
  const release =
    !recoveryMode && (update.phase === "available" || update.phase === "ready");
  const blockedBy =
    (recovery || (!recoveryMode && update.phase === "ready")) &&
    "blockedBy" in update
      ? update.blockedBy
      : undefined;
  const localDismiss = !release || disabled || update.deferred;
  const stateCopy =
    !recoveryMode && snapshot.status !== "current"
      ? "Update status could not be confirmed. Review Diagnostics."
      : recoveryMode && !recovery
        ? rollbackVersion
          ? `Previous version ${rollbackVersion} is retained for update safety.`
          : "No interrupted update needs recovery."
        : update.phase === "ready"
          ? `Version ${updateVersionLabel(update.version)} is ready to install.`
          : update.phase === "available"
            ? `Version ${updateVersionLabel(update.version)} is available to download.`
            : update.phase === "failed"
              ? update.code === "UPDATE_ROLLED_BACK" &&
                !update.recoveryRequired &&
                snapshot.installedVersion
                ? `The update didn't finish. Farol ${snapshot.installedVersion.version} is still installed and works.`
                : updateResultMessage(
                    "failed",
                    update.recoveryRequired,
                    update.code,
                  )
              : update.phase === "unavailable"
                ? updateResultMessage("unavailable")
                : update.phase === "recovery"
                  ? "The update didn’t finish. Check Diagnostics to confirm the installed application."
                  : update.phase === "applying"
                    ? `Applying version ${update.version}…`
                    : update.phase === "checking"
                      ? "Checking for updates…"
                      : update.phase === "downloading"
                        ? updateDownloadMessage(update)
                        : intent?.state === "unknown"
                          ? "Update status could not be confirmed."
                          : intent?.state === "pending"
                            ? "Checking update status…"
                            : update.checkedAt === null
                              ? "Update availability has not been checked."
                              : null;
  useEffect(() => {
    const active = document.activeElement;
    const target = safeAction.current;
    if (
      localDismiss &&
      target &&
      (active === document.body ||
        (active instanceof HTMLButtonElement &&
          active.disabled &&
          target.closest("dialog")?.contains(active)))
    )
      target.focus();
  }, [localDismiss, update.phase]);
  return (
    <Overlay
      title={
        recoveryMode
          ? "Update recovery"
          : update.phase === "downloading" &&
              update.progress?.stage === "verifying"
            ? "Checking update"
            : intent?.state === "unknown"
              ? "Update status unconfirmed"
              : intent?.state === "pending" && update.phase === "idle"
                ? "Checking for updates"
                : snapshot.status !== "current"
                  ? "Update status unconfirmed"
                  : update.phase === "idle" && update.checkedAt !== null
                    ? "You’re up to date"
                    : update.phase === "failed" &&
                        update.code === "UPDATE_NETWORK_FAILURE"
                      ? "Update network request failed"
                      : updateSheetTitles[update.phase]
      }
      onClose={() => facade.overlay("none")}
      dismissible={update.phase !== "applying"}
      className="update-sheet"
      initialFocus={update.phase === "applying" ? progressStatus : safeAction}
      headingIcon={
        recoveryMode ||
        update.phase === "failed" ||
        update.phase === "recovery" ||
        update.phase === "unavailable"
          ? "warning"
          : "download"
      }
      headingDescription={
        stateCopy !== null ? (
          <>
            <p
              className="update-state"
              role="status"
              ref={progressStatus}
              tabIndex={-1}
            >
              {stateCopy}
            </p>
            {!recoveryMode && update.phase === "downloading" && (
              <UpdateDownloadProgress update={update} />
            )}
          </>
        ) : undefined
      }
    >
      {!recoveryMode &&
        (update.phase === "available" || update.phase === "ready") &&
        update.notes && (
          <details className="update-release">
            <summary>
              What’s new in {updateVersionLabel(update.version)}
            </summary>
            <p className="update-notes">{update.notes}</p>
          </details>
        )}
      {recoveryMode &&
        (update.phase === "failed" || update.phase === "unavailable") &&
        (recovery || !isConfirmedBrowserBlock(update.code)) && (
          <details className="update-technical-code">
            <summary>Technical code</summary>
            <code>{update.code}</code>
          </details>
        )}
      {!recoveryMode && (
        <AutomaticUpdateChoice snapshot={snapshot} facade={facade} />
      )}
      {!recoveryMode && update.phase === "ready" && (
        <p className="description update-confirmation">
          Farol will close open ChatGPT sessions and interrupt work before
          restarting.
        </p>
      )}
      {recoveryMode && recovery ? (
        <p className="description">
          This is the recorded state of an unfinished installation. Viewing it
          does not resume the helper or repeat the update. Farol installs newer
          releases only.
        </p>
      ) : rollbackVersion ? (
        <p className="description">
          Farol installs newer releases only. The retained image belongs to the
          existing update transaction and cannot be selected for a downgrade.
        </p>
      ) : !recoveryMode && update.phase === "available" ? (
        <p className="description">
          Download the update, then confirm installation and restart.
        </p>
      ) : null}
      {blockedBy &&
        (recoveryMode || recovery || !isConfirmedBrowserBlock(blockedBy)) && (
          <div
            className={
              recoveryMode || recovery ? "update-block" : "update-issue"
            }
            role={confirmedRestartAllowed(update) ? "status" : "alert"}
          >
            <strong>
              {recovery
                ? "Recovery is blocked"
                : confirmedRestartAllowed(update)
                  ? "Restart postponed"
                  : "Update needs attention"}
            </strong>
            <p>
              {recoveryMode || recovery
                ? updateBlockMessage(blockedBy)
                : confirmedRestartAllowed(update)
                  ? "The last restart did not begin. You can try again or review the current work."
                  : "Review Diagnostics before restarting."}
            </p>
            {recoveryMode && (
              <details>
                <summary>Technical code</summary>
                <code>{blockedBy}</code>
              </details>
            )}
          </div>
        )}
      <div
        className={`update-actions${update.phase === "available" ? "" : " two"}`}
      >
        {localDismiss && update.phase !== "applying" && (
          <button ref={safeAction} onClick={() => facade.overlay("none")}>
            {recoveryMode
              ? rollbackVersion || recovery
                ? "Cancel"
                : "Done"
              : update.phase === "idle"
                ? "Done"
                : recovery || rollbackVersion
                  ? "Dismiss"
                  : update.phase === "failed" || update.phase === "unavailable"
                    ? "Dismiss"
                    : "Continue working"}
          </button>
        )}
        {!recoveryMode && update.phase === "available" && (
          <>
            <button
              disabled={disabled}
              onClick={() => {
                const latest = facade.getSnapshot();
                if (
                  latest.status === "current" &&
                  latest.intents.update?.state !== "pending" &&
                  latest.intents.update?.state !== "unknown" &&
                  latest.update.phase === "available"
                )
                  void facade.update("skip");
              }}
            >
              Skip This Version
            </button>
            <button
              ref={!localDismiss ? safeAction : undefined}
              disabled={disabled || update.deferred}
              onClick={() => {
                void facade.update("later").then((result) => {
                  if (result.state === "applied") facade.overlay("none");
                });
              }}
            >
              Remind Me Later
            </button>
            <button
              className="primary"
              disabled={disabled}
              onClick={() => {
                const latest = facade.getSnapshot();
                if (
                  latest.status === "current" &&
                  latest.intents.update?.state !== "pending" &&
                  latest.intents.update?.state !== "unknown" &&
                  latest.update.phase === "available"
                )
                  void facade.update("download");
              }}
            >
              Download Update
            </button>
          </>
        )}
        {!recoveryMode && update.phase === "ready" && (
          <>
            <button
              ref={!localDismiss ? safeAction : undefined}
              disabled={disabled}
              onClick={() => {
                void facade.update("later").then((result) => {
                  if (result.state === "applied") facade.overlay("none");
                });
              }}
            >
              Remind Me Later
            </button>
            <button
              className="primary"
              disabled={disabled || !confirmedRestartAllowed(update)}
              onClick={() =>
                void facade.update("restart-confirmed", update.version)
              }
            >
              Install and Relaunch
            </button>
          </>
        )}
        {!recoveryMode &&
          unresolvedActions(snapshot, retainedSetupIntents(facade, snapshot))
            .length > 0 &&
          (recovery ||
            (!!blockedBy && !isConfirmedBrowserBlock(blockedBy)) ||
            update.phase === "failed" ||
            update.phase === "unavailable") && (
            <button onClick={() => facade.overlay("unresolved-actions")}>
              Unresolved actions
            </button>
          )}
      </div>
      {recoveryMode &&
        (("notice" in update && update.notice?.blockedBy) ||
          snapshot.intents["update-notice"]?.state === "unknown") && (
          <p role="alert">
            Saved update notices could not be confirmed. Do not retry the notice
            acknowledgement. Update actions retain their separate safety checks.
          </p>
        )}
      {intent?.state === "unknown" && (
        <p role="alert">
          Outcome unknown. Inspect the retained operation; do not submit another
          apply.
        </p>
      )}
    </Overlay>
  );
}
