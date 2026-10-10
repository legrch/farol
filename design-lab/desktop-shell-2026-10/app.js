const paths = {
  back: "m12 4-6 6 6 6",
  forward: "m8 4 6 6-6 6",
  sidebar: "M2 3h16v14H2V3M7 3v14",
  download: "M10 2v10m-4-4 4 4 4-4M3 14v4h14v-4",
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
    mode: "Read & write",
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
          : c?.phase === "Interrupted"
            ? "INTERRUPTED"
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
const head = (title, copy) => `<p class="page-intro">${copy}</p>`;
const row = (title, copy, control) =>
  `<div class="row"><div class="row-copy"><h3>${title}</h3><p>${copy}</p></div>${control}</div>`;
const drafts = {};
const select = (name, options, chosen) =>
  `<select aria-label="${name}" data-draft="${name}">${options.map((o) => `<option ${o === ((name === "Folder access" ? folders[state.folder].mode : drafts[name]) ?? chosen) ? "selected" : ""}>${o}</option>`).join("")}</select>`;
const toggle = (name, on) =>
  `<button class="switch" role="switch" aria-label="${name}" aria-checked="${on}" data-action="toggle"></button>`;

const accentNames = { iris: "Iris", cobalt: "Cobalt", amber: "Amber" };
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
 </section><p class="note">Changes apply immediately. You can change them again at any time.</p>`
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
  const work = [
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
  if (demoUpdate.didInterrupt)
    for (const c of work) {
      if (c.phase === "Working") {
        c.phase = "Interrupted";
        c.class = "attention";
      }
    }
  return work;
}

function toast(message) {
  const t = document.querySelector("#toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => (t.hidden = true), 3800);
}

function connectionHealth() {
  if (state.fixture === "empty")
    return {
      title: "Setup needed",
      kind: "attention",
      copy: "Connect ChatGPT to get started.",
    };
  if (state.fixture === "offline")
    return {
      title: "Disconnected",
      kind: "offline",
      copy: "ChatGPT is not connected to this Mac.",
    };
  if (state.fixture === "attention")
    return {
      title: "Connection check needed",
      kind: "unknown",
      copy: "The last connection check has no confirmed result.",
    };
  return {
    title: "Ready",
    kind: "",
    copy: "ChatGPT is connected and the connection check passed.",
  };
}
function home() {
  const health = connectionHealth();
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
          ? "Ready for your next task"
          : "Work is moving in the background";
  const copy = empty
    ? "Connect your account, then choose what ChatGPT can access."
    : state.fixture === "ready"
      ? "ChatGPT is connected. The connection check passed."
      : state.fixture === "offline"
        ? "The local service is available, but ChatGPT is disconnected."
        : state.fixture === "attention"
          ? "An outcome is not confirmed. Inspect the available evidence before deciding what to do next."
          : "Watch current work and manage access without interrupting it.";
  return `<div class="status-hero"><div class="status-emblem">${icon(attention ? "warning" : empty ? "home" : state.fixture === "ready" ? "check" : "clock")}</div><div><h2 class="home-headline">${title}</h2><p>${copy}</p></div>${empty ? `<button class="btn primary" ${nav("setup", "overview")}>Set up Farol</button>` : ""}</div>
 <div class="home-layout"><section class="home-tasks"><div class="section-title"><h2>Current work</h2>${link("View ChatGPT", "chat")}</div>
 ${empty ? `<div class="empty">${icon("chat")}<h2>No work yet</h2><p>Tasks started from your connected tools appear here. Browser windows are created only when needed.</p></div>` : current.map((c) => `<button class="task-row" ${nav("chat")} data-chat="${c.number}"><span class="task-number">${c.number}</span><span class="task-copy"><strong>${c.title}</strong><p>Window ${c.number}${c.phase === "Done" ? " · Still available to inspect" : ""}</p></span>${label(c.phase, c.class)}<span class="arrow">${icon("chevron")}</span></button>`).join("")}
 ${attention ? `<div class="attention-banner">${icon("warning")}<div><h3>${state.fixture === "offline" ? "ChatGPT is disconnected" : "Connection check has no confirmed result"}</h3><p>${state.fixture === "offline" ? "Inspect the connection state and supported recovery steps." : "Open the event to see what is confirmed."}</p><button class="btn" ${state.fixture === "offline" ? nav("settings", "connection") : eventSelection(2)}>${state.fixture === "offline" ? "Open Connection" : "Inspect event"}</button></div></div>` : !empty ? (demoUpdate.didInterrupt ? '<div class="quiet">Restart preview: interrupted work remains available to inspect.</div>' : '<div class="quiet">No action needed. Switching sections keeps ongoing work available.</div>') : ""}
 ${empty ? "" : recentActivity()}</section>
 <aside class="health" aria-label="Connection and access"><div class="section-title"><h2>Connection & access</h2></div><div class="health-summary">${label(health.title, health.kind)}<p>${health.copy}</p></div>
 <div class="health-item"><h3>ChatGPT</h3>${label(empty ? "Not connected" : state.fixture === "offline" ? "Disconnected" : "Connected", empty ? "attention" : state.fixture === "offline" ? "offline" : "")}<p>${empty ? "Use your own ChatGPT account." : state.fixture === "offline" ? "Current connection unavailable." : "Account and connection confirmed in this sample."}</p>${link("Manage connection", "settings", "connection")}</div>
 <div class="health-item"><h3>This Mac</h3>${label(empty ? "Not checked" : "Available", empty ? "attention" : "")}<p>Manage what ChatGPT can do on this computer.</p>${link("Review access", "settings", "mac")}</div>
 <div class="health-item"><h3>Shared folders</h3>${label(empty ? "None shared" : folders.some((f) => !f.verified) ? `${folders.filter((f) => !f.verified).length} need a check` : `${folders.length} verified`, empty || folders.some((f) => !f.verified) ? "attention" : "")}<p>${empty ? "Choose a folder when you need file access." : `${folders.filter((f) => f.verified).length} verified · ${folders.filter((f) => !f.verified).length} need a check. Folder status is separate from the connection.`}</p>${link("Manage folders", "settings", "folders")}</div>
 </aside></div>`;
}

function general() {
  return (
    head("General", "Choose where Farol starts and how its sidebar behaves.") +
    `<section class="form-group">${row("Start page", "The page shown when you open Farol.", select("Start page", ["Home", "Last used page", "ChatGPT"], "Home"))}${row("Sidebar", "The list of pages beside the icons. You can also hide it with the button in the top bar.", select("Sidebar", ["Show page list", "Remember my choice"], "Show page list"))}</section><p class="note">Activity shows a short event summary. Extra details are available inside each event when you need them.</p>`
  );
}

function folderPage() {
  const f = folders[state.folder];
  return (
    head("Folders", "Choose what ChatGPT can read and change.") +
    `<div class="folder-layout"><aside class="folder-picker" aria-label="Shared folders">${folders.map((x, i) => `<button class="folder-button" data-action="folder" data-index="${i}" aria-current="${state.folder === i ? "page" : "false"}">${icon("folders")}<div><h3>${esc(x.name)}</h3><p>${x.mode}</p></div></button>`).join("")}</aside><section class="folder-detail"><div class="folder-title">${icon("folders")}<h2>${esc(f.name)}</h2></div><code>${esc(f.path)}</code>${label(f.verified ? "Access verified" : "Check needed", f.verified ? "" : "attention")}<div class="form-group">${row("File access", "Read only, or let ChatGPT propose file changes for your approval.", select("Folder access", ["Read-only", "Read & write"], f.mode))}</div><p class="permission-explainer">${f.mode === "Read-only" ? "ChatGPT can read files here. It cannot change them." : "ChatGPT can propose changes here. Changes still require approval."}</p><details class="advanced-settings"><summary>More access options</summary><div class="form-group">${row("Git history & settings", "This includes more than the files currently in this folder.", btn("Review access", "git-access"))}</div><h3>Excluded paths</h3><p>Files and subfolders to keep private.</p><input class="input" aria-label="Excluded paths" value="private, build/secrets.txt"><p>Git history, old file versions, hooks and user settings need separate approval. Verify access again after changing this permission.</p></details><div class="form-foot">${btn("Remove folder", "remove-folder")}${btn("Check access", "verify-folder", "primary")}</div></section></div><div class="add-folder-row">${btn("Add folder…", "add-folder")}<span>Choose a folder on your Mac. It starts read-only.</span></div>`
  );
}

function macPage() {
  return (
    head("This Mac", "Manage command access on this Mac.") +
    `<section class="form-group">${row("Local service", "The service that connects this Mac to ChatGPT.", label("Available"))}${row("Shared folders", "File access is managed separately for each folder.", link("Manage folders", "settings", "folders"))}</section><details class="advanced-settings"><summary>Command access</summary><p>Some tasks need to run commands inside an approved folder. Leave this off if you only need file access.</p><section class="form-group">${row("Run commands", "Commands stay inside an approved folder. Network access is not included.", select("Run commands", ["Off", "Approved folders only"], "Approved folders only"))}</section></details><p class="micro-note">Sample capability state. Connection verification is shown separately in Connection.</p>`
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
  const u = demoUpdate;
  return (
    head("Updates", "Keep Farol up to date, on your terms.") +
    `<section class="form-group">${row("Installed version", `Farol ${u.current} · Owner beta (sample)`, btn("Check for Updates…", "check-update", "primary"))}${row("Update status", updateStatusCopy(), u.phase === "none" ? '<span class="small muted">' + (u.checked ? "Up to date" : "Not checked") + "</span>" : btn("View update…", "review-update"))}${row("Automatic updates", "Download in the background and install when you quit Farol. Ongoing work is never interrupted automatically.", updateSwitch("Automatic updates", "toggle-auto-update", u.automatic))}${row("Update notices", "Show one quiet notice for a new version. The update button stays available after dismissal.", updateSwitch("Update notices", "toggle-update-notices", u.notifications))}${row("Previous version", "Farol 0.1.7 is available in this example.", btn("Review restore…", "restore"))}</section><p class="note">Clicking the update button opens its details. It never restarts Farol immediately.</p><p class="micro-note">Update prototype. Nothing is downloaded, installed or restarted.</p>`
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
    `<section class="form-group">${["Home", "ChatGPT", "Activity", "Setup"].map((s, i) => row(s, "Switch section without restarting work.", `<code>⌘ ${i + 1}</code>`)).join("")}${row("Settings", "Open the Settings section.", "<code>⌘ ,</code>")}${row("Back / Forward", "Return to a previous Farol page or inspector.", "<code>⌘ [ / ⌘ ]</code>")}${row("Find a page", "Search section names and settings.", "<code>⌘ K</code>")}${row("Sidebar", "Show or hide the list of pages.", "<code>⌃ ⌘ S</code>")}</section><p class="note">Shortcuts here are a design proposal. Search and section navigation work in this prototype; the installed application keeps its existing keyboard map.</p>`
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
 <div class="activity-event"><time>${e.time}</time><strong>${e.phase === "Outcome unknown" ? "Outcome not confirmed" : e.phase === "Interrupted" ? "Work interrupted" : e.phase === "Working" ? "Computer operation requested" : e.phase === "Unavailable" ? "Connection unavailable" : e.phase === "Disconnected" ? "Connection lost during work" : "Completed event"}</strong><p>${e.phase === "Outcome unknown" ? "There is no confirmed successful or failed result." : e.code === "COMPLETED" ? "A completed result was recorded." : "The available event does not confirm task completion."}</p></div>
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
  return `<div class="browser-surface"><div class="webview-placeholder"><div class="webview-label">${icon("chat")}<strong>${c?.taskKey ? "Embedded ChatGPT" : "This window is available"}</strong><p>${c?.taskKey ? "The existing ChatGPT page occupies this entire area." : "A ChatGPT page appears when a task is assigned."}<br>Farol keeps the native browser surface and its own navigation.</p><span class="sample-tag">Design placeholder · No live ChatGPT page</span></div></div></div>`;
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
  return `<div class="context-head"><h2>${title}</h2><p>${copy}</p><button class="mobile-close" data-action="close-context" aria-label="Close sidebar">${icon("close")}</button></div><div class="context-list">${items}</div><div class="context-foot">${state.root === "settings" ? "Appearance works in this preview." : state.root === "activity" ? "Sample records · No conversation text." : state.root === "chat" ? "History opens event details. Chat opens only when the task still matches." : "Setup does not run checks on its own."}</div>`;
}

const routeKeys = ["root", "page", "chat", "event", "folder", "filter"];
const routeSnapshot = () =>
  Object.fromEntries(routeKeys.map((k) => [k, state[k]]));
const historyEntries = [{ ...routeSnapshot(), scroll: 0 }];
let historyIndex = 0;
function navigationFocus() {
  document
    .querySelector("#active-window-title")
    ?.focus({ preventScroll: true });
}
function navigate(next) {
  const current = historyEntries[historyIndex];
  current.scroll = document.querySelector(".content")?.scrollTop || 0;
  Object.assign(state, next);
  state.contextOpen = false;
  render();
  const nextRoute = routeSnapshot();
  if (routeKeys.some((k) => current[k] !== nextRoute[k])) {
    historyEntries.splice(historyIndex + 1);
    historyEntries.push({ ...nextRoute, scroll: 0 });
    historyIndex++;
    render();
  }
  navigationFocus();
}
function moveHistory(delta) {
  const target = historyIndex + delta;
  if (target < 0 || target >= historyEntries.length) return;
  historyEntries[historyIndex].scroll =
    document.querySelector(".content")?.scrollTop || 0;
  historyIndex = target;
  Object.assign(state, historyEntries[target]);
  state.contextOpen = false;
  render();
  const content = document.querySelector(".content");
  if (content) content.scrollTop = historyEntries[target].scroll;
  navigationFocus();
}

function render() {
  if (!sectionNames[state.root]) state.root = "home";
  if (!palette.light[state.accent]) state.accent = "iris";
  if (!themeNames[state.theme]) state.theme = "dark";
  const w = document.querySelector("#window"),
    theme = actualTheme();
  w.className = `window unified ${theme === "light" ? "mac" : "graphite"} ${state.font === "geist" ? "geist" : ""}`;
  const [accent, tint] = palette[theme][state.accent];
  w.style.setProperty("--accent", accent);
  w.style.setProperty("--tint", tint);
  document.body.classList.toggle("presentation", params.has("present"));
  document.querySelector("#fixture").value = state.fixture;

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
    ["home", "chat", "activity", "setup"]
      .map(
        (id, i) =>
          `<button ${nav(id, id === "setup" ? "overview" : null)} aria-label="${sectionNames[id]}${id === "home" && attention ? " — needs attention" : ""}" aria-current="${state.root === id ? "page" : "false"}">${icon(id)}${id === "home" && attention ? '<span class="home-attention" aria-hidden="true">!</span>' : ""}<span class="tip">${sectionNames[id]} · ⌘${i + 1}${id === "home" && attention ? " · Needs attention" : ""}</span></button>`,
      )
      .join("") +
    `<div class="rail-spacer"></div>${updateRailButton()}<button ${nav("settings", "general")} aria-label="Settings" aria-current="${state.root === "settings" ? "page" : "false"}">${icon("settings")}<span class="tip">Settings · ⌘,</span></button>`;
  const leaf =
    state.root === "settings"
      ? settingPages.find((p) => p[0] === state.page)?.[1] || "General"
      : state.root === "setup"
        ? steps.find((p) => p[0] === state.page)?.[1] || "Overview"
        : state.root === "chat"
          ? selectedChat()?.taskKey
            ? selectedChat().title
            : `Window ${state.chat}`
          : state.root === "activity" &&
              state.fixture !== "empty" &&
              !(
                state.filter === "attention" &&
                !eventsFor().some((e) => e.phase === "Outcome unknown")
              )
            ? eventsFor()[state.event]?.title || "Activity"
            : sectionNames[state.root];
  const parent = ["settings", "setup"].includes(state.root)
    ? sectionNames[state.root]
    : null;
  w.classList.toggle(
    "chrome-expanded",
    state.root !== "home" && !state.menuHidden && innerWidth > 850,
  );
  document.querySelector("#window-header").innerHTML =
    `<div class="chrome-nav"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><div class="history-controls"><button data-action="back" aria-label="Go back" ${historyIndex === 0 ? "disabled" : ""}>${icon("back")}</button><button data-action="forward" aria-label="Go forward" ${historyIndex === historyEntries.length - 1 ? "disabled" : ""}>${icon("forward")}</button></div><button class="context-toggle" data-action="context" aria-label="Show or hide sidebar" aria-expanded="${innerWidth <= 850 ? state.contextOpen : !state.menuHidden}" ${state.root === "home" ? "disabled" : ""}>${icon("sidebar")}</button></div><div class="chrome-page">${parent ? `<span class="chrome-parent">${parent}</span><span class="chrome-slash" aria-hidden="true">/</span>` : ""}<h1 id="active-window-title" tabindex="-1" title="${esc(leaf)}">${esc(leaf)}</h1><span class="chrome-spacer"></span><button data-action="search" class="chrome-search" aria-label="Find a page">${icon("search")}<span>Find a page</span><kbd>⌘ K</kbd></button></div>`;
  document.title = leaf + " — Farol design";
  document.querySelector("#pane").innerHTML =
    state.root === "chat"
      ? browser()
      : `<div class="content">${{ home, settings, setup, activity }[state.root]()}</div>`;
  document.querySelector("#pane").inert =
    state.contextOpen && innerWidth <= 850;
  renderUpdateNotice();
  document.querySelector("#update-fixture").value =
    demoUpdate.phase === "downloading" ? "available" : demoUpdate.phase;
  document.querySelector("#thesis").textContent =
    `One Farol interface · ${themeNames[state.theme]} theme · ${accentNames[state.accent]} accent · ${state.font === "geist" ? "Geist" : "System"}. Unified window toolbar. No brand tile in navigation. Update and menu-bar interactions are proposals. All data and history here are samples.`;
}

let dialogReturn;
function openDialog(html) {
  dialogReturn = document.activeElement;
  const d = document.querySelector("#dialog");
  d.classList.remove("update-dialog");
  delete d.dataset.kind;
  d.dataset.dismissible = "true";
  d.innerHTML = html;
  const heading = d.querySelector("h2");
  if (heading) {
    heading.id = "dialog-title";
    d.setAttribute("aria-labelledby", heading.id);
  }
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
  if (e.target !== d || d.dataset.dismissible === "false") return;
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
  else if (dialogReturn?.dataset.action)
    document
      .querySelector(`[data-action="${dialogReturn.dataset.action}"]`)
      ?.focus();
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
    const next = {
      root: b.dataset.root,
      page:
        b.dataset.page ||
        (b.dataset.root === "setup" ? "overview" : state.page),
    };
    if (b.dataset.chat) next.chat = Number(b.dataset.chat);
    if (b.dataset.event) {
      next.event = Number(b.dataset.event);
      next.filter = "all";
    }
    navigate(next);
    return;
  }
  const a = b.dataset.action;
  if (a === "back" || a === "forward") {
    moveHistory(a === "back" ? -1 : 1);
    return;
  }
  if (a === "context" && state.root === "home") return;
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
    navigate({ folder: Number(b.dataset.index) });
    return;
  }
  if (a === "save") {
    toast(
      "Changes saved in this prototype only. Farol settings were not changed.",
    );
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
    document.querySelector("#folder-native-picker").click();
    return;
  }
  if (a === "verify-folder") {
    messageDialog(
      "Check folder access",
      "The installed app verifies access through ChatGPT. This prototype cannot perform that check or mark a selected folder as verified.",
    );
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
    if (e.target.dataset.draft === "Sidebar") {
      if (e.target.value === "Show page list") state.menuHidden = false;
      render();
      document.querySelector('select[aria-label="Sidebar"]')?.focus();
    }
    if (e.target.dataset.draft === "Folder access") {
      folders[state.folder].mode = e.target.value;
      folders[state.folder].verified = false;
      render();
      document.querySelector('select[aria-label="Folder access"]')?.focus();
    }
  }
  if (e.target.id === "fixture") {
    state.fixture = e.target.value;
    state.updateChecked = false;
    render();
  }
  if (e.target.id === "activity-filter") {
    navigate({
      filter: e.target.value,
      event: e.target.value === "attention" ? 2 : state.event,
    });
  }
});
document.addEventListener("keydown", (e) => {
  if (
    e.metaKey &&
    ["[", "]"].includes(e.key) &&
    !e.target.closest("input,textarea,select") &&
    !document.querySelector("#dialog").open
  ) {
    e.preventDefault();
    moveHistory(e.key === "[" ? -1 : 1);
    return;
  }
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
    const root = {
      1: "home",
      2: "chat",
      3: "activity",
      4: "setup",
      ",": "settings",
    }[e.key];
    navigate({ root, page: root === "setup" ? "overview" : "general" });
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

document
  .querySelector("#folder-native-picker")
  .addEventListener("change", (e) => {
    const chosen = e.target.files?.[0];
    if (!chosen) return;
    const name = chosen.webkitRelativePath?.split("/")[0] || "Selected folder";
    if (folders.some((f) => f.selectedName === name)) {
      toast("That sample folder is already listed.");
      return;
    }
    folders.push({
      name,
      selectedName: name,
      path: "Selected on this Mac · absolute path hidden by browser",
      mode: "Read-only",
      verified: false,
    });
    e.target.value = "";
    navigate({ root: "settings", page: "folders", folder: folders.length - 1 });
    toast(
      "Folder shown in the prototype only. No files were read and no access was granted.",
    );
  });
