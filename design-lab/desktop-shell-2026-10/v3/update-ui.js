/* Synthetic update interactions; no updater or network adapter is invoked. */
const updateParams = new URLSearchParams(location.search);
const demoUpdate = {
  phase: ["available", "ready", "failed"].includes(updateParams.get("update"))
    ? updateParams.get("update")
    : "none",
  version: "0.1.9",
  current: "0.1.8",
  automatic: false,
  deferred: false,
  skipped: false,
  notice: true,
  checked: false,
  downloadTimer: null,
};
function restartBlock() {
  const gate = updateParams.get("gate");
  if (gate === "browser")
    return {
      code: "UPDATE_BROWSER_OPEN",
      copy: "Close the open ChatGPT windows before restarting.",
      root: "chat",
    };
  if (gate === "draft")
    return {
      code: "UPDATE_BROWSER_DRAFT",
      copy: "Send or clear the unsent ChatGPT draft and attachments before restarting.",
      root: "chat",
    };
  if (gate === "unknown" || state.fixture === "attention")
    return {
      code: "UPDATE_WORK_DRAIN_UNCONFIRMED",
      copy: "The last work result is not confirmed. Review Activity before restarting.",
      root: "activity",
    };
  if (state.fixture === "offline")
    return {
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
      copy: "Farol cannot confirm that ChatGPT is idle. Review the connection and browser state.",
      root: "settings",
      page: "connection",
    };
  if (chats().some((c) => c.phase === "Working"))
    return {
      code: "UPDATE_WORK_PENDING",
      copy: "A task is still running. Wait for it to finish before restarting.",
      root: "chat",
    };
  return null;
}
function updateStatusCopy() {
  const u = demoUpdate;
  if (u.skipped)
    return `Farol ${u.version} was skipped. This version will not prompt again.`;
  if (u.phase === "none")
    return u.checked
      ? "You’re up to date in this sample."
      : "No update check has been made in this example.";
  if (u.phase === "checking") return "Checking for updates…";
  if (u.phase === "downloading")
    return "Downloading in the background. You can keep working.";
  if (u.phase === "applying") return "Installing and restarting…";
  if (u.phase === "failed")
    return "The update needs attention. Your current version is still available.";
  return u.phase === "ready"
    ? `Farol ${u.version} is downloaded${u.deferred ? " and saved for later" : ""}.`
    : `Farol ${u.version} is available. You have ${u.current}.`;
}
function updateRailButton() {
  const u = demoUpdate;
  if (u.phase === "none" || u.skipped) return "";
  const text =
    u.phase === "ready"
      ? "Update ready"
      : u.phase === "failed"
        ? "Update needs attention"
        : u.phase === "downloading"
          ? "Downloading update"
          : "Update available";
  return `<button class="rail-update" data-action="review-update" aria-label="${text}">${icon(u.phase === "failed" ? "warning" : "download")}<span class="tip">${text}</span><span class="update-dot" aria-hidden="true"></span></button>`;
}
function renderUpdateNotice() {
  let node = document.querySelector("#update-notice");
  if (!node) {
    node = document.createElement("section");
    node.id = "update-notice";
    node.setAttribute("aria-label", "Update notice");
    document.querySelector("#window").append(node);
  }
  const u = demoUpdate;
  node.hidden =
    !u.notice ||
    u.deferred ||
    u.skipped ||
    !["available", "ready", "failed"].includes(u.phase);
  if (node.hidden) return;
  const title =
    u.phase === "ready"
      ? `Farol ${u.version} is ready to install`
      : u.phase === "failed"
        ? "An update needs attention"
        : `Farol ${u.version} is available`;
  node.innerHTML = `<div class="notice-symbol">${icon(u.phase === "failed" ? "warning" : "download")}</div><div><strong>${title}</strong><p>${u.phase === "ready" ? "Restart when your work is safe." : u.phase === "failed" ? "Review the recorded update status." : "Review the new version when you’re ready."}</p><button class="btn link" data-action="review-update">Review update</button></div><button class="notice-close" data-action="dismiss-update-notice" aria-label="Dismiss update notice">${icon("close")}</button>`;
}
function updateCheckbox() {
  return `<label class="update-choice"><input type="checkbox" data-auto-update ${demoUpdate.automatic ? "checked" : ""}>Automatically download and install updates in the future</label><p class="update-policy">Installation always waits for a confirmed safe restart.</p>`;
}
function paintUpdateDialog(html, kind = "update") {
  demoUpdate.notice = false;
  renderUpdateNotice();
  const d = document.querySelector("#dialog");
  if (!d.open) openDialog(html);
  else {
    const action = document.activeElement?.dataset.action;
    d.innerHTML = html;
    const heading = d.querySelector("h2");
    heading.id = "dialog-title";
    d.setAttribute("aria-labelledby", heading.id);
    (
      d.querySelector(action ? `[data-action="${action}"]` : ".primary") ||
      d.querySelector("button,input")
    )?.focus();
  }
  d.dataset.kind = kind;
  d.classList.add("update-dialog");
}
function showUpdateDialog() {
  const u = demoUpdate;
  if (u.phase === "none") {
    paintUpdateDialog(
      `<h2>You’re up to date</h2><p>Farol ${u.current} is installed.</p><div class="dialog-actions">${btn("Done", "dialog-close", "primary")}</div><p class="dialog-demo">Update preview · Sample versions</p>`,
    );
    return;
  }
  if (["checking", "downloading", "applying"].includes(u.phase)) {
    const name =
      u.phase === "checking"
        ? "Checking for updates"
        : u.phase === "downloading"
          ? "Downloading Farol " + u.version
          : "Updating Farol";
    paintUpdateDialog(
      `<h2>${name}</h2><p>${u.phase === "downloading" ? "You can keep working. Restart will be reviewed separately." : "This is a local demonstration of update progress."}</p><div class="update-progress" role="progressbar" aria-label="${name}" aria-valuetext="In progress"><i></i></div><div class="dialog-actions">${btn("Continue working", "dialog-close")}</div><p class="dialog-demo">Prototype · No actual download or restart</p>`,
    );
    return;
  }
  if (u.phase === "failed") {
    paintUpdateDialog(
      `<h2>The update needs attention</h2><p>The example update could not be completed. Your current version is still available. Review Diagnostics before choosing a recovery action.</p><div class="dialog-actions">${btn("Later", "update-later")}${btn("View Diagnostics", "update-diagnostics", "primary")}</div><p class="dialog-demo">Sample failure · No automatic retry</p>`,
    );
    return;
  }
  const ready = u.phase === "ready",
    blocked = ready ? restartBlock() : null;
  paintUpdateDialog(
    `<div class="update-heading"><span>${icon("download")}</span><div><h2>${ready ? "An update is ready to install" : "A new version of Farol is available"}</h2><p>Farol ${u.version} ${ready ? "is downloaded" : "is available"}. You have ${u.current}.</p></div></div><details class="update-release"><summary>What’s new in ${u.version}</summary><p>Clearer navigation, separated settings and improved update notices. Sample release notes for this design.</p></details>${updateCheckbox()}${blocked ? `<div class="restart-block"><strong>Restart is waiting</strong><p>${blocked.copy}</p><button class="btn link" data-action="update-view-work">Review ${blocked.root === "chat" ? "ChatGPT" : blocked.root === "activity" ? "Activity" : "Connection"}</button></div>` : ""}<div class="update-actions">${btn("Skip This Version", "update-skip")}${btn("Remind Me Later", "update-later")}${btn(ready ? "Restart & Update" : "Download Update", ready ? "review-install" : "download-update", "primary", blocked ? "disabled" : "")}</div><p class="dialog-demo">Update preview · No app or system changes</p>`,
  );
}
function confirmInstall() {
  const block = restartBlock();
  if (block) {
    showUpdateDialog();
    return;
  }
  paintUpdateDialog(
    `<div class="update-heading"><span>${icon("updates")}</span><div><h2>Update Farol now?</h2><p>Farol will close and restart to install version ${demoUpdate.version}.</p></div></div><p class="safe-restart">No active work or unconfirmed outcome in this example. The installed app must check current readiness again before restarting.</p><div class="dialog-actions">${btn("Cancel", "review-update")}${btn("Restart & Update", "apply-update", "primary")}</div><p class="dialog-demo">Confirmation preview · Farol will not restart</p>`,
    "install-confirm",
  );
}
function startDemoDownload() {
  demoUpdate.phase = "downloading";
  demoUpdate.notice = false;
  render();
  showUpdateDialog();
  clearTimeout(demoUpdate.downloadTimer);
  demoUpdate.downloadTimer = setTimeout(() => {
    demoUpdate.phase = "ready";
    demoUpdate.notice = true;
    render();
    if (
      document.querySelector("#dialog").open &&
      document.querySelector("#dialog").dataset.kind === "update"
    )
      showUpdateDialog();
  }, 900);
}
function closeUpdate() {
  document.querySelector("#dialog").close();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  switch (b.dataset.action) {
    case "check-update":
      demoUpdate.phase = "available";
      demoUpdate.checked = true;
      demoUpdate.skipped = false;
      demoUpdate.deferred = false;
      demoUpdate.notice = false;
      render();
      showUpdateDialog();
      break;
    case "review-update":
      showUpdateDialog();
      break;
    case "download-update":
      startDemoDownload();
      break;
    case "review-install":
      confirmInstall();
      break;
    case "apply-update":
      if (restartBlock()) {
        showUpdateDialog();
        break;
      }
      demoUpdate.current = demoUpdate.version;
      demoUpdate.phase = "none";
      demoUpdate.checked = true;
      closeUpdate();
      render();
      toast("Update completed in the prototype only. Farol was not restarted.");
      break;
    case "update-later":
      demoUpdate.deferred = true;
      demoUpdate.notice = false;
      closeUpdate();
      render();
      break;
    case "update-skip":
      demoUpdate.skipped = true;
      demoUpdate.notice = false;
      closeUpdate();
      render();
      break;
    case "dismiss-update-notice":
      demoUpdate.notice = false;
      renderUpdateNotice();
      break;
    case "update-diagnostics":
      closeUpdate();
      navigate({ root: "settings", page: "diagnostics" });
      break;
    case "update-view-work": {
      const block = restartBlock();
      closeUpdate();
      if (block) navigate({ root: block.root, page: block.page || state.page });
      break;
    }
  }
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-auto-update]")) {
    demoUpdate.automatic = e.target.checked;
    document
      .querySelectorAll("[data-auto-update]")
      .forEach((n) => (n.checked = demoUpdate.automatic));
  }
  if (e.target.id === "update-fixture") {
    clearTimeout(demoUpdate.downloadTimer);
    demoUpdate.phase = e.target.value;
    demoUpdate.notice = true;
    demoUpdate.skipped = false;
    demoUpdate.deferred = false;
    render();
  }
});
document.addEventListener("DOMContentLoaded", () => {
  if (updateParams.get("dialog") === "update") showUpdateDialog();
});
