import type { InstalledUpdateView } from "../modules/release/contract/installed-update";
import { canRecheckUpdateAdmission } from "../modules/release/contract/installed-update";

export type InstalledUpdateViewCommand =
  "check" | "download" | "skip" | "later" | "restart" | "recover" | "rollback";

const blockedMessages: Readonly<Record<string, string>> = {
  UPDATE_CONNECTOR_ACTIVE:
    "Disconnect the active connector in Connections before restarting.",
  UPDATE_TASK_ROUTE_NEEDS_DRAIN:
    "Wait for the current task to finish before restarting.",
  UPDATE_BROWSER_OPEN:
    "Close open ChatGPT tabs before restarting so no browser work is interrupted.",
  UPDATE_BROWSER_BUSY:
    "Wait for the active ChatGPT response, check or voice session to finish before restarting.",
  UPDATE_BROWSER_DRAFT:
    "Send or clear the unsent ChatGPT draft and attachments before restarting.",
  UPDATE_BROWSER_STATE_UNKNOWN:
    "Farol could not confirm that ChatGPT is idle. Keep your current work and review this result in Diagnostics before considering another update action.",
  UPDATE_BROWSER_RELEASE_UNCONFIRMED:
    "Farol could not confirm that ChatGPT resumed. Quit Farol and reopen it before updating.",
  UPDATE_WORK_PENDING: "Finish or cancel active work before restarting.",
  UPDATE_WORK_DRAIN_UNCONFIRMED:
    "Farol could not confirm that local work has finished. Review its current result before restarting.",
  UPDATE_STATE_UNREADABLE: "Farol couldn’t read its update status.",
};

function updateName(version: string): string {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
    ? `Farol ${version}`
    : "The update";
}

function description(view: InstalledUpdateView): string {
  switch (view.phase) {
    case "unavailable":
      return "Update checks are available in the installed Farol owner beta. Install and open the owner beta to use updates.";
    case "recovery":
      return `An interrupted update was found. Quit to finish recovery of ${updateName(view.version)}. No update will be downloaded or applied again. If recovery restores the previous version, it stays closed until completion is verified.${view.blockedBy ? ` ${blockedMessages[view.blockedBy] ?? "Finish active work before quitting."}` : ""}`;
    case "idle":
      if (view.blockedBy)
        return (
          blockedMessages[view.blockedBy] ??
          "Farol can’t restart safely yet. Review active work before restoring the previous version."
        );
      if (view.rollbackVersion)
        return `The previous accepted version, ${updateName(view.rollbackVersion)}, is available to restore. Farol will quit and the restored version will stay closed until completion is verified. Your settings and folders are kept.`;
      return view.checkedAt === null
        ? "Check for a newer version of Farol when you’re ready."
        : "You’re up to date.";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return "Downloading the update in the background. You can keep working.";
    case "available":
      return `${updateName(view.version)} is available to download. It is not installed.${view.deferred ? " Saved for later; download it when you choose." : ""}`;
    case "ready": {
      const ready = `${updateName(view.version)} is ready to install.`;
      if (view.blockedBy !== null) {
        const reason =
          blockedMessages[view.blockedBy] ??
          "Farol can’t restart safely yet. Review active work and Diagnostics before updating.";
        return `${ready} ${reason}${view.blockedBy === "UPDATE_STATE_UNREADABLE" ? " Review Settings → Diagnostics before updating." : ""}`;
      }
      return view.deferred
        ? `${ready} Saved for later; restart when you’re ready.`
        : `${ready} Restart when you’re ready.`;
    }
    case "applying":
      return "Installing the update and restarting Farol…";
    case "failed": {
      const reason =
        blockedMessages[view.code] ?? "Farol couldn’t complete the update.";
      if (view.recoveryRequired)
        return `${reason} Updating is paused until recovery is complete. Review Settings → Diagnostics.`;
      return view.rollbackVersion
        ? `${reason} The previous accepted version, ${updateName(view.rollbackVersion)}, is still available to restore. Farol will quit and the restored version will stay closed until completion is verified. Your settings and folders are kept.`
        : `${reason} You can check for updates again when you’re ready.`;
    }
  }
}

