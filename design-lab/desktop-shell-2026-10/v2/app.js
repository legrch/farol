const paths = {
  appearance:
    "M10 2a8 8 0 1 0 0 16h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h6a2 2 0 0 0 2-2 8 8 0 0 0-8-4M6 6h.1M5 10h.1M9 5h.1M13 6h.1",
  home: "M3 10 10 4l7 6M5 9v8h4v-5h3v5h3V9",
  chat: "M4 4h12v10H8l-4 3V4M7 7h6M7 10h4",
  setup: "M3 6h14M3 14h14M7 3v6M13 11v6",
  activity: "M3 15h3l3-10 4 12 2-6h3",
  settings:
    "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4",
  general: "M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4",
  folders: "M2 6V4h6l2 2h8v10H2V6",
  mac: "M3 3h14v10H3V3M7 17h6M10 13v4",
  connection: "M7 7 5 9a3 3 0 0 0 4 4l2-2M13 13l2-2a3 3 0 0 0-4-4L9 9M7 13l6-6",
  model: "M10 2 17 6v8l-7 4-7-4V6l7-4M3 6l7 4 7-4M10 10v8",
  updates: "M16 6a7 7 0 1 0 1 7M16 2v5h-5",
  diagnostics: "M6 2h8M8 2v6l-5 7v3h14v-3l-5-7V2M6 12h8",
  shortcuts: "M2 5h16v11H2V5M5 8h1M9 8h1M13 8h1M5 12h10",
  chevron: "m7 4 6 6-6 6",
  menu: "M3 4h14M3 10h14M3 16h14",
  check: "m4 10 4 4 8-8",
  search: "M8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 12l5 5",
  close: "m5 5 10 10M15 5 5 15",
  shield: "M10 2 17 5v5c0 4-7 8-7 8s-7-4-7-8V5l7-3",
  clock: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16M10 5v5l3 2",
  warning: "m10 2 8 15H2l8-15M10 7v5M10 14v1",
};
const gearPoints = Array.from({ length: 32 }, (_, i) => {
  const a = (i * Math.PI) / 16 - Math.PI / 16;
  const r = i % 4 < 2 ? 8.3 : 6.8;
  return `${10 + r * Math.cos(a)},${10 + r * Math.sin(a)}`;
});
paths.settings =
  "M" +
  gearPoints.join("L") +
  "Z M12.6 10a2.6 2.6 0 1 0-5.2 0 2.6 2.6 0 0 0 5.2 0";
const icon = (n) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${paths[n] || paths.general}"/></svg>`;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const params = new URLSearchParams(location.search);
const state = {
  theme:
    params.get("theme") ||
    (params.get("direction") === "mac" ? "light" : "dark"),
  accent: params.get("accent") || "iris",
  mark: params.get("mark") || "lamp",
  menuHidden: false,
  direction: params.get("direction") || "graphite",
  root: params.get("page") || "home",
  page: params.get("sub") || "general",
  fixture: params.get("state") || "working",
  font: params.get("font") || "geist",
  chat: 1,
  event: 0,
  folder: 0,
  contextOpen: false,
  filter: "all",
  saved: false,
  updateChecked: false,
};
const sectionNames = {
  home: "Home",
  chat: "ChatGPT",
  setup: "Setup",
  activity: "Activity",
  settings: "Settings",
};
const settingPages = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["folders", "Folders"],
  ["mac", "This Mac"],
  ["connection", "Connection"],
  ["model", "Model"],
  ["shortcuts", "Keyboard shortcuts"],
  ["updates", "Updates"],
  ["diagnostics", "Diagnostics"],
];
const steps = [
  ["overview", "Overview"],
  ["signin", "Sign in"],
  ["folders", "Folders"],
  ["connection", "Connection"],
  ["add", "Add to ChatGPT"],
];
const folders = [
  {
    name: "Project Atlas",
    path: "/demo/projects/atlas",
    mode: "Guarded edits",
    verified: true,
  },
  { name: "Notes", path: "/demo/notes", mode: "Read-only", verified: true },
  {
    name: "Design files",
    path: "/demo/design",
    mode: "Read-only",
    verified: false,
  },
];

function eventsFor() {
  const c = chats()[1];
  return [
    {
      id: "atlas",
      title: "Atlas workspace check",
      time: "10:42",
      phase: "Completed",
      badge: "",
      taskKey: "sample-atlas",
      slot: 1,
      kind: "turn.terminal",
      code: "COMPLETED",
      operation: "workspace.list",
      seq: null,
      operationFromRequest: true,
    },
    {
      id: "design",
      title: "Design review",
      time: "10:39",
      phase: c?.taskKey ? c.phase : "Completed",
      badge: c?.taskKey ? c.class : "",
      taskKey: "sample-design",
      slot: 2,
      kind: ["Working", "Disconnected"].includes(c?.phase)
        ? "computer.requested"
        : "turn.terminal",
      code: ["Working", "Disconnected"].includes(c?.phase)
        ? null
        : c?.phase === "Outcome unknown"
          ? "OUTCOME_UNKNOWN"
          : "COMPLETED",
      operation: "workspace.search",
      seq: null,
      operationFromRequest: true,
    },
    {
      id: "connection",
      title: "Connection check",
      time: "10:32",
      phase:
        state.fixture === "attention"
          ? "Outcome unknown"
          : state.fixture === "offline"
            ? "Unavailable"
            : "Completed",
      badge:
        state.fixture === "attention"
          ? "unknown"
          : state.fixture === "offline"
            ? "offline"
            : "",
      taskKey: null,
      slot: null,
      kind: "setup.check",
      code:
        state.fixture === "attention"
          ? "OUTCOME_UNKNOWN"
          : state.fixture === "offline"
            ? "UNAVAILABLE"
            : "COMPLETED",
      operation: "connector.verify-app",
      seq: null,
    },
    {
      id: "prior",
      title: "Folder inventory",
      time: "10:18",
      phase: "Completed",
      badge: "",
      taskKey: "sample-prior",
      slot: 1,
      kind: "turn.terminal",
      code: "COMPLETED",
      operation: "workspace.list",
      seq: null,
      operationFromRequest: true,
    },
  ];
}

