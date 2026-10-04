import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Shell } from "../../src/ui/renderer/shell";
import { Services } from "../../src/ui/renderer/services";
import { WindowController } from "../../src/ui/renderer/controller";
import { bootstrap, fixture, task } from "./fixture";
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
async function mount() {
  const f = fixture();
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
it("R32 R37 compact sidebar on Home has no hidden scrim or inert content", async () => {
  const { host, c, f } = await mount();
  const homeIsAccessible = () => {
    expect(host.querySelector(".contextual-sidebar")).toBeNull();
    expect(host.querySelector(".sidebar-scrim")).toBeNull();
    expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(f.api.layout).toHaveBeenLastCalledWith(
      "activity",
      "",
      false,
      false,
      "rail",
      "none",
    );
  };
  await act(async () => c.toggleSidebar(true));
  homeIsAccessible();
  await act(async () => c.navigate({ area: "chatgpt" }));
  expect(host.querySelector(".contextual-sidebar")).not.toBeNull();
  expect(host.querySelector(".sidebar-scrim")).not.toBeNull();
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
  await act(async () => c.navigate({ area: "home" }));
  homeIsAccessible();
  await act(async () => c.travel(-1));
  expect(host.querySelector(".sidebar-scrim")).not.toBeNull();
  await act(async () => c.travel(-1));
  homeIsAccessible();
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
    "General",
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
      tasks: [{ ...task(), label: "<script>owned()</script>" }, task("task-2")],
    });
    c.navigate({ area: "chatgpt" });
  });
  expect(host.querySelector("script")).toBeNull();
  const row = host.querySelector(".contextual-sidebar button");
  await act(async () =>
    f.emit("tasks", {
      revision: 2,
      tasks: [task("task-2"), { ...task(), label: "<script>owned()</script>" }],
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
  await act(async () => button(host, "New ChatGPT task").click());
  expect(f.api.task).toHaveBeenCalledWith({ kind: "task.create-chatgpt" });
  await act(async () => {
    c.navigate({ area: "home" });
    f.emit("tasks", { revision: 1, tasks: [task()] });
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".work-row")!.click(),
  );
  expect(f.api.task).toHaveBeenCalledWith({
    kind: "task.activate",
    taskId: "task-1",
  });
  await act(async () => button(host, "Task options").click());
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
  for (const label of ["Rename", "Pin", "Cancel work", "Close task"])
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
