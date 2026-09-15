(() => {
  "use strict";

  const directions = new Set(["native", "dense", "beacon"]);
  const sections = ["browser", "computer", "activity", "settings"];
  const states = new Set([
    "running",
    "waiting",
    "complete",
    "failed",
    "unavailable",
    "unknown",
  ]);

  const tasks = [
    {
      id: "atlantic",
      label: "Atlantic workspace check",
      state: "waiting",
      runId: "Run F-2048",
      lede: "Checking the synthetic workspace boundary without reading files, commands, screenshots, or account state.",
    },
    {
      id: "harbor",
      label: "Harbor research stream",
      state: "running",
      runId: "Run F-2049",
      lede: "Reviewing public navigation patterns through a controlled local stream while the task surface remains isolated.",
    },
    {
      id: "release",
      label: "Release dependency and compatibility review",
      state: "complete",
      runId: "Run F-2044",
      lede: "The fixture result is retained locally. No release, provider call, signing, or publication was performed.",
    },
  ];

  const stateCopy = {
    running: {
      label: "Running",
      title: "Response is streaming",
      detail: "The selected local fixture is producing new task-bound output.",
      primary: "Open Activity",
      computer: "No approval needed",
      inspector: "The task is active and retained in its own Browser surface.",
    },
    waiting: {
      label: "Waiting",
      title: "Computer approval needed",
      detail: "The task is paused before a bounded fixture-status check.",
      primary: "Review Computer request",
      computer: "Approval required",
      inspector:
        "One explicit decision is holding this task. Nothing has been submitted twice.",
    },
    complete: {
      label: "Complete",
      title: "Final result retained",
      detail:
        "The local fixture finished and kept its final result with this task.",
      primary: "Review result",
      computer: "No request",
      inspector:
        "The final fixture result is retained locally and ready to inspect.",
    },
    failed: {
      label: "Failed",
      title: "Stopped before completion",
      detail:
        "Open Activity for the recorded reason before trying this task again.",
      primary: "Inspect failure",
      computer: "Unavailable",
      inspector:
        "The task stopped with a recorded failure. Recovery starts in Activity.",
    },
    unavailable: {
      label: "Unavailable",
      title: "Local runtime is offline",
      detail:
        "This view will not resubmit the task. Reopen it after the runtime is available.",
      primary: "Open Settings",
      computer: "Runtime offline",
      inspector:
        "The task is preserved, but its local fixture runtime is unavailable.",
    },
    unknown: {
      label: "Outcome unknown",
      title: "Submission outcome is unknown",
      detail:
        "The operation may have been submitted. Inspect Activity before any retry.",
      primary: "Inspect Activity",
      computer: "Do not retry",
      inspector:
        "No automatic retry is allowed while the previous outcome remains unknown.",
    },
  };

  const setupSteps = [
    {
      name: "ChatGPT",
      title: "Keep the signed-in route separate",
      copy: "Farol Next will use its own authenticated Browser route. This lab never borrows or changes the installed provider profile.",
      status: "Not connected",
      tone: "blocked",
      details: [
        "The controlled local provider remains available for this lab.",
        "No login, cookies, provider slot, or account state is read from Legacy.",
      ],
    },
    {
      name: "Computer",
      title: "Choose exactly what This Mac may expose",
      copy: "Computer begins closed and capability-bound. The lab offers one synthetic fixture-status check and nothing from your filesystem.",
      status: "Lab simulation only",
      tone: "limited",
      details: [
        "Available: one synthetic workspace status after explicit approval.",
        "Unavailable: files, commands, screenshots, and native host actions.",
      ],
    },
    {
      name: "Connect",
      title: "Use an isolated local runtime",
      copy: "The future desktop shell and utility runtime communicate through a bounded local route. This design lab performs no runtime connection.",
      status: "Design proposal",
      tone: "limited",
      details: [
        "Task surfaces keep separate labels, state, and selected context.",
        "No tunnel, global MCP registration, login item, or update channel is enabled.",
      ],
    },
    {
      name: "Hosts",
      title: "Leave native hosts untouched",
      copy: "Codex and Agent integrations require their own live proof. They remain unavailable instead of being inferred from configuration.",
      status: "Not configured",
      tone: "blocked",
      details: [
        "Native Codex task creation is not represented as ready.",
        "Native Agent creation and a real Consult are not represented as ready.",
      ],
    },
    {
      name: "Verify",
      title: "Know what the prototype proves",
      copy: "Navigation, fixture states, compact layout, dialogs, and keyboard paths work in this lab. Live providers, native views, and filesystem access remain separate gates.",
      status: "Prototype verified locally",
      tone: "available",
      details: [
        "Proved here: DOM interaction, visible states, layout, and focus behavior.",
        "Not proved: WebContentsView stacking, production IPC, native menu parity, or live capability readiness.",
      ],
    },
  ];

  const query = new URLSearchParams(window.location.search);
  let direction = directions.has(query.get("direction"))
    ? query.get("direction")
    : "beacon";
  let section = sections.includes(query.get("section"))
    ? query.get("section")
    : "browser";
  let selectedTaskId = tasks.some((task) => task.id === query.get("task"))
    ? query.get("task")
    : "atlantic";
  let currentState = states.has(query.get("state"))
    ? query.get("state")
    : tasks.find((task) => task.id === selectedTaskId).state;
  let setupIndex = 0;
  let setupReturnFocus = null;
  let commandReturnFocus = null;
  let toastTimer = 0;
  let activeSettingsCategory = "General";
  let activeActivityFilter = "all";

  const required = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`LAB_ELEMENT_MISSING:${selector}`);
    return element;
  };

  const escapeMarkup = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const selectedTask = () =>
    tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];

  function stateForTask(task) {
    return task.id === selectedTaskId ? currentState : task.state;
  }

  function showToast(message) {
    const toast = required("#toast");
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(
      () => toast.classList.remove("is-visible"),
      2600,
    );
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    required("#toast").classList.remove("is-visible");
  }

  function restoreFocus(target) {
    requestAnimationFrame(() => {
      target?.focus({ preventScroll: true });
      window.setTimeout(() => target?.focus({ preventScroll: true }), 0);
    });
  }

  function renderTabs() {
    const tabs = required("#task-tabs");
    tabs.replaceChildren(
      ...tasks.map((task) => {
        const taskState = stateForTask(task);
        const button = document.createElement("button");
        button.type = "button";
        button.className = `task-tab${task.id === selectedTaskId ? " is-selected" : ""}`;
        button.dataset.taskId = task.id;
        button.dataset.state = taskState;
        button.setAttribute("role", "tab");
        button.setAttribute(
          "aria-selected",
          String(task.id === selectedTaskId),
        );
        button.setAttribute(
          "tabindex",
          task.id === selectedTaskId ? "0" : "-1",
        );
        button.innerHTML = `<strong>${escapeMarkup(task.label)}</strong><small><i></i>${escapeMarkup(stateCopy[taskState].label)}</small>`;
        button.addEventListener("click", () => selectTask(task.id, true));
        button.addEventListener("keydown", (event) => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const index = tasks.findIndex(
            (candidate) => candidate.id === task.id,
          );
          const delta = event.key === "ArrowRight" ? 1 : -1;
          const next = tasks[(index + delta + tasks.length) % tasks.length];
          selectTask(next.id, true);
          requestAnimationFrame(() =>
            document.querySelector(`[data-task-id="${next.id}"]`)?.focus(),
          );
        });
        return button;
      }),
    );
    requestAnimationFrame(() =>
      tabs
        .querySelector(`[data-task-id="${selectedTaskId}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  }

  function renderBrowser() {
    const task = selectedTask();
    const copy = stateCopy[currentState];
    required("#browser-title").textContent = task.label;
    required("#browser-lede").textContent = task.lede;
    required("#task-run-id").textContent = task.runId;
    const state = required("#browser-state");
    state.dataset.state = currentState;
    required("#state-title").textContent = copy.title;
    required("#state-detail").textContent = copy.detail;
    required("#inspector-state").textContent = copy.label;
    required("#inspector-state").dataset.state = currentState;
    required("#inspector-title").textContent = task.label;
    required("#inspector-copy").textContent = copy.inspector;
    required("#computer-fact").textContent = copy.computer;
    required("#primary-label").textContent = copy.primary;
    const fixture = required("#fixture-button");
    fixture.querySelector("span:nth-child(2)").textContent = copy.label;
    const dot = fixture.querySelector(".state-dot");
    dot.className = `state-dot ${currentState}`;
    required("#fixture-menu")
      .querySelectorAll("[data-state]")
      .forEach((button) =>
        button.classList.toggle(
          "is-selected",
          button.dataset.state === currentState,
        ),
      );
    required("#task-menu-label").textContent = task.label;
    required("#task-menu-computer").disabled = currentState !== "waiting";
  }

  function renderComputer() {
    const waiting = currentState === "waiting";
    const status = required("[data-panel='computer'] .status-label");
    status.className = `status-label ${waiting ? "attention" : currentState}`;
    status.innerHTML = `<i></i>${escapeMarkup(waiting ? "Approval required" : stateCopy[currentState].label)}`;
    required("#allow-request").disabled = !waiting;
    required("#decline-request").disabled = !waiting;
  }

  function renderRuntime() {
    const offline = currentState === "unavailable";
    const status = required("#runtime-status");
    status.classList.toggle("is-offline", offline);
    required("#runtime-status-label").textContent = offline
      ? "Local runtime offline"
      : "Local runtime ready";
    const readiness = required("#runtime-readiness");
    readiness.classList.toggle("is-offline", offline);
    required("#runtime-readiness-label").textContent = offline
      ? "Offline"
      : "Ready";
  }

  function applyActivityFilter() {
    document.querySelectorAll(".filter-group button").forEach((button) => {
      const selected = button.dataset.filter === activeActivityFilter;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll("#timeline li").forEach((item) => {
      const visible =
        activeActivityFilter === "all" ||
        (activeActivityFilter === "attention" &&
          ["attention", "failed"].includes(item.dataset.tone)) ||
        (activeActivityFilter === "complete" &&
          item.dataset.tone === "complete");
      item.hidden = !visible;
    });
  }

  function renderTimeline() {
    const first = required("#timeline li");
    const copy = stateCopy[currentState];
    first.dataset.tone = ["failed", "unavailable"].includes(currentState)
      ? "failed"
      : ["complete", "running"].includes(currentState)
        ? currentState
        : "attention";
    first.querySelector("strong").textContent = copy.title;
    first.querySelector("p").textContent =
      `${selectedTask().label}: ${copy.detail}`;
    first.querySelector(".event-state").textContent = copy.label;
    applyActivityFilter();
  }

  function renderSettings() {
    document.querySelectorAll(".settings-nav button").forEach((button) => {
      const selected = button.textContent.trim() === activeSettingsCategory;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll(".settings-group").forEach((group) => {
      const categories = (group.dataset.setting ?? "General").split(" ");
      group.hidden = !categories.includes(activeSettingsCategory);
    });
  }

  function render() {
    document.documentElement.dataset.direction = direction;
    document.documentElement.dataset.state = currentState;
    document.documentElement.dataset.section = section;
    document.querySelectorAll(".nav-item").forEach((button) => {
      const active = button.dataset.section === section;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.querySelectorAll(".workspace-panel").forEach((panel) => {
      const active = panel.dataset.panel === section;
      panel.classList.toggle("is-active", active);
      panel.toggleAttribute("hidden", !active);
    });
    required("#section-name").textContent =
      section.charAt(0).toUpperCase() + section.slice(1);
    renderTabs();
    renderBrowser();
    renderComputer();
    renderRuntime();
    renderTimeline();
    renderSettings();
  }

  function selectTask(taskId, moveToBrowser = false) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    selectedTaskId = task.id;
    currentState = task.state;
    if (moveToBrowser) section = "browser";
    render();
  }

  function selectSection(nextSection, moveFocus = false) {
    if (!sections.includes(nextSection)) return;
    section = nextSection;
    render();
    if (moveFocus) required("#main-content").focus();
  }

  function setState(nextState) {
    if (!states.has(nextState)) return;
    hideToast();
    currentState = nextState;
    render();
  }

  function setDirection(nextDirection) {
    if (!directions.has(nextDirection)) return;
    direction = nextDirection;
    render();
  }

  function actOnPrimary() {
    if (currentState === "waiting") {
      selectSection("computer", true);
      return;
    }
    if (["running", "failed", "unknown"].includes(currentState)) {
      selectSection("activity", true);
      return;
    }
    if (currentState === "unavailable") {
      selectSection("settings", true);
      return;
    }
    showToast("The synthetic final result is retained with this task.");
  }

  function closeTaskMenu() {
    const menu = required("#task-menu");
    if (menu.matches(":popover-open")) menu.hidePopover();
  }

  function renderSetup() {
    const step = setupSteps[setupIndex];
    required("#setup-progress").innerHTML = setupSteps
      .map(
        (candidate, index) =>
          `<li class="${index < setupIndex ? "is-complete" : index === setupIndex ? "is-current" : ""}"${index === setupIndex ? ' aria-current="step"' : ""}><span>${index + 1}</span><b>${escapeMarkup(candidate.name)}</b></li>`,
      )
      .join("");
    required("#setup-context").textContent = step.name;
    required("#setup-title").textContent = step.title;
    required("#setup-copy").textContent = step.copy;
    const status = required("#setup-status");
    status.className = `setup-status is-${step.tone}`;
    status.querySelector("strong").textContent = step.status;
    required("#setup-details").className = "setup-details";
    required("#setup-details").innerHTML = step.details
      .map((detail) => `<li>${escapeMarkup(detail)}</li>`)
      .join("");
    required("#setup-counter").textContent =
      `Step ${setupIndex + 1} of ${setupSteps.length}`;
    required("#setup-back").disabled = setupIndex === 0;
    required("#setup-next").textContent =
      setupIndex === setupSteps.length - 1 ? "Open Browser" : "Continue";
  }

  function openSetup(trigger = document.activeElement) {
    const dialog = required("#setup-dialog");
    setupReturnFocus =
      trigger instanceof HTMLElement ? trigger : required("#review-setup");
    setupIndex = 0;
    renderSetup();
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => required("#setup-next").focus());
  }

  function closeSetup() {
    const dialog = required("#setup-dialog");
    if (dialog.open) dialog.close();
    const target = setupReturnFocus;
    setupReturnFocus = null;
    restoreFocus(target);
  }

  const commandItems = () => [
    ...sections.map((item, index) => ({
      id: `section:${item}`,
      label: item.charAt(0).toUpperCase() + item.slice(1),
      meta: `Section · ⌘${index + 1}`,
      kind: "section",
      value: item,
    })),
    ...tasks.map((task) => ({
      id: `task:${task.id}`,
      label: task.label,
      meta: `Task · ${stateCopy[stateForTask(task)].label}`,
      kind: "task",
      value: task.id,
    })),
  ];

  function renderCommands(filter = "") {
    const normalized = filter.trim().toLocaleLowerCase();
    const items = commandItems().filter((item) =>
      `${item.label} ${item.meta}`.toLocaleLowerCase().includes(normalized),
    );
    const results = required("#command-results");
    results.replaceChildren(
      ...items.map((item, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.commandId = item.id;
        button.classList.toggle("is-selected", index === 0);
        button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${item.kind === "section" ? '<rect x="3" y="3" width="14" height="14" rx="2" /><path d="M7 3v14" />' : '<path d="M4 5h12v10H4zM7 8h6M7 11h4" />'}</svg><span>${escapeMarkup(item.label)}</span><small>${escapeMarkup(item.meta)}</small>`;
        button.addEventListener("click", () => executeCommand(item));
        return button;
      }),
    );
  }

  function executeCommand(item) {
    if (item.kind === "section") selectSection(item.value, true);
    else selectTask(item.value, true);
    closeCommands();
  }

  function openCommands(trigger = document.activeElement) {
    const dialog = required("#command-dialog");
    commandReturnFocus =
      trigger instanceof HTMLElement ? trigger : required("#command-button");
    const input = required("#command-search");
    input.value = "";
    renderCommands();
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => input.focus());
  }

  function closeCommands() {
    const dialog = required("#command-dialog");
    if (dialog.open) dialog.close();
    const target = commandReturnFocus;
    commandReturnFocus = null;
    restoreFocus(target);
  }

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () =>
      selectSection(button.dataset.section, true),
    );
  });

  document.querySelectorAll("#fixture-menu [data-state]").forEach((button) => {
    button.addEventListener("click", () => {
      setState(button.dataset.state);
      required("#fixture-menu").hidePopover();
      required("#fixture-button").focus();
    });
  });

  required("#task-menu-activity").addEventListener("click", () => {
    closeTaskMenu();
    selectSection("activity", true);
  });
  required("#task-menu-computer").addEventListener("click", () => {
    if (currentState !== "waiting") return;
    closeTaskMenu();
    selectSection("computer", true);
  });
  required("#task-menu-setup").addEventListener("click", () => {
    closeTaskMenu();
    openSetup(required("#task-menu-button"));
  });

  required("#primary-action").addEventListener("click", actOnPrimary);
  required("#view-activity").addEventListener("click", () =>
    selectSection("activity", true),
  );
  required("#allow-request").addEventListener("click", () => {
    setState("running");
    selectSection("browser", true);
    showToast("Fixture approval recorded once. The task is running.");
  });
  required("#decline-request").addEventListener("click", () => {
    setState("failed");
    selectSection("activity", true);
    showToast("Fixture request declined. No Computer action ran.");
  });
  required("#review-setup").addEventListener("click", (event) =>
    openSetup(event.currentTarget),
  );
  required("#setup-close").addEventListener("click", closeSetup);
  required("#setup-back").addEventListener("click", () => {
    setupIndex = Math.max(0, setupIndex - 1);
    renderSetup();
    required("#setup-next").focus();
  });
  required("#setup-next").addEventListener("click", () => {
    if (setupIndex === setupSteps.length - 1) {
      closeSetup();
      selectSection("browser", true);
      return;
    }
    setupIndex += 1;
    renderSetup();
    required("#setup-next").focus();
  });
  required("#setup-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSetup();
  });

  required("#command-button").addEventListener("click", (event) =>
    openCommands(event.currentTarget),
  );
  required("#command-search").addEventListener("input", (event) =>
    renderCommands(event.target.value),
  );
  required("#command-search").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    required("#command-results button")?.click();
  });
  required("#command-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCommands();
  });

  document.querySelectorAll(".filter-group button").forEach((button) => {
    button.addEventListener("click", () => {
      activeActivityFilter = button.dataset.filter;
      applyActivityFilter();
    });
  });

  document.querySelectorAll(".settings-nav button").forEach((button) => {
    button.addEventListener("click", () => {
      activeSettingsCategory = button.textContent.trim();
      renderSettings();
    });
  });

  window.addEventListener("keydown", (event) => {
    if (event.metaKey && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      if (!required("#command-dialog").open) openCommands();
      return;
    }
    if (required("#setup-dialog").open || required("#command-dialog").open)
      return;
    if (event.metaKey && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      selectSection(sections[Number(event.key) - 1], true);
      return;
    }
    if (event.ctrlKey && event.key === "Tab") {
      event.preventDefault();
      const index = tasks.findIndex((task) => task.id === selectedTaskId);
      const delta = event.shiftKey ? -1 : 1;
      selectTask(tasks[(index + delta + tasks.length) % tasks.length].id, true);
    }
  });

  window.farolLab = Object.freeze({
    setDirection,
    setSection: selectSection,
    setState,
    setTask: selectTask,
    openSetup,
    openCommands,
    snapshot: () => ({
      direction,
      section,
      selectedTaskId,
      state: currentState,
    }),
  });

  render();
  document.documentElement.dataset.ready = "true";
})();
