import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Shell } from "../../src/ui/renderer/shell";
import { Services } from "../../src/ui/renderer/services";
import { WindowController } from "../../src/ui/renderer/controller";
import { bootstrap, fixture, task, settings, deferred } from "./fixture";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// DOM-only modal fixture. Real Chromium/native stacking remains a separate gate.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
  this.querySelector<HTMLElement>("input,button")?.focus();
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
});
async function mount(data = bootstrap()) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue(data);
  const c = new WindowController(f.api);
  await c.start();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StrictMode>
        <Services value={c}>
          <Shell />
        </Services>
      </StrictMode>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    c.dispose();
  });
  return { f, c, host };
}
function button(host: Element, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      (button.getAttribute("aria-label") ?? button.textContent)?.trim() ===
      label,
  );
  if (!found) throw new Error(`BUTTON_MISSING:${label}`);
  return found;
}
function agentTask(id = "task-1") {
  return {
    ...task(id),
    label: "Review project",
    agent: {
      phase: "running",
      workspaceId: "approved",
      parentDelivery: "not_applicable",
      workspaceEnforcement: "verified",
      resultAvailable: false,
    },
  };
}
it.each([
  ["Home", "click"],
  ["Home", "Enter"],
  ["Folders", "click"],
  ["Folders", "Enter"],
] as const)(
  "R34 current %s search selection by %s closes and restores focus",
  async (label, input) => {
    const { host, c, f } = await mount();
    if (label === "Folders")
      await act(async () => c.navigate({ area: "settings", page: "folders" }));
    const before = c.getSnapshot();
    const trigger = button(host, "Find a page");
    trigger.focus();
    await act(async () => trigger.click());
    if (input === "click") {
      await act(async () =>
        button(host.querySelector("dialog")!, label).click(),
      );
    } else {
      const field = host.querySelector<HTMLInputElement>("dialog input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(field, label);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        field.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    }
    expect(host.querySelector("dialog")).toBeNull();
    expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(c.getSnapshot().destination).toEqual(before.destination);
    expect(c.getSnapshot().back).toBe(before.back);
    expect(c.getSnapshot().forward).toBe(before.forward);
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
  },
);
it("Home retains the approved rail and context sidebar and compact overlays keep the existing host layout reporting", async () => {
  const { host, c, f } = await mount();
  expect(host.querySelectorAll(".sidebar")).toHaveLength(1);
  expect(host.querySelectorAll(".rail")).toHaveLength(1);
  expect(
    host.querySelector(".rail button:first-child")?.getAttribute("aria-label"),
  ).toBe("Home");
  expect(
    host.querySelector(".rail button:last-child")?.getAttribute("aria-label"),
  ).toBe("Settings");
  expect(host.querySelector(".contextual-sidebar")).not.toBeNull();
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
  await act(async () => c.toggleSidebar(false));
  expect(host.querySelector(".contextual-sidebar")).toBeNull();
  expect(host.querySelector(".sidebar-scrim")).toBeNull();
  await act(async () => c.toggleSidebar(true));
  expect(host.querySelector(".sidebar-scrim")).not.toBeNull();
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
  expect(f.api.layout).toHaveBeenLastCalledWith(
    "activity",
    "",
    false,
    false,
    "overlay",
    "sidebar",
    180,
  );
  await act(async () => button(host, "Close sidebar").click());
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
  await act(async () => c.navigate({ area: "chatgpt" }));
  await act(async () => c.toggleSidebar(true));
  expect(f.api.layout).toHaveBeenLastCalledWith(
    "browser",
    "",
    false,
    false,
    "overlay",
    "sidebar",
    180,
  );
  await act(async () =>
    host.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(host.querySelector(".sidebar-scrim")).toBeNull();
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
});
it("resizes the page list with keyboard bounds and remembers its width only in this window", async () => {
  const { host, c, f } = await mount();
  const divider = host.querySelector<HTMLElement>('[role="separator"]')!;
  const key = async (value: string) =>
    act(async () => {
      divider.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  expect(divider.getAttribute("aria-valuenow")).toBe("180");
  await key("ArrowRight");
  expect(c.getSnapshot().sidebarWidth).toBe(188);
  expect(
    host
      .querySelector<HTMLElement>(".desktop")!
      .style.getPropertyValue("--side-width"),
  ).toBe("188px");
  expect(f.api.layout).toHaveBeenLastCalledWith(
    "activity",
    "",
    false,
    false,
    "full",
    "none",
    188,
  );
  await key("End");
  await key("ArrowRight");
  expect(c.getSnapshot().sidebarWidth).toBe(288);
  await key("Home");
  await key("ArrowLeft");
  expect(c.getSnapshot().sidebarWidth).toBe(152);
  await act(async () => c.toggleSidebar(false));
  expect(host.querySelector('[role="separator"]')).toBeNull();
  await act(async () => c.toggleSidebar(false));
  expect(
    host.querySelector('[role="separator"]')?.getAttribute("aria-valuenow"),
  ).toBe("152");
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});

it.each([
  "pointerup",
  "pointercancel",
  "lostpointercapture",
  "blur",
  "collapse",
  "escape",
  "native-escape",
])(
  "hides native browser input during resizing and releases it after %s",
  async (ending) => {
    const { host, c, f } = await mount();
    await act(async () => c.navigate({ area: "chatgpt" }));
    const divider = host.querySelector<HTMLElement>('[role="separator"]')!;
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    const pointer = async (type: string, x: number) =>
      act(async () => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: x,
        });
        Object.defineProperty(event, "pointerId", { value: 1 });
        divider.dispatchEvent(event);
      });
    await pointer("pointerdown", 235);
    expect(c.getSnapshot().sidebarResizing).toBe(true);
    expect(f.api.layout).toHaveBeenLastCalledWith(
      "browser",
      "",
      false,
      false,
      "full",
      "sidebar",
      180,
    );
    await pointer("pointermove", 275);
    expect(c.getSnapshot().sidebarWidth).toBe(220);
    if (ending === "blur")
      await act(async () => window.dispatchEvent(new Event("blur")));
    else if (ending === "native-escape")
      await act(async () =>
        f.emit("action", {
          action: "close-overlay",
          source: "overlay-dismissed",
          eventId: "11111111-1111-4111-8111-111111111177",
          authWindowGeneration: null,
        }),
      );
    else if (ending === "escape")
      await act(async () =>
        divider.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
      );
    else if (ending === "collapse")
      await act(async () => c.toggleSidebar(false));
    else await pointer(ending, 275);
    expect(c.getSnapshot().sidebarResizing).toBe(false);
    const cancelled = ending === "escape" || ending === "native-escape";
    expect(c.getSnapshot().sidebarWidth).toBe(cancelled ? 180 : 220);
    expect(f.api.layout).toHaveBeenLastCalledWith(
      "browser",
      "",
      false,
      false,
      ending === "collapse" ? "rail" : "full",
      "none",
      cancelled ? 180 : 220,
    );
    // A still-held pointer cannot restart a drag cancelled by the native action.
    if (cancelled) {
      await act(async () =>
        divider.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
      );
      expect(c.getSnapshot().sidebarResizing).toBe(false);
      await pointer("pointermove", 290);
      expect(c.getSnapshot().sidebarResizing).toBe(false);
      expect(c.getSnapshot().sidebarWidth).toBe(188);
    }
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
  },
);

it.each(["Setup", "Home", "Back"] as const)(
  "narrow page-list navigation to %s closes the scrim and restores page input",
  async (label) => {
    const { host, c, f } = await mount();
    const originalWidth = window.innerWidth;
    try {
      await act(async () => {
        window.innerWidth = 758;
        window.dispatchEvent(new Event("resize"));
        if (label === "Back") c.navigate({ area: "settings", page: "folders" });
      });
      await act(async () => button(host, "Toggle sidebar").click());
      expect(host.querySelector(".sidebar-overlay")).not.toBeNull();
      expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
      const before = c.getSnapshot();
      await act(async () => button(host, label).click());
      expect(host.querySelector(".sidebar-overlay")).toBeNull();
      expect(host.querySelector(".sidebar-scrim")).toBeNull();
      expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
      expect(c.getSnapshot().sidebar).toBe("rail");
      expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(4, 6)).toEqual([
        "rail",
        "none",
      ]);
      if (label === "Home") {
        expect(c.getSnapshot().back).toBe(before.back);
        expect(c.getSnapshot().destination).toEqual(before.destination);
      }
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        window.innerWidth = originalWidth;
        window.dispatchEvent(new Event("resize"));
      });
    }
  },
);

