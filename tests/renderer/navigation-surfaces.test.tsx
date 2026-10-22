import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  settingsPages,
  setupPages,
  homeViews,
  navigationAreas,
  sheets,
} from "../../apps/desktop/renderer/navigation-destinations";
import type { Sheet } from "../../apps/desktop/renderer/navigation-destinations";
import { unresolvedActions } from "../../apps/desktop/renderer/unresolved-actions";
import { setupSections } from "../../src/ui/renderer/setup-checklist";
import type { Destination } from "../../src/ui/renderer/contract";
import { deferred } from "./fixture";
import { mount, readySettings, workspaceId } from "./setup-fixture";

// DOM-only renderer contracts. cancel models the browser's Escape dialog event;
// no Electron, native focus, provider, filesystem or connection evidence.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.querySelector<HTMLElement>("button, input")?.focus();
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

const selector = 'dialog[aria-label="Unresolved actions"]';
const operationId = "44444444-4444-4444-8444-444444444444";
async function unknown(
  h: Awaited<ReturnType<typeof mount>>,
  id = "settings:chatgpt.open-browser:",
) {
  h.reply(async () => {
    throw new Error("scripted lost result");
  });
  await act(async () => {
    await h.c.configure({ kind: "chatgpt.open-browser" }, id);
  });
}

describe("closed renderer destinations", () => {
  const surfaces: readonly {
    name: string;
    destination: Partial<Destination>;
    selector: string;
    sheet?: Sheet;
  }[] = [
    ...navigationAreas.map((area) => ({
      name: area,
      destination: { area } as Partial<Destination>,
      selector:
        area === "home"
          ? ".home-candidate"
          : area === "setup"
            ? ".setup-page"
            : area === "settings"
              ? ".settings-page"
              : area === "activity"
                ? ".activity-page"
                : ".native-browser-placeholder",
    })),
    ...settingsPages.map((page) => ({
      name: `settings/${page}`,
      destination: { area: "settings", page } as Partial<Destination>,
      selector: ".settings-page",
    })),
    ...setupPages.map((setupStep) => ({
      name: `setup/${setupStep}`,
      destination: { area: "setup", setupStep } as Partial<Destination>,
      selector: `[data-setup-step="${setupStep}"]`,
    })),
    ...homeViews.map((homeView) => ({
      name: `home/${homeView}`,
      destination: { area: "home", homeView } as Partial<Destination>,
      selector: ".home-candidate",
    })),
    ...sheets.map((sheet) => ({
      name: `sheet/${sheet}`,
      destination: { area: "home" } as Partial<Destination>,
      selector: "dialog",
      sheet,
    })),
  ];
  it.each(surfaces)("renders a real surface for $name", async (surface) => {
    const h = await mount({ page: "general", shell: true });
    await act(async () => {
      h.c.navigate(surface.destination);
      if ("sheet" in surface) h.c.overlay(surface.sheet!);
    });
    expect(h.host.querySelector(surface.selector), surface.name).toBeTruthy();
    if (surface.name.startsWith("settings/")) {
      const selectors = {
        general: ".settings-setup-status",
        appearance: ".appearance-page",
        shortcuts: '[aria-label="Navigation shortcuts"]',
      };
      expect(
        h.host.querySelector(selectors[h.c.getSnapshot().destination.page]),
      ).toBeTruthy();
    }
  });
  it("uses the exact rendered Setup section set", () =>
    expect(setupPages).toEqual(setupSections.map(([key]) => key)));
  it.each([
    "diagnostics",
    "connection",
    "computer",
    "folders",
    "model",
    "this-mac",
    "workspaces",
    "start",
  ])(
    "rejects removed Settings destination %s without navigating",
    async (page) => {
      const h = await mount({ page: "appearance", shell: true });
      const before = h.c.getSnapshot().destination;
      await act(async () =>
        h.c.navigate({
          area: "settings",
          page,
        } as unknown as Partial<Destination>),
      );
      expect(h.c.getSnapshot().destination).toBe(before);
      expect(h.host.querySelector(".appearance-page")).toBeTruthy();
    },
  );
  it("rejects removed setup Finish without silently opening Overview", async () => {
    const h = await mount({ step: "folders", shell: true });
    const before = h.c.getSnapshot().destination;
    await act(async () =>
      h.c.navigate({
        area: "setup",
        setupStep: "finish",
      } as unknown as Partial<Destination>),
    );
    expect(h.c.getSnapshot().destination).toBe(before);
  });
});

