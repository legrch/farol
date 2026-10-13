import { StrictMode, act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { isCompactShell } from "../../src/pkg/shell-layout/geometry";
import { Shell } from "../../src/ui/renderer/shell";
import type { WindowSnapshot } from "../../src/ui/renderer/contract";
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
async function mount(data = bootstrap(), compactViewport = () => false) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue(data);
  const c = new WindowController(f.api, undefined, undefined, compactViewport);
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
  return { f, c, host, root };
}
function openUpdates(f: ReturnType<typeof fixture>) {
  f.emit("action", {
    action: "open-updates",
    source: "update-command",
    eventId: crypto.randomUUID(),
    authWindowGeneration: null,
  });
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
it("shows measured transfer progress and then verification without offering installation", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    c.overlay("update");
    f.emit("update", {
      phase: "downloading",
      progress: {
        stage: "transferring",
        receivedBytes: 150_000_000,
        totalBytes: 300_000_000,
      },
    });
  });
  const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
  const progress = dialog.querySelector<HTMLProgressElement>("progress")!;
  expect(progress.value).toBe(150_000_000);
  expect(progress.max).toBe(300_000_000);
  expect(progress.getAttribute("aria-label")).toBe("Update download");
  expect(dialog.textContent).toContain("50% · 150.0 of 300.0 MB");
  expect(dialog.textContent).not.toContain("Install and Relaunch");
  await act(async () =>
    f.emit("update", {
      phase: "downloading",
      progress: { stage: "verifying" },
    }),
  );
  expect(dialog.textContent).toContain("Checking the downloaded update");
  expect(dialog.getAttribute("aria-label")).toBe("Checking update");
  expect(dialog.querySelector("progress")).toBeNull();
  expect(dialog.textContent).not.toContain("Install and Relaunch");
});
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
// jsdom scroll properties/events only; Chromium layout/clamping remains unqualified.
function scrollStage(host: Element, top: number, left: number) {
  const stage = host.querySelector<HTMLElement>("main.stage")!;
  stage.scrollTop = top;
  stage.scrollLeft = left;
  stage.dispatchEvent(new Event("scroll"));
  return stage;
}
function stageOffset(host: Element) {
  const stage = host.querySelector<HTMLElement>("main.stage")!;
  return [stage.scrollTop, stage.scrollLeft];
}
it("history stage scroll restores both offsets using the exact immutable entry", async () => {
  const { host, c, f } = await mount();
  const configuration = c.getSnapshot().configuration;
  await act(async () => c.navigate({ area: "settings", page: "appearance" }));
  const first = c.getSnapshot().destination;
  expect(Object.isFrozen(first)).toBe(true);
  await act(async () => scrollStage(host, 180, 17));
  await act(async () => c.navigate({ area: "settings", page: "connection" }));
  expect(stageOffset(host)).toEqual([0, 0]);
  const second = c.getSnapshot().destination;
  const stage = scrollStage(host, 290, 29);
  await act(async () => {
    c.navigate({ area: "home", homeView: "work" });
    // Simulate content clamping before the navigation commit. Cleanup must not
    // overwrite the earlier observed offset with this changed DOM value.
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
  });
  await act(async () => button(host, "Back").click());
  expect(c.getSnapshot().destination).toBe(second);
  expect(stageOffset(host)).toEqual([290, 29]);
  await act(async () => button(host, "Back").click());
  expect(c.getSnapshot().destination).toBe(first);
  expect(stageOffset(host)).toEqual([180, 17]);
  await act(async () => button(host, "Forward").click());
  expect(c.getSnapshot().destination).toBe(second);
  expect(stageOffset(host)).toEqual([290, 29]);
  expect(c.getSnapshot().configuration).toBe(configuration);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});
it("history stage scroll separates identical-route visits and a truncated forward branch", async () => {
  const { host, c, f } = await mount();
  await act(async () => c.navigate({ area: "settings", page: "appearance" }));
  const original = c.getSnapshot().destination;
  scrollStage(host, 180, 17);
  await act(async () => c.navigate({ area: "settings", page: "connection" }));
  scrollStage(host, 290, 29);
  await act(async () => c.navigate({ area: "settings", page: "appearance" }));
  const discarded = c.getSnapshot().destination;
  expect(discarded).not.toBe(original);
  expect(stageOffset(host)).toEqual([0, 0]);
  scrollStage(host, 440, 44);
  await act(async () => button(host, "Back").click());
  expect(stageOffset(host)).toEqual([290, 29]);
  await act(async () => c.navigate({ area: "settings", page: "appearance" }));
  expect(c.getSnapshot().destination).not.toBe(discarded);
  expect(c.getSnapshot().forward).toBe(false);
  expect(button(host, "Forward").disabled).toBe(true);
  expect(stageOffset(host)).toEqual([0, 0]);
  scrollStage(host, 660, 66);
  await act(async () => button(host, "Back").click());
  expect(stageOffset(host)).toEqual([290, 29]);
  await act(async () => button(host, "Back").click());
  expect(c.getSnapshot().destination).toBe(original);
  expect(stageOffset(host)).toEqual([180, 17]);
  await act(async () => button(host, "Forward").click());
  await act(async () => button(host, "Forward").click());
  expect(stageOffset(host)).toEqual([660, 66]);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});
it("history stage scroll preserves the current offset during same-route updates", async () => {
  const { host, c, f } = await mount();
  await act(async () => c.navigate({ area: "settings", page: "appearance" }));
  const entry = c.getSnapshot().destination;
  scrollStage(host, 150, 15);
  await act(async () => f.emit("route", { state: "loaded" }));
  expect(c.getSnapshot().destination).toBe(entry);
  expect(stageOffset(host)).toEqual([150, 15]);
  await act(async () => c.navigate({ area: "settings", page: "appearance" }));
  expect(c.getSnapshot().destination).toBe(entry);
  expect(stageOffset(host)).toEqual([150, 15]);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});
it("history stage scroll distinguishes workspace entries with the same former page key", async () => {
  const value = settings();
  value.computer.workspaces = ["A", "B"].map((name, index) => ({
    workspaceId:
      index === 0
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333",
    root: `/work/${name}`,
    label: name,
    access: "read" as const,
    excludedPaths: [],
    rootIdentity: { device: "1", inode: String(index + 2) },
  }));
  const { host, c, f } = await mount({
    ...bootstrap(),
    configuration: {
      status: "ready",
      settings: ProductSettingsSchema.parse(value),
    },
  });
  await act(async () =>
    c.navigate({
      area: "settings",
      page: "folders",
      workspaceId: value.computer.workspaces[0]!.workspaceId,
    }),
  );
  scrollStage(host, 160, 16);
  await act(async () =>
    c.navigate({
      area: "settings",
      page: "folders",
      workspaceId: value.computer.workspaces[1]!.workspaceId,
    }),
  );
  expect(
    host.querySelector(".workspace-detail")?.getAttribute("aria-label"),
  ).toBe("Workspace B");
  expect(stageOffset(host)).toEqual([0, 0]);
  scrollStage(host, 280, 28);
  await act(async () => button(host, "Back").click());
  expect(
    host.querySelector(".workspace-detail")?.getAttribute("aria-label"),
  ).toBe("Workspace A");
  expect(stageOffset(host)).toEqual([160, 16]);
  await act(async () => button(host, "Forward").click());
  expect(stageOffset(host)).toEqual([280, 28]);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});