it("automatically uses the rail at narrow widths and opens a bounded page-list overlay", async () => {
  const { host, c, f } = await mount();
  const originalWidth = window.innerWidth;
  try {
    await act(async () => {
      window.innerWidth = 979;
      window.dispatchEvent(new Event("resize"));
    });
    expect(host.querySelector(".contextual-sidebar")).toBeNull();
    expect(button(host, "Toggle sidebar").getAttribute("aria-expanded")).toBe(
      "false",
    );
    await act(async () => button(host, "Toggle sidebar").click());
    expect(host.querySelector(".sidebar-overlay")).not.toBeNull();
    expect(f.api.layout).toHaveBeenLastCalledWith(
      "activity",
      "",
      false,
      false,
      "overlay",
      "sidebar",
      180,
    );
    await act(async () => button(host, "Close sidebar").click());
    await act(async () => {
      window.innerWidth = 1180;
      window.dispatchEvent(new Event("resize"));
    });
    // Explicit dismissal preserves the user's collapsed preference when wider.
    expect(host.querySelector(".contextual-sidebar")).toBeNull();
    await act(async () => button(host, "Toggle sidebar").click());
    expect(c.getSnapshot().sidebar).toBe("full");
    expect(host.querySelector(".contextual-sidebar")).not.toBeNull();
  } finally {
    await act(async () => {
      window.innerWidth = originalWidth;
      window.dispatchEvent(new Event("resize"));
    });
  }
});