describe("Unresolved actions sheet", () => {
  it("hides entry points when no actions are unresolved", async () => {
    const h = await mount({ page: "general", shell: true });
    expect(h.button("Review unresolved actions")).toBeUndefined();
    expect(h.host.querySelector(selector)).toBeNull();
    expect(unresolvedActions(h.c.getSnapshot())).toEqual([]);
  });
  it("shows unknown cause and retained identity, never resubmits, and restores focus after Escape", async () => {
    const h = await mount({ page: "general", shell: true });
    await unknown(h);
    const trigger = h.button("Review unresolved actions")!;
    trigger.focus();
    vi.mocked(h.f.api.configure).mockClear();
    await h.click("Review unresolved actions");
    const dialog = h.host.querySelector<HTMLDialogElement>(selector)!;
    expect(dialog.textContent).toContain(
      "The action may have taken effect; do not repeat it.",
    );
    expect(dialog.textContent).toContain("settings:chatgpt.open-browser:");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(h.f.api.configure).not.toHaveBeenCalled();
    await act(async () => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(h.host.querySelector(selector)).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(
      h.c.getSnapshot().intents["settings:chatgpt.open-browser:"]?.state,
    ).toBe("unknown");
  });
  it("lists pending only while it exists and can close without cancelling it", async () => {
    const h = await mount({ page: "general", shell: true });
    const pending = deferred<unknown>();
    h.reply(() => pending.promise);
    let request!: ReturnType<typeof h.c.configure>;
    await act(async () => {
      request = h.c.configure(
        { kind: "chatgpt.open-browser" },
        "settings:chatgpt.open-browser:",
      );
    });
    await h.click("Review unresolved actions");
    expect(h.host.querySelector(selector)?.textContent).toContain(
      "still waiting for its result",
    );
    await h.click("Close");
    expect(
      h.c.getSnapshot().intents["settings:chatgpt.open-browser:"]?.state,
    ).toBe("pending");
    await act(async () => {
      pending.resolve({ ok: true, snapshot: h.c.getSnapshot().configuration });
      await request;
    });
    expect(h.button("Review unresolved actions")).toBeUndefined();
  });
  it("reads the same pending workspace edit without applying or acknowledging it", async () => {
    const value = readySettings();
    value.computer.pendingEdit = {
      operationId,
      workspaceId,
      relativePath: "file.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-02T20:00:00.000Z",
    };
    const h = await mount({ page: "general", shell: true, value });
    await h.click("Review unresolved actions");
    expect(h.host.querySelector(selector)?.textContent).toContain(operationId);
    h.reply(() => ({
      ok: true,
      snapshot: { status: "ready", settings: value },
    }));
    await h.click("Observe existing edit");
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "computer.observe-workspace-edit",
      operationId,
    });
  });
  it("offers existing readback and support export without repeating the unknown command", async () => {
    const h = await mount({ page: "general", shell: true });
    await unknown(h);
    await act(async () => {
      await h.c.refresh();
    });
    h.reply(() => ({ ok: true, snapshot: h.c.getSnapshot().configuration }));
    vi.mocked(h.f.api.configure).mockClear();
    await h.click("Review unresolved actions");
    const save = [
      ...h.host.querySelectorAll<HTMLButtonElement>(`${selector} button`),
    ].find((button) => button.textContent === "Save support file…")!;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "support.export",
    });
    vi.mocked(h.f.api.configure).mockClear();
    await h.click("Refresh status");
    expect(h.f.api.configure).not.toHaveBeenCalled();
    expect(
      h.c.getSnapshot().intents["settings:chatgpt.open-browser:"]?.state,
    ).toBe("unknown");
  });
});