it("history stage scroll restores Activity offsets while preserving inspector focus", async () => {
  const { host } = await activityFixture();
  const focus = vi.spyOn(
    host.querySelector<HTMLElement>(".toolbar-title h1")!,
    "focus",
  );
  cleanups.push(async () => {
    focus.mockRestore();
  });
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>(".activity-row")[1]!.click(),
  );
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  scrollStage(host, 50, 5);
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>(".activity-row")[0]!.click(),
  );
  expect(stageOffset(host)).toEqual([0, 0]);
  scrollStage(host, 80, 8);
  await act(async () => button(host, "Back").click());
  expect(stageOffset(host)).toEqual([50, 5]);
  expect(document.activeElement).toBe(host.querySelector(".toolbar-title h1"));
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  await act(async () => button(host, "Forward").click());
  expect(stageOffset(host)).toEqual([80, 8]);
  expect(document.activeElement).toBe(host.querySelector(".toolbar-title h1"));
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
});
it("history stage scroll ignores nested scroll notifications", async () => {
  const { host, c } = await mount();
  await act(async () => c.navigate({ area: "settings", page: "appearance" }));
  const stage = scrollStage(host, 120, 12);
  // A nested notification must not save an unobserved/clamped stage value.
  stage.scrollTop = 1;
  stage.scrollLeft = 1;
  stage
    .querySelector("button")!
    .dispatchEvent(new Event("scroll", { bubbles: true }));
  await act(async () => c.navigate({ area: "settings", page: "connection" }));
  await act(async () => button(host, "Back").click());
  expect(stageOffset(host)).toEqual([120, 12]);
});
it("history stage scroll retains observed offsets through StrictMode layout replay", async () => {
  const { host, c, root } = await mount();
  function ScrolledShell() {
    const initialized = useRef(false);
    useLayoutEffect(() => {
      if (!initialized.current) {
        initialized.current = true;
        scrollStage(host, 120, 12);
      }
    }, [host]);
    return <Shell />;
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <Services value={c}>
          <ScrolledShell />
        </Services>
      </StrictMode>,
    ),
  );
  expect(stageOffset(host)).toEqual([120, 12]);
});
it("history stage scroll starts fresh when the Shell is actually unmounted", async () => {
  const { host, c, root } = await mount();
  scrollStage(host, 120, 12);
  await act(async () => root.render(null));
  await act(async () =>
    root.render(
      <StrictMode>
        <Services value={c}>
          <Shell />
        </Services>
      </StrictMode>,
    ),
  );
  expect(stageOffset(host)).toEqual([0, 0]);
});
it("returns an unresolved Setup workspace action to its actual Setup step", async () => {
  const value = settings();
  value.computer.workspaces = [
    {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
    },
  ];
  const { host, c, f } = await mount({
    ...bootstrap(),
    configuration: {
      status: "ready",
      settings: ProductSettingsSchema.parse(value),
    },
  });
  await act(async () => c.navigate({ area: "setup", setupStep: "folders" }));
  vi.mocked(f.api.configure).mockRejectedValueOnce(new Error("lost reply"));
  await act(async () => button(host, "Verify workspace").click());
  expect(c.getSnapshot().intents).toHaveProperty(
    "settings:computer.verify-workspace:22222222-2222-4222-8222-222222222222",
  );
  await act(async () => c.navigate({ area: "settings", page: "diagnostics" }));
  await act(async () => button(host, "Return to Setup").click());
  expect(c.getSnapshot().destination.area).toBe("setup");
  expect(c.getSnapshot().destination.setupStep).toBe("folders");
  expect(f.api.configure).toHaveBeenCalledTimes(1);
});
it.each([
  ["Home", "click"],
  ["Home", "Enter"],
  ["Workspaces", "click"],
  ["Workspaces", "Enter"],
] as const)(
  "R34 current %s search selection by %s closes and restores focus",
  async (label, input) => {
    const { host, c, f } = await mount();
    if (label === "Workspaces")
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
it("Home keeps the rail and full-width overview while an explicitly opened page list reports the actual host layout", async () => {
  const { host, c, f } = await mount();
  expect(host.querySelectorAll(".sidebar")).toHaveLength(0);
  expect(host.querySelectorAll(".rail")).toHaveLength(1);
  expect(
    host.querySelector(".rail button:first-child")?.getAttribute("aria-label"),
  ).toBe("Home");
  expect(
    host.querySelector(".rail button:last-child")?.getAttribute("aria-label"),
  ).toBe("Settings");
  expect(host.querySelector(".contextual-sidebar")).toBeNull();
  expect(c.getSnapshot().sidebar).toBe("full");
  expect(f.api.layout).toHaveBeenLastCalledWith(
    "activity",
    "",
    false,
    false,
    "rail",
    "none",
    232,
  );
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
  await act(async () => c.toggleSidebar(false));
  expect(host.querySelector(".sidebar-scrim")).not.toBeNull();
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
  expect(f.api.layout).toHaveBeenLastCalledWith(
    "activity",
    "",
    false,
    false,
    "overlay",
    "sidebar",
    232,
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
    232,
  );
  await act(async () =>
    host.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(host.querySelector(".sidebar-scrim")).toBeNull();
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
});
it.each([
  [849, "58px", false],
  [850, "58px", false],
  [851, "62px", true],
] as const)(
  "approved geometry projects rail and context at %ipx",
  async (width, rail, context) => {
    const previous = window.innerWidth;
    cleanups.push(async () => {
      await act(async () => {
        window.innerWidth = previous;
        window.dispatchEvent(new Event("resize"));
      });
    });
    window.innerWidth = width;
    const { host, c, f } = await mount(bootstrap(), () =>
      isCompactShell(window.innerWidth),
    );
    await act(async () => c.navigate({ area: "home", homeView: "work" }));
    const desktop = host.querySelector<HTMLElement>(".desktop")!;
    expect(desktop.style.getPropertyValue("--rail-width")).toBe(rail);
    expect(desktop.style.getPropertyValue("--page-list-width")).toBe("232px");
    expect(Boolean(host.querySelector("aside"))).toBe(context);
    await act(async () => button(host, "Toggle sidebar").click());
    expect(c.getSnapshot().sidebar).toBe(context ? "rail" : "overlay");
    expect(Boolean(host.querySelector(".sidebar-overlay"))).toBe(!context);
    expect(host.querySelector("main")?.hasAttribute("inert")).toBe(!context);
    expect(desktop.style.getPropertyValue("--rail-width")).toBe(rail);
    await act(async () =>
      f.emit("action", {
        action: "toggle-sidebar",
        source: "sidebar-command",
        eventId: "11111111-1111-4111-8111-111111111178",
        authWindowGeneration: null,
      }),
    );
    expect(c.getSnapshot().sidebar).toBe(context ? "full" : "rail");
    expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
    await act(async () =>
      f.emit("action", {
        action: "toggle-sidebar",
        source: "sidebar-command",
        eventId: "11111111-1111-4111-8111-111111111179",
        authWindowGeneration: null,
      }),
    );
    expect(c.getSnapshot().sidebar).toBe(context ? "rail" : "overlay");
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  },
);
async function compactSettingsShell() {
  const originalWidth = window.innerWidth;
  cleanups.push(async () => {
    await act(async () => {
      window.innerWidth = originalWidth;
      window.dispatchEvent(new Event("resize"));
    });
  });
  window.innerWidth = 758;
  const mounted = await mount();
  await act(async () =>
    mounted.c.navigate({ area: "settings", page: "general" }),
  );
  return mounted;
}
it.each(["toolbar", "controller"] as const)(
  "compact sidebar focus enters a page control when opened by %s",
  async (source) => {
    const { host, c, f } = await compactSettingsShell();
    const trigger = button(host, "Toggle sidebar");
    trigger.focus();
    await act(async () => {
      if (source === "toolbar") trigger.click();
      else c.toggleSidebar(true);
    });
    expect(
      document.activeElement ===
        button(host.querySelector("aside")!, "General"),
    ).toBe(true);
    expect(document.activeElement?.getAttribute("role")).not.toBe("separator");
    expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  },
);
it.each(["Escape", "scrim", "toggle", "host-dismiss", "current-page"] as const)(
  "compact sidebar focus returns to its toggle after %s dismissal",
  async (dismissal) => {
    const { host, f } = await compactSettingsShell();
    const trigger = button(host, "Toggle sidebar");
    await act(async () => trigger.click());
    const current = button(host.querySelector("aside")!, "General");
    current.focus();
    await act(async () => {
      if (dismissal === "Escape")
        current.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      else if (dismissal === "scrim") button(host, "Close sidebar").click();
      else if (dismissal === "toggle") trigger.click();
      else if (dismissal === "current-page") current.click();
      else
        f.emit("action", {
          action: "close-overlay",
          source: "overlay-dismissed",
          eventId: "11111111-1111-4111-8111-111111111177",
          authWindowGeneration: null,
        });
    });
    expect(host.querySelector(".sidebar-overlay")).toBeNull();
    expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement === trigger).toBe(true);
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  },
);
it.each(["search", "update", "update-recovery"] as const)(
  "compact sidebar focus does not displace the %s dialog",
  async (overlay) => {
    const { host, c, f } = await compactSettingsShell();
    await act(async () => c.overlay(overlay));
    const dialogTarget = document.activeElement;
    expect(host.querySelector("dialog")?.contains(dialogTarget)).toBe(true);
    await act(async () => c.toggleSidebar(true));
    expect(document.activeElement).toBe(dialogTarget);
    await act(async () => c.toggleSidebar(true));
    expect(document.activeElement).toBe(dialogTarget);
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  },
);
it("compact sidebar focus does not restore its toggle after destination navigation", async () => {
  const { host, c } = await compactSettingsShell();
  const trigger = button(host, "Toggle sidebar");
  await act(async () => trigger.click());
  const target = button(host.querySelector("aside")!, "Appearance");
  target.focus();
  await act(async () => target.click());
  expect(c.getSnapshot().destination.page).toBe("appearance");
  expect(host.querySelector(".sidebar-overlay")).toBeNull();
  expect(document.activeElement).not.toBe(trigger);
});
it("compact sidebar focus leaves desktop toggle focus unchanged", async () => {
  const { host, c } = await mount();
  await act(async () => c.navigate({ area: "home", homeView: "work" }));
  const trigger = button(host, "Toggle sidebar");
  trigger.focus();
  await act(async () => c.toggleSidebar(false));
  expect(document.activeElement).toBe(trigger);
  await act(async () => c.toggleSidebar(false));
  expect(document.activeElement).toBe(trigger);
});
it("resizes the page list with keyboard bounds and remembers its width only in this window", async () => {
  const { host, c, f } = await mount();
  await act(async () => c.navigate({ area: "home", homeView: "work" }));
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
  expect(divider.getAttribute("aria-valuenow")).toBe("232");
  await key("ArrowRight");
  expect(c.getSnapshot().sidebarWidth).toBe(240);
  expect(
    host
      .querySelector<HTMLElement>(".desktop")!
      .style.getPropertyValue("--side-width"),
  ).toBe("240px");
  expect(f.api.layout).toHaveBeenLastCalledWith(
    "activity",
    "",
    false,
    false,
    "full",
    "none",
    240,
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
    await act(async () => f.emit("route", { state: "loaded" }));
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
      232,
    );
    await pointer("pointermove", 275);
    expect(c.getSnapshot().sidebarWidth).toBe(272);
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
    expect(c.getSnapshot().sidebarWidth).toBe(cancelled ? 232 : 272);
    expect(f.api.layout).toHaveBeenLastCalledWith(
      "browser",
      "",
      false,
      false,
      ending === "collapse" ? "rail" : "full",
      "none",
      cancelled ? 232 : 272,
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
      expect(c.getSnapshot().sidebarWidth).toBe(240);
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
  await act(async () => c.navigate({ area: "home", homeView: "work" }));
  const originalWidth = window.innerWidth;
  try {
    await act(async () => {
      window.innerWidth = 979;
      window.dispatchEvent(new Event("resize"));
    });
    expect(host.querySelector(".contextual-sidebar")).not.toBeNull();
    await act(async () => {
      window.innerWidth = 850;
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
      232,
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
  expect(host.querySelector(".toolbar-title strong")?.textContent).toBe(
    "Overview",
  );
  expect(host.querySelector(".toolbar-title")?.textContent).toBe(
    "Home /Overview",
  );
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
  expect(document.activeElement).toBe(host.querySelector("dialog input"));
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
  expect(button(host, "Install and Relaunch").disabled).toBe(true);
  expect(host.textContent).not.toContain("WORK_PENDING");
  expect(button(host, "Review Diagnostics").disabled).toBe(false);
  await act(async () => button(host, "Close").click());
  expect(c.getSnapshot().overlay).toBe("none");
});

it("R31 R36 Home keeps local views selected and explicit destinations use existing routes", async () => {
  const { host, c, f } = await mount();
  for (const [label, page] of [
    ["Manage connection", "connection"],
    ["Manage workspaces", "folders"],
  ] as const) {
    await act(async () =>
      c.navigate({ area: "home", homeView: "access", homeSelection: null }),
    );
    await act(async () => button(host, label).click());
    expect(c.getSnapshot().destination).toMatchObject({
      area: "settings",
      page,
    });
  }
  await act(async () =>
    c.navigate({ area: "home", homeView: "activity", homeSelection: null }),
  );
  await act(async () => button(host, "Open full Activity").click());
  expect(c.getSnapshot().destination.area).toBe("activity");
  expect(host.querySelector('.rail [aria-label="New chat"]')).toBeNull();
  expect(f.api.task).not.toHaveBeenCalled();
  expect(f.api.configure).not.toHaveBeenCalled();
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
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "Not recorded",
  );
  expect(host.querySelector("dialog")).toBeNull();
  await act(async () => button(host, "View chat").click());
  expect(c.getSnapshot().destination.taskId).toBe("task-1");
  await act(async () => c.navigate({ area: "activity" }));
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".activity-row")!.click(),
  );
  expect(c.getSnapshot().overlay).toBe("none");
  expect(host.querySelector(".activity-page")?.textContent).toContain("task-1");
});
it("R16 R23 R24 distinct update controls preserve exact operations and pending fence", async () => {
  const { host, c, f } = await mount();
  await act(async () => c.overlay("update"));
  await act(async () => openUpdates(f));
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "check" });
  const ready = {
    phase: "ready",
    version: "1.0",
    deferred: false,
    blockedBy: null,
  };
  await act(async () => f.emit("update", ready));
  await act(async () => button(host, "Install and Relaunch").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({
    kind: "restart-confirmed",
    version: "1.0",
  });
  await act(async () => {
    f.emit("update", ready);
    c.overlay("update");
  });
  await act(async () => button(host, "Remind Me Later").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "later" });
  expect(c.getSnapshot().overlay).toBe("none");
  await act(async () => {
    f.emit("update", { phase: "recovery", version: "1.0", blockedBy: null });
    c.overlay("update-recovery");
  });
  await act(async () => button(host, "Recover").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "recover" });
  await act(async () => {
    f.emit("update", {
      phase: "idle",
      checkedAt: null,
      rollbackVersion: "0.9",
    });
    c.overlay("update-recovery");
  });
  await act(async () => button(host, "Roll Back").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "rollback" });
});
it("offers Download only for a current available release", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", {
      phase: "available",
      version: "0.2.0-owner.beta.5",
      deferred: false,
    });
    c.overlay("update");
  });
  expect(host.textContent).toContain("is available to download");
  expect(document.activeElement).toBe(button(host, "Remind Me Later"));
  await act(async () => button(host, "Download Update").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "download" });
  await act(async () => f.emit("update", { phase: "idle", checkedAt: 10 }));
  expect((await c.update("download")).state).toBe("refused");
  expect(
    vi
      .mocked(f.api.installedUpdate)
      .mock.calls.filter(([command]) => command.kind === "download"),
  ).toHaveLength(1);
});
it("keeps the update indicator in the rail only while an update needs attention", async () => {
  const { host, c, f } = await mount();
  expect(host.querySelector(".rail .update-action")).toBeNull();
  await act(async () =>
    f.emit("update", {
      phase: "available",
      version: "0.2.0-owner.beta.5",
      deferred: false,
    }),
  );
  expect(host.querySelector(".toolbar .update-action")).toBeNull();
  const rail = button(host.querySelector(".rail")!, "Update available");
  await act(async () => rail.click());
  expect(c.getSnapshot().overlay).toBe("update");
  expect(rail.parentElement).toBe(host.querySelector(".rail-footer"));
  expect(rail.nextElementSibling?.getAttribute("aria-label")).toBe("Settings");
  await act(async () => {
    c.overlay("none");
    f.emit("update", { phase: "idle", checkedAt: 42 });
  });
  expect(host.querySelector(".rail .update-action")).toBeNull();
});
it("renders release notes as text without creating provider-supplied markup", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", {
      phase: "available",
      version: "0.2.0-owner.beta.5",
      deferred: false,
      notes: "Cleaner Setup. <script>not executable</script>",
    });
    c.overlay("update");
  });
  expect(host.querySelector("dialog .update-release")?.textContent).toContain(
    "Cleaner Setup. <script>not executable</script>",
  );
  expect(host.querySelector("dialog .update-release script")).toBeNull();
});
// Design parity fixtures prove renderer composition/guards, not native updates.
it.each([
  [
    { phase: "available", version: "1.0", deferred: false },
    "Update available",
    "is available to download",
    ["Skip This Version", "Remind Me Later", "Download Update"],
  ],
  [
    { phase: "ready", version: "1.0", deferred: false, blockedBy: null },
    "Ready to install",
    "is ready to install.",
    ["Remind Me Later", "Install and Relaunch"],
  ],
  [
    { phase: "checking" },
    "Checking for updates",
    "Checking for updates…",
    ["Continue working"],
  ],
  [
    { phase: "downloading" },
    "Downloading update",
    "Downloading update in the background. Keep working.",
    ["Continue working"],
  ],
  [
    { phase: "applying", version: "1.0" },
    "Restarting to update",
    "Applying version 1.0…",
    [],
  ],
  [
    { phase: "idle", checkedAt: null },
    "Update status",
    "Update availability has not been checked.",
    ["Done"],
  ],
  [
    { phase: "unavailable", code: "UPDATE_STATUS_UNAVAILABLE" },
    "Updates unavailable",
    "cannot confirm update availability",
    ["Dismiss", "Review Diagnostics"],
  ],
  [
    { phase: "failed", code: "UPDATE_FAILED", recoveryRequired: false },
    "The update did not finish",
    "The update did not finish",
    ["Dismiss", "Review Diagnostics"],
  ],
  [
    {
      phase: "failed",
      code: "UPDATE_VERIFICATION_RECOVERY_REQUIRED",
      recoveryRequired: true,
    },
    "The update did not finish",
    "An earlier package check did not finish. Its files are saved.",
    ["Dismiss", "Review Diagnostics"],
  ],
] satisfies [WindowSnapshot["update"], string, string, string[]][])(
  "Updates %j shows its own heading, state and release actions",
  async (update, heading, status, actions) => {
    const { host, c, f } = await mount();
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () => {
      c.overlay("update");
      f.emit("update", update);
    });
    const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe(heading);
    expect(dialog.querySelector(".update-heading h2")?.textContent).toBe(
      heading,
    );
    expect(
      dialog.querySelector(".update-symbol svg")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(dialog.querySelector(".update-state")?.textContent).toContain(
      status,
    );
    if (update.phase === "failed" || update.phase === "unavailable") {
      expect(dialog.querySelector(".update-state")?.textContent).not.toContain(
        update.code,
      );
      const technical = dialog.querySelector<HTMLDetailsElement>(
        ".update-technical-code",
      );
      expect(technical).toBeNull();
      expect(c.getSnapshot().update).toMatchObject({ code: update.code });
    }
    expect(dialog.querySelector(".update-installed")).toBeNull();
    expect(
      [...dialog.querySelectorAll("summary")].some(
        (node) => node.textContent === "Details",
      ),
    ).toBe(false);
    expect(
      [...dialog.querySelectorAll(".update-actions button")].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(actions);
    expect(dialog.querySelector(".update-check")).toBeNull();
    if (update.phase === "available" || update.phase === "ready") {
      expect(dialog.querySelector(".update-options")).toBeNull();
      expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
      expect(dialog.querySelector(".update-policy-strip")).toBeNull();
    }
    if (update.phase === "applying") {
      expect(dialog.querySelector('[aria-label="Close"]')).toBeNull();
      expect(document.activeElement).toBe(
        dialog.querySelector(".update-state"),
      );
      await act(async () =>
        dialog.dispatchEvent(new Event("cancel", { cancelable: true })),
      );
      expect(c.getSnapshot().overlay).toBe("update");
    } else {
      const safe = actions.some((label) => label === "Remind Me Later")
        ? "Remind Me Later"
        : actions[0]!;
      expect(document.activeElement).toBe(button(dialog, safe));
    }
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
  },
);
it("describes an uncertain update as requiring recovery without claiming the installed version changed", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => {
    f.emit("update", {
      phase: "failed",
      code: "UPDATE_HANDOFF_UNKNOWN",
      recoveryRequired: true,
    });
    c.overlay("update");
  });
  const dialog = host.querySelector("dialog")!;
  expect(dialog.querySelector(".update-state")?.textContent).toContain(
    "The update result needs recovery",
  );
  expect(dialog.querySelector(".update-state")?.textContent).not.toContain(
    "UPDATE_HANDOFF_UNKNOWN",
  );
  expect(dialog.querySelector(".update-technical-code")).toBeNull();
  await act(async () => button(dialog, "Review Diagnostics").click());
  expect(c.getSnapshot().destination.page).toBe("diagnostics");
  await act(async () => button(host, "Review recovery options").click());
  expect(
    host.querySelector("dialog .update-technical-code code")?.textContent,
  ).toBe("UPDATE_HANDOFF_UNKNOWN");
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it("keeps real recovery refusals visible and fenced", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => {
    f.emit("update", {
      phase: "recovery",
      version: "1.0",
      blockedBy: "WORK_PENDING",
    });
    c.overlay("update-recovery");
  });
  const block = host.querySelector("dialog .update-block")!;
  expect(block.getAttribute("role")).toBe("alert");
  expect(block.querySelector("strong")?.textContent).toBe(
    "Recovery is blocked",
  );
  expect(block.querySelector("details code")?.textContent).toBe("WORK_PENDING");
  expect(button(host, "Recover").disabled).toBe(true);
  await act(async () => button(host, "Recover").click());
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});