it("R36 R39 new profile opens Home without a legacy modal and has one leaf toolbar", async () => {
  const { host, f } = await mount();
  expect(host.querySelector(".toolbar-title")?.textContent).toBe("Home");
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.textContent).toContain("Setup needed");
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  await act(async () => button(host, "Settings").click());
  expect(host.querySelector(".toolbar-title")?.textContent).toContain(
    "Appearance",
  );
});
it("R34 search dismisses, restores focus and uses real navigation", async () => {
  const { host, c } = await mount();
  const trigger = button(host, "Find a page");
  trigger.focus();
  await act(async () => trigger.click());
  expect(c.getSnapshot().overlay).toBe("search");
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
  await act(async () => button(host, "Appearance").click());
  expect(c.getSnapshot().destination.page).toBe("appearance");
  expect(host.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => button(host, "Back").click());
  expect(c.getSnapshot().destination.area).toBe("home");
});
it("R25 R26 R29 task input/caret/composition survive unchanged host layout", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("tasks", { revision: 1, tasks: [task()] });
    c.navigate({ area: "chatgpt", taskId: "task-1" });
    c.overlay("task");
  });
  const input = host.querySelector<HTMLTextAreaElement>("#agent-objective")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "folder inventory");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.focus();
  input.setSelectionRange(6, 6);
  input.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  await act(async () =>
    f.emit("layout", {
      section: "browser",
      taskId: "task-1",
      setupOpen: false,
      sidebar: "full",
      overlay: "none",
    }),
  );
  expect(host.querySelector("#agent-objective")).toBe(input);
  expect(input.value).toBe("folder inventory");
  expect(button(host, "Run Agent").disabled).toBe(true);
  expect(input.selectionStart).toBe(6);
  expect(c.getSnapshot().overlay).toBe("task");
  expect(f.api.task).not.toHaveBeenCalled();
});
it("R05 renders hostile labels as text and stable task identity survives reorder", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("tasks", {
      revision: 1,
      tasks: [
        { ...agentTask(), label: "<script>owned()</script>" },
        agentTask("task-2"),
      ],
    });
    c.navigate({ area: "chatgpt" });
  });
  expect(host.querySelector("script")).toBeNull();
  const row = host.querySelector(".contextual-sidebar button");
  await act(async () =>
    f.emit("tasks", {
      revision: 2,
      tasks: [
        agentTask("task-2"),
        { ...agentTask(), label: "<script>owned()</script>" },
      ],
    }),
  );
  expect([...host.querySelectorAll(".contextual-sidebar button")]).toContain(
    row,
  );
});
it("R24 refused/unavailable update remains honest and review is dismissible", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", {
      phase: "ready",
      version: "1.0",
      deferred: false,
      blockedBy: "WORK_PENDING",
    });
    c.overlay("update");
  });
  expect(button(host, "Restart & Update").disabled).toBe(true);
  expect(host.textContent).toContain("WORK_PENDING");
  await act(async () => button(host, "Close").click());
  expect(c.getSnapshot().overlay).toBe("none");
});