/** Rendering is passive. The caller owns commands and authoritative update state. */
export function createInstalledUpdateView(
  root: Document,
  onCommand: (kind: InstalledUpdateViewCommand) => void,
): {
  render(view: InstalledUpdateView): void;
  setInstalledIdentity(version: string, buildVersion?: string): void;
} {
  function required<T extends HTMLElement>(id: string): T {
    const node = root.getElementById(id);
    if (!node) throw new Error(`INSTALLED_UPDATE_ELEMENT_MISSING:${id}`);
    return node as T;
  }
  const summary = required("installed-update-summary");
  const rail = required("installed-update-notice");
  const railTitle = required("installed-update-notice-title");
  const railCopy = required("installed-update-notice-copy");
  const railMark = required("installed-update-notice-mark");
  let installedIdentity: string | null = null;
  let lastView: InstalledUpdateView | null = null;
  function text(node: HTMLElement, value: string): void {
    if (node.textContent !== value) node.textContent = value;
  }
  const controls = [
    {
      node: required<HTMLButtonElement>("installed-update-recover"),
      kind: "recover",
      inRail: false,
    },
    {
      node: required<HTMLButtonElement>("installed-update-rollback"),
      kind: "rollback",
      inRail: false,
    },
    {
      node: required<HTMLButtonElement>("installed-update-check"),
      kind: "check",
      inRail: false,
    },
    {
      node: required<HTMLButtonElement>("installed-update-skip"),
      kind: "skip",
      inRail: false,
    },
    {
      node: required<HTMLButtonElement>("installed-update-restart"),
      kind: "restart",
      inRail: false,
    },
    {
      node: required<HTMLButtonElement>("installed-update-later"),
      kind: "later",
      inRail: false,
    },
    {
      node: required<HTMLButtonElement>("installed-update-notice-restart"),
      kind: "restart",
      inRail: true,
    },
    {
      node: required<HTMLButtonElement>("installed-update-notice-later"),
      kind: "later",
      inRail: true,
    },
  ] as const;

  for (const { node, kind, inRail } of controls) {
    node.disabled = true;
    node.addEventListener("click", () => {
      if (node.disabled || node.hidden || (inRail && rail.hidden)) return;
      if (kind === "later") {
        for (const control of controls)
          if (control.kind === "later") control.node.disabled = true;
      } else {
        for (const control of controls) control.node.disabled = true;
      }
      onCommand(
        kind === "check" && lastView?.phase === "available" ? "download" : kind,
      );
    });
  }

  const presenter = {
    setInstalledIdentity(version: string, buildVersion?: string): void {
      installedIdentity = `${updateName(version)}${buildVersion ? ` (build ${buildVersion})` : ""}`;
      if (lastView) presenter.render(lastView);
    },
    render(view: InstalledUpdateView): void {
      lastView = view;
      const message =
        installedIdentity && view.phase !== "unavailable"
          ? `Installed: ${installedIdentity}. ${description(view)}`
          : description(view);
      const ready = view.phase === "ready";
      const available = view.phase === "available";
      const applying = view.phase === "applying";
      const recovery =
        view.phase === "recovery" ||
        (view.phase === "failed" && view.recoveryRequired);
      const canCheck =
        view.phase === "idle" ||
        available ||
        (ready &&
          view.blockedBy !== null &&
          canRecheckUpdateAdmission(view.blockedBy)) ||
        (view.phase === "failed" && !view.recoveryRequired);
      text(summary, message);
      text(railCopy, message);
      text(
        railTitle,
        recovery
          ? "Update needs attention"
          : applying
            ? "Updating Farol"
            : available
              ? "Update available"
              : ready && view.deferred
                ? "Update saved for later"
                : "Update ready",
      );
      text(railMark, recovery ? "!" : "↑");
      rail.title = message;
      rail.hidden = !ready && !available && !applying && !recovery;
      rail.dataset.updateState = view.phase;
      for (const { node, kind } of controls) {
        if (kind === "recover" || kind === "rollback") {
          const available =
            kind === "recover"
              ? view.phase === "recovery"
              : (view.phase === "idle" ||
                  (view.phase === "failed" && !view.recoveryRequired)) &&
                !!view.rollbackVersion;
          node.hidden = !available;
          node.disabled = !available;
          node.title = message;
        } else if (kind === "check") {
          node.disabled = !canCheck;
          text(
            node,
            view.phase === "checking"
              ? "Checking…"
              : view.phase === "downloading"
                ? "Downloading…"
                : available
                  ? "Download Update"
                  : ready && view.blockedBy !== null
                    ? canRecheckUpdateAdmission(view.blockedBy)
                      ? "Check again"
                      : "Update blocked"
                    : "Check for Updates…",
          );
        } else if (kind === "skip") {
          node.hidden = !available;
          node.disabled = !available;
          node.title = available ? "Skip This Version" : message;
        } else {
          node.hidden =
            kind === "restart"
              ? !ready && !applying
              : !ready && !available && !applying;
          node.disabled =
            kind === "restart"
              ? !ready || view.blockedBy !== null
              : (!ready && !available) ||
                (ready || available ? view.deferred : false);
          node.title = node.disabled
            ? message
            : kind === "restart"
              ? "Restart & Update"
              : "Remind me later";
        }
      }
    },
  };
  return presenter;
}