it.each([
  "UPDATE_BROWSER_OPEN",
  "UPDATE_BROWSER_BUSY",
  "UPDATE_BROWSER_DRAFT",
  "UPDATE_BROWSER_STATE_UNKNOWN",
])(
  "confirms manual installation despite %s, binding the displayed version",
  async (blockedBy) => {
    const { host, c, f } = await mount();
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () => {
      f.emit("update", {
        phase: "ready",
        version: "0.2.1",
        deferred: false,
        blockedBy,
      });
      c.overlay("update");
    });
    const dialog = host.querySelector("dialog")!;
    expect(dialog.textContent).toContain(
      "Farol will close open ChatGPT sessions and interrupt work before restarting.",
    );
    expect(dialog.textContent).not.toContain("Restart is blocked");
    expect(dialog.textContent).not.toContain(blockedBy);
    expect(dialog.querySelector(".update-block")).toBeNull();
    const pending = deferred<unknown>();
    vi.mocked(f.api.installedUpdate).mockReturnValueOnce(pending.promise);
    const install = button(dialog, "Install and Relaunch");
    expect(install.disabled).toBe(false);
    await act(async () => {
      install.click();
      install.click();
    });
    expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "restart-confirmed",
      version: "0.2.1",
    });
    expect(host.querySelectorAll("dialog")).toHaveLength(1);
    expect(button(dialog, "Install and Relaunch").disabled).toBe(true);
    await act(async () => pending.reject(new Error("reply lost")));
    await act(async () =>
      f.emit("update", {
        phase: "ready",
        version: "0.2.1",
        deferred: false,
        blockedBy: null,
      }),
    );
    expect(button(dialog, "Install and Relaunch").disabled).toBe(true);
    await act(async () => button(dialog, "Install and Relaunch").click());
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
  },
);

it.each(["UPDATE_BROWSER_RELEASE_UNCONFIRMED", "UPDATE_STATE_UNREADABLE"])(
  "keeps %s as a concise issue with Diagnostics and a disabled install",
  async (blockedBy) => {
    const { host, c, f } = await mount();
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () => {
      f.emit("update", {
        phase: "ready",
        version: "0.2.1",
        deferred: false,
        blockedBy,
      });
      c.overlay("update");
    });
    const dialog = host.querySelector("dialog")!;
    expect(dialog.querySelector(".update-block")).toBeNull();
    expect(dialog.querySelector(".update-issue p")?.textContent).toContain(
      "Review Diagnostics before restarting.",
    );
    expect(dialog.querySelector(".update-issue details")).toBeNull();
    expect(c.getSnapshot().update).toMatchObject({ blockedBy });
    const install = button(dialog, "Install and Relaunch");
    expect(install.disabled).toBe(true);
    await act(async () => install.click());
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
  },
);

it.each(["available", "ready"] as const)(
  "Updates deferred %s keeps a usable local dismiss and restores the rail trigger",
  async (phase) => {
    const { host, c, f } = await mount();
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () =>
      f.emit(
        "update",
        phase === "available"
          ? { phase, version: "1.0", deferred: true }
          : { phase, version: "1.0", deferred: true, blockedBy: null },
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>(
      ".rail .update-action",
    )!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(button(host, "Remind Me Later").disabled).toBe(
      phase === "available",
    );
    expect(document.activeElement).toBe(button(host, "Continue working"));
    await act(async () => button(host, "Continue working").click());
    expect(c.getSnapshot().overlay).toBe("none");
    expect(document.activeElement).toBe(trigger);
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
  },
);
it("a temporarily blocked ready update can establish explicit postponement", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockClear();
  vi.mocked(f.api.installedUpdate).mockResolvedValue({
    phase: "ready",
    version: "1.0",
    deferred: true,
    blockedBy: "UPDATE_BROWSER_DRAFT",
  });
  await act(async () => {
    f.emit("update", {
      phase: "ready",
      version: "1.0",
      deferred: true,
      blockedBy: "UPDATE_BROWSER_DRAFT",
    });
    c.overlay("update");
  });
  expect(button(host, "Remind Me Later").disabled).toBe(false);
  await act(async () => button(host, "Remind Me Later").click());
  expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
    kind: "later",
  });
  expect(c.getSnapshot().overlay).toBe("none");
});
it("Updates moves focus to local dismissal when a focused release action becomes pending", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockClear();
  const operation = deferred<unknown>();
  vi.mocked(f.api.installedUpdate).mockReturnValueOnce(operation.promise);
  await act(async () => {
    f.emit("update", { phase: "available", version: "1.0", deferred: false });
    c.overlay("update");
  });
  const download = button(host, "Download Update");
  download.focus();
  await act(async () => download.click());
  expect(download.disabled).toBe(true);
  expect(document.activeElement).toBe(button(host, "Continue working"));
  await act(async () => operation.reject(new Error("reply lost")));
  expect(c.getSnapshot().intents.update?.state).toBe("unknown");
  await act(async () => button(host, "Continue working").click());
  await act(async () => c.overlay("update"));
  expect(button(host, "Download Update").disabled).toBe(true);
  expect(document.activeElement).toBe(button(host, "Continue working"));
  expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
});
it("Updates uses only supplied notes and confirmed installed version", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", { phase: "available", version: "1.0", deferred: false });
    c.overlay("update");
  });
  expect(host.querySelector("dialog .update-release")).toBeNull();
  expect(
    host.querySelector("dialog .automatic-update-choice strong")?.textContent,
  ).toBe("Automatically install updates");
  expect(
    host.querySelector<HTMLInputElement>(
      "dialog .automatic-update-choice input",
    )?.disabled,
  ).toBe(true);
  expect(host.querySelector("dialog")?.textContent).not.toContain(
    "install when you quit",
  );
  await act(async () =>
    f.emit("runtime", {
      state: "offline",
      error: null,
      identity: null,
      embeddedNode: null,
      embeddedElectron: null,
    }),
  );
  expect(host.querySelector("dialog .update-installed")).toBeNull();
  expect(host.querySelector("dialog")?.textContent).not.toContain("0.1.8");
});
it("offers version-scoped Skip only for an available release", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", {
      phase: "available",
      version: "0.2.0-owner.beta.5",
      deferred: false,
    });
    c.overlay("update");
  });
  await act(async () => button(host, "Skip This Version").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "skip" });
  await act(async () => f.emit("update", { phase: "idle", checkedAt: 10 }));
  expect((await c.update("skip")).state).toBe("refused");
  expect(
    vi
      .mocked(f.api.installedUpdate)
      .mock.calls.filter(([command]) => command.kind === "skip"),
  ).toHaveLength(1);
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
    c.navigate({ area: "settings", page: "connection", taskId: "task-1" });
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
    )!.set!.call(input, "Workspaces");
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

it("R15 ChatGPT navigation observes the original Connection intention without replay", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.configure).mockRejectedValue(new Error("reply lost"));
  await act(async () => c.navigate({ area: "settings", page: "connection" }));
  await act(async () => button(host, "Open ChatGPT").click());
  expect(c.getSnapshot().intents["settings:chatgpt.open-browser:"]?.state).toBe(
    "unknown",
  );
  expect(button(host, "Open ChatGPT").disabled).toBe(true);
  await act(async () => c.navigate({ area: "chatgpt" }));
  expect(host.querySelector("main [role=alert]")?.textContent).toContain(
    "Opening ChatGPT is unconfirmed",
  );
  expect(host.querySelector("main")?.textContent).not.toContain("Open ChatGPT");
  await act(async () => button(host, "Diagnostics").click());
  expect(c.getSnapshot().destination.page).toBe("diagnostics");
  await act(async () => c.navigate({ area: "settings", page: "connection" }));
  await act(async () => button(host, "Open ChatGPT").click());
  expect(f.api.configure).toHaveBeenCalledTimes(1);
});