it("R31 R36 Home destinations and sidebar work actions use the facade", async () => {
  const { host, c, f } = await mount();
  for (const [label, page] of [
    ["Manage connection", "connection"],
    ["Review access", "computer"],
    ["Manage folders", "folders"],
  ] as const) {
    await act(async () => button(host, label).click());
    expect(c.getSnapshot().destination.page).toBe(page);
    await act(async () => c.navigate({ area: "home" }));
  }
  await act(async () => button(host, "View all").click());
  expect(c.getSnapshot().destination.area).toBe("activity");
  await act(async () => button(host, "New chat").click());
  expect(f.api.task).toHaveBeenCalledWith({ kind: "task.create-chatgpt" });
  await act(async () => {
    c.navigate({ area: "home" });
    f.emit("tasks", { revision: 1, tasks: [agentTask()] });
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".work-row")!.click(),
  );
  expect(f.api.task).toHaveBeenCalledWith({
    kind: "task.activate",
    taskId: "task-1",
  });
  await act(async () => button(host, "Chat options").click());
  expect(c.getSnapshot().overlay).toBe("task");
  await act(async () => button(host, "Close").click());
  expect(c.getSnapshot().overlay).toBe("none");
});
it("R05 R32 R34 activity inspection displays only metadata and returns to exact chat", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("tasks", { revision: 1, tasks: [task()] });
    f.emit("event", {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: 100,
      kind: "turn.terminal",
      phase: "outcome_unknown",
      code: "UNKNOWN",
    });
    c.navigate({ area: "activity" });
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".activity-row")!.click(),
  );
  expect(host.querySelector("dialog")?.textContent).toContain("Not recorded");
  await act(async () => button(host, "View chat").click());
  expect(c.getSnapshot().destination.taskId).toBe("task-1");
  await act(async () => c.navigate({ area: "activity" }));
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".activity-row")!.click(),
  );
  await act(async () => button(host, "Close").click());
  expect(c.getSnapshot().overlay).toBe("none");
});
it("R16 R23 R24 distinct update controls preserve exact operations and pending fence", async () => {
  const { host, c, f } = await mount();
  await act(async () => c.overlay("update"));
  await act(async () => button(host, "Check for Updates").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "check" });
  const ready = {
    phase: "ready",
    version: "1.0",
    deferred: false,
    blockedBy: null,
  };
  await act(async () => f.emit("update", ready));
  await act(async () => button(host, "Restart & Update").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "restart" });
  await act(async () => {
    f.emit("update", ready);
    c.overlay("update");
  });
  await act(async () => button(host, "Remind Me Later").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "later" });
  expect(c.getSnapshot().overlay).toBe("none");
  await act(async () => {
    f.emit("update", { phase: "recovery", version: "1.0", blockedBy: null });
    c.overlay("update");
  });
  await act(async () => button(host, "Recover").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "recover" });
  await act(async () =>
    f.emit("update", {
      phase: "idle",
      checkedAt: null,
      rollbackVersion: "0.9",
    }),
  );
  await act(async () => button(host, "Roll Back").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "rollback" });
});
it("R13 R14 R23 disconnected and incompatible displays retain inspection and classified feedback", async () => {
  const { host, c, f } = await mount();
  await act(async () =>
    f.emit("runtime", {
      state: "offline",
      error: null,
      identity: null,
      embeddedNode: null,
      embeddedElectron: null,
    }),
  );
  expect(host.textContent).toContain("State is stale");
  await act(async () => button(host, "Refresh state").click());
  expect(c.getSnapshot().status).toBe("current");
  await act(async () => {
    f.emit("tasks", { revision: 1, tasks: [task()] });
    c.navigate({ area: "chatgpt", taskId: "task-1" });
  });
  await act(async () => button(host, "Sign in").click());
  expect(f.api.configure).toHaveBeenCalledWith({
    kind: "chatgpt.open-sign-in",
  });
  await act(async () => button(host, "Open ChatGPT").click());
  expect(f.api.configure).toHaveBeenCalledWith({
    kind: "chatgpt.open-browser",
  });
});
it("R16 R25 R27 R28 task actions and assignment scope survive panels without restoring old authority", async () => {
  const { host, c, f } = await mount();
  const data = bootstrap();
  data.configuration.settings.computer.workspaces = [
    {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      label: "Project",
      root: "/approved/project",
      access: "read",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
    },
  ];
  vi.mocked(f.api.bootstrap).mockResolvedValue(data);
  await act(async () => {
    await c.refresh();
    f.emit("tasks", {
      revision: 1,
      tasks: [{ ...task(), lifecycle: "running" }],
    });
    c.navigate({ area: "chatgpt", taskId: "task-1" });
    c.overlay("task");
  });
  const edit = async (selector: string, value: string, event = "input") =>
    act(async () => {
      const input = host.querySelector<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(selector)!;
      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : input instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event(event, { bubbles: true }));
    });
  await edit("#task-label", "Renamed");
  for (const label of ["Rename", "Pin", "Cancel work", "Close chat"])
    await act(async () => button(host, label).click());
  expect(f.api.task).toHaveBeenCalledWith({
    kind: "task.rename",
    taskId: "task-1",
    label: "Renamed",
  });
  expect(f.api.task).toHaveBeenCalledWith({
    kind: "task.cancel",
    taskId: "task-1",
  });
  await edit("#agent-objective", "Inventory the source files");
  await edit("#agent-scope", "subtree", "change");
  await edit("#agent-subtree", "../outside");
  await edit("#agent-exclusions", "private");
  await act(async () => button(host, "Run Agent").click());
  expect(host.textContent).toContain("Review the relative paths");
  await edit("#agent-subtree", "src");
  await act(async () => button(host, "Run Agent").click());
  expect(f.api.task).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "task.start-agent",
      scope: {
        mode: "subtree",
        relativeRoot: "src",
        excludedPaths: ["private"],
      },
    }),
  );
  await edit("#agent-scope", "exact", "change");
  await edit("#agent-paths", "src/a.ts\nsrc/b.ts");
  await act(async () => button(host, "Run Agent").click());
  expect(f.api.task).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: { mode: "exact", relativePaths: ["src/a.ts", "src/b.ts"] },
    }),
  );
  await act(async () => {
    c.overlay("none");
    c.overlay("task");
  });
  expect(
    host.querySelector<HTMLTextAreaElement>("#agent-objective")?.value,
  ).toBe("Inventory the source files");
  const changed = bootstrap();
  changed.configuration.settings.computer.workspaces =
    data.configuration.settings.computer.workspaces;
  changed.configuration.settings.computer.generation = 2;
  changed.configuration.settings.revision = 2;
  vi.mocked(f.api.bootstrap).mockResolvedValue(changed);
  await act(async () => c.refresh());
  expect(button(host, "Run Agent").disabled).toBe(true);
  await act(async () => button(host, "Review current authority").click());
  expect(button(host, "Run Agent").disabled).toBe(false);
  await edit(
    "#agent-workspace",
    "22222222-2222-4222-8222-222222222222",
    "change",
  );
});
it("R29 R34 Enter navigation prevents browser activation of the restored search trigger", async () => {
  const { host, c } = await mount();
  await act(async () => button(host, "Find a page").click());
  const input = host.querySelector<HTMLInputElement>("dialog input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Folders");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => input.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(true);
  expect(c.getSnapshot().destination.page).toBe("folders");
  expect(c.getSnapshot().overlay).toBe("none");
});