const label = (text, cls = "") => `<span class="badge ${cls}">${text}</span>`;
const btn = (text, action, cls = "", extra = "") =>
  `<button class="btn ${cls}" data-action="${action}" ${extra}>${text}</button>`;
const nav = (root, page) =>
  `data-root="${root}"${page ? ` data-page="${page}"` : ""}`;
const link = (text, root, page) =>
  `<button class="btn link" ${nav(root, page)}>${text}</button>`;
const head = (title, copy) =>
  `<header class="page-head"><h1>${title}</h1><p>${copy}</p></header>`;
const row = (title, copy, control) =>
  `<div class="row"><div class="row-copy"><h3>${title}</h3><p>${copy}</p></div>${control}</div>`;
const drafts = {};
const select = (name, options, chosen) =>
  `<select aria-label="${name}" data-draft="${name}">${options.map((o) => `<option ${o === ((name === "Folder access" ? folders[state.folder].mode : drafts[name]) ?? chosen) ? "selected" : ""}>${o}</option>`).join("")}</select>`;
const toggle = (name, on) =>
  `<button class="switch" role="switch" aria-label="${name}" aria-checked="${on}" data-action="toggle"></button>`;

const accentNames = { iris: "Iris", cobalt: "Cobalt", amber: "Amber" };
const markNames = {
  lamp: "Original lamp",
  lens: "Signal lens",
  beacon: "Beacon",
};
const themeNames = { light: "Light", dark: "Dark", system: "System" };
const palette = {
  light: {
    iris: ["#6750b8", "#ece7f8"],
    cobalt: ["#315db5", "#e6edf9"],
    amber: ["#8b5b1d", "#f4eadb"],
  },
  dark: {
    iris: ["#b3a3fa", "#353047"],
    cobalt: ["#9ebaf2", "#28384e"],
    amber: ["#e4bb7f", "#433729"],
  },
};
function actualTheme() {
  return state.theme === "system"
    ? matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : state.theme;
}
function markSvg(mark, mono = false) {
  const accent = palette[actualTheme()][state.accent][0];
  const navy = mono ? "none" : "#1c2639",
    signal = mono ? "currentColor" : accent,
    core = mono ? "currentColor" : "#f2be70";
  const tile = mono
    ? ""
    : '<rect x="4" y="4" width="56" height="56" rx="14" fill="' + navy + '"/>';
  if (mark === "beacon")
    return `<svg viewBox="0 0 64 64" aria-hidden="true" class="brand-vector">${tile}<path d="M28 30h8l5 19H23l5-19Z" fill="${signal}" stroke="none"/><rect x="26" y="23" width="12" height="7" rx="2" fill="${core}" stroke="none"/><path d="m22 24-8-4m8 8-8 4m28-8 8-4m-8 8 8 4" stroke="${signal}" stroke-width="4" stroke-linecap="round"/></svg>`;
  return `<svg viewBox="0 0 64 64" aria-hidden="true" class="brand-vector">${tile}<path d="M23 19a16 16 0 0 0 0 26M41 19a16 16 0 0 1 0 26" stroke="${signal}" stroke-width="5" stroke-linecap="round" fill="none"/><circle cx="32" cy="32" r="8" fill="${core}" stroke="none"/></svg>`;
}
function brand(mark = state.mark) {
  return mark === "lamp"
    ? '<img src="assets/farol-mark.png" alt="Farol">'
    : markSvg(mark);
}
function appearance() {
  return (
    head(
      "Appearance",
      "One interface, in the light that feels right for you.",
    ) +
    `
 <section class="form-group appearance-group"><div class="row row-wide"><div class="row-copy"><h3>Theme</h3><p>System follows the appearance of your Mac.</p></div><div class="choice-row">${["light", "dark", "system"].map((t) => `<button class="theme-choice" data-theme="${t}" aria-pressed="${state.theme === t}"><span class="theme-mini ${t}"><i></i><b></b></span>${themeNames[t]}</button>`).join("")}</div></div>
 <div class="row"><div class="row-copy"><h3>Accent color</h3><p>Highlights selection, focus and primary actions. Status stays distinct.</p></div><div class="swatches">${Object.entries(
   accentNames,
 )
   .map(
     ([a, n]) =>
       `<button class="swatch-choice" data-accent="${a}" aria-label="${n} accent" aria-pressed="${state.accent === a}"><span style="background:${palette[actualTheme()][a][0]}"></span>${n}</button>`,
   )
   .join("")}</div></div>
 ${row("Typeface", "Geist gives Farol a consistent voice. System follows your platform.", select("Typeface", ["Geist", "System"], state.font === "geist" ? "Geist" : "System"))}
 </section><p class="note">Appearance changes are immediate in this preview. The production app must apply its saved theme before drawing the first frame.</p>`
  );
}
function selectedChat() {
  return chats().find((c) => c.number === state.chat);
}
function matchingChat(e) {
  return e.taskKey ? chats().find((c) => c.taskKey === e.taskKey) : null;
}
function eventSelection(index) {
  return `data-root="activity" data-event="${index}"`;
}
function recentActivity() {
  return `<section class="recent-activity"><div class="section-title"><h2>Recent activity</h2>${link("View all", "activity")}</div>${eventsFor()
    .filter((e) => e.phase !== "Working")
    .slice(0, 3)
    .map(
      (e) =>
        `<button class="recent-row" ${eventSelection(eventsFor().findIndex((x) => x.id === e.id))}><time>${e.time}</time><span><strong>${e.title}</strong><small>${e.phase}${e.operation ? " · " + e.operation : ""}</small></span>${icon("chevron")}</button>`,
    )
    .join(
      "",
    )}<p class="micro-note">Sample of recorded event metadata. This is not a conversation archive.</p></section>`;
}