// Renderer-only fixtures: route events do not prove native view/AX placement.
it("Goal17 retained ChatGPT navigation has no shell launcher and preserves drafts", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("tasks", { revision: 1, tasks: [task()] });
    c.navigate({ area: "chatgpt", taskId: "task-1" });
    f.emit("route", { state: "loaded" });
  });
  c.draft.capture(
    "task-1",
    {
      mode: "workspace",
      objective: "Retain this task draft",
      subtree: "",
      paths: "",
      exclusions: "",
    },
    null,
  );
  const draft = c.draft.restore("task-1");
  c.conversationDraft.capture("retained-conversation", "Unsent text", 2, 5);
  const conversation = c.conversationDraft.read("retained-conversation");
  const configuration = c.getSnapshot().configuration;
  for (const area of ["setup", "home", "settings"] as const) {
    await act(async () => c.navigate({ area }));
    await act(async () => button(host, "ChatGPT").click());
    expect(host.querySelector(".native-browser-placeholder")).toBeNull();
    expect(host.querySelector("main")?.textContent).not.toContain(
      "Open ChatGPT",
    );
    expect(host.querySelector("main")?.textContent).not.toContain("Sign in");
    expect(c.getSnapshot().destination.taskId).toBe("task-1");
    expect(c.draft.restore("task-1")).toBe(draft);
    expect(draft?.objective).toBe("Retain this task draft");
    expect(c.conversationDraft.read("retained-conversation")).toBe(
      conversation,
    );
    expect(c.getSnapshot().configuration).toBe(configuration);
    expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 3)).toEqual([
      "browser",
      "task-1",
      false,
    ]);
  }
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});

it.each(["loading", "failed"] as const)(
  "Goal18 %s projection asks the host once without an extra launcher click",
  async (route) => {
    const { host, c, f } = await mount();
    await act(async () => f.emit("route", { state: route }));
    for (let entry = 0; entry < 2; entry++) {
      await act(async () => button(host, "ChatGPT").click());
      expect(
        host.querySelector(".native-browser-placeholder")?.textContent,
      ).toContain(
        route === "failed"
          ? "ChatGPT could not be opened"
          : "ChatGPT page status has not been confirmed",
      );
      expect(host.querySelector("main")?.textContent).not.toContain(
        "Open ChatGPT",
      );
      expect(host.querySelector("main")?.textContent).not.toContain("Sign in");
      await act(async () => button(host, "Connection").click());
      expect(c.getSnapshot().destination).toMatchObject({
        area: "settings",
        page: "connection",
      });
    }
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "chatgpt.present-browser",
    });
    expect(f.api.task).not.toHaveBeenCalled();
  },
);

it.each(["applied", "refused", "unknown"] as const)(
  "Goal18 shows and retains the %s presentation intent across actual remount and late reply",
  async (outcome) => {
    const { host, c, f, root } = await mount();
    expect(f.api.configure).not.toHaveBeenCalled();
    const waiting = deferred<unknown>();
    vi.mocked(f.api.configure).mockReturnValueOnce(waiting.promise);
    c.conversationDraft.capture("retained", "Unsent text", 1, 3);
    const draft = c.conversationDraft.read("retained");
    await act(async () => {
      button(host, "ChatGPT").click();
      button(host, "ChatGPT").click();
    });
    expect(host.querySelector("main [role=status]")?.textContent).toBe(
      "Opening ChatGPT…",
    );
    expect(host.querySelector("main")?.textContent).not.toContain(
      "Open ChatGPT",
    );
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "chatgpt.present-browser",
    });
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        <StrictMode>
          <Services value={c}>
            <Shell />
          </Services>
        </StrictMode>,
      ),
    );
    expect(host.querySelector("main [role=status]")?.textContent).toBe(
      "Opening ChatGPT…",
    );
    await act(async () => c.navigate({ area: "setup", setupStep: "folders" }));
    const destination = c.getSnapshot().destination;
    await act(async () => {
      if (outcome === "unknown") waiting.reject(new Error("reply lost"));
      else
        waiting.resolve({
          ok: outcome === "applied",
          ...(outcome === "refused"
            ? { error: "CHATGPT_PAGE_UNREACHABLE" }
            : {}),
          snapshot: bootstrap().configuration,
        });
    });
    expect(c.getSnapshot().destination).toBe(destination);
    expect(
      c.getSnapshot().intents["settings:chatgpt.present-browser:"]?.state,
    ).toBe(outcome);
    await act(async () => c.refresh());
    await act(async () => {
      c.travel(-1);
      f.emit("route", { state: "loaded" });
    });
    if (outcome === "applied")
      expect(host.querySelector(".native-browser-placeholder")).toBeNull();
    else
      expect(host.querySelector("main [role=alert]")?.textContent).toContain(
        outcome === "unknown"
          ? "Opening ChatGPT is unconfirmed"
          : "ChatGPT could not be opened",
      );
    await act(async () => c.travel(1));
    expect(c.getSnapshot().destination).toBe(destination);
    await act(async () => button(host, "ChatGPT").click());
    expect(c.conversationDraft.read("retained")).toBe(draft);
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "chatgpt.present-browser",
    });
    expect(f.api.task).not.toHaveBeenCalled();
  },
);

it("Goal18 an actual loaded home route is revealed without Open, reload, or automatic mount work", async () => {
  const { host, c, f, root } = await mount();
  await act(async () => f.emit("route", { state: "loaded" }));
  c.conversationDraft.capture("retained", "Unsent text", 2, 5);
  const draft = c.conversationDraft.read("retained");
  for (let entry = 0; entry < 2; entry++) {
    await act(async () => button(host, "ChatGPT").click());
    expect(host.querySelector(".native-browser-placeholder")).toBeNull();
    expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 3)).toEqual([
      "browser",
      "",
      false,
    ]);
    await act(async () => c.navigate({ area: "setup", setupStep: "folders" }));
    await act(async () => c.travel(-1));
    await act(async () => c.travel(1));
  }
  await act(async () => root.render(null));
  await act(async () =>
    root.render(
      <StrictMode>
        <Services value={c}>
          <Shell />
        </Services>
      </StrictMode>,
    ),
  );
  expect(c.conversationDraft.read("retained")).toBe(draft);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});

it.each(["applied", "refused", "unknown"] as const)(
  "Goal17 a late %s open result cannot steal Setup navigation or trigger another open",
  async (outcome) => {
    const { host, c, f } = await mount();
    const waiting = deferred<unknown>();
    vi.mocked(f.api.configure).mockReturnValueOnce(waiting.promise);
    await act(async () => c.navigate({ area: "settings", page: "connection" }));
    await act(async () => button(host, "Open ChatGPT").click());
    await act(async () => button(host, "ChatGPT").click());
    expect(host.querySelector("main [role=status]")?.textContent).toBe(
      "Opening ChatGPT…",
    );
    await act(async () => c.navigate({ area: "setup", setupStep: "folders" }));
    const destination = c.getSnapshot().destination;
    await act(async () => {
      if (outcome === "unknown") waiting.reject(new Error("reply lost"));
      else
        waiting.resolve({
          ok: outcome === "applied",
          ...(outcome === "refused"
            ? { error: "CHATGPT_PAGE_UNREACHABLE" }
            : {}),
          snapshot: bootstrap().configuration,
        });
    });
    expect(c.getSnapshot().destination).toBe(destination);
    expect(
      c.getSnapshot().intents["settings:chatgpt.open-browser:"]?.state,
    ).toBe(outcome);
    for (let entry = 0; entry < 2; entry++) {
      await act(async () => {
        f.emit("route", { state: "loaded" });
        c.navigate({ area: "chatgpt" });
      });
      expect(host.querySelector("main")?.textContent).not.toContain(
        "Open ChatGPT",
      );
      if (outcome === "applied")
        expect(host.querySelector(".native-browser-placeholder")).toBeNull();
      else
        expect(host.querySelector("main [role=alert]")?.textContent).toContain(
          outcome === "unknown"
            ? "Opening ChatGPT is unconfirmed"
            : "ChatGPT could not be opened",
        );
      await act(async () =>
        c.navigate({ area: "setup", setupStep: "folders" }),
      );
    }
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "chatgpt.open-browser",
    });
    expect(f.api.task).not.toHaveBeenCalled();
  },
);

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
    expect(host.querySelector(".update-check")).toBeNull();
  }
  expect(host.textContent).not.toContain("Roll Back");
  await act(async () => {
    f.emit("update", {
      phase: "idle",
      checkedAt: null,
      rollbackVersion: "0.9",
      blockedBy: "WORK_PENDING",
    });
    c.overlay("update-recovery");
  });
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

it("fresh Setup navigation never writes, verifies, clears credentials or invents Computer readiness", async () => {
  const { host, c, f } = await mount();
  const saved = c.getSnapshot().configuration;
  await act(async () => button(host, "Setup").click());
  expect(c.getSnapshot().destination.setupStep).toBe("overview");
  expect(
    host.querySelector('[aria-label="Setup overview"]')?.textContent,
  ).toContain("Not checked");
  for (const step of ["Sign in", "Workspaces", "Connection", "Check"]) {
    await act(async () => button(host, step).click());
    expect(c.getSnapshot().destination.area).toBe("setup");
  }
  await act(async () => button(host, "Back to overview").click());
  expect(c.getSnapshot().destination.setupStep).toBe("overview");
  expect(
    host.querySelector(
      '[data-setup-check="connection"] [data-check-state="verified"]',
    ),
  ).toBeNull();
  expect(c.getSnapshot().configuration).toBe(saved);
  await act(async () => button(host, "Set up Connection").click());
  expect(c.getSnapshot().destination.setupStep).toBe("connection");
  expect(f.api.configure).toHaveBeenCalledTimes(1);
  expect(f.api.configure).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "chatgpt.observe-sign-in" }),
  );
  expect(f.api.task).not.toHaveBeenCalled();
});

it("Setup presents a guided Overview and contextual steps with navigation-only controls", async () => {
  const { host, c, f } = await mount();
  const saved = c.getSnapshot().configuration;
  await act(async () => button(host, "Setup").click());
  const page = host.querySelector(".setup-page")!;
  const visibleHeadings = () =>
    [...page.querySelectorAll("h1,h2,h3")]
      .filter((node) => !node.closest("[hidden]"))
      .map((node) => node.textContent);
  expect(page.querySelector("h1")?.textContent).toBe("Setup");
  expect(page.querySelector(".setup-wizard-intro")?.textContent).toContain(
    "A guided path to connect ChatGPT and decide what it can access.",
  );
  expect(page.querySelectorAll(".setup-checklist-row")).toHaveLength(4);
  expect(
    page.querySelector('[data-setup-check="folders"]')?.textContent,
  ).toContain("Choose workspaces and access for each one.");
  expect(page.querySelector(".setup-wizard-footer")).toBeNull();
  await act(async () => button(page, "Set up Workspaces").click());
  expect(page.querySelector("h1")?.textContent).toBe("Workspaces");
  expect(page.querySelector(".setup-wizard-intro")?.textContent).toContain(
    "Choose what ChatGPT can read and change.",
  );
  expect(
    visibleHeadings().filter((title) => title === "Workspaces"),
  ).toHaveLength(1);
  await act(async () => button(page, "Previous").click());
  expect(c.getSnapshot().destination.setupStep).toBe("connection");
  expect(visibleHeadings()).toEqual(["Connection"]);
  const help = page.querySelector<HTMLDetailsElement>(".setup-help")!;
  expect(help.open).toBe(false);
  expect(help.textContent).toContain("Connection diagnostics");
  await act(async () => {
    help.open = true;
  });
  await act(async () => button(page, "Continue").click());
  expect(c.getSnapshot().destination.setupStep).toBe("folders");
  await act(async () => button(page, "Continue").click());
  expect(c.getSnapshot().destination.setupStep).toBe("attachment");
  expect(visibleHeadings()).toEqual(["Check"]);
  await act(async () => button(page, "Previous").click());
  expect(c.getSnapshot().destination.setupStep).toBe("folders");
  await act(async () => button(page, "Continue").click());
  await act(async () => button(page, "Back to overview").click());
  expect(c.getSnapshot().destination.setupStep).toBe("overview");
  expect(
    [...page.querySelectorAll("button")].some(
      (item) => item.textContent === "Open Home",
    ),
  ).toBe(false);
  expect(c.getSnapshot().configuration).toBe(saved);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  expect(f.api.bootstrap).toHaveBeenCalledTimes(1);
  expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
});