it("R15 browser controls share the same retained intention across pages", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.configure).mockRejectedValue(new Error("reply lost"));
  await act(async () => c.navigate({ area: "chatgpt" }));
  await act(async () => button(host, "Open ChatGPT").click());
  expect(c.getSnapshot().intents["settings:chatgpt.open-browser:"]?.state).toBe(
    "unknown",
  );
  await act(async () => c.navigate({ area: "settings", page: "connection" }));
  expect(button(host, "Open ChatGPT").disabled).toBe(true);
  await act(async () => c.navigate({ area: "chatgpt" }));
  await act(async () => button(host, "Open ChatGPT").click());
  expect(f.api.configure).toHaveBeenCalledTimes(1);
});
it("R24 checking and rollback controls follow recovery and drain eligibility", async () => {
  const { host, c, f } = await mount();
  for (const update of [
    { phase: "unavailable", code: "NOT_INSTALLED" },
    { phase: "ready", version: "1.0", deferred: false, blockedBy: null },
    {
      phase: "failed",
      code: "RECOVERY",
      recoveryRequired: true,
    },
  ]) {
    await act(async () => {
      f.emit("update", update);
      c.overlay("update");
    });
    expect(button(host, "Check for Updates").disabled).toBe(true);
  }
  expect(host.textContent).not.toContain("Roll Back");
  await act(async () =>
    f.emit("update", {
      phase: "idle",
      checkedAt: null,
      rollbackVersion: "0.9",
      blockedBy: "WORK_PENDING",
    }),
  );
  expect(button(host, "Roll Back").disabled).toBe(true);
  expect(f.api.installedUpdate).not.toHaveBeenCalledWith({ kind: "rollback" });
});