function chats() {
  if (state.fixture === "empty")
    return Array.from({ length: 5 }, (_, i) => ({
      number: i + 1,
      title: "Available",
      phase: "Available",
      class: "idle",
      taskKey: null,
    }));
  const reused = state.fixture === "reused";
  return [
    {
      number: 1,
      title: reused ? "Release notes review" : "Atlas workspace check",
      phase: reused ? "Working" : "Done",
      class: reused ? "working" : "",
      taskKey: reused ? "sample-release" : "sample-atlas",
    },
    {
      number: 2,
      title: "Design review",
      phase:
        state.fixture === "ready"
          ? "Done"
          : state.fixture === "attention"
            ? "Outcome unknown"
            : state.fixture === "offline"
              ? "Disconnected"
              : "Working",
      class:
        state.fixture === "ready"
          ? ""
          : state.fixture === "attention"
            ? "unknown"
            : state.fixture === "offline"
              ? "offline"
              : "working",
      taskKey: "sample-design",
    },
    {
      number: 3,
      title: "Folder summary",
      phase: "Done",
      class: "",
      taskKey: "sample-folders",
    },
    {
      number: 4,
      title: "Available",
      phase: "Available",
      class: "idle",
      taskKey: null,
    },
    {
      number: 5,
      title: "Available",
      phase: "Available",
      class: "idle",
      taskKey: null,
    },
  ];
}