// Inventory of controls that formerly linked to retired Settings pages. The
// assertions click the rendered control and check its actual destination.
describe("former callers open their real home", () => {
  const callers = [
    {
      name: "shell unresolved rail action",
      from: "rail",
      to: "unresolved-actions",
      control: '[aria-label="Review unresolved actions"]',
    },
    {
      name: "ChatGPT placeholder unresolved action",
      from: "browser",
      to: "unresolved-actions",
      control: ".native-browser-placeholder button",
    },
    {
      name: "update sheet action-details link",
      from: "update",
      to: "unresolved-actions",
      text: "Unresolved actions",
    },
    {
      name: "Home attention action row",
      from: "attention",
      to: "unresolved-actions",
      control: ".home-candidate-issue",
      text: "An action needs review",
    },
    {
      name: "Home attention inspector action-details link",
      from: "inspector",
      to: "unresolved-actions",
      text: "Inspect action details",
    },
    {
      name: "Chat options action-details link",
      from: "task",
      to: "unresolved-actions",
      text: "Inspect action details",
    },
    {
      name: "Home connection footer",
      from: "work",
      to: "connection",
      control: ".home-candidate-connection-link",
    },
    {
      name: "Home connection readiness",
      from: "overview",
      to: "connection",
      control: ".home-candidate-status-row",
      text: "Connection settings",
    },
    {
      name: "Home workspace readiness",
      from: "overview",
      to: "folders",
      control: ".home-candidate-status-row",
      text: "Manage access",
    },
    {
      name: "Home access manage connection",
      from: "access",
      to: "connection",
      text: "Manage connection",
    },
    {
      name: "Home access manage workspaces",
      from: "access",
      to: "folders",
      text: "Manage workspaces",
    },
    {
      name: "Home workspace issue row",
      from: "folder-row",
      to: "folders",
      control: ".home-candidate-issue",
      text: "needs an access check",
    },
    {
      name: "Home workspace inspector",
      from: "folder-inspector",
      to: "folders",
      text: "Manage workspaces",
    },
  ];
  it.each(callers)("$name → $to", async (caller) => {
    const value = readySettings();
    value.connectors.secureMcp.runtime = null;
    value.computer.workspaces[0]!.accessCheck = null;
    const h = await mount({ page: "general", shell: true, value });
    if (
      ["rail", "browser", "update", "attention", "inspector"].includes(
        caller.from,
      )
    )
      await unknown(h);
    await act(async () => {
      if (caller.from === "browser") h.c.navigate({ area: "chatgpt" });
      else if (caller.from === "update") {
        h.f.emit("update", {
          phase: "failed",
          code: "UPDATE_FAILED",
          recoveryRequired: false,
        });
        h.c.overlay("update");
      } else if (
        [
          "overview",
          "work",
          "access",
          "attention",
          "inspector",
          "folder-row",
          "folder-inspector",
        ].includes(caller.from)
      ) {
        h.c.navigate({
          area: "home",
          homeView:
            caller.from === "work"
              ? "work"
              : caller.from === "access"
                ? "access"
                : ["attention", "folder-row"].includes(caller.from)
                  ? "attention"
                  : "overview",
          homeSelection:
            caller.from === "inspector"
              ? {
                  kind: "attention",
                  id: "intent:settings:chatgpt.open-browser:",
                }
              : caller.from === "folder-inspector"
                ? { kind: "attention", id: `folder:${workspaceId}` }
                : null,
        });
      } else if (caller.from === "task") {
        h.f.emit("tasks", {
          revision: 1,
          tasks: [
            {
              taskId: "task-1",
              sessionId: "task-1",
              turnId: "task-1",
              label: "Chat",
              provider: "chatgpt",
              requestedModel: null,
              observedModel: null,
              requestedMode: null,
              observedMode: null,
              hasComputer: false,
              pinned: false,
              lifecycle: "idle",
            },
          ],
        });
        h.c.navigate({ area: "home", taskId: "task-1" });
      }
    });
    if (caller.from === "task") {
      vi.mocked(h.f.api.task).mockRejectedValueOnce(
        new Error("lost task result"),
      );
      await act(async () => {
        await h.c.task(
          { kind: "task.rename", taskId: "task-1", label: "New" },
          "rename:task-1",
        );
        h.c.overlay("task");
      });
    }
    const controls = [
      ...h.host.querySelectorAll<HTMLButtonElement>(caller.control ?? "button"),
    ];
    const control = controls.find(
      (button) => !caller.text || button.textContent?.includes(caller.text),
    );
    expect(control, caller.name).toBeTruthy();
    vi.mocked(h.f.api.configure).mockClear();
    vi.mocked(h.f.api.task).mockClear();
    await act(async () => control!.click());
    if (caller.to === "unresolved-actions") {
      expect(h.host.querySelector(selector)).toBeTruthy();
      expect(h.c.getSnapshot().overlay).toBe("unresolved-actions");
    } else {
      expect(
        h.host.querySelector(`[data-setup-step="${caller.to}"]`),
      ).toBeTruthy();
      expect(h.c.getSnapshot().destination).toMatchObject({
        area: "setup",
        setupStep: caller.to,
      });
    }
    expect(h.f.api.configure).not.toHaveBeenCalled();
    expect(h.f.api.task).not.toHaveBeenCalled();
  });
});