const buildId = "3".repeat(64);
const runtimeGeneration = "a".repeat(64);
const workspaceId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-10-02T20:00:00.000Z";
function homeComputerSettings() {
  const value = settings();
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
      accessCheck: {
        buildId,
        computerGeneration: 1,
        verifiedAt: timestamp,
        rootIdentity: { device: "1", inode: "2" },
      },
    },
  ];
  const witness = {
    profile: "farol-next",
    configRevision: 1,
    workspaceId,
    runtimeGeneration,
    buildId,
    protocol: "secure-mcp",
    verifiedAt: timestamp,
  };
  value.setup.computer.verified = witness;
  value.setup.connect.verified = witness;
  value.connectors.secureMcp = {
    ...value.connectors.secureMcp,
    tunnelId: "owner-tunnel",
    credential: "stored",
    tunnelClient: {
      executablePath: "/approved/tunnel",
      executableSha256: "b".repeat(64),
      version: "1.0.0",
      protocol: "openai-tunnel-client/v1",
      verifiedAt: timestamp,
    },
    runtime: {
      state: "ready",
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      observedAt: timestamp,
    },
    challenge: {
      value: "33333333-3333-4333-8333-333333333333",
      challengeSha256: "c".repeat(64),
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      preparedAt: timestamp,
    },
    attachment: {
      tunnelId: "owner-tunnel",
      workspaceId,
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      challengeSha256: "c".repeat(64),
      receiptSha256: "d".repeat(64),
      verifiedAt: timestamp,
    },
  };
  return ProductSettingsSchema.parse(value);
}

it("Home is Computer-ready without embedded login, with no commands on mount or navigation", async () => {
  const data = bootstrap();
  data.configuration.settings = homeComputerSettings();
  const { host, c, f } = await mount(data);
  await act(async () => c.navigate({ area: "home" }));
  expect(host.querySelector(".home-intro h1")?.textContent).toBe(
    "Computer ready",
  );
  expect(
    host.querySelector(".readiness-summary")?.getAttribute("data-ready"),
  ).toBe("true");
  expect(host.querySelector(".readiness")?.textContent).toContain(
    "Embedded ChatGPT · optional",
  );
  expect(host.querySelector(".readiness")?.textContent).toContain(
    "Sign-in check needed",
  );
  for (const page of ["folders", "computer", "connection"] as const) {
    await act(async () => c.navigate({ area: "settings", page }));
    await act(async () => c.navigate({ area: "home" }));
  }
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});
it("Home keeps login readiness separate from external Computer readiness", async () => {
  const data = bootstrap();
  data.configuration.settings.setup.chatgpt.verified =
    homeComputerSettings().setup.computer.verified;
  const { host, c, f } = await mount(data);
  expect(
    host.querySelector(".readiness-summary")?.getAttribute("data-ready"),
  ).toBe("false");
  expect(host.querySelector(".readiness-summary")?.textContent).toContain(
    "Setup needed",
  );
  expect(
    [...host.querySelectorAll(".readiness h3")].find(
      (node) => node.textContent === "Embedded ChatGPT · optional",
    )?.nextElementSibling?.textContent,
  ).toBe("Ready");
  const changed = bootstrap();
  changed.configuration.settings = homeComputerSettings();
  changed.configuration.settings.setup.connect.verified!.runtimeGeneration =
    "e".repeat(64);
  vi.mocked(f.api.bootstrap).mockResolvedValue(changed);
  await act(async () => c.refresh());
  expect(
    host.querySelector(".readiness-summary")?.getAttribute("data-ready"),
  ).toBe("false");
  expect(f.api.configure).not.toHaveBeenCalled();
});

