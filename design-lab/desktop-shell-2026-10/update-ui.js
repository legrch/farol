/* Design-only update policy. No updater, network, quit or install adapter is invoked. */
const updateParams = new URLSearchParams(location.search);
const updatePrefsKey = "farol-design-v4.update-preferences";
function readUpdatePrefs() {
  try {
    return JSON.parse(localStorage.getItem(updatePrefsKey) || "{}");
  } catch {
    return {};
  }
}
const storedUpdatePrefs = readUpdatePrefs();
const demoUpdate = {
  phase: ["available", "ready", "failed"].includes(updateParams.get("update"))
    ? updateParams.get("update")
    : "none",
  version: /^\d+\.\d+\.\d+$/.test(updateParams.get("version") || "")
    ? updateParams.get("version")
    : "0.1.9",
  current: "0.1.8",
  automatic: updateParams.has("auto")
    ? updateParams.get("auto") === "on"
    : storedUpdatePrefs.automatic === true,
  notifications: storedUpdatePrefs.notifications !== false,
  deferred: false,
  skipped: false,
  notice: true,
  checked: false,
  downloadTimer: null,
  reviewed: false,
  failureAcknowledged: false,
  didInterrupt: false,
};
demoUpdate.skipped = storedUpdatePrefs.skippedVersion === demoUpdate.version;
demoUpdate.reviewed = storedUpdatePrefs.seenVersion === demoUpdate.version;
demoUpdate.failureAcknowledged =
  storedUpdatePrefs.seenFailure === demoUpdate.version;
