const menuParams = new URLSearchParams(location.search);
const menuState = {
  status: "ready",
  mark: ["lens", "aperture", "relay"].includes(menuParams.get("mark"))
    ? menuParams.get("mark")
    : "lens",
  theme: "light",
  open: false,
};
const menuStates = {
  ready: [
    "Ready",
    "Connection and local access are available in this example.",
  ],
  running: ["1 task running", "Work continues in ChatGPT."],
  attention: ["Needs attention", "A work result is not confirmed."],
  offline: ["Disconnected", "ChatGPT access is not currently confirmed."],
  update: ["Update ready", "Farol 0.1.9 is downloaded in this example."],
};
function appLink(root = "home", sub = "general") {
  const fixture =
    { running: "working", attention: "attention", offline: "offline" }[
      menuState.status
    ] || "ready";
  return `index.html?page=${root}&sub=${sub}&state=${fixture}&theme=${menuState.theme}&update=${menuState.status === "update" ? "ready" : "none"}`;
}
function updateLink() {
  const u = new URL(appLink(), location.href);
  u.searchParams.set(
    "update",
    menuState.status === "update" ? "ready" : "available",
  );
  u.searchParams.set("dialog", "update");
  return "index.html?" + u.searchParams.toString();
}
function renderMenu() {
  const [title, copy] = menuStates[menuState.status];
  const trigger = document.querySelector("#status-trigger");
  trigger.innerHTML = FarolMark.svg(
    menuState.mark,
    "currentColor",
    "emblem",
    menuState.status,
  );
  trigger.setAttribute("aria-label", "Farol — " + title);
  trigger.setAttribute("title", "Farol — " + title);
  trigger.setAttribute("aria-expanded", menuState.open);
  document
    .querySelector("#desktop")
    .classList.toggle("dark", menuState.theme === "dark");
  document.querySelector("#menu-state").value = menuState.status;
  document.querySelector("#menu-mark").value = menuState.mark;
  const m = document.querySelector("#status-menu");
  m.hidden = !menuState.open;
  const context =
    menuState.status === "running"
      ? `<a role="menuitem" class="menu-item" href="${appLink("chat")}">View running work</a>`
      : menuState.status === "attention"
        ? `<a role="menuitem" class="menu-item" href="${appLink("activity")}">Review Activity</a>`
        : menuState.status === "offline"
          ? `<a role="menuitem" class="menu-item" href="${appLink("settings", "connection")}">Review connection</a>`
          : "";
  m.innerHTML = `<div class="menu-status" role="presentation"><strong>Farol · ${title}</strong><p>${copy}</p></div>${context}<div class="menu-divider" role="separator"></div><a role="menuitem" class="menu-item" href="${appLink()}">Open Farol</a><a role="menuitem" class="menu-item" href="${updateLink()}">Check for Updates…</a><div class="menu-divider" role="separator"></div><button role="menuitem" class="menu-item" data-menu-action="quit">Quit Farol<kbd>⌘Q</kbd></button>`;
  document.querySelector("#state-strip").innerHTML = Object.entries(menuStates)
    .map(
      ([state, [label]]) =>
        `<button data-menu-state="${state}" aria-pressed="${menuState.status === state}">${FarolMark.svg(menuState.mark, "currentColor", "emblem", state)}<span>${label}</span></button>`,
    )
    .join("");
}
function closeMenu() {
  menuState.open = false;
  renderMenu();
  document.querySelector("#status-trigger").focus();
}
document.querySelector("#status-trigger").addEventListener("click", (e) => {
  e.stopPropagation();
  menuState.open = !menuState.open;
  renderMenu();
  if (menuState.open)
    document.querySelector('#status-menu [role="menuitem"]')?.focus();
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b?.dataset.menuState) {
    menuState.status = b.dataset.menuState;
    renderMenu();
    document.querySelector(`[data-menu-state="${menuState.status}"]`).focus();
    return;
  }
  if (b?.dataset.menuAction === "quit") {
    closeMenu();
    const f = document.querySelector("#menu-feedback");
    f.hidden = false;
    f.textContent =
      menuState.status === "running"
        ? "Quit preview: the installed app must review active work before exiting. No app was closed."
        : "Quit command previewed. No application was closed.";
    return;
  }
  if (menuState.open && !e.target.closest("#status-menu,#status-trigger"))
    closeMenu();
});
document.addEventListener("change", (e) => {
  if (e.target.id === "menu-state") menuState.status = e.target.value;
  if (e.target.id === "menu-mark") menuState.mark = e.target.value;
  if (e.target.id === "bar-theme") menuState.theme = e.target.value;
  renderMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuState.open) {
    e.preventDefault();
    closeMenu();
  }
  if (
    menuState.open &&
    ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    const items = [
      ...document.querySelectorAll('#status-menu [role="menuitem"]'),
    ];
    const pos = items.indexOf(document.activeElement);
    const target =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (pos + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[target].focus();
  }
});
renderMenu();