it("opens Setup from the approved rail and context sidebar and retains ordinary navigation and appearance", async () => {
  const { host, c, f } = await mount();
  expect(host.querySelectorAll(".sidebar")).toHaveLength(1);
  expect(host.querySelectorAll(".rail")).toHaveLength(1);
  expect(
    host.querySelector(".rail button:first-child")?.getAttribute("aria-label"),
  ).toBe("Home");
  expect(
    host.querySelector(".rail button:last-child")?.getAttribute("aria-label"),
  ).toBe("Settings");
  await act(async () => button(host, "Setup").click());
  expect(c.getSnapshot().destination).toMatchObject({
    area: "settings",
    page: "general",
  });
  expect(host.querySelector(".toolbar-title strong")?.textContent).toBe(
    "Setup",
  );
  expect(host.querySelector('[aria-label="Setup overview"]')).not.toBeNull();
  await act(async () => button(host, "Folders").click());
  expect(host.querySelector(".toolbar-title")?.textContent).toContain(
    "Setup /Folders",
  );
  await act(async () => button(host, "Settings").click());
  expect(c.getSnapshot().destination.page).toBe("appearance");
  expect(host.querySelector('[aria-label="Settings pages"]')).not.toBeNull();
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});
it("does not present foreign ChatGPT windows as Farol work or expose acceptance tools on Home", async () => {
  const { host, c, f } = await mount();
  await act(async () =>
    f.emit("tasks", { revision: 1, tasks: [task(), task("task-2")] }),
  );
  expect(host.querySelector(".work-row")).toBeNull();
  expect(host.textContent).not.toMatch(
    /Task 1|task-1|task-2|Five current|Check account|Read-only file preview|Saved Chat answers/,
  );
  expect(f.api.task).not.toHaveBeenCalled();
  await act(async () => c.navigate({ area: "chatgpt", taskId: "task-1" }));
  expect(host.querySelector(".toolbar-title strong")?.textContent).toBe(
    "ChatGPT",
  );
  expect(host.querySelector('[aria-label="Farol work"]')).toBeNull();
  await act(async () => button(host, "New chat").click());
  expect(f.api.task).toHaveBeenCalledTimes(1);
  expect(f.api.task).toHaveBeenCalledWith({ kind: "task.create-chatgpt" });
});
it.each([
  "MODEL_ENDPOINT_UNAVAILABLE",
  "CHATGPT_SIGN_IN_IN_PROGRESS",
  "TASK_OPERATION_IN_PROGRESS",
  "SUPPORT_EXPORT_CANCELLED",
])("does not broadcast %s across unrelated pages", async (code) => {
  const { host, c, f } = await mount();
  if (code === "TASK_OPERATION_IN_PROGRESS") {
    vi.mocked(f.api.task).mockResolvedValueOnce({
      ok: false,
      error: code,
      state: { revision: 0, tasks: [] },
    });
    await act(async () => c.task({ kind: "task.create-chatgpt" }, "task:new"));
    expect(c.getSnapshot().intents["task:new"]?.code).toBe(code);
  } else {
    vi.mocked(f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: code,
      snapshot: bootstrap().configuration,
    });
    await act(async () =>
      c.configure({ kind: "support.export" }, "settings:support.export:"),
    );
    expect(c.getSnapshot().intents["settings:support.export:"]?.code).toBe(
      code,
    );
  }
  for (const area of ["home", "chatgpt", "activity"] as const) {
    await act(async () => c.navigate({ area }));
    expect(host.querySelector("main")?.textContent).not.toContain(code);
    expect(host.querySelector('main > [role="alert"]')).toBeNull();
  }
  await act(async () => c.navigate({ area: "settings", page: "diagnostics" }));
  expect(
    host.querySelector('[aria-label="Retained actions"]')?.textContent,
  ).toContain(code);
  if (code === "TASK_OPERATION_IN_PROGRESS")
    expect(f.api.task).toHaveBeenCalledTimes(1);
  else expect(f.api.configure).toHaveBeenCalledTimes(1);
});