function saveUpdatePrefs() {
  try {
    localStorage.setItem(
      updatePrefsKey,
      JSON.stringify({
        automatic: demoUpdate.automatic,
        notifications: demoUpdate.notifications,
        skippedVersion: demoUpdate.skipped ? demoUpdate.version : null,
        seenVersion: demoUpdate.reviewed ? demoUpdate.version : null,
        seenFailure: demoUpdate.failureAcknowledged ? demoUpdate.version : null,
      }),
    );
  } catch {}
}
function updateSwitch(name, action, on) {
  return `<button class="switch" role="switch" aria-label="${name}" aria-checked="${on}" data-action="${action}"></button>`;
}
function restartRisk() {
  const gate = updateParams.get("gate");
  if (gate === "integrity")
    return {
      hard: true,
      copy: "The update package could not be verified. This package cannot be installed.",
      root: "settings",
      page: "diagnostics",
    };
  if (gate === "draft")
    return {
      copy: "There is an unsent ChatGPT draft. Restarting may discard the draft and attachments.",
      root: "chat",
    };
  if (gate === "unknown" || state.fixture === "attention")
    return {
      copy: "A previous work result is unconfirmed. Restarting will not recover or complete that work.",
      root: "activity",
    };
  if (gate === "browser")
    return {
      copy: "Open ChatGPT sessions will close when Farol restarts.",
      root: "chat",
    };
  if (state.fixture === "offline")
    return {
      copy: "ChatGPT is disconnected. A restart does not prove that pending work completed.",
      root: "settings",
      page: "connection",
    };
  const running = chats().filter((c) => c.phase === "Working").length;
  return running
    ? {
        copy: `${running} task is still running. Restarting will interrupt it; unfinished work may need to be started again.`,
        root: "chat",
        running,
      }
    : null;
}
function updateStatusCopy() {
  const u = demoUpdate;
  if (u.skipped)
    return `Version ${u.version} was skipped. You will not be prompted for it again.`;
  if (u.phase === "none")
    return u.checked
      ? "You’re up to date in this sample."
      : "No update check yet.";
  if (u.phase === "downloading")
    return "Downloading in the background. Keep working.";
  if (u.phase === "applying") return "Restarting to install the update…";
  if (u.phase === "failed")
    return (
      "The last update failed. Farol is still running on " + u.current + "."
    );
  return u.phase === "ready"
    ? `Version ${u.version} is downloaded. ${u.automatic ? "It will install when you quit Farol." : "Restart when you choose."}`
    : `Version ${u.version} is available.`;
}
function updateRailButton() {
  const u = demoUpdate;
  if (u.phase === "none" || u.skipped) return "";
  const unseen = u.phase === "failed" ? !u.failureAcknowledged : !u.reviewed;
  const name =
    u.phase === "ready"
      ? "Update ready"
      : u.phase === "downloading"
        ? "Downloading update"
        : u.phase === "failed"
          ? u.failureAcknowledged
            ? "View update status"
            : "Update needs attention"
          : "Update available";
  return `<button class="rail-update" data-action="review-update" aria-label="${name}">${icon(u.phase === "failed" && !u.failureAcknowledged ? "warning" : "download")}<span class="tip">${name}</span>${unseen ? '<span class="update-dot" aria-hidden="true"></span>' : ""}</button>`;
}
function renderUpdateNotice() {
  let n = document.querySelector("#update-notice");
  if (!n) {
    n = document.createElement("section");
    n.id = "update-notice";
    n.setAttribute("aria-label", "Update notice");
    document.querySelector("#window").append(n);
  }
  const u = demoUpdate;
  n.hidden =
    !u.notice ||
    !u.notifications ||
    u.deferred ||
    u.skipped ||
    u.reviewed ||
    !["available", "ready", "failed"].includes(u.phase);
  if (n.hidden) return;
  const title =
    u.phase === "failed"
      ? "The update did not finish"
      : u.phase === "ready"
        ? `Farol ${u.version} is ready`
        : `Farol ${u.version} is available`;
  n.innerHTML = `<div class="notice-symbol">${icon(u.phase === "failed" ? "warning" : "download")}</div><div><strong>${title}</strong><p>${u.phase === "failed" ? "Farol is still available. Review the update when you choose." : u.phase === "ready" ? "Restart when you choose. Your work continues." : "A new version is available when you’re ready."}</p><button class="btn link" data-action="review-update">View update</button></div><button class="notice-close" data-action="dismiss-update-notice" aria-label="Dismiss update notice">${icon("close")}</button>`;
}
function acknowledgeUpdate() {
  demoUpdate.notice = false;
  demoUpdate.reviewed = true;
  if (demoUpdate.phase === "failed") demoUpdate.failureAcknowledged = true;
  saveUpdatePrefs();
  renderUpdateNotice();
}
function updatePreference() {
  if (demoUpdate.automatic)
    return '<p class="update-policy-strip"><strong>Automatic updates are on.</strong><br>This update is downloaded in the background and will install when you quit Farol. You can change this in Settings → Updates.</p>';
  return `<div class="update-preference"><div class="copy"><strong>Automatic updates</strong><p>Download future updates and install when you quit Farol.</p></div>${updateSwitch("Automatic updates", "toggle-auto-update", false)}</div>`;
}
function paintUpdateDialog(html, kind = "update", dismissible = true) {
  const d = document.querySelector("#dialog");
  acknowledgeUpdate();
  const content =
    (dismissible
      ? `<button class="dialog-close-corner" data-action="dialog-close" aria-label="Close update">${icon("close")}</button>`
      : "") + html;
  if (!d.open) openDialog(content);
  else {
    d.innerHTML = content;
    const h = d.querySelector("h2");
    h.id = "dialog-title";
    d.setAttribute("aria-labelledby", h.id);
  }
  d.dataset.kind = kind;
  d.dataset.dismissible = String(dismissible);
  d.classList.add("update-dialog");
  (
    d.querySelector('[data-action="cancel-install"]') ||
    d.querySelector('[data-action="update-later"]') ||
    d.querySelector("button")
  )?.focus();
}
function showUpdateDialog() {
  const u = demoUpdate;
  if (u.phase === "none") {
    paintUpdateDialog(
      `<h2>You’re up to date</h2><p>Farol ${u.current} is installed.</p><div class="dialog-actions">${btn("Done", "dialog-close", "primary")}</div>`,
    );
    render();
    return;
  }
  if (["downloading", "applying"].includes(u.phase)) {
    paintUpdateDialog(
      `<h2>${u.phase === "downloading" ? "Downloading Farol " + u.version : "Restarting to update"}</h2><p>${u.phase === "downloading" ? "Keep working. The update will be ready when the download finishes." : "This is a restart preview. No application is actually closed."}</p><div class="update-progress" role="progressbar" aria-label="Update progress" aria-valuetext="In progress"><i></i></div>${u.phase === "downloading" ? `<div class="dialog-actions">${btn("Continue working", "dialog-close")}</div>` : ""}<p class="dialog-demo">Design preview · No real download or restart</p>`,
      "update",
      u.phase !== "applying",
    );
    return;
  }
  if (u.phase === "failed") {
    paintUpdateDialog(
      `<h2>The update did not finish</h2><p>Farol is still running on ${u.current}. There is no need to stop your work.</p><div class="interrupt-warning"><strong>Update status</strong><p>This example download failed. Details remain in Settings → Updates after you dismiss this notice.</p></div><div class="dialog-actions">${btn("Dismiss", "update-later")}${btn("View details", "update-diagnostics", "primary")}</div><p class="dialog-demo">Example failure · No automatic retry</p>`,
    );
    render();
    return;
  }
  const ready = u.phase === "ready",
    risk = ready ? restartRisk() : null;
  const release = `<details class="update-release"><summary>What’s new in ${u.version}</summary><p>Clearer navigation, separated settings and quiet update notices. Example release notes.</p></details>`;
  const riskCopy = risk
    ? `<div class="interrupt-warning"><strong>${risk.hard ? "Cannot install this package" : "Your work is still open"}</strong><p>${risk.copy}</p>${risk.hard ? btn("View details", "update-diagnostics", "link") : ""}</div>`
    : "";
  paintUpdateDialog(
    `<div class="update-heading"><span>${icon("download")}</span><div><h2>${ready ? "Ready to update Farol" : "A new version of Farol is available"}</h2><p>Farol ${u.version} ${ready ? "is downloaded" : "is available"}. You have ${u.current}.</p></div></div>${release}${updatePreference()}${riskCopy}<div class="update-actions ${ready ? "two" : ""}">${ready ? "" : btn("Skip This Version", "update-skip")}${btn("Remind Me Later", "update-later")}${btn(ready ? "Restart & Update" : "Download Update", ready ? "review-install" : "download-update", "primary", risk?.hard ? "disabled" : "")}</div><p class="dialog-demo">Design preview · No app changes</p>`,
  );
  render();
}
function confirmInstall() {
  if (demoUpdate.phase !== "ready") {
    showUpdateDialog();
    return;
  }
  const risk = restartRisk();
  if (risk?.hard) {
    showUpdateDialog();
    return;
  }
  if (!risk) {
    finishDemoUpdate(false);
    return;
  }
  paintUpdateDialog(
    `<div class="update-heading"><span>${icon(risk ? "warning" : "updates")}</span><div><h2>${risk ? "Interrupt work and update?" : "Restart Farol to update?"}</h2><p>Farol will close and restart to install version ${demoUpdate.version}.</p></div></div>${risk ? `<div class="interrupt-warning"><strong>Your open sessions will close.</strong><p>${risk.copy}</p><p>Unfinished work will remain interrupted or unconfirmed. It will not be marked as completed.</p></div>` : '<p class="safe-restart">No active work is shown in this example.</p>'}<div class="dialog-actions">${btn("Cancel", "cancel-install")}${btn(risk ? "Interrupt & Update" : "Restart & Update", "apply-update", risk ? "destructive" : "primary")}</div><p class="dialog-demo">Confirmation preview · No sessions will close</p>`,
    "install-confirm",
  );
}
function finishDemoUpdate(interrupted) {
  const u = demoUpdate;
  u.didInterrupt = interrupted;
  u.current = u.version;
  u.phase = "none";
  u.checked = true;
  closeUpdate();
  render();
  toast(
    interrupted
      ? "Restart preview: open work would be interrupted. No real session was closed."
      : "Update preview completed. No real app was restarted.",
  );
}
function startDemoDownload(present = false) {
  const u = demoUpdate;
  if (u.phase === "downloading" || u.phase === "ready" || u.skipped) return;
  u.phase = "downloading";
  u.notice = false;
  render();
  if (present || document.querySelector("#dialog").open) showUpdateDialog();
  clearTimeout(u.downloadTimer);
  u.downloadTimer = setTimeout(() => {
    u.phase = "ready";
    u.notice = !u.reviewed;
    render();
    if (
      document.querySelector("#dialog").open &&
      document.querySelector("#dialog").dataset.kind === "update"
    )
      showUpdateDialog();
  }, 1000);
}
function closeUpdate() {
  document.querySelector("#dialog").close();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const a = b.dataset.action,
    u = demoUpdate;
  if (a === "toggle-auto-update" || a === "toggle-update-notices") {
    if (a === "toggle-auto-update") u.automatic = !u.automatic;
    else u.notifications = !u.notifications;
    saveUpdatePrefs();
    if (
      a === "toggle-auto-update" &&
      u.automatic &&
      u.phase === "available" &&
      !u.skipped
    )
      startDemoDownload();
    else {
      render();
      if (
        document.querySelector("#dialog").open &&
        document.querySelector("#dialog").dataset.kind === "update"
      )
        showUpdateDialog();
    }
    document.querySelector(`[data-action="${a}"]`)?.focus();
    return;
  }
  switch (a) {
    case "review-update":
      showUpdateDialog();
      break;
    case "check-update":
      if (u.phase !== "ready" && u.phase !== "downloading")
        u.phase = "available";
      u.checked = true;
      u.skipped = false;
      u.deferred = false;
      u.notice = false;
      saveUpdatePrefs();
      showUpdateDialog();
      if (u.automatic && u.phase === "available") startDemoDownload();
      break;
    case "download-update":
      startDemoDownload(true);
      break;
    case "review-install":
      confirmInstall();
      break;
    case "cancel-install":
      closeUpdate();
      break;
    case "apply-update": {
      if (
        document.querySelector("#dialog").dataset.kind !== "install-confirm" ||
        u.phase !== "ready"
      )
        break;
      if (restartRisk()?.hard) {
        showUpdateDialog();
        break;
      }
      finishDemoUpdate(!!restartRisk());
      break;
    }
    case "update-later":
      u.deferred = true;
      acknowledgeUpdate();
      closeUpdate();
      render();
      break;
    case "update-skip":
      u.skipped = true;
      acknowledgeUpdate();
      closeUpdate();
      render();
      break;
    case "dismiss-update-notice":
      acknowledgeUpdate();
      render();
      break;
    case "update-diagnostics":
      acknowledgeUpdate();
      closeUpdate();
      navigate({ root: "settings", page: "updates" });
      break;
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "update-fixture") {
    const u = demoUpdate;
    clearTimeout(u.downloadTimer);
    u.phase = e.target.value;
    u.notice = true;
    u.skipped = false;
    u.deferred = false;
    u.reviewed = false;
    u.failureAcknowledged = false;
    render();
    if (u.automatic && u.phase === "available") startDemoDownload();
  }
});
document.addEventListener("DOMContentLoaded", () => {
  const d = document.querySelector("#dialog");
  d.addEventListener("cancel", (e) => {
    if (d.dataset.dismissible === "false") e.preventDefault();
  });
  if (updateParams.get("dialog") === "update") showUpdateDialog();
  if (
    demoUpdate.automatic &&
    demoUpdate.phase === "available" &&
    !demoUpdate.skipped
  )
    startDemoDownload();
});