function toast(message) {
  const t = document.querySelector("#toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => (t.hidden = true), 3800);
}

function home() {
  const attention = ["attention", "offline"].includes(state.fixture),
    empty = state.fixture === "empty";
  const current = chats().filter((c) => c.taskKey);
  const title = empty
    ? "Your ChatGPT work, connected to this Mac"
    : state.fixture === "offline"
      ? "Your connection needs attention"
      : state.fixture === "attention"
        ? "A task needs a closer look"
        : state.fixture === "ready"
          ? "Everything is quiet"
          : "Work is moving in the background";
  const copy = empty
    ? "Connect your account, then choose what ChatGPT can access."
    : state.fixture === "ready"
      ? "Your Mac is connected. No tasks need your attention."
      : state.fixture === "offline"
        ? "The local service is available, but ChatGPT is disconnected."
        : state.fixture === "attention"
          ? "An outcome is not confirmed. Inspect the available evidence before deciding what to do next."
          : "Watch current work and manage access without interrupting it.";
  return `<div class="status-hero"><div class="status-emblem">${icon(attention ? "warning" : empty ? "home" : state.fixture === "ready" ? "check" : "clock")}</div><div><h1>${title}</h1><p>${copy}</p></div>${empty ? `<button class="btn primary" ${nav("setup", "overview")}>Set up Farol</button>` : ""}</div>
 <div class="home-layout"><section class="home-tasks"><div class="section-title"><h2>Current work</h2>${link("View ChatGPT", "chat")}</div>
 ${empty ? `<div class="empty">${icon("chat")}<h2>No work yet</h2><p>Tasks started from your connected tools appear here. Browser windows are created only when needed.</p></div>` : current.map((c) => `<button class="task-row" ${nav("chat")} data-chat="${c.number}"><span class="task-number">${c.number}</span><span class="task-copy"><strong>${c.title}</strong><p>Window ${c.number}${c.phase === "Done" ? " · Still available to inspect" : ""}</p></span>${label(c.phase, c.class)}<span class="arrow">${icon("chevron")}</span></button>`).join("")}
 ${attention ? `<div class="attention-banner">${icon("warning")}<div><h3>${state.fixture === "offline" ? "ChatGPT is disconnected" : "Connection check has no confirmed result"}</h3><p>${state.fixture === "offline" ? "Inspect the connection state and supported recovery steps." : "Unknown is different from failed. No automatic repeat is proposed."}</p><button class="btn" ${state.fixture === "offline" ? nav("settings", "connection") : eventSelection(2)}>${state.fixture === "offline" ? "Open Connection" : "Inspect event"}</button></div></div>` : !empty ? '<div class="quiet">No action needed. Switching sections keeps ongoing work available.</div>' : ""}
 ${empty ? "" : recentActivity()}</section>
 <aside class="health" aria-label="Connection and access"><div class="section-title"><h2>Connection & access</h2></div>
 <div class="health-item"><h3>ChatGPT</h3>${label(empty ? "Not connected" : state.fixture === "offline" ? "Disconnected" : "Connected", empty ? "attention" : state.fixture === "offline" ? "offline" : "")}<p>${empty ? "Use your own ChatGPT account." : state.fixture === "offline" ? "Current connection unavailable." : "Account and connection confirmed in this sample."}</p>${link("Manage connection", "settings", "connection")}</div>
 <div class="health-item"><h3>This Mac</h3>${label(empty ? "Not checked" : "Available", empty ? "attention" : "")}<p>Manage what ChatGPT can do on this computer.</p>${link("Review access", "settings", "mac")}</div>
 <div class="health-item"><h3>Shared folders</h3>${label(empty ? "None shared" : "3 folders approved", empty ? "attention" : "")}<p>Approval and verification stay separate for each folder.</p>${link("Manage folders", "settings", "folders")}</div>
 </aside></div>`;
}

function general() {
  return (
    head("General", "Choose how Farol opens and how much activity you see.") +
    `<section class="form-group">${row("Open at launch", "Choose your starting point when no work is active.", select("Open at launch", ["Home", "Last used section", "ChatGPT"], "Home"))}${row("Section menu", "Keep section navigation open on larger windows.", select("Section menu", ["Always visible", "Remember last state"], "Always visible"))}${row("Activity detail", "Show meaningful steps or the available technical fields.", select("Activity detail", ["Meaningful steps", "Technical details"], "Meaningful steps"))}</section><div class="form-foot"><span>These preferences apply to Farol.</span>${btn("Save changes", "save", "primary")}</div>`
  );
}

function folderPage() {
  const f = folders[state.folder];
  return (
    head(
      "Folders",
      "Choose which folders ChatGPT can access, and what it can do in each one.",
    ) +
    `<div class="folder-layout"><aside class="folder-picker" aria-label="Approved folders">${folders.map((f, i) => `<button class="folder-button" data-action="folder" data-index="${i}" aria-current="${state.folder === i ? "page" : "false"}">${icon("folders")}<div><h3>${f.name}</h3><p>${f.mode}</p></div></button>`).join("")}</aside><section class="folder-detail"><div class="folder-title">${icon("folders")}<h2>${f.name}</h2></div><code>${f.path}</code>${label(f.verified ? "Folder check passed" : "Folder check needed", f.verified ? "" : "attention")}<div class="form-group">${row("Access", "Read files, or allow edits that require a review.", select("Folder access", ["Read-only", "Guarded edits"], f.mode))}${row("Git history & user settings", "A separate permission, beyond ordinary folder access.", btn("Review access", "git-access"))}</div><div class="section-title"><h3>Excluded paths</h3></div><p class="note" style="padding-top:0">These paths stay outside the folder access you approve.</p><input class="input" aria-label="Excluded paths" value="private, build/secrets.txt" style="width:100%"><details><summary>What does Git access include?</summary><p>Git metadata, previous versions of files, hooks and your Git user settings can contain information outside the current folder. Review this scope separately before allowing access. Folder verification must be repeated after changing this permission.</p></details><div class="form-foot">${btn("Remove folder", "remove-folder")}${btn("Save changes", "save", "primary")}</div></section></div><p class="note">${btn("Add folder…", "add-folder")} New folders start with read-only access.</p>`
  );
}
function macPage() {
  return (
    head(
      "This Mac",
      "See what this computer can do for ChatGPT. Each capability has its own access rules.",
    ) +
    `<section class="form-group">${row("Computer name", "Used to identify this Mac in your connections.", '<input aria-label="Computer name" value="This Mac">')}${row("Computer commands", "Choose the permitted command environment.", select("Computer commands", ["Disabled", "Workspace shell"], "Workspace shell"))}</section><div class="section-title"><h2>Access & readiness</h2></div><div class="connection-line"><span class="step-icon">${icon("mac")}</span><div><h3>Local service</h3><p>Available on this Mac. This alone does not verify ChatGPT access.</p></div>${label("Available")}</div><div class="connection-line"><span class="step-icon">${icon("folders")}</span><div><h3>Folder access</h3><p>Three approved folders. Permissions are managed per folder.</p></div>${link("Review folders", "settings", "folders")}</div><div class="connection-line"><span class="step-icon">${icon("shield")}</span><div><h3>Workspace shell</h3><p>Runs inside an approved folder. Network access is not included.</p></div>${label("Configured")}</div><p class="note">A saved configuration is different from a verified operation. Folder and connection checks remain separate.</p><div class="form-foot"><span>Sample configuration, not live device evidence.</span>${btn("Save changes", "save", "primary")}</div>`
  );
}
function connectionPage() {
  const off = state.fixture === "offline" || state.fixture === "empty";
  return (
    head(
      "Connection",
      "Your ChatGPT account, the local connection and verification in one place.",
    ) +
    `<div class="connection-line"><span class="step-icon">${icon("chat")}</span><div><h3>ChatGPT sign-in</h3><p>${state.fixture === "empty" ? "Your account is not connected." : "Signed in to your own ChatGPT account."}</p></div>${label(state.fixture === "empty" ? "Not signed in" : "Signed in", state.fixture === "empty" ? "attention" : "")}</div><div class="connection-line"><span class="step-icon">${icon("connection")}</span><div><h3>Local connection</h3><p>${off ? "ChatGPT access is not currently confirmed." : "Local service and ChatGPT are connected in this sample."}</p></div>${label(off ? "Not confirmed" : "Connected", off ? "attention" : "")}</div><div class="connection-line"><span class="step-icon">${icon("check")}</span><div><h3>Check from ChatGPT</h3><p>${state.fixture === "attention" ? "Last attempt ended with an unknown outcome." : off ? "No current verification available." : "Sample verification completed at 10:32."}</p></div>${label(state.fixture === "attention" ? "Outcome unknown" : off ? "Not verified" : "Verified", state.fixture === "attention" ? "unknown" : off ? "attention" : "")}</div><p class="note">These checks are independent. A connected local service does not prove that ChatGPT can access an approved folder.</p><div class="form-foot">${link("Open setup guide", "setup", "add")}${btn("Review connection check", "connection-check", "primary")}</div>`
  );
}
function modelPage() {
  return (
    head("Model", "The model connection used by your tools through Farol.") +
    `<section class="form-group">${row("Provider", "The permanent route exposed to connected tools.", "<code>farol</code>")}${row("Model", "The stable model name for the ChatGPT route.", "<code>chatgpt</code>")}${row("Model selection", "The actual ChatGPT model depends on the supported request and account.", '<span class="small muted">Managed by ChatGPT</span>')}</section><p class="note">This page describes the model route. It does not claim a particular underlying model, subscription entitlement or model response.</p>${link("Manage ChatGPT connection", "settings", "connection")}`
  );
}
function updatesPage() {
  return (
    head(
      "Updates",
      "Keep Farol current, and see the previous version available to restore.",
    ) +
    `<div class="version-mark"><img src="assets/farol-mark.png" alt=""><div><strong>Farol 0.1.8</strong><p>Owner beta · Sample version information</p></div></div><div class="form-group">${row("Update status", state.updateChecked ? "Sample state: no newer version is available. No live check was made." : "Check the installed update channel for a newer version.", btn(state.updateChecked ? "Check again" : "Check for updates", "check-update", "primary"))}${row("Previous version", "Farol 0.1.7 · Available to restore in this example.", btn("Review restore…", "restore"))}</div><div class="release-note"><h3>Updates wait for active work</h3><p>Restarting must respect running work and uncertain outcomes. The final product must use its actual update readiness state.</p></div><details class="note"><summary>Version details</summary><p>Channel: Owner beta<br>Current: 0.1.8 (sample)<br>Previous: 0.1.7 (sample)</p></details>`
  );
}
function diagnostics() {
  return (
    head(
      "Diagnostics",
      "Inspect available evidence when something needs investigation.",
    ) +
    `<section class="form-group">${row("Local service", "The service on this Mac is available in the sample.", label("Available"))}${row("ChatGPT connection", "See independent sign-in and connection checks.", link("Open Connection", "settings", "connection"))}${row("Recent activity", "Inspect task stages, operation names and result codes.", link("Open Activity", "activity"))}</section><details class="note"><summary>What is included in Activity?</summary><p>The current product projects time, task/turn linkage, event kind, phase, operation and terminal code. Prompt and answer text, file contents and full tool payloads are excluded. A detailed event view can explain only what was actually recorded.</p></details>${btn("View sample report", "report")}`
  );
}
function shortcuts() {
  return (
    head(
      "Keyboard shortcuts",
      "A proposed keyboard map for the new navigation.",
    ) +
    `<section class="form-group">${["Home", "ChatGPT", "Activity", "Setup"].map((s, i) => row(s, "Switch section without restarting work.", `<code>⌘ ${i + 1}</code>`)).join("")}${row("Settings", "Open the Settings section.", "<code>⌘ ,</code>")}${row("Find a page", "Search section names and settings.", "<code>⌘ K</code>")}${row("Section menu", "Open or close the contextual navigation.", "<code>⌃ ⌘ S</code>")}</section><p class="note">Shortcuts here are a design proposal. Search and section navigation work in this prototype; the installed application keeps its existing keyboard map.</p>`
  );
}
function settings() {
  return (
    {
      general,
      appearance,
      folders: folderPage,
      mac: macPage,
      connection: connectionPage,
      model: modelPage,
      updates: updatesPage,
      diagnostics,
      shortcuts,
    }[state.page] || general
  )();
}

function activity() {
  if (
    state.filter === "attention" &&
    !eventsFor().some((e) => e.phase === "Outcome unknown")
  )
    return (
      head("Activity", "Recorded work, with details you can inspect.") +
      `<div class="empty">${icon("activity")}<h2>No events need attention</h2><p>Choose All activity to inspect recorded work.</p></div>`
    );
  if (state.fixture === "empty")
    return (
      head("Activity", "Recorded work, with details you can inspect.") +
      `<div class="empty">${icon("activity")}<h2>No activity yet</h2><p>Task stages and connection checks appear here as work happens. Only recorded metadata is shown.</p></div>`
    );
  const e = eventsFor()[state.event] || eventsFor()[0],
    c = matchingChat(e);
  return (
    head(
      e.title,
      "Recorded stages and outcomes, without storing the conversation itself.",
    ) +
    `
 <div class="activity-header">${icon("activity")}<div>${label(e.phase, e.badge)}<p>${e.slot ? "Window " + e.slot + " · " : ""}Today at ${e.time}</p></div>${c ? `<button class="btn" ${nav("chat")} data-chat="${c.number}">View chat</button>` : ""}</div>
 ${e.taskKey && !c ? `<div class="history-limit"><h3>Chat no longer available here</h3><p>Window ${e.slot} no longer contains this task. Its recorded event can still be inspected. Opening another task in the same numbered window would show a different conversation.</p></div>` : ""}
 <div class="section-title"><h2>What was recorded</h2></div>
 <div class="activity-event"><time>${e.time}</time><strong>${e.phase === "Outcome unknown" ? "Outcome not confirmed" : e.phase === "Working" ? "Computer operation requested" : e.phase === "Unavailable" ? "Connection unavailable" : e.phase === "Disconnected" ? "Connection lost during work" : "Completed event"}</strong><p>${e.phase === "Outcome unknown" ? "There is no confirmed successful or failed result." : e.code === "COMPLETED" ? "A completed result was recorded." : "The available event does not confirm task completion."}</p></div>
 <dl class="facts"><div><dt>Event kind</dt><dd><code>${e.kind}</code></dd></div><div><dt>Phase / terminal code</dt><dd><code>${e.code || "Not recorded"}</code></dd></div><div><dt>Operation${e.operationFromRequest ? " (linked request event)" : ""}</dt><dd><code>${e.operation}</code></dd></div><div><dt>Sequence</dt><dd>${e.seq ?? "Not recorded"}</dd></div></dl>
 <details class="note"><summary>Available technical identifiers</summary><p>Task: <code>${e.taskKey || "setup"}</code><br>Turn: <code>sample-turn-${e.id}</code><br>Generation: ${e.taskKey ? 1 : 0}<br>Computer call: ${e.taskKey ? "sample-call-" + e.id : "Not recorded"}</p></details>
 <p class="micro-note">Sample metadata. The current task-event log is bounded and held in memory; it is not a durable transcript archive. Persistent task history is a separate proposed feature.</p>
 ${e.phase === "Outcome unknown" ? link("Inspect connection", "settings", "connection") : ""}`
  );
}

function setup() {
  if (state.page === "overview" || !steps.some((s) => s[0] === state.page)) {
    return (
      head(
        "Setup",
        "A guided path to connect ChatGPT and decide what it can access.",
      ) +
      steps
        .slice(1)
        .map(
          ([id, name], i) =>
            `<div class="connection-line"><span class="step-icon">${state.fixture === "empty" ? i + 1 : "✓"}</span><div><h3>${name}</h3><p>${["Use your own ChatGPT account.", "Choose folders and access for each one.", "Connect this Mac to ChatGPT.", "Add the app and review verification."][i]}</p></div><button class="btn" ${nav("setup", id)}>${state.fixture === "empty" ? "Set up" : "Review"}</button></div>`,
        )
        .join("") +
      `<p class="note">After setup, Home is your everyday starting point. Optional folder access stays optional.</p>`
    );
  }
  if (state.page === "folders") return folderPage();
  if (state.page === "connection") return connectionPage();
  if (state.page === "signin")
    return (
      head("Sign in", "Use your own ChatGPT account inside Farol.") +
      `<div class="check-block">${label(state.fixture === "empty" ? "Not signed in" : "Signed in", state.fixture === "empty" ? "attention" : "")}<p>This concept uses sample account status. Sign-in itself happens in the embedded ChatGPT surface.</p></div>${btn("Preview sign-in step", "signin", "primary")}`
    );
  return (
    head(
      "Add to ChatGPT",
      "Connect the Farol app, then review a check from ChatGPT.",
    ) +
    `<div class="check-block"><h2>1. Add the app in ChatGPT</h2><p>Open the relevant ChatGPT app settings and connect this Farol using the supported connection flow.</p></div><div class="check-block"><h2>2. Select the connected app</h2><p>The selected app must match the current Farol connection.</p><label class="small">App name <input class="input" aria-label="ChatGPT app name" value="Farol" style="margin:14px 0 0 10px"></label></div><div class="check-block"><h2>3. Review the verification</h2><p>A verification action sends a short check through ChatGPT. Opening a settings page or saving an app name alone does not verify access.</p></div>${btn("Review connection check", "connection-check", "primary")}<p class="note">Detailed service instructions belong in the setup guide, separate from everyday Settings.</p>`
  );
}

function browser() {
  const c = selectedChat();
  return `<div class="browser-surface"><div class="webview-placeholder"><div class="webview-identity">${icon("chat")}<span>Existing ChatGPT window</span><small>Window ${state.chat}</small></div><div class="webview-label">${c?.taskKey ? `<strong>${esc(c.title)}</strong>${label(c.phase, c.class)}<p>This area is occupied by the actual embedded ChatGPT page.<br>Farol does not recreate its messages, composer or navigation.</p>` : `<strong>Window ${state.chat} is available</strong><p>A ChatGPT page appears when work is assigned.<br>An available slot does not mean an eagerly opened browser.</p>`}<span class="sample-tag">Design placeholder · No live ChatGPT page</span></div></div></div>`;
}

function context() {
  let items = "",
    title = sectionNames[state.root],
    copy = "";
  if (state.root === "settings") {
    copy = "Clear pages. Independent controls.";
    items = settingPages
      .map(
        ([id, name]) =>
          `${id === "updates" ? '<div class="divider"></div>' : ""}<button class="item" ${nav("settings", id)} aria-current="${state.page === id ? "page" : "false"}">${icon(id)}<span class="label">${name}</span></button>`,
      )
      .join("");
  }
  if (state.root === "setup") {
    copy = "Connect once. Stay in control.";
    items = steps
      .map(
        ([id, name]) =>
          `<button class="item" ${nav("setup", id)} aria-current="${state.page === id ? "page" : "false"}"><span class="end">${state.fixture === "empty" ? "○" : "✓"}</span><span class="label">${name}</span></button>`,
      )
      .join("");
  }
  if (state.root === "chat") {
    copy = "Five numbered work windows.";
    items =
      '<div class="subheading">Current windows</div>' +
      chats()
        .map(
          (c) =>
            `<button class="item window-item" ${nav("chat")} data-chat="${c.number}" aria-current="${state.chat === c.number ? "page" : "false"}"><span class="task-number">${c.number}</span><span class="label"><strong>${esc(c.title)}</strong><small>${c.taskKey ? c.phase : "No task assigned"}</small></span></button>`,
        )
        .join("");
    if (state.fixture !== "empty") {
      const past = eventsFor().filter((e) => e.taskKey && !matchingChat(e));
      items +=
        '<div class="divider"></div><div class="subheading">Recent work</div>' +
        past
          .map(
            (e) =>
              `<button class="item recent-item" ${eventSelection(eventsFor().findIndex((x) => x.id === e.id))}><span class="label">${e.title}<small>${e.phase} · ${e.time}</small></span>${icon("chevron")}</button>`,
          )
          .join("");
    }
  }
  if (state.root === "activity") {
    copy = "Events you can inspect.";
    const events =
      state.fixture === "empty"
        ? []
        : eventsFor().filter(
            (e) => state.filter === "all" || e.phase === "Outcome unknown",
          );
    if (
      events.length &&
      !events.some((e) => eventsFor()[state.event]?.id === e.id)
    )
      state.event = eventsFor().findIndex((e) => e.id === events[0].id);
    items =
      `<select class="input" id="activity-filter" aria-label="Activity filter" style="width:100%;min-width:0;margin-bottom:13px"><option value="all">All activity</option><option value="attention" ${state.filter === "attention" ? "selected" : ""}>Needs attention</option></select>` +
      (events.length
        ? events
            .map(
              (e) =>
                `<button class="item" ${eventSelection(eventsFor().findIndex((x) => x.id === e.id))} aria-current="${eventsFor()[state.event]?.id === e.id ? "page" : "false"}"><span class="label">${e.title}<small>${e.phase} · ${e.time}</small></span></button>`,
            )
            .join("")
        : '<p class="note">No matching events.</p>');
  }
  return `<div class="context-head"><h2>${title}</h2><p>${copy}</p><button class="mobile-close" data-action="close-context" aria-label="Close section menu">${icon("close")}</button></div><div class="context-list">${items}</div><div class="context-foot">${state.root === "settings" ? "Appearance works in this preview." : state.root === "activity" ? "Sample records · No conversation text." : state.root === "chat" ? "History opens event details. Chat opens only when the task still matches." : "Setup does not run checks on its own."}</div>`;
}

function render() {
  if (!sectionNames[state.root]) state.root = "home";
  if (!palette.light[state.accent]) state.accent = "iris";
  if (!markNames[state.mark]) state.mark = "lamp";
  if (!themeNames[state.theme]) state.theme = "dark";
  const w = document.querySelector("#window"),
    theme = actualTheme();
  w.className = `window unified ${theme === "light" ? "mac" : "graphite"} ${state.font === "geist" ? "geist" : ""}`;
  const [accent, tint] = palette[theme][state.accent];
  w.style.setProperty("--accent", accent);
  w.style.setProperty("--tint", tint);
  document.body.classList.toggle("presentation", params.has("present"));
  document.querySelector("#fixture").value = state.fixture;
  document.querySelector("#mark-select").value = state.mark;
  document
    .querySelectorAll("[data-theme]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.theme === state.theme),
    );
  document
    .querySelectorAll(".board [data-accent]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.accent === state.accent),
    );
  document.querySelector("#workspace").className =
    `workspace ${state.root === "home" ? "no-context" : ""} ${state.contextOpen ? "context-open" : ""} ${state.menuHidden ? "context-collapsed" : ""}`;
  document.querySelector("#context").hidden =
    state.root === "home" || state.menuHidden;
  document.querySelector("#context").innerHTML = context();
  const attention = ["attention", "offline"].includes(state.fixture);
  document.querySelector("#rail").innerHTML =
    `<div class="rail-brand" title="Farol">${brand()}</div>` +
    ["home", "chat", "activity", "setup"]
      .map(
        (id, i) =>
          `<button ${nav(id, id === "setup" ? "overview" : null)} aria-label="${sectionNames[id]}${id === "home" && attention ? " — needs attention" : ""}" aria-current="${state.root === id ? "page" : "false"}">${icon(id)}${id === "home" && attention ? '<span class="home-attention" aria-hidden="true">!</span>' : ""}<span class="tip">${sectionNames[id]} · ⌘${i + 1}${id === "home" && attention ? " · Needs attention" : ""}</span></button>`,
      )
      .join("") +
    `<div class="rail-spacer"></div><button ${nav("settings", "general")} aria-label="Settings" aria-current="${state.root === "settings" ? "page" : "false"}">${icon("settings")}<span class="tip">Settings · ⌘,</span></button>`;
  const sub =
    state.root === "settings"
      ? settingPages.find((p) => p[0] === state.page)?.[1]
      : state.root === "setup"
        ? steps.find((p) => p[0] === state.page)?.[1]
        : state.root === "chat"
          ? `${state.chat} · ${selectedChat()?.title || "Available"}`
          : state.root === "activity"
            ? state.fixture === "empty" ||
              (state.filter === "attention" &&
                !eventsFor().some((e) => e.phase === "Outcome unknown"))
              ? null
              : eventsFor()[state.event]?.title
            : null;
  const title =
    state.root === "home"
      ? "Home"
      : sub
        ? `${sectionNames[state.root]} · ${sub}`
        : sectionNames[state.root];
  document.querySelector("#active-window-title").textContent = title;
  document.title = title + " — Farol design";
  document.querySelector("#pane").innerHTML =
    `<header class="toolbar">${state.root === "home" ? "" : `<button class="context-toggle" data-action="context" aria-label="Toggle section menu" aria-expanded="${innerWidth <= 850 ? state.contextOpen : !state.menuHidden}">${icon("menu")}</button>`}<span>${sectionNames[state.root]}</span>${sub ? `<span aria-hidden="true">/</span><span class="crumb">${esc(sub)}</span>` : ""}<span class="spacer"></span><button data-action="search" aria-label="Find a page">${icon("search")}<span>Find a page</span><kbd>⌘ K</kbd></button></header>${state.root === "chat" ? browser() : `<div class="content">${{ home, settings, setup, activity }[state.root]()}</div>`}`;
  document.querySelector("#pane").inert =
    state.contextOpen && innerWidth <= 850;
  document.querySelector("#thesis").textContent =
    `One Farol interface · ${themeNames[state.theme]} theme · ${accentNames[state.accent]} accent · ${state.font === "geist" ? "Geist" : "System"}. The warm mark and the interface accent can remain independent. All data and history here are samples.`;
}

let dialogReturn;
function openDialog(html) {
  dialogReturn = document.activeElement;
  const d = document.querySelector("#dialog");
  d.innerHTML = html;
  d.showModal();
  d.querySelector("input,button")?.focus();
}
function messageDialog(title, copy, actionLabel = "Close") {
  openDialog(
    `<h2>${title}</h2><p>${copy}</p><div class="dialog-actions">${btn(actionLabel, "dialog-close", "primary")}</div>`,
  );
}
document.querySelector("#dialog").addEventListener("click", (e) => {
  const d = e.currentTarget;
  if (e.target !== d || !d.querySelector("#page-search")) return;
  const r = d.getBoundingClientRect();
  if (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  )
    d.close();
});
document.querySelector("#dialog").addEventListener("close", () => {
  if (dialogReturn?.isConnected) dialogReturn.focus();
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.theme) {
    const zone = b.closest(".content") ? ".content " : ".board ";
    state.theme = b.dataset.theme;
    render();
    document.querySelector(`${zone}[data-theme="${state.theme}"]`)?.focus();
    return;
  }
  if (b.dataset.accent) {
    const zone = b.closest(".content") ? ".content " : ".board ";
    state.accent = b.dataset.accent;
    render();
    document.querySelector(`${zone}[data-accent="${state.accent}"]`)?.focus();
    return;
  }
  if (b.dataset.root) {
    state.root = b.dataset.root;
    state.page =
      b.dataset.page || (state.root === "setup" ? "overview" : state.page);
    if (b.dataset.chat) state.chat = Number(b.dataset.chat);
    if (b.dataset.event) {
      state.event = Number(b.dataset.event);
      state.filter = "all";
    }
    state.contextOpen = false;
    render();
    document.querySelector("#pane h1,#pane h2")?.setAttribute("tabindex", "-1");
    document.querySelector("#pane h1,#pane h2")?.focus({ preventScroll: true });
    return;
  }
  const a = b.dataset.action;
  if (a === "toggle") {
    b.setAttribute("aria-checked", b.getAttribute("aria-checked") !== "true");
    return;
  }
  if (a === "context") {
    if (innerWidth > 850) {
      state.menuHidden = !state.menuHidden;
    } else {
      state.menuHidden = false;
      state.contextOpen = !state.contextOpen;
    }
    render();
    if (state.contextOpen) document.querySelector(".context .item")?.focus();
    return;
  }
  if (a === "close-context") {
    state.contextOpen = false;
    render();
    document.querySelector(".context-toggle")?.focus();
    return;
  }
  if (a === "folder") {
    state.folder = Number(b.dataset.index);
    render();
    return;
  }
  if (a === "save") {
    toast(
      "Changes saved in this prototype only. Farol settings were not changed.",
    );
    return;
  }
  if (a === "check-update") {
    state.updateChecked = true;
    render();
    toast("Sample update state displayed. No server was contacted.");
    return;
  }
  if (a === "git-access") {
    messageDialog(
      "Git history & user settings",
      "This permission includes Git metadata, past file versions, hooks and your Git user settings. These can include information beyond the current folder. In the final app, review this scope before allowing it, then verify the folder again. This prototype cannot grant access.",
    );
    return;
  }
  if (a === "connection-check") {
    messageDialog(
      "Review a connection check",
      "A live check would send a short message through ChatGPT using the selected Farol app. Its result can be verified, failed or unknown. This prototype previews the review step only; it cannot send a check.",
    );
    return;
  }
  if (a === "restore") {
    messageDialog(
      "Restore Farol 0.1.7?",
      "The final application would review update readiness and restart into the previously accepted version. Active work and unknown outcomes must be resolved by the existing update flow. This preview does not restart or restore anything.",
      "Back to Updates",
    );
    return;
  }
  if (a === "remove-folder") {
    messageDialog(
      "Remove this folder?",
      "In the final app, removing a folder revokes future access without deleting its files. This is a preview of that review step; no folder access will change.",
    );
    return;
  }
  if (a === "add-folder") {
    openDialog(
      `<h2>Add a folder</h2><p>In the final app, choose a folder using the Mac file picker. New folders start read-only. This field previews the naming step only.</p><label>Folder label<input class="input" aria-label="Folder label" placeholder="Project name"></label><div class="dialog-actions">${btn("Cancel", "dialog-close")}${btn("Preview addition", "demo-add", "primary")}</div>`,
    );
    return;
  }
  if (a === "demo-add") {
    const name = document.querySelector("#dialog input").value.trim();
    if (!name) {
      document.querySelector("#dialog input").focus();
      return;
    }
    folders.push({
      name,
      path: "/demo/selected-folder",
      mode: "Read-only",
      verified: false,
    });
    state.folder = folders.length - 1;
    document.querySelector("#dialog").close();
    render();
    toast("Sample folder added to this preview only.");
    return;
  }
  if (a === "signin") {
    messageDialog(
      "Sign in to ChatGPT",
      "The final app opens its isolated embedded ChatGPT surface. This design room does not open an account, read a session or change authentication.",
    );
    return;
  }
  if (a === "report") {
    messageDialog(
      "Sample diagnostic report",
      "Local service: available. ChatGPT: sample connection. Activity: projected metadata only. No live system information was collected.",
    );
    return;
  }
  if (a === "dialog-close") {
    document.querySelector("#dialog").close();
    return;
  }
  if (a === "search") {
    openDialog(
      `<h2>Find a page</h2><label>Page name<input class="input" id="page-search" aria-label="Page name" placeholder="Try Updates or Folders"></label><div id="search-results"></div><div class="dialog-actions">${btn("Close", "dialog-close")}</div>`,
    );
    searchPages("");
    return;
  }
});
function searchPages(q) {
  const candidates = [
    ["home", null, "Home"],
    ["chat", null, "ChatGPT"],
    ["activity", null, "Activity"],
    ["setup", "overview", "Setup"],
    ...settingPages.map(([id, title]) => ["settings", id, title]),
  ].filter((p) => p[2].toLowerCase().includes(q.toLowerCase()));
  document.querySelector("#search-results").innerHTML = candidates.length
    ? candidates
        .map(
          ([root, page, title]) =>
            `<button class="folder-button" ${nav(root, page)}>${esc(title)}</button>`,
        )
        .join("")
    : '<p class="note">No matching page. Try another name.</p>';
}
document.addEventListener("input", (e) => {
  if (e.target.id === "page-search") searchPages(e.target.value);
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.draft) {
    drafts[e.target.dataset.draft] = e.target.value;
    if (e.target.dataset.draft === "Typeface") {
      state.font = e.target.value === "Geist" ? "geist" : "system";
      render();
      document.querySelector('.content select[aria-label="Typeface"]')?.focus();
    }
    if (e.target.dataset.draft === "Folder access")
      folders[state.folder].mode = e.target.value;
  }
  if (e.target.id === "fixture") {
    state.fixture = e.target.value;
    state.updateChecked = false;
    render();
  }
  if (e.target.id === "mark-select") {
    state.mark = e.target.value;
    render();
  }
  if (e.target.id === "activity-filter") {
    state.filter = e.target.value;
    if (state.filter === "attention") state.event = 2;
    render();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.contextOpen) {
    e.preventDefault();
    state.contextOpen = false;
    render();
    document.querySelector(".context-toggle")?.focus();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    document.querySelector('[data-action="search"]').click();
  }
  if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (state.root !== "home") {
      document.querySelector('[data-action="context"]')?.click();
    }
  }
  if (
    e.metaKey &&
    ["1", "2", "3", "4", ","].includes(e.key) &&
    !document.querySelector("#dialog").open
  ) {
    e.preventDefault();
    state.root = {
      1: "home",
      2: "chat",
      3: "activity",
      4: "setup",
      ",": "settings",
    }[e.key];
    state.page = state.root === "setup" ? "overview" : "general";
    state.contextOpen = false;
    render();
  }
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#search-results button[data-root]"))
    document.querySelector("#dialog").close();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.theme === "system") render();
});
render();