it.each(["full", "rail", "overlay"] as const)(
  "shows New chat refusal and unknown outcomes outside the %s page list",
  async (width) => {
    const { host, c, f } = await mount();
    if (width !== "full")
      await act(async () => c.toggleSidebar(width === "overlay"));
    vi.mocked(f.api.task).mockResolvedValueOnce({
      ok: false,
      error: "TASK_OPERATION_IN_PROGRESS",
      state: { revision: 0, tasks: [] },
    });
    await act(async () => button(host, "New chat").click());
    expect(
      host.querySelector('dialog [aria-label="New chat result"]')?.textContent,
    ).toContain("Another action is still in progress");
    expect(host.querySelector("dialog")?.closest(".sidebar")).toBeNull();
    await act(async () =>
      button(host.querySelector("dialog")!, "Close").click(),
    );
    expect(
      host.querySelector('.rail [aria-label="Review New chat result"]'),
    ).not.toBeNull();
    vi.mocked(f.api.task).mockRejectedValueOnce(new Error("Create reply lost"));
    await act(async () => button(host, "New chat").click());
    expect(host.querySelector('dialog [role="status"]')?.textContent).toContain(
      "New chat: Outcome unknown",
    );
    expect(button(host, "New chat").disabled).toBe(true);
    await act(async () =>
      button(host.querySelector("dialog")!, "Close").click(),
    );
    await act(async () => c.navigate({ area: "activity" }));
    await act(async () => button(host, "Review New chat result").click());
    expect(host.querySelector('dialog [role="status"]')?.textContent).toContain(
      "New chat: Outcome unknown",
    );
    expect(f.api.task).toHaveBeenCalledTimes(2);
  },
);
it("keeps late New chat failure reviewable without moving the current page or focus", async () => {
  const { host, c, f } = await mount();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValueOnce(waiting.promise);
  await act(async () => button(host, "New chat").click());
  await act(async () => c.navigate({ area: "settings", page: "folders" }));
  await act(async () => waiting.reject(new Error("Late reply lost")));
  expect(c.getSnapshot().destination.page).toBe("folders");
  expect(host.querySelector("dialog")).toBeNull();
  await act(async () => button(host, "Review New chat result").click());
  expect(host.querySelector('dialog [role="status"]')?.textContent).toContain(
    "Outcome unknown",
  );
  await act(async () => button(host, "Inspect action details").click());
  expect(
    host.querySelector('[aria-label="Retained actions"]')?.textContent,
  ).toContain("task:new");
  await act(async () => f.emit("tasks", { revision: 1, tasks: [task()] }));
  await act(async () => c.navigate({ area: "chatgpt", taskId: "task-1" }));
  await act(async () => c.overlay("task"));
  expect(
    host.querySelector('dialog[aria-label="Chat options"]'),
  ).not.toBeNull();
});
it.each(["refused", "unknown"] as const)(
  "dismisses a %s New chat result when action details is already the current page",
  async (outcome) => {
    const { host, c, f } = await mount();
    await act(async () =>
      c.navigate({ area: "settings", page: "diagnostics" }),
    );
    if (outcome === "unknown")
      vi.mocked(f.api.task).mockRejectedValueOnce(
        new Error("Create reply lost"),
      );
    else
      vi.mocked(f.api.task).mockResolvedValueOnce({
        ok: false,
        error: "TASK_OPERATION_IN_PROGRESS",
        state: { revision: 0, tasks: [] },
      });
    await act(async () => button(host, "New chat").click());
    const retained = c.getSnapshot().intents["task:new"];
    for (let visit = 0; visit < 2; visit++) {
      expect(
        host.querySelector('dialog[aria-label="New chat"]'),
      ).not.toBeNull();
      await act(async () => button(host, "Inspect action details").click());
      expect(host.querySelector("dialog")).toBeNull();
      expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
      expect(c.getSnapshot().destination.page).toBe("diagnostics");
      expect(c.getSnapshot().intents["task:new"]).toEqual(retained);
      if (visit === 0)
        await act(async () => button(host, "Review New chat result").click());
    }
    expect(f.api.task).toHaveBeenCalledTimes(1);
    if (outcome === "unknown")
      expect(button(host, "New chat").disabled).toBe(true);
  },
);
it("keeps a pending New chat out of the review overlay so successful navigation completes", async () => {
  const { host, c, f } = await mount();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValueOnce(waiting.promise);
  await act(async () => button(host, "New chat").click());
  expect(button(host, "New chat").getAttribute("aria-busy")).toBe("true");
  expect(
    host.querySelector('[aria-label="Review New chat result"]'),
  ).toBeNull();
  expect(host.querySelector("dialog")).toBeNull();
  await act(async () =>
    waiting.resolve({
      ok: true,
      state: { revision: 1, tasks: [task()] },
      selectedTaskId: "task-1",
    }),
  );
  expect(c.getSnapshot().destination).toMatchObject({
    area: "chatgpt",
    taskId: "task-1",
  });
  expect(host.querySelector("dialog")).toBeNull();
  expect(f.api.task).toHaveBeenCalledTimes(1);
});
it("keeps unknown task work discoverable after its options are dismissed and Home is collapsed", async () => {
  const { host, c, f } = await mount();
  const running = { ...task(), lifecycle: "running" };
  await act(async () => f.emit("tasks", { revision: 1, tasks: [running] }));
  await act(async () => c.navigate({ area: "chatgpt", taskId: "task-1" }));
  await act(async () => button(host, "Chat options").click());
  vi.mocked(f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "TASK_CANCEL_FAILED",
    state: { revision: 1, tasks: [running] },
  });
  await act(async () => button(host, "Cancel work").click());
  expect(
    host.querySelector('[aria-label="Chat action results"]')?.textContent,
  ).toContain("Cancel work: Outcome unknown");
  await act(async () => button(host.querySelector("dialog")!, "Close").click());
  await act(async () => c.navigate({ area: "home" }));
  await act(async () => c.toggleSidebar(false));
  expect(
    host.querySelector('.rail [aria-label="Review unresolved actions"]'),
  ).not.toBeNull();
  await act(async () => button(host, "Review unresolved actions").click());
  expect(
    host.querySelector('[aria-label="Retained actions"]')?.textContent,
  ).toContain("TASK_CANCEL_FAILED");
  expect(f.api.task).toHaveBeenCalledTimes(1);
});