describe("unresolved operation boundaries", () => {
  it("does not accept a sheet that has no renderer", async () => {
    const h = await mount({ page: "general", shell: true });
    await act(async () => h.c.overlay("diagnostics" as never));
    expect(h.c.getSnapshot().overlay).toBe("none");
    expect(h.host.querySelector("dialog")).toBeNull();
  });
  it("shows saved unknown checks and update recovery without sending a recovery command", async () => {
    const value = readySettings();
    value.setup.chatgpt.outcomeUnknown = true;
    const h = await mount({ page: "general", shell: true, value });
    vi.mocked(h.f.api.installedUpdate).mockClear();
    await act(async () =>
      h.f.emit("update", {
        phase: "recovery",
        version: "0.2.7",
        blockedBy: null,
      }),
    );
    await h.click("Review unresolved actions");
    const dialog = h.host.querySelector(selector)!;
    expect(dialog.textContent).toContain("ChatGPT sign-in");
    expect(dialog.textContent).toContain(
      "An earlier update has no confirmed completion",
    );
    await h.click("Review recovery options");
    expect(h.c.getSnapshot().overlay).toBe("update-recovery");
    expect(
      h.host.querySelector('dialog[aria-label="Update recovery"]'),
    ).toBeTruthy();
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("does not repeat an unknown workspace readback", async () => {
    const value = readySettings();
    value.computer.pendingEdit = {
      operationId,
      workspaceId,
      relativePath: "file.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-02T20:00:00.000Z",
    };
    const h = await mount({ page: "general", shell: true, value });
    h.reply(async () => {
      throw new Error("readback lost");
    });
    await h.click("Review unresolved actions");
    await h.click("Observe existing edit");
    expect(h.button("Observe existing edit")?.disabled).toBe(true);
    await h.click("Observe existing edit");
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "computer.observe-workspace-edit",
      operationId,
    });
    expect(h.c.getSnapshot().intents[`observe:${operationId}`]?.state).toBe(
      "unknown",
    );
  });
  it("does not repeat an export whose result is unknown after reopening", async () => {
    const value = readySettings();
    value.setup.chatgpt.outcomeUnknown = true;
    const h = await mount({ page: "appearance", shell: true, value });
    await h.click("Review unresolved actions");
    h.reply(async () => {
      throw new Error("export lost");
    });
    await h.click("Save support file…");
    await h.click("Close");
    await act(async () => h.c.refresh());
    await h.click("Review unresolved actions");
    expect(h.button("Save support file…")?.disabled).toBe(true);
    await h.click("Save support file…");
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "support.export",
    });
  });
});