it("Setup keeps credential draft nodes through Overview, other steps and background status", async () => {
  const { host, c, f } = await mount();
  await act(async () => c.navigate({ area: "setup", setupStep: "connection" }));
  const inputs = host.querySelectorAll<HTMLInputElement>(
    ".connection-credentials input",
  );
  const tunnel = inputs[0]!;
  const key = inputs[1]!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setValue.call(tunnel, "draft-tunnel");
    tunnel.dispatchEvent(new Event("input", { bubbles: true }));
    setValue.call(key, "fixture-draft-key-0000000000");
    key.dispatchEvent(new Event("input", { bubbles: true }));
    key.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
  });
  for (const step of [
    "overview",
    "signin",
    "folders",
    "attachment",
    "finish",
  ] as const) {
    await act(async () => c.navigate({ area: "setup", setupStep: step }));
    expect(key.isConnected).toBe(true);
    expect(key.closest("[hidden]")).not.toBeNull();
  }
  await act(async () => f.emit("route", { state: "loaded" }));
  await act(async () => c.navigate({ area: "setup", setupStep: "connection" }));
  expect(host.querySelectorAll(".connection-credentials input")[0]).toBe(
    tunnel,
  );
  expect(host.querySelectorAll(".connection-credentials input")[1]).toBe(key);
  expect(tunnel.value).toBe("draft-tunnel");
  expect(key.value).toBe("fixture-draft-key-0000000000");
  expect(button(host, "Save & connect").disabled).toBe(false);
  await act(async () => button(host, "Save & connect").click());
  expect(f.api.configure).toHaveBeenCalledTimes(1);
  expect(f.api.configure).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "chatgpt.observe-sign-in" }),
  );
  await act(async () =>
    key.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    ),
  );
  await act(async () => button(host, "Cancel").click());
  expect(key.value).toBe("");
  expect(f.api.configure).toHaveBeenCalledTimes(1);
  expect(f.api.task).not.toHaveBeenCalled();
});

it.each(["stale", "unknown"] as const)(
  "Setup Overview and Finish never promote %s checks to Computer ready",
  async (state) => {
    const data = bootstrap();
    data.configuration.settings = homeComputerSettings();
    if (state === "stale")
      data.configuration.settings.setup.connect.verified!.runtimeGeneration =
        "e".repeat(64);
    else data.configuration.settings.setup.connect.outcomeUnknown = true;
    const { host, c, f } = await mount(data);
    for (const step of ["overview", "finish"] as const) {
      await act(async () => c.navigate({ area: "setup", setupStep: step }));
      const connection = host.querySelector('[data-setup-check="attachment"]')!;
      expect(
        connection.querySelector('[data-check-state="verified"]'),
      ).toBeNull();
      expect(
        [...host.querySelectorAll(".setup-checklist button")].some(
          (item) => item.textContent === "Open Home",
        ),
      ).toBe(false);
    }
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  },
);

it("ready Review Setup retains saved credentials and cancels replacement without any configuration effect", async () => {
  const data = bootstrap();
  data.configuration.settings = homeComputerSettings();
  const { host, c, f } = await mount(data);
  const saved = c.getSnapshot().configuration;
  await act(async () => c.navigate({ area: "settings", page: "general" }));
  await act(async () => button(host, "Review Setup").click());
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "overview",
  });
  expect(
    host.querySelectorAll(
      '.setup-checklist-row:not([data-setup-check="signin"]) .setup-check-status[data-check-state="verified"]',
    ),
  ).toHaveLength(3);
  await act(async () => button(host, "Connection").click());
  expect(host.querySelector(".credentials-saved")?.textContent).toContain(
    "Tunnel credentials saved",
  );
  await act(async () => button(host, "Edit connection").click());
  const password = host.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  expect(password.value).toBe("");
  await act(async () => button(host, "Cancel").click());
  await act(async () => button(host, "Overview").click());
  await act(async () => button(host, "Open Home").click());
  expect(c.getSnapshot().configuration).toBe(saved);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});

it("partial setup survives controller reopen with an obvious continuation and unchanged launch preference", async () => {
  const data = bootstrap();
  data.configuration.settings.computer.workspaces =
    homeComputerSettings().computer.workspaces;
  for (let lifetime = 0; lifetime < 2; lifetime++) {
    const { host, c, f } = await mount(data);
    expect(c.getSnapshot().destination.area).toBe("home");
    await act(async () => button(host, "Continue setup").click());
    expect(c.getSnapshot().destination).toMatchObject({
      area: "setup",
      setupStep: "overview",
    });
    expect(
      host.querySelector('[aria-label="Setup overview"]')?.textContent,
    ).toContain("Not checked");
    expect(data.configuration.settings.general.openAtLaunch).toBe("browser");
    expect(data.configuration.settings.computer.workspaces).toHaveLength(1);
    expect(f.api.configure).not.toHaveBeenCalled();
  }
});

it("Setup overview resumes the first incomplete step and ready review stays nondestructive", async () => {
  const partial = bootstrap();
  partial.configuration.settings.computer.workspaces =
    homeComputerSettings().computer.workspaces;
  const first = await mount(partial);
  await act(async () => button(first.host, "Setup").click());
  await act(async () => button(first.host, "Set up Connection").click());
  expect(first.c.getSnapshot().destination.setupStep).toBe("connection");
  expect(first.f.api.configure).not.toHaveBeenCalled();

  const ready = bootstrap();
  ready.configuration.settings = homeComputerSettings();
  const review = await mount(ready);
  await act(async () =>
    review.c.navigate({ area: "settings", page: "general" }),
  );
  await act(async () => button(review.host, "Review Setup").click());
  await act(async () => button(review.host, "Review Workspaces").click());
  expect(review.c.getSnapshot().destination.setupStep).toBe("folders");
  await act(async () => button(review.host, "Overview").click());
  expect(
    [...review.host.querySelectorAll("button")].filter(
      (item) => item.textContent?.trim() === "Open Home",
    ),
  ).toHaveLength(1);
  expect(review.f.api.configure).not.toHaveBeenCalled();
});

it("Home projects Computer readiness separately from optional embedded login", async () => {
  const data = bootstrap();
  data.configuration.settings = homeComputerSettings();
  const { host, c, f } = await mount(data);
  await act(async () => c.navigate({ area: "home", homeView: "access" }));
  expect(host.querySelector("main")?.textContent).toContain("Computer ready");
  expect(host.querySelector("main")?.textContent).toContain(
    "Current sign-in is unknown",
  );
  for (const page of ["folders", "computer", "connection"] as const) {
    await act(async () => c.navigate({ area: "settings", page }));
    await act(async () => c.navigate({ area: "home" }));
  }
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});
it("Home never upgrades embedded login or stale attachment to Computer ready", async () => {
  const data = bootstrap();
  data.configuration.settings.setup.chatgpt.verified =
    homeComputerSettings().setup.computer.verified;
  const { host, c, f } = await mount(data);
  await act(async () => c.navigate({ area: "home", homeView: "access" }));
  expect(host.querySelector("main")?.textContent).toContain("Setup needed");
  expect(host.querySelector("main")?.textContent).not.toContain(
    "Computer ready",
  );
  const changed = bootstrap();
  changed.configuration.settings = homeComputerSettings();
  changed.configuration.settings.setup.connect.verified!.runtimeGeneration =
    "e".repeat(64);
  vi.mocked(f.api.bootstrap).mockResolvedValue(changed);
  await act(async () => c.refresh());
  expect(host.querySelector("main")?.textContent).not.toContain(
    "Computer ready",
  );
  expect(f.api.configure).not.toHaveBeenCalled();
});
it("Setup owns a separate guided rail destination and shares existing Settings without effects", async () => {
  const { host, c, f } = await mount();
  await act(async () => button(host, "Setup").click());
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    page: "general",
    setupStep: "overview",
  });
  expect(
    host
      .querySelector('.rail [aria-label="Setup"]')
      ?.getAttribute("aria-current"),
  ).toBe("page");
  expect(
    host
      .querySelector('.rail [aria-label="Settings"]')
      ?.hasAttribute("aria-current"),
  ).toBe(false);
  expect(host.querySelector('[aria-label="Setup steps"]')).not.toBeNull();
  await act(async () => button(host, "Workspaces").click());
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    page: "folders",
  });
  expect(host.querySelector(".toolbar-title")?.textContent).toContain(
    "Workspaces",
  );
  await act(async () => button(host, "Settings").click());
  expect(c.getSnapshot().destination.page).toBe("appearance");
  expect(host.querySelector('[aria-label="Settings pages"]')).not.toBeNull();
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
});
it("Home projects current window metadata without creating a chat or exposing qualification forms", async () => {
  const { host, c, f } = await mount();
  await act(async () =>
    f.emit("tasks", { revision: 1, tasks: [task(), task("task-2")] }),
  );
  await act(async () => c.navigate({ area: "home", homeView: "work" }));
  expect(host.querySelector("main")?.textContent).toContain("Task 1");
  expect(host.querySelector("main")?.textContent).not.toMatch(
    /Check account|Read-only file preview|Saved Chat answers/,
  );
  expect(host.querySelector('.rail [aria-label="New chat"]')).toBeNull();
  expect(f.api.task).not.toHaveBeenCalled();
  await act(async () => c.navigate({ area: "chatgpt", taskId: "task-1" }));
  expect(host.querySelector(".toolbar-title strong")?.textContent).toBe(
    "ChatGPT",
  );
  expect(host.querySelector('[aria-label="Farol work"]')).toBeNull();
  expect(host.querySelector('[aria-label="New chat"]')).toBeNull();
});
it.each([
  "MODEL_ENDPOINT_UNAVAILABLE",
  "CHATGPT_SIGN_IN_IN_PROGRESS",
  "TASK_OPERATION_IN_PROGRESS",
  "SUPPORT_EXPORT_CANCELLED",
])("does not broadcast %s across unrelated pages", async (code) => {
  const { host, c, f } = await mount();
  await act(async () => f.emit("route", { state: "loaded" }));
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

// The global task-create control is retired. Keep its retained-outcome safety
// coverage through the actual facade and Diagnostics, without restoring that UI.
it.each(["full", "rail", "overlay"] as const)(
  "retained unknown creation stays observable with %s sidebar and no global resubmit",
  async (width) => {
    const { host, c, f } = await mount();
    if (width !== "full")
      await act(async () => c.toggleSidebar(width === "overlay"));
    vi.mocked(f.api.task).mockRejectedValueOnce(new Error("Create reply lost"));
    await act(async () => c.task({ kind: "task.create-chatgpt" }, "task:new"));
    const original = c.getSnapshot().intents["task:new"];
    expect(original?.state).toBe("unknown");
    expect(host.querySelector('[aria-label="New chat"]')).toBeNull();
    await act(async () => button(host, "Review unresolved actions").click());
    expect(
      host.querySelector('[aria-label="Retained actions"]')?.textContent,
    ).toContain("task:new");
    await act(async () => c.navigate({ area: "home" }));
    await act(async () => c.refresh());
    expect(c.getSnapshot().intents["task:new"]).toEqual(original);
    await act(async () => c.task({ kind: "task.create-chatgpt" }, "task:new"));
    expect(f.api.task).toHaveBeenCalledTimes(1);
  },
);
it("a late creation failure preserves the current Setup step and remains observable", async () => {
  const { host, c, f } = await mount();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValueOnce(waiting.promise);
  let result: ReturnType<typeof c.task>;
  await act(async () => {
    result = c.task({ kind: "task.create-chatgpt" }, "task:new");
  });
  await act(async () => c.navigate({ area: "setup", setupStep: "folders" }));
  await act(async () => {
    waiting.reject(new Error("Late reply lost"));
    await result;
  });
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "folders",
  });
  expect(host.querySelector("dialog")).toBeNull();
  await act(async () => button(host, "Review unresolved actions").click());
  expect(
    host.querySelector('[aria-label="Retained actions"]')?.textContent,
  ).toContain("task:new");
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

it.each([null, Date.UTC(2026, 9, 12, 10, 30)])(
  "normal idle Updates reports checkedAt %s without rollback content",
  async (checkedAt) => {
    const { host, c, f } = await mount();
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () => {
      f.emit("update", {
        phase: "idle",
        checkedAt,
        rollbackVersion: "0.9",
        blockedBy: "WORK_PENDING",
      });
      c.overlay("update");
    });
    const dialog = host.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe(
      checkedAt === null ? "Update status" : "You’re up to date",
    );
    expect(dialog.textContent).toContain(
      checkedAt === null
        ? "Update availability has not been checked."
        : "You’re up to date",
    );
    if (checkedAt !== null)
      expect(dialog.querySelector(".update-state")).toBeNull();
    expect(dialog.textContent).not.toContain("Last checked:");
    expect(dialog.textContent).not.toMatch(
      /Roll Back|roll back|restore|0\.9|WORK_PENDING/i,
    );
    expect(dialog.querySelector(".update-block")).toBeNull();
    expect(dialog.querySelector(".update-check")).toBeNull();
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
  },
);
it("does not show the previous no-update result during a new pending or unknown dialog check", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", { phase: "idle", checkedAt: 1000 });
    c.overlay("update");
  });
  expect(host.querySelector("dialog")?.textContent).toContain(
    "You’re up to date",
  );
  const pending = deferred<unknown>();
  vi.mocked(f.api.installedUpdate).mockReturnValueOnce(pending.promise);
  await act(async () => openUpdates(f));
  expect(host.querySelector("dialog")?.textContent).toContain(
    "Checking update status…",
  );
  expect(host.querySelector("dialog")?.textContent).not.toContain(
    "You’re up to date",
  );
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
    "Checking for updates",
  );
  await act(async () => pending.reject(new Error("lost response")));
  expect(host.querySelector("dialog")?.textContent).toContain(
    "Update status could not be confirmed.",
  );
  expect(host.querySelector("dialog")?.textContent).not.toContain(
    "You’re up to date",
  );
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
    "Update status unconfirmed",
  );
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => openUpdates(f));
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it("normal failed Updates omits optional rollback and keeps update checking", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", {
      phase: "failed",
      code: "UPDATE_FAILED",
      recoveryRequired: false,
      rollbackVersion: "0.9",
    });
    c.overlay("update");
  });
  const dialog = host.querySelector("dialog")!;
  expect(dialog.textContent).not.toMatch(/Roll Back|roll back|0\.9/);
  expect(dialog.querySelector(".update-block")).toBeNull();
  expect(dialog.querySelector(".update-check")).toBeNull();
});
it.each(["WORK_PENDING", "UPDATE_BROWSER_STATE_UNKNOWN"])(
  "Diagnostics rollback retains the backend admission fence %s",
  async (blockedBy) => {
    const { host, c, f } = await mount();
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () => {
      f.emit("update", {
        phase: "idle",
        checkedAt: null,
        rollbackVersion: "0.9",
        blockedBy,
      });
      c.overlay("update-recovery");
    });
    const dialog = host.querySelector("dialog")!;
    expect(dialog.querySelector(".update-block")?.textContent).toContain(
      "Roll back is blocked",
    );
    expect(dialog.querySelector(".update-block")?.textContent).toContain(
      blockedBy,
    );
    expect(button(dialog, "Roll Back").disabled).toBe(true);
    await act(async () => button(dialog, "Roll Back").click());
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
  },
);
it("Diagnostics rollback remains inspectable but disabled when the snapshot becomes stale", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => {
    f.emit("update", {
      phase: "idle",
      checkedAt: null,
      rollbackVersion: "0.9",
    });
    c.overlay("update-recovery");
    f.emit("runtime", {
      state: "offline",
      error: null,
      identity: null,
      embeddedNode: null,
      embeddedElectron: null,
    });
  });
  expect(c.getSnapshot().status).toBe("stale");
  const dialog = host.querySelector("dialog")!;
  expect(dialog.textContent).toContain("Restore previous version 0.9.");
  expect(button(dialog, "Roll Back").disabled).toBe(true);
  await act(async () => button(dialog, "Roll Back").click());
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it.each(["available", "ready"] as const)(
  "Diagnostics recovery does not acknowledge an unrelated %s update notice",
  async (phase) => {
    const { host, c, f } = await mount();
    vi.mocked(f.api.installedUpdate).mockClear();
    const notice = { key: "update-notice", seen: false, blockedBy: null };
    await act(async () => {
      f.emit("update", {
        phase,
        version: "1.0",
        deferred: false,
        ...(phase === "ready" ? { blockedBy: null } : {}),
        notice,
      });
      c.overlay("update-recovery");
    });
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
    expect(c.getSnapshot().intents["update-notice"]).toBeUndefined();
    expect(c.getSnapshot().update).toMatchObject({ phase, notice });
    await act(async () =>
      button(host.querySelector("dialog")!, "Close").click(),
    );
    expect(host.querySelector('[aria-label="Update notice"]')).not.toBeNull();
    expect(c.getSnapshot().update).toMatchObject({ phase, notice });
    expect(f.api.installedUpdate).not.toHaveBeenCalledWith({
      kind: "notice-seen",
      noticeKey: notice.key,
    });
  },
);
it("Diagnostics recovery stays isolated from Updates and closes without dispatch", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => {
    f.emit("update", {
      phase: "idle",
      checkedAt: null,
      rollbackVersion: "0.9",
    });
    c.navigate({ area: "settings", page: "diagnostics" });
  });
  const trigger = button(host, "Review recovery options");
  trigger.focus();
  await act(async () => trigger.click());
  expect(c.getSnapshot().overlay).toBe("update-recovery");
  const dialog = host.querySelector("dialog")!;
  expect(dialog.getAttribute("aria-label")).toBe("Update recovery");
  expect(dialog.textContent).toContain("Restore previous version 0.9.");
  expect(button(dialog, "Roll Back").disabled).toBe(false);
  expect(dialog.textContent).not.toContain("No updates available");
  expect(dialog.querySelector(".update-check")).toBeNull();
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
  await act(async () => button(dialog, "Cancel").click());
  expect(c.getSnapshot().overlay).toBe("none");
  expect(c.getSnapshot().destination).toMatchObject({
    area: "settings",
    page: "diagnostics",
  });
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(trigger);
  await act(async () => c.overlay("update"));
  expect(host.querySelector("dialog")?.textContent).not.toContain("Roll Back");
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it.each([
  { phase: "idle", checkedAt: null },
  { phase: "failed", code: "UPDATE_FAILED", recoveryRequired: false },
  {
    phase: "available",
    version: "1.0",
    deferred: false,
    notes: "New features",
  },
  {
    phase: "ready",
    version: "1.0",
    deferred: false,
    blockedBy: "WORK_PENDING",
  },
] satisfies WindowSnapshot["update"][])(
  "recovery overlay honestly reports unavailable restoration for %j without update controls",
  async (update) => {
    const { host, c, f } = await mount();
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () => {
      f.emit("update", update);
      c.overlay("update-recovery");
    });
    const dialog = host.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe("Update recovery");
    expect(dialog.textContent).toContain(
      "No previous version is available to restore",
    );
    expect(dialog.textContent).not.toMatch(
      /Roll Back|Check for Updates|Download Update|Install and Relaunch|Skip This Version|Remind Me Later|Update settings|What’s new|WORK_PENDING/,
    );
    expect(dialog.querySelector(".update-check")).toBeNull();
    await act(async () => button(dialog, "Done").click());
    expect(c.getSnapshot().overlay).toBe("none");
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
  },
);

