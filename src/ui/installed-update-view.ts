import type { InstalledUpdateView } from "../modules/release/contract/installed-update";

export type InstalledUpdateViewCommand = "check" | "later" | "restart";

const blockedMessages: Readonly<Record<string, string>> = {
  UPDATE_CONNECTOR_ACTIVE:
    "Disconnect the active connector in Connections before restarting.",
  UPDATE_TASK_ROUTE_NEEDS_DRAIN:
    "Wait for the current task to finish before restarting.",
  UPDATE_BROWSER_OPEN:
    "Close open ChatGPT tabs before restarting so no browser work is interrupted.",
  UPDATE_WORK_PENDING: "Finish or cancel active work before restarting.",
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
    case "idle":
      return view.checkedAt === null
        ? "Check for a newer version of Farol when you’re ready."
        : "You’re up to date.";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return "Downloading the update in the background. You can keep working.";
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
      return view.recoveryRequired
        ? `${reason} Updating is paused until recovery is complete. Review Settings → Diagnostics.`
        : `${reason} You can check for updates again when you’re ready.`;
    }
  }
}

/** Rendering is passive. The caller owns commands and authoritative update state. */
export function createInstalledUpdateView(
  root: Document,
  onCommand: (kind: InstalledUpdateViewCommand) => void,
): { render(view: InstalledUpdateView): void } {
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
  function text(node: HTMLElement, value: string): void {
    if (node.textContent !== value) node.textContent = value;
  }
  const controls = [
    {
      node: required<HTMLButtonElement>("installed-update-check"),
      kind: "check",
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
        rail.hidden = true;
        for (const control of controls)
          if (control.kind === "later") control.node.disabled = true;
      } else {
        for (const control of controls) control.node.disabled = true;
      }
      onCommand(kind);
    });
  }

  return {
    render(view): void {
      const message = description(view);
      const ready = view.phase === "ready";
      const applying = view.phase === "applying";
      const recovery = view.phase === "failed" && view.recoveryRequired;
      const canCheck =
        view.phase === "idle" ||
        (ready && view.blockedBy !== null) ||
        (view.phase === "failed" && !view.recoveryRequired);
      text(summary, message);
      text(railCopy, message);
      text(
        railTitle,
        recovery
          ? "Update needs attention"
          : applying
            ? "Updating Farol"
            : "Update ready",
      );
      text(railMark, recovery ? "!" : "↑");
      rail.title = message;
      rail.hidden = !(ready && !view.deferred) && !applying && !recovery;
      rail.dataset.updateState = view.phase;
      for (const { node, kind } of controls) {
        if (kind === "check") {
          node.disabled = !canCheck;
          text(
            node,
            view.phase === "checking"
              ? "Checking…"
              : view.phase === "downloading"
                ? "Downloading…"
                : ready && view.blockedBy !== null
                  ? "Check again"
                  : "Check for Updates…",
          );
        } else {
          node.hidden = !ready && !applying;
          node.disabled =
            kind === "restart"
              ? !ready || view.blockedBy !== null
              : !ready || view.deferred;
          node.title = node.disabled
            ? message
            : kind === "restart"
              ? "Restart & Update"
              : "Remind me later";
        }
      }
    },
  };
}