// B04 DOM fixtures: presentation and dispatch fences, not native recovery proof.
it.each([
  [{ phase: "recovery", version: "1.0", blockedBy: null }, "Recover", "1.0"],
  [
    { phase: "failed", code: "RECOVERY_REQUIRED", recoveryRequired: true },
    "Recover",
    null,
  ],
  [
    { phase: "idle", checkedAt: null, rollbackVersion: "0.9" },
    "Roll Back",
    "0.9",
  ],
  [
    {
      phase: "failed",
      code: "UPDATE_FAILED",
      recoveryRequired: false,
      rollbackVersion: "0.9",
    },
    "Roll Back",
    "0.9",
  ],
] satisfies [WindowSnapshot["update"], string, string | null][])(
  "B04 %j explains closure and a separate verified start before %s",
  async (update, action, version) => {
    const { host, c, f } = await mount();
    await act(async () => {
      f.emit("update", update);
      c.overlay("update-recovery");
    });
    const copy = host
      .querySelector("dialog")!
      .textContent!.replace(/\s+/gu, " ");
    expect(copy).toContain("Farol will quit");
    expect(copy).toContain(
      "stays closed until recovery completion is confirmed",
    );
    expect(copy).toContain(
      "after confirmation, then verify that start before resuming work",
    );
    if (version) expect(copy).toContain(version);
    expect(button(host, action).disabled).toBe(false);
    expect(copy).not.toContain("restart into the new version");
    expect(f.api.installedUpdate).not.toHaveBeenCalledWith({ kind: "recover" });
    expect(f.api.installedUpdate).not.toHaveBeenCalledWith({
      kind: "rollback",
    });
  },
);
it("B04 an ordinary successful target update explains restart with its available version", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", {
      phase: "ready",
      version: "1.0",
      deferred: false,
      blockedBy: null,
    });
    c.overlay("update");
  });
  const copy = host.querySelector("dialog")!.textContent!.replace(/\s+/gu, " ");
  expect(copy).toContain("Version 1.0 is ready to install.");
  expect(copy).not.toContain("stays closed");
  expect(button(host, "Install and Relaunch").disabled).toBe(false);
  await act(async () => button(host, "Install and Relaunch").click());
  expect(f.api.installedUpdate).toHaveBeenCalledWith({
    kind: "restart-confirmed",
    version: "1.0",
  });
});
it("B04 distinguishes installed and downloaded versions and refuses an unknown-state Check", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", {
      phase: "ready",
      version: "0.2.0-owner.beta.4",
      deferred: false,
      blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    c.overlay("update");
  });
  const text = host.querySelector("dialog")!.textContent!;
  expect(text).not.toContain("Current version:");
  expect(text).toContain("Version 0.2.0 beta 4 is ready to install.");
  expect(text).toContain("close open ChatGPT sessions and interrupt work");
  expect(text).not.toContain("UPDATE_BROWSER_STATE_UNKNOWN");
  expect(text).not.toContain("Restart is blocked");
  expect(host.querySelector(".update-check")).toBeNull();
  expect(button(host, "Install and Relaunch").disabled).toBe(false);
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => openUpdates(f));
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it("native menu preserves the current destination and downloaded update without another check", async () => {
  const { c, f, host } = await mount();
  await act(async () => {
    c.navigate({ area: "settings", page: "connection" });
    f.emit("update", {
      phase: "ready",
      version: "0.2.2",
      deferred: false,
      blockedBy: null,
    });
  });
  const destination = c.getSnapshot().destination;
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => openUpdates(f));
  expect(c.getSnapshot().destination).toEqual(destination);
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
    "Ready to install",
  );
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
const boundedUpdateActions = [
  [
    { phase: "recovery", version: "1.0", blockedBy: null },
    "Recover",
    "recover",
  ],
  [
    { phase: "idle", checkedAt: null, rollbackVersion: "0.9" },
    "Roll Back",
    "rollback",
  ],
  [
    { phase: "ready", version: "1.0", deferred: false, blockedBy: null },
    "Install and Relaunch",
    "restart-confirmed",
  ],
] satisfies [
  WindowSnapshot["update"],
  string,
  "recover" | "rollback" | "restart-confirmed",
][];
it.each(boundedUpdateActions)(
  "B04 blocked current work fences %j while %s remains inspectable",
  async (update, action, kind) => {
    const { host, c, f } = await mount();
    await act(async () => {
      f.emit("update", { ...update, blockedBy: "WORK_PENDING" });
      c.overlay(kind === "restart-confirmed" ? "update" : "update-recovery");
    });
    expect(button(host, action).disabled).toBe(true);
    await act(async () => button(host, action).click());
    expect(f.api.installedUpdate).not.toHaveBeenCalledWith({ kind });
    await act(async () => button(host, "Close").click());
    expect(c.getSnapshot().overlay).toBe("none");
  },
);
it.each(boundedUpdateActions)(
  "B04 pending then unknown %j fences %s across sheet reopening",
  async (update, action, kind) => {
    const { host, c, f } = await mount();
    const operation = deferred<unknown>();
    vi.mocked(f.api.installedUpdate).mockReturnValueOnce(operation.promise);
    await act(async () => {
      f.emit("update", update);
      c.overlay(kind === "restart-confirmed" ? "update" : "update-recovery");
    });
    await act(async () => button(host, action).click());
    expect(c.getSnapshot().intents.update?.state).toBe("pending");
    expect(button(host, action).disabled).toBe(true);
    if (kind === "rollback")
      expect(host.querySelector(".update-check")).toBeNull();
    else expect(host.querySelector(".update-check")).toBeNull();
    await act(async () => button(host, action).click());
    await act(async () => operation.reject(new Error("reply lost")));
    expect(c.getSnapshot().intents.update?.state).toBe("unknown");
    expect(host.querySelector("dialog")?.textContent).toContain(
      "Outcome unknown",
    );
    await act(async () => button(host, "Close").click());
    await act(async () =>
      c.overlay(kind === "restart-confirmed" ? "update" : "update-recovery"),
    );
    expect(button(host, action).disabled).toBe(true);
    if (kind === "rollback")
      expect(host.querySelector(".update-check")).toBeNull();
    else expect(host.querySelector(".update-check")).toBeNull();
    await act(async () => button(host, action).click());
    expect(
      vi
        .mocked(f.api.installedUpdate)
        .mock.calls.filter(([command]) => command.kind === kind),
    ).toHaveLength(1);
  },
);

// Activity fixtures prove renderer projection only, not provider/native evidence.
async function activityFixture() {
  const mounted = await mount();
  await act(async () => {
    mounted.f.emit("tasks", { revision: 1, tasks: [task()] });
    for (const phase of ["completed", "outcome_unknown"] as const) {
      mounted.f.emit("event", {
        ownerId: "owner",
        sessionId: "task-1",
        taskId: "task-1",
        turnId: "task-1",
        generation: 1,
        at: phase === "completed" ? 100 : 200,
        kind: "turn.terminal",
        phase,
        code: phase === "completed" ? "COMPLETED" : "OUTCOME_UNKNOWN",
      });
    }
    mounted.c.navigate({ area: "activity", activityId: null });
  });
  return mounted;
}
async function filterActivity(host: Element, value: "all" | "attention") {
  const select = host.querySelector<HTMLSelectElement>(
    ".activity-filter select",
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("Activity uses one focused toolbar leaf with the recorded event label across history", async () => {
  const { host, c, f } = await activityFixture();
  const leaf = () =>
    host.querySelector<HTMLHeadingElement>(".toolbar-title h1");
  expect(leaf()?.textContent).toBe("Task 1");
  expect(leaf()?.tabIndex).toBe(-1);
  expect(document.activeElement).toBe(leaf());
  expect(host.querySelector(".activity-page h1")).toBeNull();
  await act(async () => {
    f.emit("tasks", {
      revision: 2,
      tasks: [{ ...task(), label: "New recorded work" }],
    });
    f.emit("event", {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: 300,
      kind: "turn.terminal",
      phase: "completed",
      code: "COMPLETED",
    });
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".activity-row")!.click(),
  );
  const newer = c.getSnapshot().destination.activityId;
  expect(leaf()?.textContent).toBe("New recorded work");
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>(".activity-row")[1]!.click(),
  );
  const older = c.getSnapshot().destination.activityId;
  expect(older).not.toBe(newer);
  expect(leaf()?.textContent).toBe("Task 1");
  await act(async () => button(host, "Back").click());
  expect(c.getSnapshot().destination.activityId).toBe(newer);
  expect(leaf()?.textContent).toBe("New recorded work");
  await act(async () => button(host, "Forward").click());
  expect(c.getSnapshot().destination.activityId).toBe(older);
  expect(leaf()?.textContent).toBe("Task 1");
  expect(f.api.task).not.toHaveBeenCalled();
  expect(f.api.configure).not.toHaveBeenCalled();
});
it("Activity toolbar leaf follows the visible filter rather than an excluded selected event", async () => {
  const { host, f } = await activityFixture();
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>(".activity-row")[1]!.click(),
  );
  expect(host.querySelector(".toolbar-title h1")?.textContent).toBe("Task 1");
  await filterActivity(host, "attention");
  expect(host.querySelector(".toolbar-title h1")?.textContent).toBe("Activity");
  expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
    "Selected event is outside this filter",
  );
  await act(async () => button(host, "Show all activity").click());
  expect(host.querySelector(".toolbar-title h1")?.textContent).toBe("Task 1");
  expect(document.activeElement).toBe(host.querySelector(".toolbar-title h1"));
  expect(f.api.task).not.toHaveBeenCalled();
});
it("Activity toolbar leaf does not invent a label for a missing event", async () => {
  const { host, c } = await activityFixture();
  await act(async () =>
    c.navigate({ area: "activity", activityId: "missing" }),
  );
  expect(host.querySelector(".toolbar-title h1")?.textContent).toBe("Activity");
  expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
    "Event no longer available",
  );
  expect(host.querySelector(".activity-page h1")).toBeNull();
});
it("Activity toolbar leaf names an empty view without a duplicated content heading", async () => {
  const { host, c } = await mount();
  await act(async () => c.navigate({ area: "activity", activityId: null }));
  expect(host.querySelector(".toolbar-title h1")?.textContent).toBe("Activity");
  expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
    "No activity yet",
  );
  expect(host.querySelector(".activity-page h1")).toBeNull();
  await filterActivity(host, "attention");
  expect(host.querySelector(".toolbar-title h1")?.textContent).toBe("Activity");
  expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
    "No events need attention",
  );
});
it("Activity contextual list filters actual unknown metadata and keeps selection stable", async () => {
  const { host, c, f } = await activityFixture();
  expect(host.querySelector(".activity-event strong")?.textContent).toBe(
    "Outcome not confirmed",
  );
  expect(host.querySelectorAll("aside .activity-row")).toHaveLength(2);
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "There is no confirmed successful or failed result.",
  );
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>(".activity-row")[1]!.click(),
  );
  const selectedId = c.getSnapshot().destination.activityId;
  await filterActivity(host, "attention");
  expect(host.querySelectorAll(".activity-row")).toHaveLength(1);
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "Selected event is outside this filter",
  );
  expect(c.getSnapshot().destination.activityId).toBe(selectedId);
  await act(async () => button(host, "Show all activity").click());
  expect(host.querySelector(".activity-event strong")?.textContent).toBe(
    "Completed event",
  );
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "A completed result was recorded.",
  );
  expect(
    host.querySelector(".activity-identifiers")?.hasAttribute("open"),
  ).toBe(false);
  expect(f.api.task).not.toHaveBeenCalled();
  expect(f.api.configure).not.toHaveBeenCalled();
});
it("Activity back and forward retain exact event identity after new events arrive", async () => {
  const { host, c, f } = await activityFixture();
  const rows = [...host.querySelectorAll<HTMLButtonElement>(".activity-row")];
  await act(async () => rows[1]!.click());
  const first = c.getSnapshot().destination.activityId;
  await act(async () => rows[0]!.click());
  const second = c.getSnapshot().destination.activityId;
  await act(async () =>
    f.emit("event", {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: 300,
      kind: "turn.terminal",
      phase: "completed",
      code: "COMPLETED",
    }),
  );
  expect(c.getSnapshot().destination.activityId).toBe(second);
  await act(async () => button(host, "Back").click());
  expect(c.getSnapshot().destination.activityId).toBe(first);
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "A completed result was recorded.",
  );
  await act(async () => button(host, "Forward").click());
  expect(c.getSnapshot().destination.activityId).toBe(second);
  expect(
    host.querySelector('.activity-row[aria-current="page"] small')?.textContent,
  ).toContain("outcome unknown");
  expect(document.activeElement).toBe(host.querySelector(".toolbar-title h1"));
});
it("Activity distinguishes first-use, attention-empty and missing selection without substitution", async () => {
  const { host, c, f } = await mount();
  await act(async () => c.navigate({ area: "activity" }));
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "No activity yet",
  );
  await filterActivity(host, "attention");
  expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
    "No events need attention",
  );
  expect(host.querySelector(".activity-empty p")?.textContent).toContain(
    "Choose All activity",
  );
  await filterActivity(host, "all");
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
      phase: "completed",
      code: "COMPLETED",
    });
  });
  await filterActivity(host, "attention");
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "No events need attention",
  );
  await filterActivity(host, "all");
  await act(async () =>
    c.navigate({ area: "activity", activityId: "expired-event" }),
  );
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "Its absence does not establish an outcome.",
  );
  expect(host.querySelector(".activity-header")).toBeNull();
  expect(host.querySelector('.activity-row[aria-current="page"]')).toBeNull();
});
it.each(["page", "dialog"] as const)(
  "Activity Show all preserves %s focus when its button disappears",
  async (surface) => {
    const { host, c, f } = await mount();
    await act(async () => c.navigate({ area: "activity" }));
    await filterActivity(host, "attention");
    if (surface === "dialog") await act(async () => c.overlay("activity"));
    const container =
      surface === "dialog"
        ? host.querySelector("dialog")!
        : host.querySelector(".activity-page")!;
    const target =
      surface === "dialog"
        ? container.querySelector('button[aria-label="Close"]')
        : host.querySelector(".toolbar-title h1");
    const trigger = button(container, "Show all activity");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    expect(host.contains(trigger)).toBe(false);
    expect(document.activeElement).toBe(target);
    expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
      "No activity yet",
    );
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
  },
);
it.each([
  "turn-reused",
  "task-replaced",
  "task-removed",
  "event-removed",
  "event-rebound",
  "stale",
  "offline",
  "observation-unavailable",
] as const)(
  "Activity rechecks View chat identity before rerender after %s",
  async (change) => {
    const { host, c, f } = await activityFixture();
    const captured = button(host, "View chat");
    const before = c.getSnapshot();
    const selected = before.activity.at(-1)!;
    let latest: WindowSnapshot = before;
    if (change === "stale") latest = { ...before, status: "stale" };
    else if (change === "offline") latest = { ...before, runtime: "offline" };
    else if (change === "event-removed") latest = { ...before, activity: [] };
    else if (change === "event-rebound")
      latest = {
        ...before,
        activity: before.activity.map((event) =>
          event.id === selected.id
            ? { ...event, turnId: "another-turn" }
            : event,
        ),
      };
    else
      latest = {
        ...before,
        tasks: {
          revision: before.tasks.revision + 1,
          tasks:
            change === "task-removed"
              ? []
              : [
                  {
                    ...before.tasks.tasks[0]!,
                    ...(change === "task-replaced"
                      ? { taskId: "replacement-task" }
                      : change === "turn-reused"
                        ? { turnId: "replacement-turn" }
                        : {
                            agent: {
                              phase: "running",
                              workspaceId: "approved",
                              parentDelivery: "not_applicable",
                              workspaceEnforcement: "verified",
                              resultAvailable: false,
                              observation: "unavailable",
                            },
                          }),
                  },
                ],
        },
      };
    const navigate = vi.spyOn(c, "navigate");
    const read = vi.spyOn(c, "getSnapshot").mockReturnValue(latest);
    await act(async () => captured.click());
    read.mockRestore();
    expect(navigate).not.toHaveBeenCalled();
    expect(c.getSnapshot().destination.area).toBe("activity");
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
  },
);
it("Activity View chat opens the same currently observed task without dispatching work", async () => {
  const { host, c, f } = await activityFixture();
  await act(async () => button(host, "View chat").click());
  expect(c.getSnapshot().destination).toMatchObject({
    area: "chatgpt",
    taskId: "task-1",
  });
  expect(f.api.task).not.toHaveBeenCalled();
  expect(f.api.configure).not.toHaveBeenCalled();
});
it.each(["turn reuse", "task removal", "task replacement"] as const)(
  "Activity retains historical inspection without opening another chat after %s",
  async (change) => {
    const { host, c, f } = await activityFixture();
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".activity-row")!.click(),
    );
    const selectedId = c.getSnapshot().destination.activityId;
    const recorded = c
      .getSnapshot()
      .activity.find((event) => event.id === selectedId)!;
    await act(async () =>
      f.emit("tasks", {
        revision: 2,
        tasks:
          change === "task removal"
            ? []
            : [
                {
                  ...task(
                    change === "task replacement"
                      ? "replacement-task"
                      : "task-1",
                  ),
                  turnId: "replacement-turn",
                  label: "Different work",
                },
              ],
      }),
    );
    expect(
      c.getSnapshot().activity.find((event) => event.id === selectedId),
    ).toBe(recorded);
    expect(host.querySelector(".toolbar-title h1")?.textContent).toBe(
      recorded.label,
    );
    expect(host.querySelector(".activity-page")?.textContent).toContain(
      "Outcome not confirmed",
    );
    expect(host.querySelector(".activity-page")?.textContent).toContain(
      "There is no confirmed successful or failed result.",
    );
    expect(host.querySelector(".activity-page")?.textContent).toContain(
      "Chat no longer available here",
    );
    expect(c.getSnapshot().destination.activityId).toBe(selectedId);
    expect(
      [...host.querySelectorAll("button")].some(
        (item) => item.textContent === "View chat",
      ),
    ).toBe(false);
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
  },
);
it("Activity retains legacy Home event inspector routing", async () => {
  const { host, c } = await activityFixture();
  await act(async () => c.overlay("activity"));
  expect(host.querySelector("dialog")?.textContent).toContain(
    "What was recorded",
  );
  await act(async () => button(host, "Close").click());
  expect(c.getSnapshot().overlay).toBe("none");
  expect(document.activeElement).toBe(host.querySelector(".toolbar-title h1"));
});
it("Activity compact selection dismisses sidebar and focuses usable inline details", async () => {
  const { host, c } = await activityFixture();
  await act(async () => c.toggleSidebar(true));
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
  await act(async () =>
    host.querySelector<HTMLButtonElement>("aside .activity-row")!.click(),
  );
  expect(c.getSnapshot().sidebar).toBe("rail");
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
  expect(host.querySelectorAll(".activity-page .activity-row")).toHaveLength(2);
  expect(document.activeElement).toBe(host.querySelector(".toolbar-title h1"));
  await filterActivity(host, "attention");
  expect(host.querySelectorAll(".activity-page .activity-row")).toHaveLength(1);
});

it.each([
  ["cancelled", "Work cancelled"],
  ["failed", "Recorded event"],
] as const)(
  "Activity summarizes a recorded %s without inventing success or recovery",
  async (phase, summary) => {
    const { host, f } = await activityFixture();
    await act(async () =>
      f.emit("event", {
        ownerId: "owner",
        sessionId: "task-1",
        taskId: "task-1",
        turnId: "task-1",
        generation: 1,
        at: 400,
        kind: "turn.terminal",
        phase,
        code: phase.toUpperCase(),
      }),
    );
    expect(host.querySelector(".activity-event strong")?.textContent).toBe(
      summary,
    );
    expect(host.querySelector(".activity-facts")?.textContent).toContain(
      phase.toUpperCase(),
    );
    expect(host.querySelector(".activity-event p")?.textContent).toBe(
      "This event does not establish successful task completion.",
    );
  },
);

it("Activity shows only recorded operation data and never promotes a computer event to task success", async () => {
  const { host, c, f } = await activityFixture();
  await act(async () => {
    f.emit("event", {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: 400,
      kind: "computer.requested",
      callId: "call-1",
      operation: "workspace.read",
    });
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".activity-row")!.click(),
  );
  expect(host.querySelector(".activity-event strong")?.textContent).toBe(
    "Computer operation requested",
  );
  expect(
    host.querySelector(".activity-event time")?.getAttribute("datetime"),
  ).toBe(new Date(400).toISOString());
  expect(host.querySelector(".activity-facts")?.textContent).toContain(
    "computer.requested",
  );
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "workspace.read",
  );
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "This event does not establish successful task completion.",
  );
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "Not recorded",
  );
  const before = c.getSnapshot().activity.length;
  await act(async () =>
    f.emit("event", {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: 401,
      kind: "text.delta",
      sequence: 1,
      text: "fixture transcript excluded from activity",
    }),
  );
  expect(c.getSnapshot().activity).toHaveLength(before);
  expect(host.textContent).not.toContain(
    "fixture transcript excluded from activity",
  );
  await act(async () =>
    f.emit("event", {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: 402,
      kind: "computer.completed",
      callId: "call-1",
    }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".activity-row")!.click(),
  );
  expect(host.querySelector(".activity-event strong")?.textContent).toBe(
    "Recorded event",
  );
  expect(host.querySelector(".activity-event p")?.textContent).toBe(
    "This event does not establish successful task completion.",
  );
});
it("Activity remains usable for a recorded timestamp outside the Date range", async () => {
  const { host, f } = await activityFixture();
  await act(async () =>
    f.emit("event", {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: Number.MAX_VALUE,
      kind: "turn.terminal",
      phase: "failed",
      code: "FAILED",
    }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".activity-row")!.click(),
  );
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "Time unavailable",
  );
  expect(host.querySelector(".activity-page")?.textContent).toContain(
    "This event does not establish successful task completion.",
  );
});

it("Activity preserves search-trigger focus when an unrelated dialog is dismissed", async () => {
  const { host } = await activityFixture();
  const trigger = button(host, "Find a page");
  trigger.focus();
  await act(async () => trigger.click());
  await act(async () => button(host, "Close").click());
  expect(document.activeElement).toBe(trigger);
});

it("retired Updates is absent from Settings navigation and page search", async () => {
  const { host, c } = await mount();
  await act(async () => c.navigate({ area: "settings", page: "general" }));
  expect(
    host.querySelector('nav[aria-label="Settings navigation"]'),
  ).not.toBeNull();
  expect(
    [
      ...host.querySelectorAll('nav[aria-label="Settings navigation"] button'),
    ].some((node) => node.textContent?.trim() === "Updates"),
  ).toBe(false);
  expect(host.querySelector(".settings-page")?.textContent).not.toContain(
    "Update status",
  );
  await act(async () => c.overlay("search"));
  const input = host.querySelector<HTMLInputElement>(
    'dialog input[aria-label="Find a page"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Updates");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(
    host.querySelector("dialog .search-results")?.textContent,
  ).not.toContain("Updates");
});
it.each<WindowSnapshot["update"]>([
  { phase: "checking" },
  { phase: "downloading" },
  { phase: "failed", code: "UPDATE_HANDOFF_UNKNOWN", recoveryRequired: false },
])(
  "native menu opens $phase without replacing it with another check",
  async (update) => {
    const { c, f, host } = await mount();
    await act(async () => f.emit("update", update));
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () => openUpdates(f));
    expect(c.getSnapshot().overlay).toBe("update");
    expect(c.getSnapshot().update).toEqual(update);
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
    expect(host.querySelector("dialog")).not.toBeNull();
  },
);
it("menu checks once immediately and suppresses concurrent checks", async () => {
  const { f, host } = await mount();
  const pending = deferred<unknown>();
  vi.mocked(f.api.installedUpdate)
    .mockClear()
    .mockReturnValueOnce(pending.promise);
  await act(async () => {
    openUpdates(f);
    openUpdates(f);
  });
  expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
    kind: "check",
  });
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
    "Checking for updates",
  );
  await act(async () => pending.resolve({ phase: "idle", checkedAt: 1000 }));
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
    "You’re up to date",
  );
  await act(async () => openUpdates(f));
  expect(f.api.installedUpdate).toHaveBeenCalledTimes(2);
});

it("dialog saves automatic download-and-install consent in both directions without restarting", async () => {
  const { host, c, f } = await mount();
  const off: WindowSnapshot["update"] = {
    phase: "idle",
    checkedAt: 1000,
    automaticUpdatePreference: {
      status: "confirmed",
      scope: "download-and-install",
      enabled: false,
    },
  };
  const on: WindowSnapshot["update"] = {
    ...off,
    automaticUpdatePreference: {
      status: "confirmed",
      scope: "download-and-install",
      enabled: true,
    },
  };
  await act(async () => {
    f.emit("update", off);
    c.overlay("update");
  });
  const checkbox = host.querySelector<HTMLInputElement>(
    'dialog input[type="checkbox"]',
  )!;
  expect(checkbox.checked).toBe(false);
  expect(host.querySelectorAll('dialog input[type="checkbox"]')).toHaveLength(
    1,
  );
  expect(host.querySelector("dialog")?.textContent).not.toContain(
    "Installation on Quit",
  );
  vi.mocked(f.api.installedUpdate).mockClear().mockResolvedValueOnce(on);
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(true);
  expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
    kind: "set-automatic-update-preference",
    scope: "download-and-install",
    enabled: true,
  });
  vi.mocked(f.api.installedUpdate).mockResolvedValueOnce(off);
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(f.api.installedUpdate).toHaveBeenLastCalledWith({
    kind: "set-automatic-update-preference",
    scope: "download-and-install",
    enabled: false,
  });
  expect(f.api.installedUpdate).toHaveBeenCalledTimes(2);
});
it("dialog retains an unknown automatic preference without permitting another save", async () => {
  const { host, c, f } = await mount();
  const off: WindowSnapshot["update"] = {
    phase: "idle",
    checkedAt: 1000,
    automaticUpdatePreference: {
      status: "confirmed",
      scope: "download-and-install",
      enabled: false,
    },
  };
  await act(async () => {
    f.emit("update", off);
    c.overlay("update");
  });
  const checkbox = host.querySelector<HTMLInputElement>(
    'dialog input[type="checkbox"]',
  )!;
  vi.mocked(f.api.installedUpdate)
    .mockClear()
    .mockResolvedValueOnce({
      ...off,
      automaticUpdatePreference: {
        status: "unknown",
        enabled: false,
        code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
      },
    });
  await act(async () => checkbox.click());
  expect(c.getSnapshot().intents["update-automatic-downloads"]?.state).toBe(
    "unknown",
  );
  expect(checkbox.disabled).toBe(true);
  expect(host.querySelector("dialog")?.textContent).toContain(
    "Do not repeat this change",
  );
  await act(async () => checkbox.click());
  expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
    kind: "set-automatic-update-preference",
    scope: "download-and-install",
    enabled: true,
  });
});

it("normal update issues direct recovery to Diagnostics without a recovery command", async () => {
  const { host, c, f } = await mount();
  await act(async () => {
    f.emit("update", { phase: "recovery", version: "0.2.2", blockedBy: null });
    c.overlay("update");
  });
  expect(
    [...host.querySelectorAll("dialog button")].map((node) => node.textContent),
  ).not.toContain("Recover");
  expect(host.querySelector("dialog")?.textContent).not.toContain(
    "stays closed until recovery completion",
  );
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => button(host, "Review Diagnostics").click());
  expect(c.getSnapshot().destination).toMatchObject({
    area: "settings",
    page: "diagnostics",
  });
  expect(c.getSnapshot().overlay).toBe("none");
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
  await act(async () => button(host, "Review recovery options").click());
  expect(c.getSnapshot().overlay).toBe("update-recovery");
  expect(button(host, "Recover").disabled).toBe(false);
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});

it("native menu rechecks an available release while its rail opens the saved offer directly", async () => {
  const { host, f, c } = await mount();
  await act(async () =>
    f.emit("update", { phase: "available", version: "0.2.2", deferred: false }),
  );
  vi.mocked(f.api.installedUpdate).mockClear();
  await act(async () => button(host, "Update available").click());
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
    "Update available",
  );
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
  await act(async () => c.overlay("none"));
  vi.mocked(f.api.installedUpdate).mockResolvedValueOnce({
    phase: "idle",
    checkedAt: 1000,
  });
  await act(async () => openUpdates(f));
  expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
    kind: "check",
  });
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
    "You’re up to date",
  );
});

it.each([
  "UPDATE_WORK_PENDING",
  "UPDATE_CONNECTOR_ACTIVE",
  "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
])(
  "menu safely rechecks %s with automatic installation off and restores manual installation",
  async (blockedBy) => {
    const { host, f, c } = await mount();
    const ready: WindowSnapshot["update"] = {
      phase: "ready",
      version: "0.2.3",
      deferred: false,
      blockedBy,
      automaticUpdatePreference: {
        status: "confirmed",
        scope: "download-and-install",
        enabled: false,
      },
    };
    await act(async () => {
      f.emit("update", ready);
      c.overlay("update");
    });
    expect(button(host, "Install and Relaunch").disabled).toBe(true);
    const pending = deferred<unknown>();
    vi.mocked(f.api.installedUpdate)
      .mockClear()
      .mockReturnValueOnce(pending.promise);
    await act(async () => {
      openUpdates(f);
      openUpdates(f);
    });
    expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "check",
    });
    await act(async () => pending.resolve({ ...ready, blockedBy: null }));
    expect(c.getSnapshot().update).toMatchObject({
      phase: "ready",
      version: "0.2.3",
      blockedBy: null,
    });
    expect(button(host, "Install and Relaunch").disabled).toBe(false);
    expect(
      host.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')
        ?.checked,
    ).toBe(false);
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
  },
);
it.each([
  null,
  "TASK_OUTCOME_UNKNOWN",
  "UPDATE_BROWSER_STATE_UNKNOWN",
  "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
  "UPDATE_UNCLASSIFIED",
])(
  "menu keeps ready %s without clearing a retained or unqualified state",
  async (blockedBy) => {
    const { f, c } = await mount();
    const ready: WindowSnapshot["update"] = {
      phase: "ready",
      version: "0.2.3",
      deferred: false,
      blockedBy,
    };
    await act(async () => f.emit("update", ready));
    vi.mocked(f.api.installedUpdate).mockClear();
    await act(async () => openUpdates(f));
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
    expect(c.getSnapshot().update).toEqual(ready);
  },
);

it("Home overview hides the default page list without changing detail or Settings preferences", async () => {
  const { host, c, f } = await mount();
  expect(c.getSnapshot().sidebar).toBe("full");
  expect(host.querySelector("aside")).toBeNull();
  expect(
    host
      .querySelector<HTMLElement>(".desktop")!
      .style.getPropertyValue("--side-width"),
  ).toBe("0px");
  await act(async () => c.navigate({ area: "home", homeView: "work" }));
  expect(host.querySelector("aside")).not.toBeNull();
  expect(f.api.layout).toHaveBeenLastCalledWith(
    "activity",
    "",
    false,
    false,
    "full",
    "none",
    232,
  );
  await act(async () =>
    c.navigate({ area: "home", homeView: "overview", homeSelection: null }),
  );
  expect(host.querySelector("aside")).toBeNull();
  await act(async () => c.navigate({ area: "settings", page: "appearance" }));
  expect(host.querySelector("aside")).not.toBeNull();
  expect(c.getSnapshot().sidebar).toBe("full");
});
it("Home page-list keyboard opening and dismissal retain usable focus at desktop width", async () => {
  const { host, c, f } = await mount();
  const trigger = button(host, "Toggle sidebar");
  trigger.focus();
  await act(async () =>
    f.emit("action", {
      action: "toggle-sidebar",
      source: "sidebar-command",
      eventId: crypto.randomUUID(),
      authWindowGeneration: null,
    }),
  );
  expect(host.querySelector(".sidebar-overlay")).not.toBeNull();
  expect(document.activeElement?.closest("aside")).not.toBeNull();
  await act(async () => c.dismissOverlay());
  expect(host.querySelector("aside")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
