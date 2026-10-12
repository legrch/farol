import { randomUUID } from "node:crypto";
import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/ui/renderer/settings";
import { Home } from "../../src/ui/renderer/home";
import { Setup } from "../../src/ui/renderer/setup";
import { WindowController } from "../../src/ui/renderer/controller";
import type {
  SettingsPage,
  WindowSnapshot,
} from "../../src/ui/renderer/contract";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
} from "../../src/pkg/product-settings/contract";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import { bootstrap, deferred, fixture, settings, signInReply } from "./fixture";

const quitChoiceLabel = "Install downloaded updates when I quit Farol";
const quitOff: WindowSnapshot["update"] = {
  phase: "idle",
  checkedAt: null,
  automaticUpdatePreference: { status: "confirmed", enabled: false },
  installOnQuitPreference: {
    status: "confirmed",
    scope: "install-on-normal-quit",
    enabled: false,
  },
};
function quitCheckbox(host: Element): HTMLInputElement {
  const label = [...host.querySelectorAll("label")].find((node) =>
    node.textContent?.includes(quitChoiceLabel),
  );
  const input = label?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!input) throw new Error("QUIT_CHOICE_MISSING");
  return input;
}

describe("explicit normal Quit installation choice", () => {
  it("saves only explicit quit consent once, independently of automatic downloads", async () => {
    const h = await mount("updates", settings(), "preview", quitOff);
    const checkbox = quitCheckbox(h.host);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.closest("label")?.textContent).toContain(quitChoiceLabel);
    expect(
      document.getElementById(checkbox.getAttribute("aria-describedby")!),
    ).not.toBeNull();
    expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "status",
    });
    expect(h.host.textContent).toContain(
      "Automatic downloads do not grant permission to install",
    );
    vi.mocked(h.f.api.installedUpdate).mockClear();
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.installedUpdate).mockReturnValueOnce(pending.promise);
    await act(async () => {
      checkbox.click();
      checkbox.click();
    });
    expect(h.c.getSnapshot().intents["update-install-on-quit"]).toEqual({
      id: "update-install-on-quit",
      state: "pending",
      code: null,
    });
    expect(quitCheckbox(h.host).disabled).toBe(true);
    expect(h.button("Turn on automatic downloads").disabled).toBe(true);
    const on: WindowSnapshot["update"] = {
      ...quitOff,
      installOnQuitPreference: {
        status: "confirmed",
        scope: "install-on-normal-quit",
        enabled: true,
      },
    };
    await act(async () => pending.resolve(on));
    expect(quitCheckbox(h.host).checked).toBe(true);
    expect(h.c.getSnapshot().intents["update-install-on-quit"]?.state).toBe(
      "applied",
    );
    expect(
      h.c.getSnapshot().intents["update-automatic-downloads"],
    ).toBeUndefined();
    expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "set-install-on-quit-preference",
      enabled: true,
    });
    expect(h.host.textContent).toContain("Farol stays closed");
    vi.mocked(h.f.api.installedUpdate).mockResolvedValueOnce({
      ...on,
      automaticUpdatePreference: { status: "confirmed", enabled: true },
    });
    await h.click("Turn on automatic downloads");
    expect(h.c.getSnapshot().update.installOnQuitPreference).toEqual(
      on.installOnQuitPreference,
    );
    expect(h.c.getSnapshot().intents["update-install-on-quit"]?.state).toBe(
      "applied",
    );
    vi.mocked(h.f.api.installedUpdate).mockResolvedValueOnce({
      ...quitOff,
      automaticUpdatePreference: { status: "confirmed", enabled: true },
    });
    await act(async () => quitCheckbox(h.host).click());
    expect(h.f.api.installedUpdate).toHaveBeenLastCalledWith({
      kind: "set-install-on-quit-preference",
      enabled: false,
    });
    expect(quitCheckbox(h.host).checked).toBe(false);
    expect(h.c.getSnapshot().update.automaticUpdatePreference).toEqual({
      status: "confirmed",
      enabled: true,
    });
    expect(h.f.api.installedUpdate).toHaveBeenCalledTimes(3);
    expect(h.calls()).toEqual([]);
  });

  it("retains the original unknown choice after refresh, remount and late confirmed events", async () => {
    const h = await mount("updates", settings(), "preview", quitOff);
    vi.mocked(h.f.api.installedUpdate).mockClear();
    vi.mocked(h.f.api.installedUpdate).mockRejectedValueOnce(
      new Error("reply lost"),
    );
    await act(async () => quitCheckbox(h.host).click());
    const original = h.c.getSnapshot().intents["update-install-on-quit"];
    expect(original).toMatchObject({
      id: "update-install-on-quit",
      state: "unknown",
    });
    await act(async () => h.c.refresh());
    await act(async () => h.f.emit("update", quitOff));
    await h.pageTo("diagnostics");
    await h.pageTo("updates");
    await h.remount();
    expect(h.c.getSnapshot().intents["update-install-on-quit"]).toBe(original);
    expect(quitCheckbox(h.host).disabled).toBe(true);
    expect(h.host.textContent).toContain(
      "Do not repeat this change; review Diagnostics",
    );
    expect(h.button("View update").disabled).toBe(false);
    await h.click("View update");
    await act(async () => quitCheckbox(h.host).click());
    expect(await h.c.setInstallOnQuitPreference(true)).toBe(original);
    expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "set-install-on-quit-preference",
      enabled: true,
    });
  });

  it.each([
    undefined,
    {
      status: "blocked",
      enabled: false,
      code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
    },
    {
      status: "unknown",
      enabled: false,
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    },
  ] satisfies WindowSnapshot["update"]["installOnQuitPreference"][])(
    "fails closed for unconfirmed quit consent %j but leaves review available",
    async (preference) => {
      const update = { ...quitOff };
      delete update.installOnQuitPreference;
      if (preference) update.installOnQuitPreference = preference;
      const h = await mount("updates", settings(), "preview", update);
      expect(quitCheckbox(h.host).disabled).toBe(true);
      expect(quitCheckbox(h.host).checked).toBe(false);
      expect(h.host.textContent).toContain(
        "Off. Quit installation preference cannot be confirmed",
      );
      expect(h.button("View update").disabled).toBe(false);
      vi.mocked(h.f.api.installedUpdate).mockClear();
      await act(async () => quitCheckbox(h.host).click());
      await h.click("View update");
      expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
    },
  );

  it("rechecks latest quit eligibility before a rendered checkbox dispatches", async () => {
    const h = await mount("updates", settings(), "preview", quitOff);
    const input = quitCheckbox(h.host);
    vi.mocked(h.f.api.installedUpdate).mockClear();
    const read = vi
      .spyOn(h.c, "getSnapshot")
      .mockReturnValue({ ...h.c.getSnapshot(), environment: "dev" });
    await act(async () => input.click());
    read.mockRestore();
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
  });

  it("disables quit consent for an idle update with unknown admission while review stays available", async () => {
    const h = await mount("updates", settings(), "preview", {
      ...quitOff,
      blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(quitCheckbox(h.host).disabled).toBe(true);
    expect(h.button("View update").disabled).toBe(false);
    vi.mocked(h.f.api.installedUpdate).mockClear();
    await act(async () => quitCheckbox(h.host).click());
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
  });

  it("never offers quit installation in Dev even with a confirmed enabled projection", async () => {
    const h = await mount("updates", settings(), "dev", {
      ...quitOff,
      installOnQuitPreference: {
        status: "confirmed",
        scope: "install-on-normal-quit",
        enabled: true,
      },
    });
    expect(
      activePage(h.host).querySelector('input[type="checkbox"]'),
    ).toBeNull();
    vi.mocked(h.f.api.installedUpdate).mockClear();
    expect((await h.c.setInstallOnQuitPreference(false)).state).toBe("refused");
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
  });
});

// DOM/adapter fixtures only: no native chooser, filesystem, provider or updater proof.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const controllers: WindowController[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const c of controllers.splice(0)) c.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const workspaceId = "22222222-2222-4222-8222-222222222222";
const selectionId = "33333333-3333-4333-8333-333333333333";
function withFolder() {
  const value = settings();
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: ["/approved/project/private"],
      rootIdentity: { device: "1", inode: "2" },
    },
  ];
  return ProductSettingsSchema.parse(value);
}
async function mount(
  page: SettingsPage = "general",
  value: ProductSettings = settings(),
  environment: "preview" | "dev" = "preview",
  update: WindowSnapshot["update"] = { phase: "idle", checkedAt: null },
  setupStep?: "signin" | "connection" | "folders" | "attachment",
  wizard = false,
  signInState: "authenticated" | "signed_out" | "unknown" = "signed_out",
  home = false,
) {
  Object.assign(globalThis.crypto, { randomUUID });
  let activeSetupStep = setupStep;
  const f = fixture();
  vi.mocked(f.api.installedUpdate).mockResolvedValue(update);
  const configuration = { status: "ready" as const, settings: value };
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    environment,
    configuration,
  });
  vi.mocked(f.api.configure).mockImplementation(async (command) =>
    command.kind === "chatgpt.observe-sign-in"
      ? signInReply(command, signInState, configuration)
      : {
          ok: true,
          snapshot: configuration,
          ...(command.kind === "connector.save-and-connect"
            ? {
                connectorSetup: {
                  kind: "connector.save-and-connect",
                  operationId: command.operationId,
                  buildId: command.buildId,
                  state: "completed",
                  stoppedAt: "complete",
                  credentials: "saved",
                  connection: "connected",
                  code: null,
                  externalVerification: "not-proven",
                },
              }
            : {}),
        },
  );
  const c = new WindowController(f.api);
  await c.start();
  c.navigate(
    wizard
      ? { area: "setup", setupStep: setupStep ?? "overview" }
      : { area: "settings", page },
  );
  controllers.push(c);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    if (wizard && snapshot.destination.area === "setup")
      return <Setup snapshot={snapshot} facade={c} />;
    if (home && snapshot.destination.area === "home")
      return <Home snapshot={snapshot} facade={c} />;
    return snapshot.destination.area === "settings" ? (
      <Settings snapshot={snapshot} facade={c} setupStep={activeSetupStep} />
    ) : null;
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <View />
      </StrictMode>,
    ),
  );
  const visible = (element: Element) => !element.closest("[hidden]");
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (item) => visible(item) && item.textContent === text,
    );
    if (!found) throw new Error(`Button not found: ${text}`);
    return found;
  };
  const field = (text: string) => {
    const label = [...host.querySelectorAll("label")].find(
      (item) =>
        visible(item) &&
        [...item.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join("")
          .trim() === text,
    );
    const found = label?.querySelector<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input,select,textarea");
    if (!found) throw new Error(`Field not found: ${text}`);
    return found;
  };
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  const pageTo = async (next: SettingsPage) => {
    await act(async () => c.navigate({ page: next }));
  };
  const calls = () =>
    vi.mocked(f.api.configure).mock.calls.map(([command]) => command);
  return {
    f,
    c,
    host,
    root,
    button,
    field,
    click,
    pageTo,
    calls,
    configuration,
    async stepTo(step: "signin" | "connection" | "folders" | "attachment") {
      if (wizard) {
        await act(async () => c.navigate({ area: "setup", setupStep: step }));
        return;
      }
      activeSetupStep = step;
      await act(async () =>
        root.render(
          <StrictMode>
            <View />
          </StrictMode>,
        ),
      );
    },
    async remount() {
      await act(async () => root.render(null));
      await act(async () =>
        root.render(
          <StrictMode>
            <View />
          </StrictMode>,
        ),
      );
    },
  };
}
async function change(
  field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      field instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
// Current React + controller/API fixtures only; no native host/filesystem proof.
describe("compact workspace detail", () => {
  async function refresh(
    h: Awaited<ReturnType<typeof mount>>,
    value: ProductSettings,
  ) {
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: { status: "ready", settings: value },
    });
    await act(async () => h.c.refresh());
  }
  async function select(h: Awaited<ReturnType<typeof mount>>, name: string) {
    const button = activePage(h.host).querySelector<HTMLButtonElement>(
      `[aria-label="Select workspace ${name}"]`,
    )!;
    await act(async () => button.click());
    return button;
  }
  function twoWorkspaces() {
    const value = connectionSettings();
    value.computer.workspaces.push({
      ...structuredClone(value.computer.workspaces[0]!),
      workspaceId: selectionId,
      root: "/approved/second",
      rootIdentity: { device: "1", inode: "3" },
      excludedPaths: [],
    });
    return ProductSettingsSchema.parse(value);
  }
  const status = (h: Awaited<ReturnType<typeof mount>>) =>
    activePage(h.host).querySelector(".workspace-feedback")!;
  it("opens Home's exact second workspace through history, refresh and removal without changing access", async () => {
    const value = twoWorkspaces();
    const h = await mount(
      "folders",
      value,
      "preview",
      undefined,
      undefined,
      false,
      "signed_out",
      true,
    );
    const configuration = h.c.getSnapshot().configuration;
    const binding = value.setup.computer.verified;
    await act(async () =>
      h.c.navigate({
        area: "home",
        homeView: "attention",
        homeSelection: { kind: "attention", id: `folder:${selectionId}` },
      }),
    );
    expect(h.host.textContent).toContain("second needs an access check");
    await act(async () =>
      h.host
        .querySelector<HTMLButtonElement>(".home-candidate-actions button")!
        .click(),
    );
    const selected = () =>
      activePage(h.host).querySelector(
        '.workspace-choice[aria-current="true"]',
      );
    expect(selected()?.getAttribute("aria-label")).toBe(
      "Select workspace second",
    );
    expect(
      activePage(h.host)
        .querySelector(".workspace-detail")
        ?.getAttribute("aria-label"),
    ).toBe("Workspace second");
    expect(h.c.getSnapshot().configuration).toBe(configuration);
    await act(async () => h.c.travel(-1));
    expect(h.host.textContent).toContain("second needs an access check");
    await act(async () => h.c.travel(1));
    expect(selected()?.getAttribute("aria-label")).toBe(
      "Select workspace second",
    );
    await refresh(h, structuredClone(value));
    expect(selected()?.getAttribute("aria-label")).toBe(
      "Select workspace second",
    );
    const removed = structuredClone(value);
    removed.revision++;
    removed.computer.workspaces = removed.computer.workspaces.filter(
      (workspace) => workspace.workspaceId !== selectionId,
    );
    await refresh(h, removed);
    expect(activePage(h.host).textContent).toContain(
      "Selected workspace is no longer available",
    );
    expect(selected()).toBeNull();
    expect(activePage(h.host).querySelector(".workspace-detail")).toBeNull();
    const remaining = activePage(h.host).querySelector(
      '[aria-label="Select workspace project"]',
    )!;
    expect(
      document.getElementById(remaining.getAttribute("aria-controls")!)
        ?.textContent,
    ).toContain("Selected workspace is no longer available");
    expect(h.c.getSnapshot().destination.workspaceId).toBe(selectionId);
    const current = h.c.getSnapshot().configuration;
    expect(
      current?.status === "ready" && current.settings.setup.computer.verified,
    ).toEqual(binding);
    expect(h.calls()).toEqual([]);
    expect(h.f.api.task).not.toHaveBeenCalled();
    expect(h.f.api.snapshot).not.toHaveBeenCalled();
    await select(h, "project");
    expect(selected()?.getAttribute("aria-label")).toBe(
      "Select workspace project",
    );
    expect(h.calls()).toEqual([]);
  });
  it("keeps an unavailable explicit workspace separate from a generic Workspace entry", async () => {
    const h = await mount(
      "folders",
      twoWorkspaces(),
      "preview",
      undefined,
      undefined,
      false,
      "signed_out",
      true,
    );
    await act(async () =>
      h.c.navigate({
        area: "settings",
        page: "folders",
        workspaceId: "removed",
      }),
    );
    expect(activePage(h.host).textContent).toContain(
      "Selected workspace is no longer available",
    );
    expect(activePage(h.host).querySelector(".workspace-detail")).toBeNull();
    await act(async () => h.c.navigate({ area: "home" }));
    await act(async () => h.c.navigate({ area: "settings", page: "folders" }));
    expect(
      activePage(h.host)
        .querySelector('.workspace-choice[aria-current="true"]')
        ?.getAttribute("aria-label"),
    ).toBe("Select workspace project");
    expect(h.calls()).toEqual([]);
    expect(h.f.api.task).not.toHaveBeenCalled();
  });
  it("selects with native buttons and keeps active Computer binding unchanged across background updates", async () => {
    const value = twoWorkspaces();
    const h = await mount("folders", value);
    const button = await select(h, "second");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-current")).toBe("true");
    const detail = document.getElementById(
      button.getAttribute("aria-controls")!,
    );
    expect(detail?.getAttribute("aria-label")).toBe("Workspace second");
    expect(detail?.textContent).toContain("Saved access: Read-only");
    expect(detail?.textContent).toContain("Check access needed");
    await act(async () => h.f.emit("route", { state: "loaded" }));
    await h.pageTo("connection");
    await h.pageTo("folders");
    await refresh(h, structuredClone(value));
    expect(button.getAttribute("aria-current")).toBe("true");
    expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
    const configuration = h.c.getSnapshot().configuration;
    expect(
      configuration?.status === "ready" &&
        configuration.settings.setup.computer.verified?.workspaceId,
    ).toBe(workspaceId);
    expect(h.calls()).toEqual([]);
  });
  it("opens the exact workspace returned by an approved selection, including an existing root", async () => {
    const h = await mount("folders", twoWorkspaces());
    vi.mocked(h.f.api.configure)
      .mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: {
          kind: "computer.workspace-pick",
          selectionId,
          displayPath: "/approved/second",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: {
          kind: "computer.workspace-selection",
          workspaceId: selectionId,
        },
      });
    await h.click("Add workspace…");
    expect(
      activePage(h.host)
        .querySelector('[aria-label="Select workspace second"]')
        ?.getAttribute("aria-current"),
    ).toBe("true");
    expect(h.calls()).toEqual([
      { kind: "computer.choose-workspace" },
      { kind: "computer.add-workspace", selectionId, access: "write" },
      { kind: "connector.stop" },
    ]);
  });
  it.each([
    { inspect: "second", approved: workspaceId },
    { inspect: "project", approved: selectionId },
  ])(
    "keeps a newer $inspect inspection when an earlier approval finishes",
    async ({ inspect, approved }) => {
      const h = await mount("folders", twoWorkspaces());
      const approval = deferred<unknown>();
      vi.mocked(h.f.api.configure)
        .mockResolvedValueOnce({
          ok: true,
          snapshot: h.configuration,
          evidence: {
            kind: "computer.workspace-pick",
            selectionId,
            displayPath: "/approved/project",
          },
        })
        .mockReturnValueOnce(approval.promise);
      await h.click("Add workspace…");
      await select(h, inspect);
      await act(async () =>
        approval.resolve({
          ok: true,
          snapshot: h.configuration,
          evidence: {
            kind: "computer.workspace-selection",
            workspaceId: approved,
          },
        }),
      );
      expect(
        h.c.getSnapshot().intents["settings:computer.add-workspace:"],
      ).toMatchObject({ state: "applied" });
      expect(
        activePage(h.host)
          .querySelector('.workspace-choice[aria-current="true"]')
          ?.getAttribute("aria-label"),
      ).toBe(`Select workspace ${inspect}`);
      expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
      expect(h.calls()).toEqual([
        { kind: "computer.choose-workspace" },
        { kind: "computer.add-workspace", selectionId, access: "write" },
        { kind: "connector.stop" },
      ]);
    },
  );
  it("retains a newer workspace destination after a late approval and generic reentry", async () => {
    const h = await mount("folders", twoWorkspaces());
    const approval = deferred<unknown>();
    vi.mocked(h.f.api.configure)
      .mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: {
          kind: "computer.workspace-pick",
          selectionId,
          displayPath: "/approved/project",
        },
      })
      .mockReturnValueOnce(approval.promise);
    await h.click("Add workspace…");
    await act(async () =>
      h.c.navigate({
        area: "settings",
        page: "folders",
        workspaceId: selectionId,
      }),
    );
    await act(async () =>
      approval.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: { kind: "computer.workspace-selection", workspaceId },
      }),
    );
    expect(
      activePage(h.host)
        .querySelector('.workspace-choice[aria-current="true"]')
        ?.getAttribute("aria-label"),
    ).toBe("Select workspace second");
    await act(async () => h.c.navigate({ workspaceId: null }));
    expect(
      activePage(h.host)
        .querySelector('.workspace-choice[aria-current="true"]')
        ?.getAttribute("aria-label"),
    ).toBe("Select workspace second");
    expect(
      h.c.getSnapshot().intents["settings:computer.add-workspace:"],
    ).toMatchObject({ state: "applied" });
    expect(h.calls()).toHaveLength(3);
  });
  it("retains a newer workspace inspection after history restores the approval origin", async () => {
    const h = await mount("folders", twoWorkspaces());
    const approval = deferred<unknown>();
    vi.mocked(h.f.api.configure)
      .mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: {
          kind: "computer.workspace-pick",
          selectionId,
          displayPath: "/approved/project",
        },
      })
      .mockReturnValueOnce(approval.promise);
    await h.click("Add workspace…");
    const origin = h.c.getSnapshot().destination;
    await act(async () =>
      h.c.navigate({
        area: "settings",
        page: "folders",
        workspaceId: selectionId,
      }),
    );
    await act(async () => h.c.travel(-1));
    expect(h.c.getSnapshot().destination).toBe(origin);
    await act(async () =>
      approval.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: { kind: "computer.workspace-selection", workspaceId },
      }),
    );
    expect(
      activePage(h.host)
        .querySelector('.workspace-choice[aria-current="true"]')
        ?.getAttribute("aria-label"),
    ).toBe("Select workspace second");
    expect(
      h.c.getSnapshot().intents["settings:computer.add-workspace:"],
    ).toMatchObject({ state: "applied" });
    expect(h.calls()).toHaveLength(3);
  });
  it("checks the current verified workspace read-only and retains its binding", async () => {
    const value = connectionSettings();
    const h = await mount("folders", value);
    expect(h.button("Verify workspace").className).toBe("primary");
    expect(() => h.button("Check access")).toThrow();
    await h.click("Verify workspace");
    expect(h.calls()).toEqual([{ kind: "computer.check-folder", workspaceId }]);
    expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
    expect(status(h).textContent).toContain(
      "Workspace access checked: /approved/project",
    );
  });
  it.each([
    "absent",
    "build",
    "generation",
    "identity",
    "unreachable",
  ] as const)(
    "uses the existing guarded verification when the current witness is %s",
    async (stale) => {
      const value = connectionSettings();
      if (stale === "absent") value.setup.computer.verified = null;
      if (stale === "build")
        value.setup.computer.verified!.buildId = "f".repeat(64);
      if (stale === "generation") value.computer.generation++;
      if (stale === "identity")
        value.computer.workspaces[0]!.accessCheck = {
          buildId: "3".repeat(64),
          computerGeneration: value.computer.generation,
          rootIdentity: { device: "1", inode: "999" },
          verifiedAt: "2026-10-02T20:00:00.000Z",
        };
      if (stale === "unreachable")
        value.setup.computer.reachable = "unreachable";
      const h = await mount("folders", value);
      await h.click("Verify workspace");
      expect(h.calls()).toEqual([
        { kind: "computer.verify-workspace", workspaceId },
      ]);
    },
  );
  it("shows an exact host stop refusal next to the selected detail and uses existing Diagnostics navigation", async () => {
    const h = await mount("folders", twoWorkspaces());
    await select(h, "second");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "CONNECTOR_STOP_REQUIRED",
      snapshot: h.configuration,
    });
    await h.click("Verify workspace");
    expect(
      h.c.getSnapshot().intents[
        `settings:computer.verify-workspace:${selectionId}`
      ],
    ).toEqual({
      id: `settings:computer.verify-workspace:${selectionId}`,
      state: "refused",
      code: "CONNECTOR_STOP_REQUIRED",
    });
    expect(status(h).textContent).toContain("choose Stop connection");
    expect(status(h).textContent).toContain("will not stop it automatically");
    expect(
      activePage(h.host)
        .querySelector(".workspace-detail")
        ?.contains(status(h)),
    ).toBe(true);
    expect(
      activePage(h.host).querySelector(".workspace-detail")?.textContent,
    ).toContain("Check access needed");
    await h.click("Workspace diagnostics");
    expect(h.c.getSnapshot().destination.page).toBe("diagnostics");
    expect(h.button("Stop connection").disabled).toBe(false);
    expect(
      activePage(h.host).querySelector('[aria-label="Retained actions"]')
        ?.textContent,
    ).toContain("CONNECTOR_STOP_REQUIRED");
    expect(h.calls()).toEqual([
      { kind: "computer.verify-workspace", workspaceId: selectionId },
    ]);
  });
  it("requires an explicit stop decision and never replays the refused workspace check", async () => {
    const h = await mount("folders", twoWorkspaces());
    await select(h, "second");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "CONNECTOR_STOP_REQUIRED",
      snapshot: h.configuration,
    });
    await h.click("Verify workspace");
    await h.click("Review stop connection");
    expect(h.calls()).toHaveLength(1);
    expect(h.host.textContent).toContain("Finish current work");
    await h.click("Keep connection");
    expect(h.calls()).toHaveLength(1);
    await h.click("Review stop connection");
    await h.click("Stop connection");
    expect(h.calls()).toEqual([
      { kind: "computer.verify-workspace", workspaceId: selectionId },
      { kind: "connector.stop" },
    ]);
    expect(h.host.textContent).toContain("submit its change separately");
  });
  it("keeps an unconfirmed stop fenced instead of retrying the connector or workspace change", async () => {
    const h = await mount("folders", twoWorkspaces());
    await select(h, "second");
    vi.mocked(h.f.api.configure)
      .mockResolvedValueOnce({
        ok: false,
        error: "CONNECTOR_STOP_REQUIRED",
        snapshot: h.configuration,
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "CONNECTOR_STOP_UNCONFIRMED",
        snapshot: h.configuration,
      });
    await h.click("Verify workspace");
    await h.click("Review stop connection");
    await h.click("Stop connection");
    expect(h.host.textContent).toContain("requested change is unconfirmed");
    expect(h.button("Review stop connection").disabled).toBe(true);
    await h.click("Verify workspace");
    expect(h.calls()).toEqual([
      { kind: "computer.verify-workspace", workspaceId: selectionId },
      { kind: "connector.stop" },
    ]);
  });
  it.each([
    [
      "CONNECTOR_STOP_UNCONFIRMED",
      "could not confirm that the connection stopped",
    ],
    [
      "CODEX_HOST_TASK_IN_PROGRESS",
      "A coding task is using the current workspace access",
    ],
    ["WORKSPACE_ROOT_CHANGED", "no longer has the approved root identity"],
    ["WORKSPACE_NOT_FOUND", "no longer in the approved list"],
  ] as const)(
    "explains %s at the attempted workspace action without claiming success",
    async (code, explanation) => {
      const h = await mount("folders", twoWorkspaces());
      await select(h, "second");
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: false,
        error: code,
        snapshot: h.configuration,
      });
      await h.click("Verify workspace");
      expect(status(h).textContent).toContain(explanation);
      expect(status(h).textContent).not.toContain("Action confirmed");
      expect(h.calls()).toEqual([
        { kind: "computer.verify-workspace", workspaceId: selectionId },
      ]);
    },
  );
  it.each([
    "computer.check-folder",
    "computer.verify-workspace",
    "computer.update-access",
    "computer.remove-workspace",
  ] as const)(
    "keeps %s pending/unknown adjacent and blocks replay through refresh/remount",
    async (kind) => {
      const h = await mount(
        "folders",
        kind === "computer.check-folder" ? connectionSettings() : withFolder(),
      );
      const wait = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
      if (kind === "computer.update-access") {
        await change(h.field("Workspace access"), "write");
        await h.click("Save");
      } else if (kind === "computer.remove-workspace") {
        await act(async () =>
          activePage(h.host)
            .querySelector<HTMLButtonElement>(
              '[aria-label="Remove workspace project"]',
            )!
            .click(),
        );
        await h.click("Confirm removal");
      } else await h.click("Verify workspace");
      expect(status(h).textContent).toContain("Saving or checking");
      expect(
        h.c.getSnapshot().intents[`settings:${kind}:${workspaceId}`]?.state,
      ).toBe("pending");
      expect(h.button("Verify workspace").disabled).toBe(true);
      await act(async () => wait.reject(new Error("private lost reply")));
      expect(status(h).textContent).toContain("Outcome unknown");
      expect(
        activePage(h.host).querySelector(".workspace-pause")?.textContent,
      ).toContain("Workspace changes are paused");
      expect(status(h).textContent).not.toContain("Action confirmed");
      expect(status(h).textContent).not.toContain("private lost reply");
      await refresh(h, withFolder());
      await h.remount();
      expect(status(h).textContent).toContain("Outcome unknown");
      await h.click("Verify workspace");
      await change(h.field("Workspace access"), "write");
      await h.click("Save");
      expect(h.calls()).toHaveLength(1);
    },
  );
  it("keeps selection-specific receipts when switching workspaces", async () => {
    const h = await mount("folders", twoWorkspaces());
    await select(h, "second");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "WORKSPACE_ROOT_CHANGED",
      snapshot: h.configuration,
    });
    await h.click("Verify workspace");
    expect(status(h).textContent).toContain(
      "no longer has the approved root identity",
    );
    await select(h, "project");
    expect(status(h).textContent).not.toContain(
      "no longer has the approved root identity",
    );
    await select(h, "second");
    expect(status(h).textContent).toContain(
      "no longer has the approved root identity",
    );
    expect(h.calls()).toHaveLength(1);
  });
  it("selects access as a draft, cancels without a command and suppresses no-op Save", async () => {
    const h = await mount("folders", withFolder());
    expect(h.button("Save").disabled).toBe(true);
    await change(h.field("Workspace access"), "write");
    expect(activePage(h.host).textContent).toContain("Saved access: Read-only");
    expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
    await h.pageTo("connection");
    await h.pageTo("folders");
    expect(h.field("Workspace access").value).toBe("write");
    await h.click("Cancel");
    expect(h.field("Workspace access").value).toBe("read");
    await change(h.field("Workspace access"), "write");
    await change(h.field("Workspace access"), "read");
    expect(h.button("Save").disabled).toBe(true);
    await h.click("Save");
    const form = h.field("Workspace access").closest("form")!;
    await act(async () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(h.calls()).toEqual([]);
  });
  it("uses submit semantics for Save and Escape cancels only the draft", async () => {
    const h = await mount("folders", withFolder());
    await change(h.field("Workspace access"), "write");
    expect(h.button("Save").type).toBe("submit");
    expect(h.button("Cancel").type).toBe("button");
    await act(async () =>
      h.field("Workspace access").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(h.field("Workspace access").value).toBe("read");
    expect(h.calls()).toEqual([]);
    await change(h.field("Workspace access"), "write");
    await act(async () =>
      h
        .field("Workspace access")
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "write" },
    ]);
  });
  it.each(["generation", "root", "identity", "access", "removed"] as const)(
    "does not silently apply a draft after %s changes",
    async (stale) => {
      const value = withFolder();
      const h = await mount("folders", value);
      await change(h.field("Workspace access"), "write");
      const next = structuredClone(value);
      next.revision++;
      if (stale === "generation") next.computer.generation++;
      if (stale === "root") {
        next.computer.workspaces[0]!.root = "/approved/replaced";
        next.computer.workspaces[0]!.excludedPaths = [];
      }
      if (stale === "identity")
        next.computer.workspaces[0]!.rootIdentity!.inode = "999";
      if (stale === "access") next.computer.workspaces[0]!.access = "write";
      if (stale === "removed") next.computer.workspaces = [];
      await refresh(h, next);
      if (stale === "removed")
        expect(
          activePage(h.host).querySelector(".workspace-detail"),
        ).toBeNull();
      else {
        expect(h.button("Save").disabled).toBe(true);
        await act(async () =>
          h
            .field("Workspace access")
            .closest("form")!
            .dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true }),
            ),
        );
        expect(activePage(h.host).textContent).toContain(
          "changed while this draft was open",
        );
        await h.click("Cancel");
        expect(h.field("Workspace access").value).toBe(
          next.computer.workspaces[0]!.access,
        );
      }
      expect(h.calls()).toEqual([]);
    },
  );
  it("keeps drafts but cannot save after the host reports incompatible build bytes", async () => {
    const h = await mount("folders", withFolder());
    await change(h.field("Workspace access"), "write");
    const next = bootstrap();
    next.build.buildId = "f".repeat(64);
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...next,
      configuration: h.configuration,
    });
    await act(async () => h.c.refresh());
    expect(h.c.getSnapshot().status).toBe("incompatible");
    expect(h.field("Workspace access").value).toBe("write");
    expect(h.button("Save").disabled).toBe(true);
    await act(async () =>
      h
        .field("Workspace access")
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(h.calls()).toEqual([]);
  });
  it("rechecks scope and verification routing from the facade at click time", async () => {
    const h = await mount("folders", withFolder());
    const original = h.c.getSnapshot();
    const next = structuredClone(original);
    if (next.configuration?.status !== "ready")
      throw new Error("fixture unavailable");
    next.configuration.settings.setup.computer.verified = proof(
      next.configuration.settings,
    );
    next.configuration.settings.setup.computer.reachable = "reachable";
    const read = vi.spyOn(h.c, "getSnapshot").mockReturnValue(next);
    await h.click("Verify workspace");
    read.mockRestore();
    await change(h.field("Workspace access"), "write");
    const changed = structuredClone(original);
    if (changed.configuration?.status !== "ready")
      throw new Error("fixture unavailable");
    changed.configuration.settings.computer.workspaces[0]!.rootIdentity!.inode =
      "777";
    const latest = vi.spyOn(h.c, "getSnapshot").mockReturnValue(changed);
    await h.click("Save");
    latest.mockRestore();
    expect(h.calls()).toEqual([]);
    expect(h.host.textContent).toContain(
      "Action not sent. The workspace or connection changed",
    );
  });
  it("projects saved access from the host reply and clears only the submitted draft", async () => {
    const value = connectionSettings();
    const h = await mount("folders", value);
    await change(h.field("Workspace access"), "write");
    const saved = structuredClone(value);
    saved.revision++;
    saved.computer.generation++;
    saved.computer.workspaces[0]!.access = "write";
    saved.computer.workspaces[0]!.accessCheck = null;
    saved.setup.computer.verified = null;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: { status: "ready", settings: saved },
    });
    await h.click("Save");
    expect(activePage(h.host).textContent).toContain(
      "Saved access: Read & write · approval required",
    );
    expect(activePage(h.host).textContent).toContain("Check access needed");
    expect(h.field("Workspace access").value).toBe("write");
    expect(h.button("Save").disabled).toBe(true);
    expect(h.button("Verify workspace").disabled).toBe(false);
    expect(status(h).textContent).toContain(
      "Workspace access saved. Verify it again",
    );
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "write" },
    ]);
  });
  it("retains a refused access draft without claiming saved access", async () => {
    const h = await mount("folders", withFolder());
    await change(h.field("Workspace access"), "write");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "CONNECTOR_STOP_REQUIRED",
      snapshot: h.configuration,
    });
    await h.click("Save");
    expect(h.field("Workspace access").value).toBe("write");
    expect(activePage(h.host).textContent).toContain("Saved access: Read-only");
    expect(status(h).textContent).toContain("Stop connection");
    expect(status(h).textContent).not.toContain("Action confirmed");
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "write" },
    ]);
    await h.click("Cancel");
    expect(h.calls()).toHaveLength(1);
  });
  it.each(["refused", "unknown"] as const)(
    "keeps a submitted access %s visible when a newer list removes its detail",
    async (outcome) => {
      const h = await mount("folders", withFolder());
      await change(h.field("Workspace access"), "write");
      const wait = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
      // Form submission is the renderer path used by keyboard Save activation.
      await act(async () =>
        h
          .field("Workspace access")
          .closest("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      const removed = withFolder();
      removed.revision++;
      removed.computer.generation++;
      removed.computer.workspaces = [];
      removed.setup.computer.configured = false;
      await refresh(h, removed);
      expect(activePage(h.host).querySelector(".workspace-detail")).toBeNull();
      const notice = () =>
        [...h.host.querySelectorAll('[role="status"]')]
          .filter((element) => !element.closest("div[hidden]"))
          .map((element) => element.textContent)
          .join(" ");
      const pendingVisible = notice().includes("Saving or checking");
      await act(async () =>
        outcome === "refused"
          ? wait.resolve({
              ok: false,
              error: "WORKSPACE_NOT_FOUND",
              snapshot: { status: "ready", settings: removed },
            })
          : wait.reject(new Error("private lost access reply")),
      );
      const message =
        outcome === "refused"
          ? "This workspace is no longer in the approved list."
          : "Outcome unknown. Do not repeat this action";
      expect(notice()).toContain(message);
      expect(pendingVisible).toBe(true);
      expect(notice()).not.toContain("Workspace access saved");
      expect(notice()).not.toContain("private lost access reply");
      await h.remount();
      await refresh(h, removed);
      expect(notice()).toContain(message);
      expect(
        h.c.getSnapshot().intents[
          `settings:computer.update-access:${workspaceId}`
        ]?.state,
      ).toBe(outcome);
      expect(h.button("Add workspace…").disabled).toBe(outcome === "unknown");
      expect(h.calls()).toEqual([
        { kind: "computer.update-access", workspaceId, access: "write" },
      ]);
    },
  );
  it("requires accessible removal confirmation, retains files copy, and cancels with Escape", async () => {
    const h = await mount("folders", withFolder());
    const remove = activePage(h.host).querySelector<HTMLButtonElement>(
      '[aria-label="Remove workspace project"]',
    )!;
    expect(remove.type).toBe("button");
    await act(async () => remove.click());
    const confirmation = activePage(h.host).querySelector(
      '[aria-label="Confirm removal of project"]',
    )!;
    expect(confirmation.textContent).toContain("revokes Farol access");
    expect(confirmation.textContent).toContain("keeps its files on disk");
    expect(h.calls()).toEqual([]);
    await act(async () =>
      h.button("Keep workspace").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(confirmation.isConnected).toBe(false);
    await act(async () => remove.click());
    await h.click("Keep workspace");
    expect(h.calls()).toEqual([]);
    await act(async () => remove.click());
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "CONNECTOR_STOP_REQUIRED",
      snapshot: h.configuration,
    });
    await h.click("Confirm removal");
    expect(status(h).textContent).toContain("Stop connection");
    expect(
      activePage(h.host).querySelector(".workspace-detail")?.textContent,
    ).toContain("/approved/project");
    expect(h.calls()).toEqual([
      { kind: "computer.remove-workspace", workspaceId },
    ]);
  });
  it("shows the retained host removal result after its detail disappears", async () => {
    const h = await mount("folders", withFolder());
    const removed = structuredClone(h.configuration.settings);
    removed.revision++;
    removed.computer.generation++;
    removed.computer.workspaces = [];
    removed.setup.computer.configured = false;
    removed.setup.computer.reachable = "unknown";
    removed.setup.computer.verified = null;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: { status: "ready", settings: removed },
    });
    await act(async () =>
      activePage(h.host)
        .querySelector<HTMLButtonElement>(
          '[aria-label="Remove workspace project"]',
        )!
        .click(),
    );
    await h.click("Confirm removal");
    expect(activePage(h.host).querySelector(".workspace-detail")).toBeNull();
    expect(h.host.textContent).toContain(
      "Workspace access removed. Files on disk were not deleted.",
    );
    expect(h.calls()).toEqual([
      { kind: "computer.remove-workspace", workspaceId },
    ]);
  });
  it("refuses a stale removal confirmation", async () => {
    const h = await mount("folders", withFolder());
    await act(async () =>
      activePage(h.host)
        .querySelector<HTMLButtonElement>(
          '[aria-label="Remove workspace project"]',
        )!
        .click(),
    );
    const next = withFolder();
    next.computer.generation++;
    await refresh(h, next);
    expect(h.button("Confirm removal").disabled).toBe(true);
    await h.click("Confirm removal");
    expect(h.calls()).toEqual([]);
    expect(activePage(h.host).textContent).toContain("Cancel and review");
  });
});

// Renderer regressions only; native credential storage is qualified separately.
describe("owner-facing credential replacement", () => {
  it("reveals only the locally entered replacement and cancels without a command", async () => {
    const value = structuredClone(settings());
    value.connectors.secureMcp.credential = "stored";
    value.connectors.secureMcp.tunnelId = "tunnel_existing";
    const h = await mount("connection", value);
    await h.click("Edit connection");
    const input = h.field("Runtime key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    await change(input, "test-only-0000000000000000000000");
    await h.click("Show runtime key");
    expect(input.type).toBe("text");
    expect(input.value).toBe("test-only-0000000000000000000000");
    await h.click("Hide runtime key");
    expect(input.type).toBe("password");
    await h.click("Cancel");
    expect(h.calls()).toEqual([]);
    await h.click("Edit connection");
    expect((h.field("Runtime key") as HTMLInputElement).value).toBe("");
    expect((h.field("Runtime key") as HTMLInputElement).type).toBe("password");
    expect(h.field("Tunnel ID").value).toBe("tunnel_existing");
  });
  it("resets the reveal state when a credential submission clears the field", async () => {
    const h = await mount("connection");
    await change(h.field("Tunnel ID"), "tunnel_fixture");
    await change(h.field("Runtime key"), "test-only-0000000000000000000000");
    await h.click("Show runtime key");
    await h.click("Save & connect");
    expect(h.calls()).toEqual([
      {
        kind: "connector.save-and-connect",
        operationId: expect.any(String),
        buildId: "3".repeat(64),
        tunnelId: "tunnel_fixture",
        runtimeKey: "test-only-0000000000000000000000",
      },
    ]);
    expect((h.field("Runtime key") as HTMLInputElement).value).toBe("");
    expect((h.field("Runtime key") as HTMLInputElement).type).toBe("password");
  });
  it("clears a first-entry draft on Cancel without sending configuration", async () => {
    const h = await mount("connection");
    await change(h.field("Tunnel ID"), "tunnel_draft");
    await change(h.field("Runtime key"), "test-only-0000000000000000000000");
    await h.click("Show runtime key");
    await h.click("Cancel");
    expect(h.calls()).toEqual([]);
    expect(h.field("Tunnel ID").value).toBe("");
    expect((h.field("Runtime key") as HTMLInputElement).value).toBe("");
    expect((h.field("Runtime key") as HTMLInputElement).type).toBe("password");
  });
  it.each([
    ["CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN", "Do not submit the key again"],
    ["SETTINGS_WRITE_FAILED", "Do not submit the key again"],
    [
      "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
      "Credentials saved; connection result unconfirmed",
    ],
  ] as const)(
    "explains %s at the credential action without exposing or resubmitting the key",
    async (error, message) => {
      const h = await mount("connection");
      await change(h.field("Tunnel ID"), "tunnel_fixture");
      const key = "test-only-0000000000000000000000";
      await change(h.field("Runtime key"), key);
      const next = structuredClone(h.configuration.settings);
      next.revision++;
      next.setup.connect.outcomeUnknown = true;
      vi.mocked(h.f.api.configure).mockImplementationOnce(async (command) => ({
        ok: false,
        error,
        snapshot: { status: "ready", settings: next },
        ...(command.kind === "connector.save-and-connect"
          ? {
              connectorSetup: {
                kind: command.kind,
                operationId: command.operationId,
                buildId: command.buildId,
                state: "unknown",
                stoppedAt:
                  error === "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
                    ? "connection"
                    : "credentials",
                credentials:
                  error === "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
                    ? "saved"
                    : "unknown",
                connection:
                  error === "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
                    ? "unknown"
                    : "not-started",
                code: error,
                externalVerification: "not-proven",
              },
            }
          : {}),
      }));
      await h.click("Save & connect");
      expect(h.host.textContent).toContain(message);
      expect(h.host.textContent).not.toContain(key);
      expect((h.field("Runtime key") as HTMLInputElement).value).toBe("");
      expect(h.button("Save & connect").disabled).toBe(true);
      expect(h.calls()).toHaveLength(1);
    },
  );
});

describe("combined connection partial receipts", () => {
  it.each(["refused", "unknown"] as const)(
    "keeps saved-stage %s visible after refresh/remount without another key",
    async (state) => {
      const h = await mount("connection");
      await change(h.field("Tunnel ID"), "synthetic-tunnel");
      const secret = "disposable-combined-key-00000000";
      await change(h.field("Runtime key"), secret);
      const next = structuredClone(h.configuration.settings);
      next.revision += 1;
      next.connectors.secureMcp.generation += 1;
      next.connectors.secureMcp.credential = "stored";
      next.connectors.secureMcp.tunnelId = "synthetic-tunnel";
      const error =
        state === "unknown"
          ? "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
          : "CONNECTOR_START_FAILED";
      vi.mocked(h.f.api.configure).mockImplementationOnce(async (command) => ({
        ok: false,
        error,
        snapshot: { status: "ready", settings: next },
        ...(command.kind === "connector.save-and-connect"
          ? {
              connectorSetup: {
                kind: command.kind,
                operationId: command.operationId,
                buildId: command.buildId,
                state,
                stoppedAt: "connection",
                credentials: "saved",
                connection: state,
                code: error,
                externalVerification: "not-proven",
              },
            }
          : {}),
      }));
      await h.click("Save & connect");
      expect(h.calls()).toHaveLength(1);
      expect(
        h.host.querySelector('.settings-page > [role="status"]')?.textContent,
      ).toContain(
        state === "unknown"
          ? "Credentials saved; connection result unconfirmed"
          : "The connection step did not complete",
      );
      expect(
        activePage(h.host).querySelector('input[type="password"]'),
      ).toBeNull();
      const connectionBadge = activePage(h.host).querySelector(
        'section[aria-label="This Mac connection"] .badges',
      );
      expect(connectionBadge).not.toBeNull();
      expect(connectionBadge!.textContent).toBe(
        state === "unknown" ? "Outcome unknown" : "Connection helper needed",
      );
      vi.mocked(h.f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: {
          status: "ready",
          settings: { ...next, revision: next.revision + 1 },
        },
      });
      await act(async () => h.c.refresh());
      await h.pageTo("folders");
      await h.pageTo("connection");
      expect(
        h.host.querySelector('.settings-page > [role="status"]')?.textContent,
      ).toContain("Credentials saved");
      expect(h.calls()).toHaveLength(1);
      expect(JSON.stringify(h.c.getSnapshot())).not.toContain(secret);
      if (state === "unknown")
        expect(h.button("Edit connection").disabled).toBe(true);
    },
  );
});

// DOM/facade regressions only. Native lifecycle and external acceptance are separate.
describe("owner setup entry feedback", () => {
  function emptyCatalogueSettings() {
    const value = connectionSettings();
    value.computer.workspaces = [];
    value.setup.computer.verified = null;
    value.setup.computer.reachable = "unknown";
    value.connectors.secureMcp.challenge = null;
    value.connectors.secureMcp.attachment!.workspaceId = null;
    value.setup.connect.verified!.workspaceId = null;
    return value;
  }
  it("shows a verified empty-catalogue connection without workspace verification prompts", async () => {
    const value = emptyCatalogueSettings();
    const before = structuredClone(value);
    const h = await mount("connection", value);
    expect(activePage(h.host).textContent).toContain("Computer ready");
    expect(activePage(h.host).textContent).not.toContain(
      "Workspace verification needed",
    );
    expect(() => h.button("Verify a workspace")).toThrow();
    expect(h.calls()).toEqual([]);
    expect(h.c.getSnapshot().configuration).toEqual({
      status: "ready",
      settings: before,
    });
  });
  it("offers the stopped empty-workspace connection with correct start copy and no file proof", async () => {
    const value = emptyCatalogueSettings();
    value.connectors.secureMcp.runtime = null;
    value.connectors.secureMcp.attachment = null;
    value.setup.connect.verified = null;
    const h = await mount("connection", value);
    expect(activePage(h.host).textContent).toContain("Ready to connect");
    expect(activePage(h.host).textContent).not.toContain(
      "Workspace verification needed",
    );
    expect(() => h.button("Verify a workspace")).toThrow();
    expect(h.button("Connect this Mac").disabled).toBe(false);
    expect(h.calls()).toEqual([]);
    await h.click("Connect this Mac");
    expect(h.calls()).toEqual([{ kind: "connector.start" }]);
    expect(h.c.getSnapshot().configuration?.status).toBe("ready");
    expect(value.setup.computer.verified).toBeNull();
  });
  it("retains workspace verification prompts for configured folders without proper proof", async () => {
    const value = connectionSettings();
    value.connectors.secureMcp.runtime = null;
    value.connectors.secureMcp.challenge = null;
    value.connectors.secureMcp.attachment = null;
    value.setup.connect.verified = null;
    value.setup.computer.verified = null;
    const h = await mount("connection", value);
    expect(activePage(h.host).textContent).toContain(
      "Workspace verification needed",
    );
    expect(h.button("Verify a workspace")).toBeTruthy();
    expect(() => h.button("Connect this Mac")).toThrow();
    expect(h.calls()).toEqual([]);
  });
  it("preserves unknown admission on a stopped empty-workspace connection", async () => {
    const value = emptyCatalogueSettings();
    value.connectors.secureMcp.runtime = null;
    value.connectors.secureMcp.attachment = null;
    value.setup.connect.verified = null;
    value.setup.connect.outcomeUnknown = true;
    const h = await mount("connection", value);
    expect(activePage(h.host).textContent).toContain("Outcome unknown");
    expect(activePage(h.host).textContent).not.toContain("Ready to connect");
    expect(() => h.button("Verify a workspace")).toThrow();
    expect(() => h.button("Connect this Mac")).toThrow();
    expect(h.calls()).toEqual([]);
  });
  it("shows one state-appropriate primary connection action without dispatch on render", async () => {
    const ready = await mount("connection", connectionSettings());
    expect(ready.calls()).toEqual([]);
    expect(ready.button("Check connection").className).toBe("primary");
    expect(() => ready.button("Reconnect")).toThrow();
    expect(() => ready.button("Stop connection")).toThrow();
    expect(() => ready.button("Choose tunnel client…")).toThrow();
    expect(ready.host.textContent).not.toContain("Client: Selected");

    const stopped = structuredClone(connectionSettings());
    stopped.connectors.secureMcp.runtime = null;
    const next = await mount("connection", stopped);
    expect(next.calls()).toEqual([]);
    expect(next.button("Connect this Mac").className).toBe("primary");
    expect(() => next.button("Check connection")).toThrow();
    expect(() => next.button("Reconnect")).toThrow();

    const unknown = structuredClone(stopped);
    unknown.setup.connect.outcomeUnknown = true;
    const fenced = await mount("connection", unknown);
    expect(fenced.calls()).toEqual([]);
    expect(fenced.host.textContent).toContain("Outcome unknown");
    expect(() => fenced.button("Connect this Mac")).toThrow();
  });
  it("offers discovery without an effect on navigation or render", async () => {
    const h = await mount(
      "connection",
      settings(),
      "dev",
      undefined,
      "connection",
    );
    expect(h.calls()).toEqual([]);
    expect(h.button("Find connection helper").disabled).toBe(false);
    expect(() => h.button("Choose tunnel client…")).toThrow();
    await h.pageTo("diagnostics");
    expect(h.button("Choose tunnel client…")).toBeTruthy();
    await h.pageTo("connection");
    await h.click("Find connection helper");
    expect(h.calls()).toEqual([{ kind: "connector.discover-client" }]);
    expect(() => h.button("Connect this Mac")).toThrow();
  });
  it("reports a validated helper without claiming connection or attachment readiness", async () => {
    const h = await mount("connection");
    const next = structuredClone(settings());
    next.revision++;
    next.connectors.secureMcp.tunnelClient =
      connectionSettings().connectors.secureMcp.tunnelClient;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: { status: "ready", settings: next },
    });
    await h.click("Find connection helper");
    expect(h.host.textContent).toContain(
      "Connection helper validated and selected",
    );
    expect(h.host.textContent).toContain(
      "does not start the connection or prove ChatGPT attachment",
    );
    expect(h.host.textContent).toContain("Connection details needed");
    expect(() => h.button("Connect this Mac")).toThrow();
    expect(h.calls()).toEqual([{ kind: "connector.discover-client" }]);
  });
  it.each([0, 2])(
    "explains %i discovery candidates without selecting or starting them",
    async (count) => {
      const h = await mount("connection");
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: {
          kind: "connector.client-discovery",
          candidates: Array.from({ length: count }, (_, index) => ({
            requestedPath: `/approved/helper-${index}`,
            path: `/approved/helper-${index}`,
            source: "homebrew",
            origin: "unsigned",
            verdict: "needs-owner-choice",
          })),
          searched: ["/approved"],
        },
      });
      await h.click("Find connection helper");
      expect(h.host.textContent).toContain(
        count === 0
          ? "No connection helper found"
          : "2 connection helper candidate(s) found, but no validated helper selected",
      );
      expect(h.button("Connection diagnostics")).toBeTruthy();
      expect(h.host.textContent).toContain("Connection details needed");
      expect(() => h.button("Connect this Mac")).toThrow();
      expect(h.calls()).toEqual([{ kind: "connector.discover-client" }]);
    },
  );
  it.each([
    ["TUNNEL_CLIENT_DISCOVERY_FAILED", "Connection helper discovery failed"],
    [
      "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
      "connection helper candidate changed",
    ],
    ["TUNNEL_CLIENT_PICKER_CANCELLED", "Action cancelled"],
    ["TUNNEL_CLIENT_EXECUTABLE_UNSAFE", "did not pass executable validation"],
    ["TUNNEL_CLIENT_INCOMPATIBLE", "could not be verified as compatible"],
  ])(
    "explains %s without claiming selection or replaying it",
    async (error, message) => {
      const h = await mount("connection");
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: false,
        error,
        snapshot: h.configuration,
      });
      await h.click("Find connection helper");
      expect(h.host.textContent).toContain(message);
      expect(h.host.textContent).toContain("Connection details needed");
      expect(() => h.button("Connect this Mac")).toThrow();
      await h.pageTo("folders");
      await h.pageTo("connection");
      expect(h.calls()).toEqual([{ kind: "connector.discover-client" }]);
    },
  );
  it("keeps unknown discovery fenced across refresh and leaves Diagnostics navigation available", async () => {
    const h = await mount("connection");
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(
      new Error("private discovery failure"),
    );
    await h.click("Find connection helper");
    await act(async () => h.c.refresh());
    expect(h.button("Find connection helper").disabled).toBe(true);
    await h.pageTo("diagnostics");
    expect(h.button("Choose tunnel client…").disabled).toBe(true);
    expect(h.host.textContent).toContain("Outcome unknown");
    expect(h.host.textContent).not.toContain("private discovery failure");
    await h.pageTo("connection");
    await h.click("Connection diagnostics");
    expect(h.c.getSnapshot().destination.page).toBe("diagnostics");
    expect(h.calls()).toHaveLength(1);
  });
  it("explains invalid credentials without echoing the key", async () => {
    const h = await mount("connection");
    const feedback = () =>
      h.host.querySelector(".credential-entry-feedback")?.textContent;
    expect(feedback()).toContain("Enter the Tunnel ID");
    await change(h.field("Tunnel ID"), "owner-tunnel");
    await change(h.field("Runtime key"), "short");
    expect(feedback()).toContain("20–512");
    expect(feedback()).not.toContain("short");
    expect(h.field("Runtime key").getAttribute("aria-invalid")).toBe("true");
    expect(h.button("Save & connect").disabled).toBe(true);
    await change(h.field("Runtime key"), "valid-shaped-test-key-000000");
    expect(feedback()).toContain("Credential format is valid");
    expect(feedback()).toContain("verification in ChatGPT is still needed");
    expect(h.button("Save & connect").disabled).toBe(false);
    expect(h.calls()).toEqual([]);
  });
  it.each(["bad tunnel", "é", "x".repeat(161)])(
    "explains an invalid Tunnel ID without exposing the key",
    async (tunnelId) => {
      const h = await mount("connection");
      const secret = "valid-test-key-000000000000";
      await change(h.field("Tunnel ID"), tunnelId);
      await change(h.field("Runtime key"), secret);
      expect(
        h.host.querySelector(".credential-entry-feedback")?.textContent,
      ).toContain("Enter the Tunnel ID");
      expect(h.button("Save & connect").disabled).toBe(true);
      expect(h.host.textContent).not.toContain(secret);
      expect(h.calls()).toEqual([]);
    },
  );
  it.each(["", "bad key-with-spaces-000000", "é".repeat(20), "x".repeat(513)])(
    "explains an invalid runtime key without transforming or exposing it",
    async (key) => {
      const h = await mount("connection");
      await change(h.field("Tunnel ID"), "owner-tunnel");
      await change(h.field("Runtime key"), key);
      expect(
        h.host.querySelector(".credential-entry-feedback")?.textContent,
      ).toContain("20–512");
      expect(h.field("Runtime key").value).toBe(key);
      expect(h.button("Save & connect").disabled).toBe(true);
      if (key) expect(h.host.textContent).not.toContain(key);
      expect(h.calls()).toEqual([]);
    },
  );
  it("separates pending-operation feedback from field validity", async () => {
    const h = await mount("connection");
    const wait = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
    await h.click("Find connection helper");
    await change(h.field("Tunnel ID"), "owner-tunnel");
    await change(h.field("Runtime key"), "valid-test-key-000000000000");
    expect(
      h.host.querySelector(".credential-entry-feedback")?.textContent,
    ).toContain("Credential format is valid");
    expect(
      h.host.querySelector(".credential-pause-feedback")?.textContent,
    ).toContain("dependent operation is pending");
    expect(h.button("Save & connect").disabled).toBe(true);
    await act(async () =>
      wait.resolve({ ok: true, snapshot: h.configuration }),
    );
    expect(
      h.host.querySelector(".credential-pause-feedback")?.textContent,
    ).toBe("");
    expect(h.button("Save & connect").disabled).toBe(false);
    const references = h
      .field("Runtime key")
      .getAttribute("aria-describedby")!
      .split(" ");
    expect(references.every((id) => document.getElementById(id) !== null)).toBe(
      true,
    );
    expect(h.calls()).toHaveLength(1);
  });
  it("explains unavailable runtime admission separately from a valid credential draft", async () => {
    const h = await mount("connection");
    await change(h.field("Tunnel ID"), "owner-tunnel");
    await change(h.field("Runtime key"), "valid-test-key-000000000000");
    await act(async () =>
      h.f.emit("runtime", {
        state: "offline",
        error: null,
        identity: null,
        embeddedNode: null,
        embeddedElectron: null,
      }),
    );
    expect(
      h.host.querySelector(".credential-entry-feedback")?.textContent,
    ).toContain("Credential format is valid");
    expect(
      h.host.querySelector(".credential-pause-feedback")?.textContent,
    ).toContain("runtime status is unavailable");
    expect(h.button("Save & connect").disabled).toBe(true);
    await h.click("Save & connect");
    expect(h.calls()).toEqual([]);
  });
  it("keeps unknown replacement fenced even with a new valid draft", async () => {
    const h = await mount("connection", connectionSettings());
    await h.click("Edit connection");
    await change(h.field("Runtime key"), "test-replacement-one-000000");
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(new Error("reply lost"));
    await h.click("Save & connect");
    await change(h.field("Runtime key"), "test-replacement-two-000000");
    expect(
      h.host.querySelector(".credential-entry-feedback")?.textContent,
    ).toContain("Credential format is valid");
    expect(
      h.host.querySelector(".credential-pause-feedback")?.textContent,
    ).toContain("Saving is paused");
    expect(
      h.host.querySelector(".credential-pause-feedback")?.textContent,
    ).toContain("Do not repeat it");
    await h.click("Save & connect");
    expect(h.calls()).toHaveLength(1);
    expect(h.button("Save & connect").disabled).toBe(true);
  });
  it("does not present a chooser result as an approved workspace", async () => {
    const h = await mount("folders");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: {
        kind: "computer.workspace-pick",
        selectionId,
        displayPath: "/private/tmp/selected-workspace",
      },
    });
    await h.click("Add workspace…");
    expect(h.host.textContent).toContain("No workspaces approved");
    expect(h.host.textContent).toContain("Approval request completed");
    expect(h.calls()).toEqual([
      { kind: "computer.choose-workspace" },
      { kind: "computer.add-workspace", selectionId, access: "write" },
    ]);
  });
});

function proof(value: ProductSettings) {
  return {
    profile: "farol-next",
    configRevision: value.computer.generation,
    workspaceId,
    runtimeGeneration: "a".repeat(64),
    buildId: "3".repeat(64),
    protocol: "secure-mcp",
    verifiedAt: "2026-10-02T20:00:00.000Z",
  };
}
function connectionSettings() {
  const value = structuredClone(withFolder());
  const timestamp = "2026-10-02T20:00:00.000Z";
  const buildId = "3".repeat(64),
    runtimeGeneration = "a".repeat(64);
  value.setup.chatgpt.verified = proof(value);
  value.setup.computer.verified = proof(value);
  value.setup.computer.reachable = "reachable";
  value.setup.connect.verified = proof(value);
  const connector = value.connectors.secureMcp;
  connector.tunnelId = "owner-tunnel";
  connector.credential = "stored";
  connector.tunnelClient = {
    executablePath: "/approved/tunnel",
    executableSha256: "b".repeat(64),
    version: "1.0.0",
    protocol: "openai-tunnel-client/v1",
    verifiedAt: timestamp,
  };
  connector.runtime = {
    state: "ready",
    connectorGeneration: 1,
    runtimeGeneration,
    computerGeneration: 1,
    buildId,
    observedAt: timestamp,
  };
  connector.challenge = {
    value: selectionId,
    challengeSha256: "c".repeat(64),
    runtimeGeneration,
    computerGeneration: 1,
    buildId,
    preparedAt: timestamp,
  };
  connector.chatgptApp = {
    name: "My Farol",
    tunnelId: "owner-tunnel",
    connectorGeneration: 1,
  };
  connector.attachment = {
    tunnelId: "owner-tunnel",
    workspaceId,
    connectorGeneration: 1,
    runtimeGeneration,
    computerGeneration: 1,
    buildId,
    challengeSha256: "c".repeat(64),
    receiptSha256: "d".repeat(64),
    verifiedAt: timestamp,
  };
  return value;
}
describe("bounded Settings writer", () => {
  for (const permission of ["commands", "file-policy"] as const) {
    it.each([
      "success",
      "refused-save",
      "unknown-save",
      "unknown-check",
      "refused-check",
      "stale-generation",
      "changed-connector",
      "no-workspace",
    ] as const)(
      `continues an acknowledged ${permission} save through fresh verification and reconnect: %s`,
      async (outcome) => {
        let value = connectionSettings();
        value.computer.commands = "none";
        if (outcome === "no-workspace") {
          value.computer.workspaces = [];
          value.setup.computer.verified = null;
        }
        const saveKind =
          permission === "commands"
            ? "computer.update-commands"
            : "computer.update-file-policy";
        const label =
          permission === "commands" ? "Command access" : "File access";
        const button =
          permission === "commands"
            ? "Save permissions"
            : "Save file permissions";
        const h = await mount("computer", value);
        expect(h.button(button).disabled).toBe(true);
        await change(
          h.field(label),
          permission === "commands" ? "workspace" : "approved-roots-v1",
        );
        vi.mocked(h.f.api.configure).mockImplementation(async (command) => {
          if (
            (command.kind === saveKind && outcome === "unknown-save") ||
            (command.kind === "computer.verify-workspace" &&
              outcome === "unknown-check")
          )
            throw new Error("original reply lost");
          if (
            (command.kind === saveKind && outcome === "refused-save") ||
            (command.kind === "computer.verify-workspace" &&
              outcome === "refused-check")
          )
            return {
              ok: false,
              error: "CONNECTOR_STOP_UNCONFIRMED",
              snapshot: { status: "ready", settings: value },
            };
          value = structuredClone(value);
          value.revision++;
          if (
            command.kind === "computer.update-commands" ||
            command.kind === "computer.update-file-policy"
          ) {
            if (command.kind === "computer.update-commands")
              value.computer.commands = command.commands;
            else value.computer.filePolicy = command.filePolicy;
            value.computer.generation += outcome === "stale-generation" ? 2 : 1;
            if (outcome === "changed-connector")
              value.connectors.secureMcp.generation++;
            value.connectors.secureMcp.runtime = null;
            value.connectors.secureMcp.attachment = null;
            value.connectors.secureMcp.challenge = null;
            value.setup.computer.verified = null;
            value.setup.computer.reachable = "unknown";
            value.setup.connect.verified = null;
          } else if (command.kind === "computer.verify-workspace") {
            const workspace = value.computer.workspaces[0]!;
            expect(command.workspaceId).toBe(workspace.workspaceId);
            // Activating workspace commands may publish one extra generation
            // with the matching new physical access proof.
            if (permission === "commands") value.computer.generation++;
            value.setup.computer.verified = {
              ...proof(value),
              workspaceId: workspace.workspaceId,
            };
            value.setup.computer.reachable = "reachable";
            workspace.accessCheck = {
              checkId: command.checkId,
              buildId: "3".repeat(64),
              computerGeneration: value.computer.generation,
              rootIdentity: workspace.rootIdentity!,
              verifiedAt: "2026-10-12T08:00:00.000Z",
            };
          } else if (command.kind === "connector.start") {
            value.connectors.secureMcp.runtime = {
              ...connectionSettings().connectors.secureMcp.runtime!,
              computerGeneration: value.computer.generation,
              runtimeGeneration: "e".repeat(64),
            };
          } else throw new Error(`Unexpected command: ${command.kind}`);
          return { ok: true, snapshot: { status: "ready", settings: value } };
        });
        await h.click(button);
        expect(h.calls().map((command) => command.kind)).toEqual(
          outcome === "success"
            ? [saveKind, "computer.verify-workspace", "connector.start"]
            : outcome === "unknown-check" || outcome === "refused-check"
              ? [saveKind, "computer.verify-workspace"]
              : [saveKind],
        );
        const dispatched = h.calls().length;
        await h.remount();
        expect(h.calls()).toHaveLength(dispatched);
        if (outcome === "success") expect(h.button(button).disabled).toBe(true);
      },
    );
  }

  it.each([
    "success",
    "workspace-commands",
    "unknown-check",
    "refused-edit",
  ] as const)(
    "continues a workspace removal through one fresh check and reconnect only after acknowledged phases: %s",
    async (outcome) => {
      let value = connectionSettings();
      if (outcome === "workspace-commands")
        value.computer.commands = "workspace";
      value.computer.workspaces.push({
        ...value.computer.workspaces[0]!,
        workspaceId: selectionId,
        root: "/approved/remaining",
        label: "Remaining",
        excludedPaths: [],
        rootIdentity: { device: "1", inode: "3" },
      });
      const h = await mount("folders", value);
      vi.mocked(h.f.api.configure).mockImplementation(async (command) => {
        if (
          command.kind === "computer.remove-workspace" &&
          outcome === "refused-edit"
        )
          return {
            ok: false,
            error: "CONNECTOR_STOP_UNCONFIRMED",
            snapshot: { status: "ready", settings: value },
          };
        if (
          command.kind === "computer.verify-workspace" &&
          outcome === "unknown-check"
        )
          throw new Error("check reply lost");
        value = structuredClone(value);
        value.revision++;
        if (command.kind === "computer.remove-workspace") {
          value.computer.generation++;
          value.computer.workspaces = value.computer.workspaces.filter(
            (item) => item.workspaceId !== command.workspaceId,
          );
          value.connectors.secureMcp.runtime = null;
          value.connectors.secureMcp.attachment = null;
          value.connectors.secureMcp.challenge = null;
          value.setup.computer.verified = null;
          value.setup.computer.reachable = "unknown";
          value.setup.connect.verified = null;
        } else if (command.kind === "computer.verify-workspace") {
          expect(command.workspaceId).toBe(selectionId);
          if (outcome === "workspace-commands") value.computer.generation++;
          value.setup.computer.verified = {
            ...proof(value),
            workspaceId: selectionId,
          };
          value.setup.computer.reachable = "reachable";
          value.computer.workspaces[0]!.accessCheck = {
            checkId: command.checkId,
            buildId: "3".repeat(64),
            computerGeneration: value.computer.generation,
            rootIdentity: value.computer.workspaces[0]!.rootIdentity!,
            verifiedAt: "2026-10-11T08:00:00.000Z",
          };
        } else if (command.kind === "connector.start") {
          value.connectors.secureMcp.runtime = {
            ...connectionSettings().connectors.secureMcp.runtime!,
            computerGeneration: value.computer.generation,
            runtimeGeneration: "e".repeat(64),
          };
        } else throw new Error(`Unexpected command: ${command.kind}`);
        return { ok: true, snapshot: { status: "ready", settings: value } };
      });
      await h.click("Remove");
      await h.click("Confirm removal");
      expect(h.calls().map((command) => command.kind)).toEqual(
        outcome === "refused-edit"
          ? ["computer.remove-workspace"]
          : outcome === "unknown-check"
            ? ["computer.remove-workspace", "computer.verify-workspace"]
            : [
                "computer.remove-workspace",
                "computer.verify-workspace",
                "connector.start",
              ],
      );
      const dispatched = h.calls().length;
      await h.remount();
      expect(h.calls()).toHaveLength(dispatched);
      if (outcome === "success" || outcome === "workspace-commands") {
        expect(h.host.textContent).toContain(
          "Workspace access checked: /approved/remaining.",
        );
        expect(h.host.textContent).not.toContain(
          "A current access check is not confirmed",
        );
      }
    },
  );

  it("renders all nine approved pages in StrictMode without effects or saves", async () => {
    const h = await mount();
    for (const page of [
      "general",
      "appearance",
      "folders",
      "computer",
      "connection",
      "model",
      "shortcuts",
      "updates",
      "diagnostics",
    ] as const)
      await h.pageTo(page);
    expect(
      [...h.host.querySelectorAll("h2")].map((node) => node.textContent),
    ).toEqual([
      "Workspaces",
      "This Mac",
      "Connection",
      "Shortcuts",
      "Updates",
      "Diagnostics",
      "Model",
      "Chat",
      "Read-only file preview",
      "Saved Chat answers",
    ]);
    expect(h.f.api.configure).not.toHaveBeenCalled();
    expect(h.f.api.task).not.toHaveBeenCalled();
    expect(h.f.api.installedUpdate).toHaveBeenCalledTimes(1); // Window bootstrap status only.
    await act(async () => h.root.unmount());
    roots.splice(roots.indexOf(h.root), 1);
    expect(h.f.listeners.size).toBe(10);
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("keeps a draft across background events and page changes; saves only explicit navigation", async () => {
    const value = settings();
    value.general.activityDetail = "technical";
    const h = await mount("general", value);
    await change(h.field("Start page"), "settings");
    await act(async () => h.f.emit("route", { state: "loaded" }));
    await h.pageTo("folders");
    await h.pageTo("general");
    expect(h.field("Start page").value).toBe("settings");
    expect(h.calls()).toEqual([]);
    await h.click("Save navigation");
    expect(h.calls()).toEqual([
      {
        kind: "general.update",
        openAtLaunch: "settings",
        sidebarDefault: "full",
        activityDetail: "technical",
      },
    ]);
    expect(h.host.textContent).toContain(
      "This choice applies when Farol opens.",
    );
  });
  it("changes appearance through facade only on user selection", async () => {
    const h = await mount("appearance");
    await h.click("Light");
    expect(h.button("Light").getAttribute("aria-pressed")).toBe("true");
    await h.click("System");
    expect(h.button("System").getAttribute("aria-pressed")).toBe("true");
    await h.click("Graphite");
    expect(h.button("Graphite").getAttribute("aria-pressed")).toBe("true");
    const amber = h.button("Amber");
    amber.focus();
    await h.click("Amber");
    expect(document.activeElement).toBe(amber);
    expect(amber.getAttribute("aria-label")).toBe("Amber accent");
    expect(amber.getAttribute("aria-pressed")).toBe("true");
    expect(h.button("Iris").getAttribute("aria-pressed")).toBe("false");
    expect(h.button("Cobalt").getAttribute("aria-pressed")).toBe("false");
    const typeface = h.host.querySelector<HTMLSelectElement>(
      'select[aria-label="Typeface"]',
    )!;
    await change(typeface, "system");
    expect(h.c.getSnapshot().appearance).toEqual({
      theme: "graphite",
      accent: "amber",
      font: "system",
    });
    expect(h.calls()).toEqual([]);
  });
  it.each(["theme", "accent", "typeface"] as const)(
    "preserves earlier appearance choices before React rerenders when selecting %s",
    async (choice) => {
      const h = await mount("appearance");
      await act(async () => {
        h.button(choice === "theme" ? "Amber" : "Graphite").click();
        if (choice === "typeface") {
          const typeface = h.host.querySelector<HTMLSelectElement>(
            'select[aria-label="Typeface"]',
          )!;
          Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            "value",
          )?.set?.call(typeface, "system");
          typeface.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          h.button(choice === "theme" ? "Graphite" : "Amber").click();
        }
      });
      expect(h.c.getSnapshot().appearance).toEqual({
        theme: "graphite",
        accent: choice === "typeface" ? "iris" : "amber",
        font: choice === "typeface" ? "system" : "geist",
      });
      expect(h.calls()).toEqual([]);
    },
  );
  it("presents the selected Appearance controls without duplicating the toolbar title", async () => {
    const h = await mount("appearance");
    const page = h.host.querySelector(".appearance-page")!;
    expect(page.querySelector("h2")).toBeNull();
    expect(
      [...page.querySelectorAll("h3")].map((item) => item.textContent),
    ).toEqual(["Theme", "Accent color", "Typeface"]);
    expect(page.textContent).toContain(
      "System follows the appearance of your Mac.",
    );
    expect(page.textContent).toContain("Status stays distinct.");
    expect(page.textContent).toContain("Changes apply immediately.");
    expect(
      page.querySelectorAll('.accent-choices button[type="button"]'),
    ).toHaveLength(3);
    expect(page.querySelectorAll(".theme-choices .theme-preview")).toHaveLength(
      3,
    );
    expect(h.calls()).toEqual([]);
  });
  it.each(["Iris", "Cobalt", "Amber"])(
    "keeps theme and typeface while choosing %s",
    async (label) => {
      const h = await mount("appearance");
      const before = h.c.getSnapshot().appearance;
      await h.click(label);
      expect(h.c.getSnapshot().appearance).toEqual({
        ...before,
        accent: label.toLowerCase(),
      });
      expect(h.button(label).getAttribute("aria-pressed")).toBe("true");
      expect(h.calls()).toEqual([]);
    },
  );
  it("adds a fresh native selection with explicit default write access in one user action", async () => {
    const h = await mount("folders");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: { kind: "computer.workspace-pick", selectionId },
    });
    await h.click("Add workspace…");
    expect(h.calls()).toHaveLength(2);
    expect(h.calls()[1]).toEqual({
      kind: "computer.add-workspace",
      selectionId,
      access: "write",
    });
    expect(
      h
        .calls()
        .every(
          (command) =>
            ProductConfigurationCommandSchema.safeParse(command).success,
        ),
    ).toBe(true);
  });
  it.each(["folders", "model"] as const)(
    "does not adopt another facade intention's %s evidence",
    async (page) => {
      const h = await mount(page);
      const waiting = deferred<unknown>();
      const ownEvidence =
        page === "folders"
          ? { kind: "computer.workspace-pick", selectionId }
          : {
              kind: "model.config-preview",
              configPath: "/approved/config.toml",
              providerBlockStatus: "install",
              providerSelectionRequested: false,
            };
      vi.mocked(h.f.api.configure)
        .mockReturnValueOnce(waiting.promise)
        .mockResolvedValueOnce({
          ok: true,
          snapshot: h.configuration,
          evidence: ownEvidence,
        });
      await h.click(
        page === "folders" ? "Add workspace…" : "Preview model configuration",
      );
      await act(async () => {
        await h.c.configure(
          page === "folders"
            ? { kind: "computer.choose-workspace" }
            : { kind: "model.preview", selectAsDefault: false },
          "another-parent-intention",
        );
      });
      await act(async () =>
        waiting.resolve({
          ok: true,
          snapshot: h.configuration,
          evidence: ownEvidence,
        }),
      );
      if (page === "folders")
        expect(() => h.button("Add selected workspace read-only")).toThrow();
      else expect(h.button("Apply reviewed configuration").disabled).toBe(true);
      expect(h.calls()).toHaveLength(2);
    },
  );
  it("never adds a cancelled picker or reuses evidence invalidated by refresh", async () => {
    const h = await mount("folders");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "WORKSPACE_PICKER_CANCELLED",
      snapshot: h.configuration,
    });
    await h.click("Add workspace…");
    expect(h.button("Add workspace…").disabled).toBe(false); // A deliberate retry may follow a known refusal; rendering never retries.
    expect(
      [...h.host.querySelectorAll("button")].some(
        (button) => button.textContent === "Add selected workspace read-only",
      ),
    ).toBe(false);
    expect(h.calls()).toHaveLength(1);
    const other = await mount("folders");
    vi.mocked(other.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: other.configuration,
      evidence: { kind: "computer.workspace-pick", selectionId },
    });
    await other.click("Add workspace…");
    await act(async () => other.c.refresh());
    expect(() => other.button("Add selected workspace read-only")).toThrow();
    expect(other.calls()).toEqual([
      { kind: "computer.choose-workspace" },
      { kind: "computer.add-workspace", selectionId, access: "write" },
    ]);
  });
  it("fences duplicate, unknown and stale actions without a retry", async () => {
    const h = await mount("folders");
    const wait = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
    await act(async () => {
      h.button("Add workspace…").click();
      h.button("Add workspace…").click();
    });
    expect(h.calls()).toHaveLength(1);
    await act(async () => wait.reject(new Error("private failure payload")));
    expect(h.button("Add workspace…").disabled).toBe(true);
    await h.click("Add workspace…");
    await act(async () => h.c.refresh());
    expect(h.button("Add workspace…").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
    expect(h.host.textContent).toContain("Outcome unknown");
    expect(h.host.textContent).not.toContain("private failure payload");
    const stale = await mount("folders");
    await act(async () =>
      stale.f.emit("runtime", {
        state: "offline",
        error: null,
        identity: null,
        embeddedNode: null,
        embeddedElectron: null,
      }),
    );
    await stale.click("Add workspace…");
    expect(stale.calls()).toHaveLength(0);
  });
  it("keeps exclusions stable during IME and validates relative paths before saving", async () => {
    const h = await mount("diagnostics", withFolder());
    const input = h.field("Excluded paths for project");
    await act(async () =>
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await change(input, "private\ncache");
    await act(async () => h.f.emit("route", { state: "loaded" }));
    await h.click("Save exclusions");
    expect(h.calls()).toEqual([]);
    expect(input.value).toBe("private\ncache");
    await act(async () =>
      input.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await h.click("Save exclusions");
    expect(h.calls()[0]).toEqual({
      kind: "computer.update-exclusions",
      workspaceId,
      excludedPaths: ["private", "cache"],
    });
    await change(input, "../secret");
    await h.click("Save exclusions");
    expect(h.calls()).toHaveLength(1);
    await change(input, "private\nprivate");
    await h.click("Save exclusions");
    expect(h.calls()).toHaveLength(1);
  });
  it("separates guarded writes, expanded Git approval and access/workspace checks", async () => {
    const h = await mount("folders", withFolder());
    await change(h.field("Workspace access"), "write");
    await h.click("Save");
    await h.pageTo("diagnostics");
    await h.click("Approve expanded Git access");
    await h.pageTo("folders");
    await h.click("Verify workspace");
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "write" },
      { kind: "computer.update-git-history", workspaceId, approved: true },
      { kind: "computer.verify-workspace", workspaceId },
    ]);
    expect(h.host.textContent).toContain("Check access needed");
  });
  it("rejects stale folder checks and retains a draft when scope changes", async () => {
    const value = withFolder();
    value.setup.computer.verified = proof(value);
    value.setup.computer.reachable = "reachable";
    const h = await mount("diagnostics", value);
    expect(h.host.textContent).toContain("Access checked");
    const input = h.field("Excluded paths for project");
    await change(input, "draft");
    const next = structuredClone(value);
    next.revision++;
    next.computer.generation++;
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: { status: "ready", settings: next },
    });
    await act(async () => h.c.refresh());
    expect(input.value).toBe("draft");
    expect(h.button("Save exclusions").disabled).toBe(true);
    expect(h.host.textContent).toContain("Check access needed");
    await h.click("Reload saved exclusions");
    expect(input.value).toBe("private");
    expect(h.button("Save exclusions").disabled).toBe(false);
  });
  it("uses all real command policies and never performs an Astra host check", async () => {
    let value = settings();
    const h = await mount("computer", value);
    vi.mocked(h.f.api.configure).mockImplementation(async (command) => {
      expect(command.kind).toBe("computer.update-commands");
      if (command.kind === "computer.update-commands") {
        value = structuredClone(value);
        value.revision++;
        value.computer.generation++;
        value.computer.commands = command.commands;
      }
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    for (const commands of ["verification", "workspace", "none"]) {
      await change(h.field("Command access"), commands);
      await h.click("Save permissions");
    }
    expect(h.calls()).toEqual(
      ["verification", "workspace", "none"].map((commands) => ({
        kind: "computer.update-commands",
        commands,
      })),
    );
    expect(h.calls().some((command) => command.kind.startsWith("host."))).toBe(
      false,
    );
    expect(h.host.textContent).toContain("Both exclude network access");
  });
  it("keeps credentials in explicit input only, saves explicitly, and clears the field", async () => {
    const h = await mount("connection");
    const secret = "explicit-test-key-000000000000";
    await change(h.field("Tunnel ID"), "owner-tunnel");
    await change(h.field("Runtime key"), secret);
    await act(async () => h.f.emit("route", { state: "loaded" }));
    expect(h.calls()).toEqual([]);
    expect(h.field("Runtime key").value).toBe(secret);
    expect(JSON.stringify(h.c.getSnapshot())).not.toContain(secret);
    expect(h.host.textContent).not.toContain(secret);
    await h.click("Save & connect");
    expect(h.calls()).toEqual([
      {
        kind: "connector.save-and-connect",
        operationId: expect.any(String),
        buildId: "3".repeat(64),
        tunnelId: "owner-tunnel",
        runtimeKey: secret,
      },
    ]);
    expect(h.field("Runtime key").value).toBe("");
    await h.click("Save & connect");
    expect(h.calls()).toHaveLength(1); // Empty credentials never look like a missing saved key or resubmit.
    expect(h.button("Save & connect").disabled).toBe(true);
    expect(h.host.textContent).toContain(
      "Connection started. Credentials are saved. Verify Farol in ChatGPT to finish connecting this Mac.",
    );
    expect(JSON.stringify(h.c.getSnapshot())).not.toContain(secret);
  });
  it("does not clear or submit a composing credential", async () => {
    const h = await mount("connection");
    const input = h.field("Runtime key");
    await change(h.field("Tunnel ID"), "owner-tunnel");
    await act(async () =>
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await change(input, "explicit-test-key-000000000000");
    await h.click("Save & connect");
    expect(input.value).toBe("explicit-test-key-000000000000");
    expect(h.calls()).toEqual([]);
  });
  it("does not label a running local service Ready without current attachment evidence", async () => {
    const h = await mount("connection", withFolder());
    expect(h.c.getSnapshot().runtime).toBe("ready");
    expect(
      h.host.querySelector('section[aria-label="This Mac connection"] .badges')
        ?.textContent,
    ).not.toBe("Computer ready");
    expect(() => h.button("Connect this Mac")).toThrow();
    await h.pageTo("diagnostics");
    expect(h.button("Check in ChatGPT once").disabled).toBe(true);
    await h.pageTo("connection");
    await h.click("Sign in");
    await h.pageTo("diagnostics");
    await h.click("Choose tunnel client…");
    expect(h.calls()).toEqual([
      { kind: "chatgpt.open-sign-in" },
      { kind: "connector.select-client" },
    ]);
  });
  it.each(["dev", "preview"] as const)(
    "requires current correlated attachment for Ready and sends a %s app check once",
    async (environment) => {
      const value = connectionSettings();
      const h = await mount("connection", value, environment);
      const badge = () =>
        h.host.querySelector(
          'section[aria-label="This Mac connection"] .badges',
        )?.textContent;
      expect(badge()).toBe("Computer ready");
      await h.click("Check attachment");
      await h.click("Check connection");
      expect(h.host.textContent).toContain(
        "Local connection checked. Access from ChatGPT has a separate verification.",
      );
      await h.pageTo("diagnostics");
      await h.click("Check in ChatGPT once");
      await h.click("Check in ChatGPT once");
      expect(h.calls()).toEqual([
        { kind: "connector.check-attachment" },
        { kind: "connector.check-health" },
        { kind: "connector.verify-app" },
      ]);
      const next = structuredClone(value);
      next.revision++;
      next.connectors.secureMcp.runtime!.runtimeGeneration = "e".repeat(64);
      vi.mocked(h.f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        environment: "dev",
        configuration: { status: "ready", settings: next },
      });
      await act(async () => h.c.refresh());
      expect(badge()).toBe("Connected to this Mac · ChatGPT check needed");
      next.setup.connect.outcomeUnknown = true;
      await act(async () => h.c.refresh());
      expect(badge()).toBe("Outcome unknown");
      await h.pageTo("connection");
      expect(h.button("Check attachment").disabled).toBe(true);
      expect(
        h.calls().some((command) => command.kind.startsWith("host.")),
      ).toBe(false);
    },
  );

  it("binds app selection to exact current tunnel/generation without admitting an unverified connection", async () => {
    const value = withFolder();
    value.connectors.secureMcp.tunnelId = "owner-tunnel";
    const h = await mount("diagnostics", value, "dev");
    await change(h.field("ChatGPT app name"), "My Farol");
    await h.click("Select ChatGPT app");
    expect(h.calls()).toEqual([
      {
        kind: "connector.select-chatgpt-app",
        name: "My Farol",
        tunnelId: "owner-tunnel",
        connectorGeneration: 1,
      },
    ]);
    expect(h.button("Check in ChatGPT once").disabled).toBe(true);
  });
  it("requires an explicit matching current model preview before Apply and hides raw config", async () => {
    const h = await mount("model");
    expect(h.button("Apply reviewed configuration").disabled).toBe(true);
    const preview = {
      kind: "model.config-preview",
      configPath: "/approved/config.toml",
      providerBlockStatus: "install",
      providerSelectionRequested: false,
      providerBlockDiff: "untrusted-private-literal",
    };
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview,
    });
    await h.click("Preview model configuration");
    expect(h.button("Apply reviewed configuration").disabled).toBe(false);
    expect(h.host.textContent).not.toContain("untrusted-private-literal");
    await h.click("Apply reviewed configuration");
    expect(h.calls()).toEqual([
      { kind: "model.preview", selectAsDefault: false },
      { kind: "model.apply", selectAsDefault: false },
    ]);
    expect(h.button("Apply reviewed configuration").disabled).toBe(true);
    await h.click("Roll back managed configuration");
    expect(h.calls()[2]).toEqual({ kind: "model.rollback" });
  });
  it.each(["conflict", "insecure_permissions", "symlink", "malformed"])(
    "blocks unsafe model preview %s",
    async (providerBlockStatus) => {
      const h = await mount("model");
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: {
          kind: "model.config-preview",
          configPath: "/approved/config.toml",
          providerBlockStatus,
          providerSelectionRequested: false,
        },
      });
      await h.click("Preview model configuration");
      expect(h.button("Apply reviewed configuration").disabled).toBe(true);
    },
  );
  it("invalidates model review after background refresh or changing default selection", async () => {
    const h = await mount("model");
    const response = {
      ok: true,
      snapshot: h.configuration,
      evidence: {
        kind: "model.config-preview",
        configPath: "/approved/config.toml",
        providerBlockStatus: "install",
        providerSelectionRequested: false,
      },
    };
    vi.mocked(h.f.api.configure).mockResolvedValue(response);
    await h.click("Preview model configuration");
    await act(async () => h.c.refresh());
    expect(h.button("Apply reviewed configuration").disabled).toBe(true);
    await h.click("Preview model configuration");
    const check = activePage(h.host).querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => check.click());
    expect(h.button("Apply reviewed configuration").disabled).toBe(true);
  });
  it("reports shortcut gap and opens update review without restart; checks once", async () => {
    const h = await mount("shortcuts");
    expect(h.host.textContent).toContain("Section keys use ⌘");
    expect(h.f.api.setNavigationShortcuts).not.toHaveBeenCalled();
    await h.pageTo("updates");
    vi.mocked(h.f.api.installedUpdate).mockClear();
    await h.click("View update");
    expect(h.c.getSnapshot().overlay).toBe("update");
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
    await h.click("Check for Updates");
    await h.click("Check for Updates");
    expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "check",
    });
  });
  it("changes only the confirmed automatic download preference without granting installation consent", async () => {
    const off = {
      phase: "idle" as const,
      checkedAt: null,
      automaticUpdatePreference: {
        status: "confirmed" as const,
        enabled: false,
      },
    };
    const on = {
      ...off,
      automaticUpdatePreference: {
        status: "confirmed" as const,
        enabled: true,
      },
    };
    const h = await mount("updates", settings(), "preview", off);
    expect(h.host.textContent).toContain("Off. Farol checks for updates");
    expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "status",
    });
    vi.mocked(h.f.api.installedUpdate).mockResolvedValueOnce(on);
    await h.click("Turn on automatic downloads");
    expect(h.f.api.installedUpdate).toHaveBeenLastCalledWith({
      kind: "set-automatic-update-preference",
      enabled: true,
    });
    expect(h.c.getSnapshot().intents["update-automatic-downloads"]?.state).toBe(
      "applied",
    );
    expect(h.host.textContent).toContain(
      "Installation requires Install and Relaunch or separate consent",
    );
    expect(h.f.api.installedUpdate).not.toHaveBeenCalledWith({
      kind: "restart",
    });
    vi.mocked(h.f.api.installedUpdate).mockResolvedValueOnce(off);
    await h.click("Turn off automatic downloads");
    expect(h.f.api.installedUpdate).toHaveBeenLastCalledWith({
      kind: "set-automatic-update-preference",
      enabled: false,
    });
  });
  it("keeps an uncertain automatic download choice disabled without retry", async () => {
    const off = {
      phase: "idle" as const,
      checkedAt: null,
      automaticUpdatePreference: {
        status: "confirmed" as const,
        enabled: false,
      },
    };
    const h = await mount("updates", settings(), "preview", off);
    vi.mocked(h.f.api.installedUpdate).mockClear();
    vi.mocked(h.f.api.installedUpdate).mockResolvedValueOnce({
      ...off,
      automaticUpdatePreference: {
        status: "unknown",
        enabled: false,
        code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
      },
    });
    await h.click("Turn on automatic downloads");
    expect(h.c.getSnapshot().intents["update-automatic-downloads"]?.state).toBe(
      "unknown",
    );
    expect(
      h.host.querySelector<HTMLDetailsElement>(".update-options")?.open,
    ).toBe(true);
    expect(h.button("Turn on automatic downloads").disabled).toBe(true);
    await h.click("Turn on automatic downloads");
    expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "set-automatic-update-preference",
      enabled: true,
    });
  });
  it("does not expose automatic downloads without a confirmed installed preference", async () => {
    const h = await mount("updates");
    expect(h.button("Turn on automatic downloads").disabled).toBe(true);
    expect(h.host.textContent).toContain(
      "Download preference cannot be confirmed",
    );
    expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "status",
    });
  });
  it.each<WindowSnapshot["update"]>([
    { phase: "unavailable", code: "UPDATE_NOT_INSTALLED" },
    { phase: "idle", checkedAt: null },
    {
      phase: "ready",
      version: "0.2.1-owner.beta.1",
      deferred: false,
      blockedBy: null,
    },
  ])(
    "explains Dev rebuilds without installed update controls for $phase",
    async (update) => {
      const h = await mount("updates", settings(), "dev", update);
      const page = h.host.querySelector(
        'section[aria-label="Development app"]',
      )!.parentElement!;
      expect(page.closest("div[hidden]")).toBeNull();
      expect(page.textContent).toContain("Development app");
      expect(page.textContent).toContain(
        "Farol Dev is updated by rebuilding the development app from source.",
      );
      expect(page.textContent).toContain(
        "Installed app updates are available in the installed Farol app.",
      );
      expect(page.textContent).not.toContain("Installed update");
      expect(page.textContent).not.toContain("unavailable");
      expect(page.textContent).not.toContain("UPDATE_NOT_INSTALLED");
      expect(page.querySelectorAll("button")).toHaveLength(0);
      expect(h.c.getSnapshot().update).toEqual(update);
      expect(h.c.getSnapshot().overlay).toBe("none");
      expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
        kind: "status",
      });
      expect(h.calls()).toEqual([]);
      await h.pageTo("diagnostics");
      expect(h.host.textContent).toContain("Environment: dev");
      expect(h.c.getSnapshot().update).toEqual(update);
      await h.pageTo("updates");
      expect(page.closest("div[hidden]")).toBeNull();
      expect(page.textContent).toContain("Development app");
      expect(page.querySelectorAll("button")).toHaveLength(0);
      expect(h.f.api.installedUpdate).toHaveBeenCalledTimes(1);
    },
  );
  it("distinguishes a blocked downloaded update from the installed version", async () => {
    const h = await mount("updates", settings(), "preview", {
      phase: "ready",
      version: "0.2.0-owner.beta.4",
      deferred: false,
      blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(h.host.textContent).toContain("Update status");
    expect(h.host.textContent).toContain(
      "Installed: Farol 0.1.8-owner.beta.1 (build 10).",
    );
    expect(h.host.textContent).toContain(
      "Downloaded: Farol 0.2.0-owner.beta.4. Ready to install; this version is not installed yet.",
    );
    expect(h.host.textContent).not.toContain("Installed update");
    expect(h.host.textContent).toContain("UPDATE_BROWSER_STATE_UNKNOWN");
    expect(h.host.textContent).toContain("Installation has not started");
    expect(h.host.textContent).toContain("Do not retry this update action");
    expect(h.button("Check for Updates").disabled).toBe(true);
    expect(h.calls()).toEqual([]);
  });
  it("rechecks the latest update state before a rendered Check can dispatch", async () => {
    const h = await mount("updates");
    expect(h.button("Check for Updates").disabled).toBe(false);
    vi.mocked(h.f.api.installedUpdate).mockClear();
    const latest = {
      ...h.c.getSnapshot(),
      update: {
        phase: "ready" as const,
        version: "0.2.0-owner.beta.4",
        deferred: false,
        blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN",
      },
    };
    const read = vi.spyOn(h.c, "getSnapshot").mockReturnValue(latest);
    await h.click("Check for Updates");
    read.mockRestore();
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
  });
  it("preserves installed update diagnostics even with UPDATE_NOT_INSTALLED", async () => {
    const h = await mount("updates", settings(), "preview", {
      phase: "unavailable",
      code: "UPDATE_NOT_INSTALLED",
    });
    expect(h.host.textContent).toContain("Update status");
    expect(h.host.textContent).toContain("unavailable");
    expect(h.host.textContent).toContain("UPDATE_NOT_INSTALLED");
    expect(
      activePage(h.host).querySelector(".notice[role='status']")?.textContent,
    ).toContain("cannot confirm update availability");
    expect(activePage(h.host).querySelector("details code")?.textContent).toBe(
      "UPDATE_NOT_INSTALLED",
    );
    expect(h.host.textContent).not.toContain("Development app");
    expect(h.button("Check for Updates").disabled).toBe(true);
    vi.mocked(h.f.api.installedUpdate).mockClear();
    await h.click("View update");
    expect(h.c.getSnapshot().overlay).toBe("update");
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
  });
  it.each<WindowSnapshot["update"]>([
    { phase: "checking" },
    { phase: "downloading" },
    { phase: "applying", version: "0.2.1-owner.beta.1" },
  ])(
    "preserves the installed update check guard for $phase",
    async (update) => {
      const h = await mount("updates");
      await act(async () => h.f.emit("update", update));
      vi.mocked(h.f.api.installedUpdate).mockClear();
      expect(h.button("Check for Updates").disabled).toBe(true);
      await h.click("Check for Updates");
      expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
    },
  );
  it("exports diagnostics explicitly and observes only the existing pending edit", async () => {
    const h = await mount("diagnostics");
    await h.click("Export support diagnostics…");
    expect(h.calls()).toEqual([{ kind: "support.export" }]);
    const value = withFolder();
    value.computer.pendingEdit = {
      operationId: selectionId,
      workspaceId,
      relativePath: "file.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-02T20:00:00.000Z",
    };
    const pending = await mount("diagnostics", value);
    expect(pending.button("Export support diagnostics…").disabled).toBe(true);
    await pending.click("Observe existing edit");
    expect(pending.calls()).toEqual([
      { kind: "computer.observe-workspace-edit", operationId: selectionId },
    ]);
  });
});
it("R35 configurable shortcut form rejects duplicate keys and saves explicitly once", async () => {
  const h = await mount("shortcuts");
  const computer = h.host.querySelector<HTMLSelectElement>(
    '[aria-label="This Mac shortcut"]',
  )!;
  await change(computer, "1");
  await h.click("Save shortcuts");
  expect(h.host.textContent).toContain("Choose distinct section keys");
  expect(h.f.api.setNavigationShortcuts).not.toHaveBeenCalled();
  await change(computer, "2");
  const sidebar = h.host.querySelector<HTMLSelectElement>(
    '[aria-label="Toggle sidebar shortcut"]',
  )!;
  await change(sidebar, "b");
  await h.click("Save shortcuts");
  expect(h.f.api.setNavigationShortcuts).toHaveBeenCalledExactlyOnceWith({
    browser: 1,
    computer: 2,
    activity: 3,
    settings: 4,
    sidebar: "b",
  });
  expect(h.host.textContent).toContain("Shortcuts saved and active");
  await h.click("Restore default choices");
  expect(sidebar.value).toBe("s");
});
it("R18 a known refusal permits deliberate retry after resolving the cause, with no render retry", async () => {
  const h = await mount("general");
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: false,
    error: "SETTINGS_INPUT_INVALID",
    snapshot: h.configuration,
  });
  await h.click("Save navigation");
  expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  await h.pageTo("appearance");
  await h.pageTo("general");
  expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  await act(async () => h.c.refresh());
  await h.click("Save navigation");
  expect(h.f.api.configure).toHaveBeenCalledTimes(2);
});

it("R25 R29 unavailable facade projection retains dirty forms and fences commands", async () => {
  const h = await mount("general");
  const snapshot = h.c.getSnapshot();
  const render = async (
    configuration: typeof snapshot.configuration,
    status: typeof snapshot.status,
  ) =>
    act(async () =>
      h.root.render(
        <StrictMode>
          <Settings
            snapshot={{ ...snapshot, configuration, status }}
            facade={h.c}
          />
        </StrictMode>,
      ),
    );
  await render(snapshot.configuration, "current");
  const field = h.field("Start page");
  await change(field, "activity");
  await render({ status: "error", error: "SETTINGS_READ_FAILED" }, "stale");
  expect(h.field("Start page")).toBe(field);
  expect(field.value).toBe("activity");
  expect(h.host.textContent).toContain("Your drafts are retained");
  expect(h.button("Save navigation").disabled).toBe(true);
  await h.click("Save navigation");
  expect(h.calls()).toEqual([]);
  await render({ status: "ready", settings: settings(2) }, "current");
  expect(h.field("Start page")).toBe(field);
  expect(field.value).toBe("activity");
  expect(h.button("Save navigation").disabled).toBe(false);
  expect(h.calls()).toEqual([]);
});

const editOperationId = "44444444-4444-4444-8444-444444444444";
function writableFolder() {
  const value = withFolder();
  value.computer.workspaces[0]!.access = "write";
  value.setup.computer.verified = proof(value);
  value.setup.computer.reachable = "reachable";
  return value;
}
function editPreview(operationId = editOperationId) {
  return {
    kind: "computer.workspace-edit-preview" as const,
    operationId,
    workspaceId,
    relativePath: "file.txt",
    bytes: 123,
    beforeSha256: "b".repeat(64),
    expiresAt: "2099-10-04T20:00:00.000Z",
  };
}
type SettingsHarness = Awaited<ReturnType<typeof mount>>;
async function prepareEdit(
  h: SettingsHarness,
  evidence: unknown = editPreview(),
) {
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: h.configuration,
    evidence,
  });
  await h.click("Prepare edit…");
}
describe("R07 R15 R17 R20 guarded edit controls (injected DOM only)", () => {
  it("prepares explicitly, presents metadata as text, and applies one bounded replacement", async () => {
    const h = await mount("diagnostics", writableFolder());
    expect(h.calls()).toEqual([]);
    expect(h.button("Apply edit").disabled).toBe(true);
    await prepareEdit(h, {
      ...editPreview(),
      relativePath: "<script>alert(1)</script>.txt",
    });
    expect(h.host.querySelector("script")).toBeNull();
    expect(h.host.textContent).toContain("123 bytes");
    expect(h.host.textContent).toContain("b".repeat(64));
    expect(h.button("Prepare edit…").disabled).toBe(true);
    await change(h.field("Old text"), "exact\nold text");
    await change(h.field("New text"), "replacement\ntext");
    expect(h.button("Apply edit").disabled).toBe(false);
    await h.click("Apply edit");
    await h.click("Apply edit");
    expect(h.calls()).toEqual([
      { kind: "computer.prepare-workspace-edit", workspaceId },
      {
        kind: "computer.apply-workspace-edit",
        operationId: editOperationId,
        oldText: "exact\nold text",
        newText: "replacement\ntext",
      },
    ]);
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.field("Old text").value).toBe("exact\nold text");
    expect(h.f.api.task).not.toHaveBeenCalled();
    expect(h.host.textContent).toContain("Use Diagnostics");
  });
  it("uses the original schema bounds and permits an empty replacement", async () => {
    const h = await mount("diagnostics", writableFolder());
    await prepareEdit(h);
    expect(h.field("Old text").getAttribute("maxlength")).toBe("32768");
    expect(h.field("New text").getAttribute("maxlength")).toBe("32768");
    await change(h.field("Old text"), "x".repeat(32_769));
    expect(h.button("Apply edit").disabled).toBe(true);
    await change(h.field("Old text"), "x");
    await change(h.field("New text"), "y".repeat(32_769));
    expect(h.button("Apply edit").disabled).toBe(true);
    await change(h.field("New text"), "");
    await h.click("Apply edit");
    expect(h.calls()[1]).toEqual({
      kind: "computer.apply-workspace-edit",
      operationId: editOperationId,
      oldText: "x",
      newText: "",
    });
  });
  it.each([
    "read",
    "unverified",
    "wrong-build",
    "wrong-generation",
    "wrong-workspace",
    "missing-identity",
    "unknown",
    "unchecked",
  ])("requires verified current write access: %s", async (condition) => {
    const value = writableFolder();
    const folder = value.computer.workspaces[0]!;
    if (condition === "read") folder.access = "read";
    if (condition === "unverified") value.setup.computer.verified = null;
    if (condition === "wrong-build")
      value.setup.computer.verified!.buildId = "c".repeat(64);
    if (condition === "wrong-generation") value.computer.generation++;
    if (condition === "wrong-workspace")
      value.setup.computer.verified!.workspaceId = selectionId;
    if (condition === "missing-identity") delete folder.rootIdentity;
    if (condition === "unknown") value.setup.computer.outcomeUnknown = true;
    if (condition === "unchecked") folder.accessCheck = null;
    const h = await mount("diagnostics", value);
    expect(h.button("Prepare edit…").disabled).toBe(true);
    await h.click("Prepare edit…");
    expect(h.calls()).toEqual([]);
  });
  it("cancels only the selected operation explicitly, with no mount/page cancellation", async () => {
    const h = await mount("diagnostics", writableFolder());
    await prepareEdit(h);
    await h.pageTo("general");
    await h.pageTo("diagnostics");
    expect(h.calls()).toHaveLength(1);
    await h.click("Cancel edit");
    await h.click("Cancel edit");
    expect(h.calls()[1]).toEqual({
      kind: "computer.cancel-workspace-edit",
      operationId: editOperationId,
    });
    expect(h.calls()).toHaveLength(2);
    expect(h.button("Apply edit").disabled).toBe(true);
  });
  it("requires a fresh correlated Prepare to regain the same unconsumed preview after remount", async () => {
    const h = await mount("diagnostics", writableFolder());
    await prepareEdit(h);
    await change(h.field("Old text"), "old");
    await h.remount();
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.button("Cancel edit").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
    await prepareEdit(h);
    expect(h.button("Cancel edit").disabled).toBe(false);
    await change(h.field("Old text"), "old");
    expect(h.button("Apply edit").disabled).toBe(false);
    expect(h.calls()).toHaveLength(2);
  });
  it("regains a reused preview only by explicit Prepare after leaving Settings", async () => {
    const h = await mount("diagnostics", writableFolder());
    await prepareEdit(h);
    await act(async () => h.c.navigate({ area: "home" }));
    expect(h.host.textContent).toBe("");
    await act(async () =>
      h.c.navigate({ area: "settings", page: "diagnostics" }),
    );
    expect(h.button("Cancel edit").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
    await prepareEdit(h);
    expect(h.button("Cancel edit").disabled).toBe(false);
    await h.click("Cancel edit");
    expect(h.calls()[2]).toEqual({
      kind: "computer.cancel-workspace-edit",
      operationId: editOperationId,
    });
  });
  it.each([
    "workspaceId",
    "relativePath",
    "beforeSha256",
    "bytes",
    "expiresAt",
  ] as const)(
    "rejects changed metadata for the same ambient operation: %s",
    async (field) => {
      const h = await mount("diagnostics", writableFolder());
      await prepareEdit(h);
      await h.remount();
      const changed = {
        workspaceId: selectionId,
        relativePath: "other.txt",
        beforeSha256: "c".repeat(64),
        bytes: 125,
        expiresAt: "2099-10-05T20:00:00.000Z",
      };
      await prepareEdit(h, {
        ...editPreview(),
        [field]: changed[field],
      });
      expect(h.button("Apply edit").disabled).toBe(true);
      expect(h.button("Cancel edit").disabled).toBe(true);
    },
  );
  it.each(["foreign-workspace", "expired", "malformed", "absent"])(
    "rejects mismatched or missing preview: %s",
    async (condition) => {
      const h = await mount("diagnostics", writableFolder());
      const evidence =
        condition === "absent"
          ? undefined
          : {
              ...editPreview(),
              ...(condition === "foreign-workspace"
                ? { workspaceId: selectionId }
                : {}),
              ...(condition === "expired"
                ? { expiresAt: "2020-01-01T00:00:00.000Z" }
                : {}),
              ...(condition === "malformed"
                ? { beforeSha256: "bad-hash" }
                : {}),
            };
      // Do not use the default argument for the absent-evidence fixture.
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        ...(evidence ? { evidence } : {}),
      });
      await h.click("Prepare edit…");
      await change(h.field("Old text"), "old");
      expect(h.button("Apply edit").disabled).toBe(true);
      expect(h.button("Cancel edit").disabled).toBe(true);
      await h.click("Apply edit");
      expect(h.calls()).toHaveLength(1);
    },
  );
  it("fences a pending Prepare and Apply synchronously across duplicate clicks", async () => {
    const h = await mount("diagnostics", writableFolder());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    await h.click("Prepare edit…");
    await h.click("Prepare edit…");
    expect(h.calls()).toHaveLength(1);
    await act(async () =>
      pending.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: editPreview(),
      }),
    );
    await change(h.field("Old text"), "old");
    const apply = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(apply.promise);
    await act(async () => {
      h.button("Apply edit").click();
      h.button("Apply edit").click();
      h.button("Cancel edit").click();
    });
    expect(h.calls()).toHaveLength(2);
    await act(async () =>
      apply.resolve({ ok: true, snapshot: h.configuration }),
    );
  });
  it.each(["refused", "unknown"])(
    "consumes Apply permanently after %s",
    async (outcome) => {
      const h = await mount("diagnostics", writableFolder());
      await prepareEdit(h);
      await change(h.field("Old text"), "old");
      if (outcome === "refused")
        vi.mocked(h.f.api.configure).mockResolvedValueOnce({
          ok: false,
          error: "WORKSPACE_MUTATION_PREVIEW_NOT_FOUND",
          snapshot: h.configuration,
        });
      else
        vi.mocked(h.f.api.configure).mockRejectedValueOnce(
          new Error("lost response"),
        );
      await h.click("Apply edit");
      await h.pageTo("general");
      await h.pageTo("diagnostics");
      await h.click("Apply edit");
      expect(h.calls()).toHaveLength(2);
      expect(h.button("Apply edit").disabled).toBe(true);
      if (outcome === "unknown") {
        await h.click("Prepare edit…");
        expect(h.calls()).toHaveLength(2);
      } else {
        await prepareEdit(h); // A repeated consumed operation is never a new edit.
        expect(h.button("Apply edit").disabled).toBe(true);
      }
    },
  );
  it("blocks every Settings command after an unknown Prepare, including after remount", async () => {
    const h = await mount("diagnostics", writableFolder());
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(
      new Error("lost response"),
    );
    await h.click("Prepare edit…");
    await h.remount();
    await h.click("Prepare edit…");
    await h.pageTo("general");
    await h.click("Save navigation");
    expect(h.calls()).toHaveLength(1);
  });
  it("allows a distinct new explicit edit after a known completion", async () => {
    const h = await mount("diagnostics", writableFolder());
    await prepareEdit(h);
    await change(h.field("Old text"), "old");
    await h.click("Apply edit");
    await prepareEdit(h, editPreview(selectionId));
    await h.click("Apply edit");
    expect(h.calls()).toHaveLength(4);
    expect(h.calls()[3]).toEqual({
      kind: "computer.apply-workspace-edit",
      operationId: selectionId,
      oldText: "old",
      newText: "",
    });
  });
  it("R25 R29 retains nodes, drafts, caret and IME across background and page changes", async () => {
    const h = await mount("diagnostics", writableFolder());
    await prepareEdit(h);
    const old = h.field("Old text") as HTMLTextAreaElement;
    const replacement = h.field("New text");
    await change(old, "old\ntext");
    await change(replacement, "new\ntext");
    old.focus();
    old.setSelectionRange(2, 5);
    await act(async () =>
      old.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await act(async () => h.f.emit("route", { state: "loaded" }));
    await h.click("Apply edit");
    await h.click("Cancel edit");
    expect(h.calls()).toHaveLength(1);
    await h.pageTo("general");
    await h.pageTo("diagnostics");
    expect(h.field("Old text")).toBe(old);
    expect(old.value).toBe("old\ntext");
    expect(old.selectionStart).toBe(2);
    expect(old.selectionEnd).toBe(5);
    expect(h.field("New text")).toBe(replacement);
    expect(replacement.value).toBe("new\ntext");
    await act(async () =>
      old.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await h.click("Apply edit");
    expect(h.calls()).toHaveLength(2);
  });
  it("rejects a refresh racing Prepare, even at the same revision", async () => {
    const h = await mount("diagnostics", writableFolder());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    await h.click("Prepare edit…");
    await act(async () => h.c.refresh());
    await act(async () =>
      pending.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: editPreview(),
      }),
    );
    await change(h.field("Old text"), "old");
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.host.textContent).toContain("could not be confirmed");
  });
  it("rejects evidence after any foreign command transition during Prepare", async () => {
    const h = await mount("diagnostics", writableFolder());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    await h.click("Prepare edit…");
    await act(async () =>
      h.c.configure({ kind: "support.export" }, "foreign:command"),
    );
    await act(async () =>
      pending.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: editPreview(),
      }),
    );
    expect(h.button("Cancel edit").disabled).toBe(true);
    expect(h.host.textContent).toContain("could not be confirmed");
  });
  it.each([
    "revision",
    "generation",
    "read",
    "build",
    "stale",
    "expired",
    "foreign-evidence",
  ])(
    "rechecks the latest facade at click time, despite old rendered eligibility: %s",
    async (condition) => {
      const h = await mount("diagnostics", writableFolder());
      await prepareEdit(h);
      await change(h.field("Old text"), "old");
      const current = h.c.getSnapshot();
      const configuration = structuredClone(h.configuration);
      const next = { ...current, configuration };
      if (condition === "revision") configuration.settings.revision++;
      if (condition === "generation")
        configuration.settings.computer.generation++;
      if (condition === "read")
        configuration.settings.computer.workspaces[0]!.access = "read";
      if (condition === "build") next.buildId = "c".repeat(64);
      if (condition === "stale") next.status = "stale";
      if (condition === "foreign-evidence" || condition === "expired")
        next.evidence = {
          revision: configuration.settings.revision,
          value: {
            ...editPreview(),
            ...(condition === "expired"
              ? { expiresAt: "2020-01-01T00:00:00.000Z" }
              : { operationId: selectionId }),
          },
        };
      vi.spyOn(h.c, "getSnapshot").mockReturnValue(next);
      await h.click("Apply edit");
      await h.click("Cancel edit");
      await h.click("Prepare edit…");
      expect(h.calls()).toHaveLength(1);
    },
  );
  it("retains drafts but invalidates the review after an ordinary same-revision refresh", async () => {
    const h = await mount("diagnostics", writableFolder());
    await prepareEdit(h);
    const old = h.field("Old text");
    await change(old, "draft");
    await act(async () => h.c.refresh());
    expect(h.field("Old text")).toBe(old);
    expect(old.value).toBe("draft");
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.button("Cancel edit").disabled).toBe(true);
  });
  it("fences Prepare while another Settings action or pending edit result is unresolved", async () => {
    const h = await mount("general", writableFolder());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    await h.click("Save navigation");
    await h.pageTo("diagnostics");
    expect(h.button("Prepare edit…").disabled).toBe(true);
    await h.click("Prepare edit…");
    expect(h.calls()).toHaveLength(1);
    await act(async () =>
      pending.resolve({ ok: true, snapshot: h.configuration }),
    );
    const value = writableFolder();
    value.computer.pendingEdit = {
      operationId: editOperationId,
      workspaceId,
      relativePath: "file.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-04T20:00:00.000Z",
    };
    const blocked = await mount("diagnostics", value);
    await blocked.click("Prepare edit…");
    expect(blocked.calls()).toEqual([]);
  });
});

it("R11 R22 unmount during Prepare releases only observation and never adopts its late result", async () => {
  const h = await mount("diagnostics", writableFolder());
  const subscribe = h.c.subscribe;
  const disposers: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(h.c, "subscribe").mockImplementation((listener) => {
    const dispose = vi.fn(subscribe(listener));
    disposers.push(dispose);
    return dispose;
  });
  const pending = deferred<unknown>();
  vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
  await h.click("Prepare edit…");
  const commandObservation = disposers[0]!;
  await h.remount();
  expect(commandObservation).toHaveBeenCalledOnce();
  expect(h.calls()).toHaveLength(1);
  await act(async () =>
    pending.resolve({
      ok: true,
      snapshot: h.configuration,
      evidence: editPreview(),
    }),
  );
  expect(h.button("Apply edit").disabled).toBe(true);
  expect(h.button("Cancel edit").disabled).toBe(true);
  expect(h.calls()).toHaveLength(1);
});
it("R07 rejects authority drift in a Prepare reply even with equal revision and generation", async () => {
  const h = await mount("diagnostics", writableFolder());
  const next = structuredClone(h.configuration);
  next.settings.computer.workspaces[0]!.root = "/other/project";
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: next,
    evidence: editPreview(),
  });
  await h.click("Prepare edit…");
  expect(h.button("Cancel edit").disabled).toBe(true);
  expect(h.host.textContent).toContain("could not be confirmed");
});
it("checks expiry at dispatch time without needing a background render", async () => {
  const h = await mount("diagnostics", writableFolder());
  await prepareEdit(h);
  await change(h.field("Old text"), "old");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(editPreview().expiresAt));
  await h.click("Apply edit");
  await h.click("Cancel edit");
  expect(h.calls()).toHaveLength(1);
});
it("reads latest facade authority before Prepare when its rendered control is still enabled", async () => {
  const h = await mount("diagnostics", writableFolder());
  const current = h.c.getSnapshot();
  const configuration = structuredClone(h.configuration);
  configuration.settings.computer.workspaces[0]!.access = "read";
  vi.spyOn(h.c, "getSnapshot").mockReturnValue({ ...current, configuration });
  await h.click("Prepare edit…");
  expect(h.calls()).toHaveLength(0);
});
it("R20 preserves result delivery and requires existing explicit acknowledgement before a new edit", async () => {
  const h = await mount("diagnostics", writableFolder());
  await prepareEdit(h);
  await change(h.field("Old text"), "old");
  const pending = structuredClone(h.configuration);
  pending.settings.revision++;
  pending.settings.computer.pendingEdit = {
    operationId: editOperationId,
    workspaceId,
    relativePath: "file.txt",
    computerGeneration: 1,
    submittedAt: "2026-10-04T20:00:00.000Z",
  };
  const evidence = {
    kind: "computer.workspace-mutation",
    operationId: editOperationId,
    workspaceId,
    relativePath: "file.txt",
    operation: "edit",
    bytes: 120,
    replacements: 1,
    beforeSha256: "b".repeat(64),
    afterSha256: "c".repeat(64),
    resultRetention: "durable",
    redelivered: false,
  };
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: pending,
    evidence,
  });
  await h.click("Apply edit");
  expect(h.c.getSnapshot().workspaceEditDelivery).toBe(editOperationId);
  await h.remount();
  await h.click("Prepare edit…");
  expect(h.calls()).toHaveLength(2);
  await h.pageTo("diagnostics");
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: pending,
    evidence: { ...evidence, redelivered: true },
  });
  await h.click("Observe existing edit");
  expect(h.calls()[2]).toEqual({
    kind: "computer.observe-workspace-edit",
    operationId: editOperationId,
  });
  expect(
    h.calls().some((command) => command.kind === "computer.ack-workspace-edit"),
  ).toBe(false);
  const settled = structuredClone(pending);
  settled.settings.revision++;
  settled.settings.computer.pendingEdit = null;
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: settled,
  });
  await act(async () => h.c.acknowledgeWorkspaceEdit(editOperationId));
  await h.pageTo("diagnostics");
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: settled,
    evidence: editPreview(selectionId),
  });
  await h.click("Prepare edit…");
  await change(h.field("Old text"), "next");
  expect(h.button("Apply edit").disabled).toBe(false);
});
it.each([false, true])(
  "settles unknown Apply only after exact Observe+ACK and enables a NEW edit (remount: %s)",
  async (remount) => {
    const h = await mount("diagnostics", writableFolder());
    await prepareEdit(h);
    await change(h.field("Old text"), "old");
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(
      new Error("response lost after dispatch"),
    );
    await h.click("Apply edit");
    const pending = structuredClone(h.configuration);
    pending.settings.revision++;
    pending.settings.computer.pendingEdit = {
      operationId: editOperationId,
      workspaceId,
      relativePath: "file.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-04T20:00:00.000Z",
    };
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: pending,
    });
    await act(async () => h.c.refresh());
    await h.pageTo("diagnostics");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: pending,
      evidence: {
        kind: "computer.workspace-mutation",
        operationId: editOperationId,
        workspaceId,
        relativePath: "file.txt",
        operation: "edit",
        bytes: 120,
        replacements: 1,
        beforeSha256: "b".repeat(64),
        afterSha256: "c".repeat(64),
        resultRetention: "durable",
        redelivered: true,
      },
    });
    await h.click("Observe existing edit");
    expect(h.c.getSnapshot().workspaceEditDelivery).toBe(editOperationId);
    expect(
      h.c.getSnapshot().intents[
        `settings:computer.apply-workspace-edit:${editOperationId}`
      ]?.state,
    ).toBe("unknown");
    await h.pageTo("diagnostics");
    expect(h.button("Prepare edit…").disabled).toBe(true);
    await h.click("Prepare edit…");
    expect(h.calls()).toHaveLength(3); // Observation alone does not retire the intent.
    const signInBadge = () =>
      h.host.querySelector('[aria-label="Embedded ChatGPT · optional"] .badges')
        ?.textContent;
    expect(signInBadge()).toBe("Outcome unknown");

    const settled = structuredClone(pending);
    settled.settings.revision++;
    settled.settings.computer.pendingEdit = null;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: settled,
    });
    await act(async () => h.c.acknowledgeWorkspaceEdit(editOperationId));
    if (remount) await h.remount();
    await h.pageTo("diagnostics");
    expect(
      h.c.getSnapshot().intents[
        `settings:computer.apply-workspace-edit:${editOperationId}`
      ]?.state,
    ).toBe("applied");
    // Only the exact Observe+ACK settlement may clear the retained shared fence.
    // Sign-in presentation must agree with the existing command admission.
    expect(signInBadge()).not.toBe("Outcome unknown");
    expect(h.button("Prepare edit…").disabled).toBe(false);
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: settled,
      evidence: editPreview(),
    });
    await h.click("Prepare edit…");
    await change(h.field("Old text"), "old");
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.button("Cancel edit").disabled).toBe(true);
    await h.remount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: settled,
      evidence: editPreview(selectionId),
    });
    await h.click("Prepare edit…");
    await change(h.field("Old text"), "next");
    expect(h.button("Apply edit").disabled).toBe(false);
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: settled,
    });
    await h.click("Apply edit");
    expect(
      h
        .calls()
        .filter((command) => command.kind === "computer.apply-workspace-edit")
        .map((command) => command.operationId),
    ).toEqual([editOperationId, selectionId]);
  },
);

it("retains consumed operation identity after a known refusal and remount", async () => {
  const h = await mount("diagnostics", writableFolder());
  await prepareEdit(h);
  await change(h.field("Old text"), "old");
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: false,
    error: "WORKSPACE_MUTATION_IN_PROGRESS",
    snapshot: h.configuration,
  });
  await h.click("Apply edit");
  await h.remount();
  await prepareEdit(h);
  await change(h.field("Old text"), "old");
  expect(h.button("Apply edit").disabled).toBe(true);
  expect(h.button("Cancel edit").disabled).toBe(true);
  expect(h.calls()).toHaveLength(3);
});

describe("Computer-first setup and explicit reconnect", () => {
  it("shows the exact verified workspace and challenge without embedded login or automatic commands", async () => {
    const value = connectionSettings();
    value.setup.chatgpt.verified = null;
    value.connectors.secureMcp.attachment = null;
    value.setup.connect.verified = null;
    const other = structuredClone(value.computer.workspaces[0]!);
    other.workspaceId = selectionId;
    other.root = "/other/folder";
    other.rootIdentity = { device: "1", inode: "3" };
    other.excludedPaths = [];
    other.accessCheck = {
      buildId: "3".repeat(64),
      computerGeneration: value.computer.generation,
      rootIdentity: other.rootIdentity,
      verifiedAt: "2026-10-02T20:00:00.000Z",
    };
    value.computer.workspaces.unshift(other);
    ProductSettingsSchema.parse(value);
    const h = await mount("diagnostics", value);
    expect(h.c.getSnapshot().configuration?.status).toBe("ready");
    expect(h.host.textContent).toContain("Copy verification request");
    const card = h.host.querySelector("[data-connector-challenge]");
    expect(card?.querySelectorAll("dl code")[0]?.textContent).toBe(selectionId);
    expect(card?.querySelectorAll("dl code")[1]?.textContent).toBe(workspaceId);
    expect(card?.textContent).toContain("/approved/project");
    expect(card?.textContent).not.toContain("/other/folder");
    for (const page of ["folders", "computer", "connection"] as const)
      await h.pageTo(page);
    expect(h.calls()).toEqual([]);
    expect(h.button("Check attachment").disabled).toBe(false);
    await h.pageTo("diagnostics");
    expect(h.button("Check in ChatGPT once").disabled).toBe(true);
  });
  it.each(["build", "runtime", "computer", "connector", "workspace", "stale"])(
    "hides a challenge with mismatched current provenance: %s",
    async (mismatch) => {
      const value = connectionSettings();
      value.connectors.secureMcp.attachment = null;
      value.setup.connect.verified = null;
      if (mismatch === "build")
        value.connectors.secureMcp.challenge!.buildId = "e".repeat(64);
      if (mismatch === "runtime")
        value.connectors.secureMcp.challenge!.runtimeGeneration = "e".repeat(
          64,
        );
      if (mismatch === "computer")
        value.connectors.secureMcp.challenge!.computerGeneration++;
      if (mismatch === "connector") value.connectors.secureMcp.generation++;
      if (mismatch === "workspace")
        value.setup.computer.verified!.workspaceId = selectionId;
      const h = await mount("diagnostics", value);
      if (mismatch === "stale")
        await act(async () =>
          h.f.emit("runtime", {
            state: "offline",
            error: null,
            identity: null,
            embeddedNode: null,
            embeddedElectron: null,
          }),
        );
      expect(h.host.querySelector("[data-connector-challenge]")).toBeNull();
      expect(h.calls()).toEqual([]);
    },
  );
  it("double-click submits one Repair, never a renderer Stop/Start chain", async () => {
    const h = await mount("connection", connectionSettings());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    expect(() => h.button("Reconnect")).toThrow();
    await h.pageTo("diagnostics");
    const reconnect = h.button("Reconnect");
    await act(async () => {
      reconnect.click();
      reconnect.click();
    });
    expect(h.calls()).toEqual([{ kind: "connector.repair" }]);
    expect(h.button("Reconnect").disabled).toBe(true);
    await h.pageTo("folders");
    await h.pageTo("diagnostics");
    await h.click("Reconnect");
    expect(h.calls()).toHaveLength(1);
    await act(async () =>
      pending.resolve({
        ok: false,
        error: "CONNECTOR_STOP_UNCONFIRMED",
        snapshot: h.configuration,
      }),
    );
    expect(h.host.textContent).toContain("CONNECTOR_STOP_UNCONFIRMED");
    expect(h.calls()).toEqual([{ kind: "connector.repair" }]);
  });
  it.each([
    "pending",
    "unknown",
    "stale",
    "runtime-unknown",
    "runtime-stale",
    "unavailable",
  ])(
    "rechecks latest facade admission before reconnect, despite an enabled old control: %s",
    async (fence) => {
      const h = await mount("diagnostics", connectionSettings());
      const next = { ...structuredClone(h.c.getSnapshot()) };
      if (fence === "pending" || fence === "unknown")
        next.intents = {
          ...next.intents,
          foreign: { id: "foreign", state: fence, code: null },
        };
      if (fence === "stale") next.status = "stale";
      if (fence === "unavailable") next.configuration = null;
      if (next.configuration?.status === "ready") {
        if (fence === "runtime-unknown")
          next.configuration.settings.connectors.secureMcp.runtime!.state =
            "outcome_unknown";
        if (fence === "runtime-stale")
          next.configuration.settings.connectors.secureMcp.runtime!
            .connectorGeneration++;
      }
      vi.spyOn(h.c, "getSnapshot").mockReturnValue(next);
      await h.click("Reconnect");
      expect(h.calls()).toEqual([]);
    },
  );
  it("lost Repair reply stays unknown through page changes and does not repeat", async () => {
    const h = await mount("diagnostics", connectionSettings());
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(new Error("reply lost"));
    await h.click("Reconnect");
    await h.pageTo("folders");
    await h.pageTo("diagnostics");
    await h.click("Reconnect");
    expect(h.calls()).toEqual([{ kind: "connector.repair" }]);
    expect(h.host.textContent).toContain("Outcome unknown");
    await h.pageTo("connection");
    expect(() => h.button("Connect this Mac")).toThrow();
  });
  it("retains the original Go open IDs in Diagnostics after an unknown reply", async () => {
    const h = await mount("diagnostics", connectionSettings());
    const requestId = "44444444-4444-4444-8444-444444444444";
    const operationId = "55555555-5555-4555-8555-555555555555";
    const reply = {
      ok: false as const,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN" as const,
      snapshot: h.configuration,
      connectorAttempt: {
        method: "computer.connector.open" as const,
        requestId,
        operationId,
        outcome: "unknown" as const,
      },
    };
    expect(ProductConfigurationResultSchema.parse(reply)).toEqual(reply);
    vi.mocked(h.f.api.configure).mockResolvedValueOnce(reply);
    let intent: Awaited<ReturnType<typeof h.c.configure>> | undefined;
    await act(async () => {
      intent = await h.c.configure(
        { kind: "connector.start" },
        "settings:connector.start:original-go-open",
      );
    });
    expect(intent?.state).toBe("unknown");
    expect(intent?.connectorAttempt).toEqual(reply.connectorAttempt);
    await h.remount();
    const retained = h.host.querySelector('[aria-label="Retained actions"]');
    expect(retained?.textContent).toContain(requestId);
    expect(retained?.textContent).toContain(operationId);
    expect(retained?.textContent).toContain(
      "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    );
    expect(h.calls()).toEqual([{ kind: "connector.start" }]);
    expect(
      ProductConfigurationResultSchema.safeParse({
        ...reply,
        connectorAttempt: { ...reply.connectorAttempt, operationId: "invalid" },
      }).success,
    ).toBe(false);
  });
  it("explicit narrowing invalidates readiness and preserves drafts without auto reconnect", async () => {
    const value = connectionSettings();
    value.computer.workspaces[0]!.access = "write";
    const h = await mount("connection", value);
    await h.click("Edit connection");
    await change(h.field("Tunnel ID"), "unsaved-tunnel");
    const tunnel = h.field("Tunnel ID");
    const narrowed = structuredClone(h.configuration);
    narrowed.settings.revision++;
    narrowed.settings.computer.generation++;
    narrowed.settings.computer.workspaces[0]!.access = "read";
    narrowed.settings.setup.computer.verified = null;
    narrowed.settings.connectors.secureMcp.attachment = null;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: narrowed,
    });
    await h.pageTo("folders");
    await change(h.field("Workspace access"), "read");
    await h.click("Save");
    await h.pageTo("connection");
    expect(h.field("Tunnel ID")).toBe(tunnel);
    expect(tunnel.value).toBe("unsaved-tunnel");
    expect(
      h.host.querySelector('section[aria-label="This Mac connection"] .badges')
        ?.textContent,
    ).toBe("Workspace verification needed");
    expect(() => h.button("Connect this Mac")).toThrow();
    expect(() => h.button("Reconnect")).toThrow();
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "read" },
    ]);
  });
});

function activePage(host: Element) {
  return host.querySelector<HTMLElement>(".settings-page > div:not([hidden])")!;
}
describe("owner Setup presentation checkpoint (DOM fixtures only)", () => {
  it("General offers Review Setup navigation without effects or Model requirements", async () => {
    const h = await mount("general");
    const navigate = vi.spyOn(h.c, "navigate");
    await h.click("Review Setup");
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ area: "setup" });
    expect(h.host.querySelector('[aria-label="Setup overview"]')).toBeNull();
    expect(h.calls()).toEqual([]);
    expect(h.f.api.task).not.toHaveBeenCalled();
  });
  it.each(["connection", "attachment"] as const)(
    "Setup %s hides other groups while retaining mounted forms",
    async (step) => {
      const h = await mount(
        "connection",
        settings(),
        "preview",
        { phase: "idle", checkedAt: null },
        step,
      );
      const group = (title: string) =>
        h.host.querySelector(`[aria-label="${title}"]`)!;
      expect(group("This Mac connection").closest("div[hidden]") !== null).toBe(
        step !== "connection",
      );
      expect(group("Add to ChatGPT").closest("div[hidden]") !== null).toBe(
        step !== "attachment" && step !== "connection",
      );
      expect(
        group("Embedded ChatGPT · optional").closest("div[hidden]"),
      ).not.toBeNull();
      expect(
        group("This Mac connection").querySelector('input[type="password"]'),
      ).not.toBeNull();
      expect(group("This Mac connection").querySelector("h3")).toBeNull();
      expect(group("Add to ChatGPT").querySelector("h3")).toBeNull();
      expect(
        h.host.querySelector<HTMLDetailsElement>(".setup-help")?.open,
      ).toBe(false);
      expect(h.calls()).toEqual([]);
    },
  );
  it("keeps workspace prerequisites in Setup and leaves ordinary Settings routing intact", async () => {
    const value = connectionSettings();
    value.setup.computer.verified = null;
    for (const step of ["connection", undefined] as const) {
      const h = await mount(
        "connection",
        value,
        "preview",
        { phase: "idle", checkedAt: null },
        step,
      );
      const navigate = vi.spyOn(h.c, "navigate");
      await h.click("Verify a workspace");
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        step
          ? { area: "setup", setupStep: "folders" }
          : { area: "settings", page: "folders" },
      );
      expect(h.calls()).toEqual([]);
    }
  });
  it("discloses Setup diagnostics on demand without dispatching a command", async () => {
    const h = await mount(
      "connection",
      settings(),
      "preview",
      { phase: "idle", checkedAt: null },
      "connection",
    );
    const help = h.host.querySelector<HTMLDetailsElement>(".setup-help")!;
    expect(help.open).toBe(false);
    await act(async () => {
      help.open = true;
    });
    await h.click("Connection diagnostics");
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "settings",
      page: "diagnostics",
    });
    expect(h.calls()).toEqual([]);
    expect(h.f.api.task).not.toHaveBeenCalled();
  });
  it("Setup step changes retain the same credential draft nodes without saving", async () => {
    const h = await mount(
      "connection",
      settings(),
      "preview",
      { phase: "idle", checkedAt: null },
      "connection",
    );
    const tunnel = h.field("Tunnel ID");
    const key = h.field("Runtime key");
    await change(tunnel, "draft-tunnel");
    await change(key, "draft-key");
    await h.stepTo("attachment");
    expect(tunnel.isConnected).toBe(true);
    expect(tunnel.closest("div[hidden]")).not.toBeNull();
    await h.stepTo("connection");
    expect(h.field("Tunnel ID")).toBe(tunnel);
    expect(h.field("Runtime key")).toBe(key);
    expect(tunnel.value).toBe("draft-tunnel");
    expect(key.value).toBe("draft-key");
    expect(h.calls()).toEqual([]);
  });
  it("lists every workspace and binds detail commands only to the presentation selection", async () => {
    const value = withFolder();
    value.computer.workspaces.push({
      ...structuredClone(value.computer.workspaces[0]!),
      workspaceId: selectionId,
      root: "/approved/second",
      rootIdentity: { device: "1", inode: "3" },
      access: "write",
      excludedPaths: [],
    });
    const h = await mount("folders", ProductSettingsSchema.parse(value));
    const picker = activePage(h.host).querySelector(
      '[aria-label="Approved workspaces"]',
    )!;
    expect(picker.querySelectorAll("button")).toHaveLength(2);
    expect(picker.textContent).toContain("/approved/project");
    expect(picker.textContent).toContain("/approved/second");
    const select = picker.querySelector<HTMLButtonElement>(
      '[aria-label="Select workspace second"]',
    )!;
    await act(async () => select.click());
    expect(select.getAttribute("aria-current")).toBe("true");
    expect(
      activePage(h.host).querySelectorAll(".workspace-detail"),
    ).toHaveLength(1);
    expect(
      activePage(h.host).querySelector(".workspace-detail")?.textContent,
    ).toContain("/approved/second");
    expect(h.calls()).toEqual([]);
    await h.click("Verify workspace");
    await change(h.field("Workspace access"), "read");
    await h.click("Save");
    const remove = activePage(h.host).querySelector<HTMLButtonElement>(
      '[aria-label="Remove workspace second"]',
    )!;
    await act(async () => remove.click());
    expect(h.calls()).toHaveLength(2);
    await h.click("Confirm removal");
    expect(h.calls()).toEqual([
      { kind: "computer.verify-workspace", workspaceId: selectionId },
      {
        kind: "computer.update-access",
        workspaceId: selectionId,
        access: "read",
      },
      { kind: "computer.remove-workspace", workspaceId: selectionId },
    ]);
    expect(activePage(h.host).textContent).not.toMatch(
      /Old text|New text|Prepare edit|Excluded paths|expanded Git/,
    );
    await h.pageTo("diagnostics");
    expect(activePage(h.host).textContent).toContain("Old text");
    expect(h.calls()).toHaveLength(3); // Moving the tools never prepares an edit.
  });
  it("shows saved credentials without a key field and cancels only the replacement draft", async () => {
    const h = await mount("connection", connectionSettings());
    const page = activePage(h.host);
    expect(page.querySelector('input[type="password"]')).toBeNull();
    expect(page.textContent).toContain("Tunnel credentials saved");
    await h.click("Edit connection");
    expect(h.field("Runtime key").value).toBe("");
    await change(h.field("Tunnel ID"), "unsaved-tunnel");
    await change(h.field("Runtime key"), "explicit-test-replacement-000000");
    await h.click("Cancel");
    expect(page.querySelector('input[type="password"]')).toBeNull();
    expect(h.calls()).toEqual([]);
    await h.click("Edit connection");
    expect(h.field("Tunnel ID").value).toBe("owner-tunnel");
    expect(h.field("Runtime key").value).toBe("");
    expect(h.button("Save & connect").disabled).toBe(true);
  });
  it("requires a valid new key, clears it on dispatch and never reloads it from saved state", async () => {
    const value = connectionSettings();
    const h = await mount("connection", value);
    await h.click("Edit connection");
    await change(h.field("Runtime key"), "short");
    await h.click("Save & connect");
    expect(h.field("Runtime key").value).toBe("short");
    expect(h.calls()).toEqual([]);
    const secret = "explicit-test-replacement-000000";
    await change(h.field("Runtime key"), secret);
    const wait = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
    await h.click("Save & connect");
    expect(h.field("Runtime key").value).toBe("");
    await h.click("Save & connect");
    expect(h.calls()).toEqual([
      {
        kind: "connector.save-and-connect",
        operationId: expect.any(String),
        buildId: "3".repeat(64),
        tunnelId: "owner-tunnel",
        runtimeKey: secret,
      },
    ]);
    await act(async () =>
      wait.resolve({
        ok: true,
        snapshot: h.configuration,
        connectorSetup: {
          kind: "connector.save-and-connect",
          operationId: (h.calls()[0] as { operationId: string }).operationId,
          buildId: "3".repeat(64),
          state: "completed",
          stoppedAt: "complete",
          credentials: "saved",
          connection: "connected",
          code: null,
          externalVerification: "not-proven",
        },
      }),
    );
    expect(
      activePage(h.host).querySelector('input[type="password"]'),
    ).toBeNull();
    expect(JSON.stringify(h.c.getSnapshot())).not.toContain(secret);
    await h.click("Edit connection");
    expect(h.field("Runtime key").value).toBe("");
  });
  it("keeps an unknown replacement fenced without reporting new credentials as saved", async () => {
    const h = await mount("connection", connectionSettings());
    await h.click("Edit connection");
    await change(h.field("Runtime key"), "explicit-test-replacement-000000");
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(new Error("reply lost"));
    await h.click("Save & connect");
    expect(h.button("Save & connect").disabled).toBe(true);
    expect(
      activePage(h.host).querySelector(".credentials-saved strong")
        ?.textContent,
    ).toBe("Credential replacement unconfirmed");
    expect(
      h.host.querySelector('.settings-page > [role="status"]')?.textContent,
    ).toContain("Outcome unknown");
    await h.pageTo("folders");
    await h.pageTo("connection");
    await h.click("Save & connect");
    expect(h.calls()).toHaveLength(1);
    expect(h.field("Runtime key").value).toBe("");
  });
  it("keeps pending and late feedback on the page that initiated the action", async () => {
    const h = await mount("connection");
    const wait = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
    await h.click("Sign in");
    expect(
      h.host.querySelector('.settings-page > [role="status"]')?.textContent,
    ).toContain("Saving or checking");
    await h.pageTo("folders");
    expect(h.host.querySelector('.settings-page > [role="status"]')).toBeNull();
    await act(async () =>
      wait.resolve({
        ok: false,
        error: "CHATGPT_SIGN_IN_IN_PROGRESS",
        snapshot: h.configuration,
      }),
    );
    expect(h.host.querySelector('.settings-page > [role="status"]')).toBeNull();
    await h.pageTo("connection");
    expect(
      h.host.querySelector('.settings-page > [role="status"]')?.textContent,
    ).toContain("Sign-in is already open");
    expect(
      h.host.querySelector('.settings-page > [role="status"]')?.textContent,
    ).not.toContain("CHATGPT_SIGN_IN_IN_PROGRESS");
    expect(h.calls()).toHaveLength(1);
  });
  it.each(["SUPPORT_EXPORT_CANCELLED", "WORKSPACE_PICKER_CANCELLED"])(
    "presents %s as a local cancellation and retains the raw result in Diagnostics",
    async (code) => {
      const page =
        code === "SUPPORT_EXPORT_CANCELLED" ? "diagnostics" : "folders";
      const h = await mount(page);
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: false,
        error: code,
        snapshot: h.configuration,
      });
      await h.click(
        page === "diagnostics"
          ? "Export support diagnostics…"
          : "Add workspace…",
      );
      const notice = h.host.querySelector('.settings-page > [role="status"]');
      expect(notice?.textContent).toBe("Action cancelled.");
      expect(h.host.querySelector('[role="alert"]')).toBeNull();
      await h.pageTo("computer");
      expect(
        h.host.querySelector('.settings-page > [role="status"]'),
      ).toBeNull();
      await h.pageTo("diagnostics");
      expect(
        activePage(h.host).querySelector('[aria-label="Retained actions"]')
          ?.textContent,
      ).toContain(code);
      expect(h.calls()).toHaveLength(1);
    },
  );
  it("keeps This Mac focused on permissions and exposes acceptance controls only in Diagnostics", async () => {
    const h = await mount("computer", withFolder());
    const normal = activePage(h.host);
    expect(normal.textContent).toContain("Terminal & Git");
    expect(normal.textContent).not.toMatch(
      /Astra|Apple Git|sandboxed|Check account|first message|Read-only file preview|Saved Chat answers/,
    );
    await change(h.field("Command access"), "verification");
    await h.click("Save permissions");
    expect(h.calls()).toEqual([
      { kind: "computer.update-commands", commands: "verification" },
    ]);
    await h.pageTo("diagnostics");
    expect(activePage(h.host).textContent).toContain("Check account");
    expect(activePage(h.host).textContent).toContain("Saved Chat answers");
    expect(h.calls()).toHaveLength(1);
  });
  it("changes file policy only on the explicit save action and describes linked-file access", async () => {
    const h = await mount("computer", withFolder());
    expect(h.field("File access").value).toBe("");
    expect(activePage(h.host).textContent).toContain(
      "linked into an approved folder",
    );
    expect(h.calls()).toEqual([]);
    await change(h.field("File access"), "approved-roots-v1");
    expect(h.calls()).toEqual([]);
    await h.click("Save file permissions");
    expect(h.calls()).toEqual([
      { kind: "computer.update-file-policy", filePolicy: "approved-roots-v1" },
    ]);
  });
  it.each(["verification", "workspace"] as const)(
    "explains the saved file-policy blocker for %s without treating a draft as permission",
    async (commands) => {
      const value = withFolder();
      value.computer.commands = commands;
      const h = await mount("computer", value);
      const status = () =>
        h.host
          .querySelector('section[aria-label="Terminal & Git"] [role="status"]')
          ?.textContent?.replace(/\s+/gu, " ");
      expect(status()).toContain(
        "unavailable with protected-file restrictions",
      );
      expect(status()).toContain("hidden and sensitive files");
      await change(h.field("File access"), "approved-roots-v1");
      expect(status()).toContain(
        "unavailable with protected-file restrictions",
      );
      expect(h.calls()).toEqual([]);
    },
  );
  it.each([
    { commands: "none", filePolicy: "" },
    { commands: "workspace", filePolicy: "approved-roots-v1" },
  ] as const)(
    "does not invent a file-policy blocker for $commands/$filePolicy",
    async (choice) => {
      const value = withFolder();
      Object.assign(value.computer, choice);
      const h = await mount("computer", value);
      const group = h.host.querySelector(
        'section[aria-label="Terminal & Git"]',
      )!;
      expect(group.textContent).not.toContain(
        "unavailable with protected-file restrictions",
      );
      expect(group.textContent).toContain("Shell requires a supported build");
      expect(h.calls()).toEqual([]);
    },
  );
});

describe("review regressions: retained action origins and exact edit delivery", () => {
  const notice = (host: Element) =>
    host.querySelector('.settings-page > [role="status"]')?.textContent ??
    activePage(host).querySelector('.workspace-feedback [role="status"]')
      ?.textContent;
  it.each(["Verify workspace", "Add workspace…"])(
    "retains Connection refusal after Folders %s and Settings remount",
    async (action) => {
      const h = await mount("connection", withFolder());
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: false,
        error: "CHATGPT_SIGN_IN_IN_PROGRESS",
        snapshot: h.configuration,
      });
      await h.click("Sign in");
      await h.pageTo("folders");
      if (action === "Add workspace…")
        vi.mocked(h.f.api.configure).mockResolvedValueOnce({
          ok: false,
          error: "WORKSPACE_PICKER_CANCELLED",
          snapshot: h.configuration,
        });
      await h.click(action);
      expect(notice(h.host)).toContain(
        action === "Add workspace…"
          ? "Action cancelled"
          : "Workspace check request completed",
      );
      await act(async () => h.c.navigate({ area: "home" }));
      await act(async () =>
        h.c.navigate({ area: "settings", page: "connection" }),
      );
      expect(notice(h.host)).toContain("Sign-in is already open");
      await h.pageTo("folders");
      expect(notice(h.host)).toContain(
        action === "Add workspace…"
          ? "Action cancelled"
          : "Workspace check request completed",
      );
      expect(h.calls()).toHaveLength(2);
    },
  );
  it("retains a late refusal after leaving Settings without overwriting another page", async () => {
    const h = await mount("connection");
    const waiting = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(waiting.promise);
    await h.click("Sign in");
    await act(async () => h.c.navigate({ area: "home" }));
    await act(async () =>
      waiting.resolve({
        ok: false,
        error: "CHATGPT_SIGN_IN_IN_PROGRESS",
        snapshot: h.configuration,
      }),
    );
    await act(async () => h.c.navigate({ area: "settings", page: "folders" }));
    expect(notice(h.host)).toBeUndefined();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "WORKSPACE_PICKER_CANCELLED",
      snapshot: h.configuration,
    });
    await h.click("Add workspace…");
    await h.pageTo("connection");
    expect(notice(h.host)).toContain("Sign-in is already open");
    await h.click("Sign in");
    expect(notice(h.host)).toContain("Sign-in request opened");
    await h.pageTo("folders");
    expect(notice(h.host)).toBe("Action cancelled.");
    expect(h.calls()).toHaveLength(3);
  });
  it("keeps an adapter exception fenced and visible even if no controller intent was retained", async () => {
    const h = await mount("connection");
    vi.spyOn(h.c, "configure").mockRejectedValueOnce(
      new Error("adapter failed before dispatch"),
    );
    await h.click("Sign in");
    await h.remount();
    expect(notice(h.host)).toContain("Outcome unknown");
    expect(h.button("Sign in").disabled).toBe(true);
    await h.pageTo("folders");
    expect(h.button("Add workspace…").disabled).toBe(true);
    await h.pageTo("diagnostics");
    expect(
      activePage(h.host).querySelector(
        '[aria-label="Actions needing observation"]',
      )?.textContent,
    ).toContain("settings:chatgpt.open-sign-in:");
    await h.click("Return to Connection");
    expect(h.c.getSnapshot().destination.page).toBe("connection");
    expect(h.calls()).toEqual([]);
  });
  it.each(["confirmed", "unknown", "refused"] as const)(
    "shows the exact refused edit and %s acknowledgement across remount",
    async (ack) => {
      const h = await mount("diagnostics", writableFolder());
      await prepareEdit(h);
      await change(h.field("Old text"), "old");
      vi.mocked(h.f.api.configure).mockRejectedValueOnce(
        new Error("Apply reply lost"),
      );
      await h.click("Apply edit");
      const pending = structuredClone(h.configuration);
      pending.settings.revision++;
      pending.settings.computer.pendingEdit = {
        operationId: editOperationId,
        workspaceId,
        relativePath: "file.txt",
        computerGeneration: 1,
        submittedAt: "2026-10-04T20:00:00.000Z",
      };
      vi.mocked(h.f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: pending,
      });
      await act(async () => h.c.refresh());
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: false,
        error: "WORKSPACE_MUTATION_CONFLICT",
        snapshot: pending,
      });
      await h.click("Observe existing edit");
      const edit = () =>
        activePage(h.host).querySelector(
          '[aria-label="Workspace edit result"]',
        )!;
      expect(edit().textContent).toContain(editOperationId);
      expect(edit().textContent).toContain(
        "Observation: Refused. WORKSPACE_MUTATION_CONFLICT",
      );
      expect(edit().textContent).toContain("Edit submission: Outcome unknown");
      expect(h.button("Prepare edit…").disabled).toBe(true);
      const settled = structuredClone(pending);
      settled.settings.revision++;
      settled.settings.computer.pendingEdit = null;
      if (ack === "unknown")
        vi.mocked(h.f.api.configure).mockRejectedValueOnce(
          new Error("ACK reply lost"),
        );
      else if (ack === "refused")
        vi.mocked(h.f.api.configure).mockResolvedValueOnce({
          ok: false,
          error: "WORKSPACE_MUTATION_NOT_PENDING",
          snapshot: pending,
        });
      else
        vi.mocked(h.f.api.configure).mockResolvedValueOnce({
          ok: true,
          snapshot: settled,
        });
      await h.click("Record result delivery");
      await h.remount();
      expect(edit().textContent).toContain(
        "Observation: Refused. WORKSPACE_MUTATION_CONFLICT",
      );
      if (ack === "confirmed") {
        expect(edit().textContent).toContain(
          "Edit submission: Refused. WORKSPACE_MUTATION_CONFLICT",
        );
        expect(edit().textContent).toContain(
          "Result acknowledgement: Confirmed.",
        );
        expect(notice(h.host)).toBe(
          "Workspace edit refused. Review the exact result in Diagnostics.",
        );
        expect(edit().textContent).not.toContain("Outcome unknown");
        expect(h.button("Prepare edit…").disabled).toBe(false);
      } else {
        expect(edit().textContent).toContain(
          `Result acknowledgement: ${ack === "unknown" ? "Outcome unknown" : "Refused"}.`,
        );
        expect(edit().textContent).toContain(
          ack === "unknown"
            ? "CONFIGURATION_OUTCOME_UNKNOWN"
            : "WORKSPACE_MUTATION_NOT_PENDING",
        );
        expect(h.button("Prepare edit…").disabled).toBe(true);
        if (ack === "unknown") {
          expect(h.button("Record result delivery").disabled).toBe(true);
          await h.click("Record result delivery");
          expect(h.button("Observe existing edit").disabled).toBe(false);
          vi.mocked(h.f.api.configure).mockResolvedValueOnce({
            ok: false,
            error: "WORKSPACE_MUTATION_CONFLICT",
            snapshot: pending,
          });
          await h.click("Observe existing edit");
          expect(edit().textContent).toContain(
            "Result acknowledgement: Outcome unknown.",
          );
          expect(h.button("Prepare edit…").disabled).toBe(true);
        }
      }
      expect(
        h
          .calls()
          .filter((command) => command.kind === "computer.ack-workspace-edit"),
      ).toEqual([
        { kind: "computer.ack-workspace-edit", operationId: editOperationId },
      ]);
      expect(
        h
          .calls()
          .filter(
            (command) => command.kind === "computer.apply-workspace-edit",
          ),
      ).toHaveLength(1);
    },
  );
  it("keeps actual external verification and Check attachment together in normal Connection", async () => {
    const value = connectionSettings();
    value.setup.chatgpt.verified = null;
    value.setup.connect.verified = null;
    value.connectors.secureMcp.attachment = null;
    const h = await mount("connection", value);
    const attachment = () =>
      activePage(h.host).querySelector('[aria-label="Add to ChatGPT"]')!;
    expect(
      attachment().querySelector(".attachment-technical summary")?.textContent,
    ).toBe("Technical details");
    expect(h.button("Copy verification request").disabled).toBe(false);
    expect(attachment().textContent).toContain("farol_next_connector_verify");
    expect(attachment().textContent).toContain(workspaceId);
    expect(attachment().textContent).toContain(selectionId);
    expect(h.button("Check attachment").disabled).toBe(false);
    const verified = connectionSettings();
    verified.revision++;
    verified.setup.chatgpt.verified = null;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: { status: "ready", settings: verified },
    });
    await h.click("Check attachment");
    expect(attachment().textContent).toContain(
      "Attachment checked · Computer ready",
    );
    expect(h.calls()).toEqual([{ kind: "connector.check-attachment" }]);
    expect(activePage(h.host).textContent).not.toContain("Check account");
  });
  it("copies only the current external request on a click without submitting it", async () => {
    const value = connectionSettings();
    value.setup.connect.verified = null;
    value.connectors.secureMcp.attachment = null;
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      const h = await mount("connection", value, "dev");
      expect(h.host.textContent).toContain("Attach this Farol Dev connection");
      expect(h.host.querySelector(".attachment-steps li")?.textContent).toBe(
        "Open Tunnels in ChatGPT and attach this Farol Dev connection.",
      );
      expect(h.host.textContent).not.toContain("Copied. Paste the request");
      await h.click("Copy verification request");
      expect(writeText).toHaveBeenCalledTimes(1);
      const request = writeText.mock.calls[0]![0] as string;
      expect(request).toContain("Farol Dev connector");
      expect(request).toContain("farol_next_connector_verify exactly once");
      expect(request).toContain(
        JSON.stringify({
          challenge: selectionId,
          workspaceId,
        }),
      );
      expect(request).not.toContain("owner-tunnel");
      expect(h.host.textContent).toContain("Copied. Paste the request");
      expect(h.calls()).toEqual([]);
      await h.pageTo("general");
      await h.pageTo("connection");
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(h.calls()).toEqual([]);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
  it("keeps a manual current request available when clipboard access fails", async () => {
    const value = connectionSettings();
    value.setup.connect.verified = null;
    value.connectors.secureMcp.attachment = null;
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    try {
      const h = await mount("connection", value, "dev");
      await h.click("Copy verification request");
      expect(h.host.textContent).toContain("Copy was unavailable");
      expect(
        h.host.querySelector(".attachment-request")?.textContent,
      ).toContain(selectionId);
      expect(h.calls()).toEqual([]);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

// Eligibility fixtures prove presentation/adapter behavior only.
describe("dependency-scoped Settings admission", () => {
  it.each(["pending", "refused", "unknown"] as const)(
    "independent Model %s allows folder actions without settling Model",
    async (state) => {
      const h = await mount("diagnostics", withFolder());
      const wait = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
      await h.click("Preview model configuration");
      if (state !== "pending")
        await act(async () =>
          state === "unknown"
            ? wait.reject(new Error("lost model reply"))
            : wait.resolve({
                ok: false,
                error: "MODEL_ENDPOINT_UNAVAILABLE",
                snapshot: h.configuration,
              }),
        );
      await h.pageTo("folders");
      expect(h.button("Verify workspace").disabled).toBe(false);
      await h.click("Verify workspace");
      expect(h.calls()).toEqual([
        { kind: "model.preview", selectAsDefault: false },
        { kind: "computer.verify-workspace", workspaceId },
      ]);
      if (state === "pending")
        await act(async () => wait.reject(new Error("late old model reply")));
      if (state !== "refused") {
        await act(async () => h.c.refresh());
        await h.remount();
        expect(h.button("Verify workspace").disabled).toBe(false);
        expect(
          h.c.getSnapshot().intents["settings:model.preview:"]?.state,
        ).toBe("unknown");
        await h.pageTo("diagnostics");
        expect(h.button("Preview model configuration").disabled).toBe(true);
        expect(h.button("Check model status").disabled).toBe(false);
        await h.click("Check model status");
        expect(
          h.c.getSnapshot().intents["settings:model.preview:"]?.state,
        ).toBe("unknown");
        await h.remount();
        expect(h.button("Preview model configuration").disabled).toBe(true);
      }
    },
  );
  it.each(["pending", "refused", "unknown"] as const)(
    "independent Chat browser %s allows folder actions and keeps its receipt",
    async (state) => {
      const h = await mount("connection", withFolder());
      const wait = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
      await h.click("Open ChatGPT");
      if (state !== "pending")
        await act(async () =>
          state === "unknown"
            ? wait.reject(new Error("lost browser reply"))
            : wait.resolve({
                ok: false,
                error: "CHATGPT_PAGE_UNREACHABLE",
                snapshot: h.configuration,
              }),
        );
      await h.pageTo("folders");
      expect(h.button("Verify workspace").disabled).toBe(false);
      await h.click("Verify workspace");
      if (state === "pending")
        await act(async () => wait.reject(new Error("late browser reply")));
      await h.remount();
      expect(h.button("Verify workspace").disabled).toBe(false);
      if (state !== "refused") {
        await h.pageTo("connection");
        expect(h.button("Open ChatGPT").disabled).toBe(true);
        expect(
          h.c.getSnapshot().intents["settings:chatgpt.open-browser:"]?.state,
        ).toBe("unknown");
      }
      expect(h.calls()).toEqual([
        { kind: "chatgpt.open-browser" },
        { kind: "computer.verify-workspace", workspaceId },
      ]);
    },
  );
  it("retained Chat readiness uncertainty permits folders while sign-in stays fenced through refresh/remount", async () => {
    const value = withFolder();
    value.setup.chatgpt.outcomeUnknown = true;
    const h = await mount("connection", value);
    expect(h.button("Sign in").disabled).toBe(true);
    await h.pageTo("folders");
    await h.click("Verify workspace");
    await act(async () => h.c.refresh());
    await h.remount();
    expect(h.button("Verify workspace").disabled).toBe(false);
    expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
    await h.pageTo("connection");
    expect(h.button("Sign in").disabled).toBe(true);
  });
  it("shared sign-in writer unknown blocks Computer but leaves navigation and Refresh observation available", async () => {
    const h = await mount("connection", withFolder());
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(
      new Error("lost shared writer reply"),
    );
    await h.click("Sign in");
    await h.pageTo("folders");
    expect(h.button("Verify workspace").disabled).toBe(true);
    await h.remount();
    await h.pageTo("diagnostics");
    await h.click("Refresh status");
    await h.click("Return to Connection");
    expect(h.button("Sign in").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
  });
  it("an unretained Model adapter failure stays global across remount", async () => {
    const h = await mount("diagnostics", withFolder());
    vi.spyOn(h.c, "configure").mockRejectedValueOnce(
      new Error("adapter lost retention"),
    );
    await h.click("Preview model configuration");
    await h.pageTo("folders");
    await h.remount();
    expect(h.button("Verify workspace").disabled).toBe(true);
    expect(h.calls()).toEqual([]);
  });
});

it("opens the dedicated connection guide once without saving the connection draft", async () => {
  const h = await mount("connection", settings(), "dev", quitOff, "connection");
  await change(h.field("Runtime key"), "local-draft-not-a-saved-key");
  await h.stepTo("attachment");
  expect(h.calls()).toEqual([]);
  await h.click("Open connection guide");
  expect(h.calls()).toEqual([
    { kind: "onboarding.open-help", destination: "setup-guide" },
  ]);
  expect(h.f.api.task).not.toHaveBeenCalled();
  await h.stepTo("connection");
  expect(h.field("Runtime key").value).toBe("local-draft-not-a-saved-key");
});

it("opens the Farol connection guide locally without saving a draft or sending a host command", async () => {
  const h = await mount(
    "connection",
    settings(),
    "dev",
    { phase: "idle", checkedAt: null },
    "connection",
  );
  const key = h.field("Runtime key");
  await change(key, "local-draft-not-a-saved-key");
  await h.stepTo("attachment");
  const guide = h.host.querySelector<HTMLDetailsElement>(".connection-guide")!;
  const summary = guide.querySelector<HTMLElement>("summary")!;
  expect(guide.open).toBe(false);
  await act(async () => summary.click());
  expect(guide.open).toBe(true);
  expect(guide.textContent).toContain("Sign in.");
  expect(guide.textContent).toContain("sends one small verification request");
  expect(guide.textContent).toContain("inspect it before trying again");
  expect(guide.textContent).not.toContain(key.value);
  await act(async () => summary.click());
  expect(guide.open).toBe(false);
  await h.stepTo("connection");
  expect(h.field("Runtime key")).toBe(key);
  expect(key.value).toBe("local-draft-not-a-saved-key");
  expect(h.calls()).toEqual([]);
  expect(h.f.api.task).not.toHaveBeenCalled();
});
it("keeps read-only connection guidance available while the original Save result is unknown", async () => {
  const h = await mount("connection", connectionSettings(), "dev");
  await h.click("Edit connection");
  await change(h.field("Runtime key"), "explicit-test-replacement-000000");
  vi.mocked(h.f.api.configure).mockRejectedValueOnce(new Error("lost reply"));
  await h.click("Save & connect");
  const intents = h.c.getSnapshot().intents;
  expect(
    Object.values(intents).some((intent) => intent.state === "unknown"),
  ).toBe(true);
  const guide = h.host.querySelector<HTMLDetailsElement>(".connection-guide")!;
  await act(async () => guide.querySelector<HTMLElement>("summary")!.click());
  expect(guide.open).toBe(true);
  expect(h.c.getSnapshot().intents).toEqual(intents);
  expect(h.calls()).toHaveLength(1);
  expect(h.button("Save & connect").disabled).toBe(true);
  expect(h.f.api.task).not.toHaveBeenCalled();
});
// Saved permission and file checks do not prove native command availability.
it.each(["none", "verification", "workspace"] as const)(
  "saved %s permission stays distinct from command availability with current or stale file evidence",
  async (commands) => {
    for (const current of [true, false]) {
      const value = connectionSettings();
      value.computer.commands = commands;
      if (!current) value.setup.connect.verified!.buildId = "f".repeat(64);
      const h = await mount("computer", value);
      const group = h.host.querySelector(
        'section[aria-label="Terminal & Git"]',
      )!;
      const copy = () => group.textContent!.replace(/\s+/gu, " ");
      const saved =
        commands === "none"
          ? "off"
          : commands === "verification"
            ? "Git checks only"
            : "Terminal in approved folders";
      expect(copy()).toContain(`Saved command permission: ${saved}.`);
      expect(copy()).toContain(
        "Shell requires a supported build and verified workspace access",
      );
      expect(copy()).toContain(
        "File and connection checks do not verify command execution",
      );
      expect(h.field("Command access").value).toBe(commands);
      expect(h.button("Save permissions").disabled).toBe(true);
      await change(
        h.field("Command access"),
        commands === "none" ? "workspace" : "none",
      );
      expect(copy()).toContain(`Saved command permission: ${saved}.`);
      expect(h.button("Save permissions").disabled).toBe(false);
      expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
      expect(h.calls()).toEqual([]);
      await h.pageTo("connection");
      const badge = h.host.querySelector(
        'section[aria-label="This Mac connection"] .badges',
      )!.textContent;
      expect(badge === "Computer ready").toBe(current);
      expect(h.calls()).toEqual([]);
    }
  },
);

// Exact Setup/controller DOM fixtures. These do not observe accounts or native state.
describe("fresh and returning Setup journey", () => {
  const mountSetup = (
    step: "signin" | "folders" | "attachment",
    value = connectionSettings(),
    signInState: "authenticated" | "signed_out" | "unknown" = "signed_out",
  ) =>
    mount(
      "connection",
      value,
      "dev",
      { phase: "idle", checkedAt: null },
      step,
      true,
      signInState,
    );
  const visibleText = (host: Element) =>
    [...host.querySelectorAll("p,li")]
      .filter(
        (element) =>
          !element.closest("[hidden]") &&
          !element.closest("details:not([open])"),
      )
      .map((element) => element.textContent)
      .join(" ");
  async function refreshSetup(
    h: Awaited<ReturnType<typeof mount>>,
    value: ProductSettings,
  ) {
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      environment: "dev",
      configuration: {
        status: "ready",
        settings: ProductSettingsSchema.parse(value),
      },
    });
    await act(async () => h.c.refresh());
  }

  it("summarizes the verified workspace instead of the first grant and continues without a recheck", async () => {
    const value = connectionSettings();
    value.computer.workspaces.unshift({
      ...structuredClone(value.computer.workspaces[0]!),
      workspaceId: selectionId,
      root: "/approved/other",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "3" },
    });
    const h = await mountSetup("folders", value);
    const detail = h.host.querySelector(".workspace-detail")!;
    expect(detail.textContent).toContain("/approved/project");
    expect(visibleText(h.host)).toContain("Saved access: Read-only");
    expect(visibleText(h.host)).toContain("Access checked · Current workspace");
    expect(visibleText(h.host)).not.toContain(
      "Access is checked for this build and saved scope",
    );
    const details = detail.querySelector<HTMLDetailsElement>(
      ".workspace-technical",
    )!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(
      "Access details and activity",
    );
    expect(details.textContent).toContain(
      "Access is checked for this build and saved scope",
    );
    for (const text of ["Save", "Cancel", "Verify workspace"])
      expect(() => h.button(text)).toThrow();
    expect(h.field("Workspace access").value).toBe("read");
    await h.click("Continue");
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "setup",
      setupStep: "attachment",
    });
    expect(h.calls()).toEqual([]);
  });

  it.each(["pending", "refused", "unknown"] as const)(
    "keeps a current %s workspace check outside the closed details",
    async (state) => {
      const value = connectionSettings();
      value.setup.computer.verified = null;
      const h = await mountSetup("folders", value);
      const wait = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
      await h.click("Verify workspace");
      if (state === "refused")
        await act(async () =>
          wait.resolve({
            ok: false,
            error: "WORKSPACE_ROOT_CHANGED",
            snapshot: h.configuration,
          }),
        );
      if (state === "unknown")
        await act(async () => wait.reject(new Error("reply lost")));
      const feedback = h.host.querySelector(".workspace-feedback")!;
      const status = feedback.querySelector('[role="status"]')!;
      expect(status.closest("details")).toBeNull();
      expect(visibleText(h.host)).toContain(
        state === "pending"
          ? "Saving or checking"
          : state === "refused"
            ? "no longer has the approved root identity"
            : "Outcome unknown",
      );
      expect(feedback.querySelector<HTMLDetailsElement>("details")!.open).toBe(
        false,
      );
      expect(h.calls()).toEqual([
        { kind: "computer.verify-workspace", workspaceId },
      ]);
      if (state === "pending")
        await act(async () =>
          wait.resolve({ ok: true, snapshot: h.configuration }),
        );
    },
  );

  it("updates a retained save's verification guidance after current access is checked", async () => {
    const h = await mountSetup("folders");
    await change(h.field("Workspace access"), "write");
    const saved = connectionSettings();
    saved.revision++;
    saved.computer.generation++;
    saved.computer.workspaces[0]!.access = "write";
    saved.computer.workspaces[0]!.accessCheck = null;
    saved.setup.computer.verified = null;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: { status: "ready", settings: saved },
    });
    await h.click("Save");
    const receipt =
      h.c.getSnapshot().intents[
        `settings:computer.update-access:${workspaceId}`
      ];
    const detail = h.host.querySelector(".workspace-detail")!;
    expect(detail.textContent).toContain("Verify it again");
    expect(visibleText(h.host)).toContain("Check access needed");
    expect(visibleText(h.host)).not.toContain("Verify it again");
    const checked = structuredClone(saved);
    checked.setup.computer.verified = proof(checked);
    checked.computer.workspaces[0]!.accessCheck = {
      rootIdentity: checked.computer.workspaces[0]!.rootIdentity!,
      buildId: "3".repeat(64),
      computerGeneration: checked.computer.generation,
      verifiedAt: "2026-10-02T20:00:00.000Z",
    };
    await refreshSetup(h, checked);
    await h.remount();
    const details = h.host.querySelector<HTMLDetailsElement>(
      ".workspace-technical",
    )!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(
      "Workspace access saved. Current access is checked.",
    );
    expect(h.host.textContent).not.toContain("Verify it again");
    expect(visibleText(h.host)).toContain("Access checked · Current workspace");
    expect(
      h.c.getSnapshot().intents[
        `settings:computer.update-access:${workspaceId}`
      ],
    ).toBe(receipt);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(visibleText(h.host)).toContain(
      "Workspace access saved. Current access is checked.",
    );
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "write" },
    ]);
  });

  it("keeps the empty workspace requirement and explains Remove beside the current grant", async () => {
    const empty = await mountSetup("folders", settings());
    expect(visibleText(empty.host)).toContain("No workspaces approved");
    expect(visibleText(empty.host)).not.toContain(
      "Local file access is optional",
    );
    expect(empty.host.querySelector(".workspace-detail")).toBeNull();
    expect(empty.button("Add workspace…").disabled).toBe(false);
    const h = await mountSetup("folders");
    const remove = h.host.querySelector<HTMLButtonElement>(
      '[aria-label="Remove workspace project"]',
    )!;
    const note = h.host.querySelector(
      `[id="${remove.getAttribute("aria-describedby")}"]`,
    )!;
    expect(note.textContent).toBe(
      "Remove revokes Farol access. Files on disk are kept.",
    );
    expect(note.closest("details")).toBeNull();
    expect(h.calls()).toEqual([]);
    expect(empty.calls()).toEqual([]);
  });

  it.each([
    "build",
    "generation",
    "identity",
    "missing",
    "unknown",
    "stale",
  ] as const)(
    "does not present a %s workspace witness as currently checked",
    async (condition) => {
      const value = connectionSettings();
      if (condition === "build")
        value.setup.computer.verified!.buildId = "f".repeat(64);
      if (condition === "generation") value.computer.generation++;
      if (condition === "identity")
        value.computer.workspaces[0]!.accessCheck = {
          buildId: "3".repeat(64),
          computerGeneration: value.computer.generation,
          rootIdentity: { device: "1", inode: "999" },
          verifiedAt: "2026-10-02T20:00:00.000Z",
        };
      if (condition === "missing") value.setup.computer.verified = null;
      if (condition === "unknown") value.setup.computer.outcomeUnknown = true;
      const h = await mountSetup("folders", value);
      if (condition === "stale") {
        vi.mocked(h.f.api.bootstrap).mockRejectedValueOnce(
          new Error("observation unavailable"),
        );
        await act(async () => h.c.refresh());
      }
      expect(visibleText(h.host)).not.toContain(
        "Access is checked for this build and saved scope",
      );
      expect(visibleText(h.host)).not.toMatch(/\bAccess checked\b/);
      expect(h.button("Verify workspace").disabled).toBe(
        condition === "unknown" || condition === "stale",
      );
      if (condition === "unknown")
        expect(visibleText(h.host)).toContain("unconfirmed outcome");
      expect(h.calls()).toEqual([]);
    },
  );

  it("Access is directly editable in the guarded form, Cancel restores saved access, and navigation retains the draft", async () => {
    const h = await mountSetup("folders");
    const select = h.host.querySelector<HTMLSelectElement>(
      ".workspace-detail select",
    )!;
    expect(h.field("Workspace access")).toBe(select);
    expect(() => h.button("Cancel")).toThrow();
    await change(select, "write");
    await h.click("Continue");
    expect(select.isConnected).toBe(true);
    await act(async () =>
      h.c.navigate({ area: "setup", setupStep: "folders" }),
    );
    expect(h.field("Workspace access")).toBe(select);
    expect(select.value).toBe("write");
    await h.click("Cancel");
    expect(select.value).toBe("read");
    expect(h.field("Workspace access").value).toBe("read");
    expect(h.field("Workspace access")).toBe(select);
    expect(() => h.button("Save")).toThrow();
    expect(
      h.host
        .querySelector('[aria-label="Remove workspace project"]')
        ?.closest("div[hidden]"),
    ).toBeNull();
    expect(h.calls()).toEqual([]);
  });

  it("retains a stale access draft across navigation and refuses saving it until Cancel", async () => {
    const h = await mountSetup("folders");
    await change(h.field("Workspace access"), "write");
    const changed = connectionSettings();
    changed.computer.generation++;
    await h.click("Continue");
    await refreshSetup(h, changed);
    await h.stepTo("folders");
    expect(h.field("Workspace access").value).toBe("write");
    expect(visibleText(h.host)).toContain(
      "Workspace access or identity changed while this draft was open",
    );
    expect(h.button("Save").disabled).toBe(true);
    await h.click("Save");
    await h.click("Cancel");
    expect(h.field("Workspace access").value).toBe("read");
    expect(h.calls()).toEqual([]);
  });

  it("fences a retained UNKNOWN save through Cancel, refresh and return without replay", async () => {
    const h = await mountSetup("folders");
    await change(h.field("Workspace access"), "write");
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(new Error("reply lost"));
    await h.click("Save");
    const receipt =
      h.c.getSnapshot().intents[
        `settings:computer.update-access:${workspaceId}`
      ];
    expect(receipt?.state).toBe("unknown");
    expect(h.field("Workspace access").value).toBe("write");
    await h.click("Cancel");
    await h.click("Continue");
    await refreshSetup(h, connectionSettings());
    await h.stepTo("folders");
    await h.remount();
    expect(
      h.c.getSnapshot().intents[
        `settings:computer.update-access:${workspaceId}`
      ],
    ).toBe(receipt);
    expect(visibleText(h.host)).toContain("unconfirmed outcome");
    expect(visibleText(h.host)).not.toContain(
      "Access is checked for this build and saved scope",
    );
    expect(h.button("Verify workspace").disabled).toBe(true);
    await change(h.field("Workspace access"), "write");
    expect(h.button("Save").disabled).toBe(true);
    await h.click("Save");
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "write" },
    ]);
  });

  it.each(["composition", "eligibility"] as const)(
    "does not fence Add when a late add reply's automatic check is blocked before dispatch by %s",
    async (guard) => {
      const h = await mount("folders", settings());
      const saved = withFolder();
      saved.computer.workspaces[0]!.access = "write";
      const pendingAdd = deferred<unknown>();
      vi.mocked(h.f.api.configure)
        .mockResolvedValueOnce({
          ok: true,
          snapshot: h.configuration,
          evidence: { kind: "computer.workspace-pick", selectionId },
        })
        .mockReturnValueOnce(pendingAdd.promise);
      await h.click("Add workspace…");
      expect(h.calls()).toHaveLength(2);
      await h.pageTo("general");
      const field = h.field("Start page");
      if (guard === "composition")
        await act(async () =>
          field.dispatchEvent(
            new CompositionEvent("compositionstart", { bubbles: true }),
          ),
        );
      else
        await act(async () =>
          h.f.emit("runtime", {
            state: "offline",
            error: null,
            identity: null,
            embeddedNode: null,
            embeddedElectron: null,
          }),
        );
      await act(async () =>
        pendingAdd.resolve({
          ok: true,
          snapshot: { status: "ready", settings: saved },
          evidence: { kind: "computer.workspace-selection", workspaceId },
        }),
      );
      expect(h.calls()).toEqual([
        { kind: "computer.choose-workspace" },
        { kind: "computer.add-workspace", selectionId, access: "write" },
      ]);
      expect(
        h.c.getSnapshot().intents[
          `settings:computer.verify-workspace:${workspaceId}`
        ],
      ).toBeUndefined();
      if (guard === "composition")
        await act(async () =>
          field.dispatchEvent(
            new CompositionEvent("compositionend", { bubbles: true }),
          ),
        );
      vi.mocked(h.f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: { status: "ready", settings: saved },
      });
      await act(async () => h.c.refresh());
      await h.pageTo("folders");
      await h.remount();
      expect(h.button("Add workspace…").disabled).toBe(false);
      await h.click("Add workspace…");
      expect(h.calls()).toHaveLength(3);
      expect(h.calls()[2]).toEqual({ kind: "computer.choose-workspace" });
    },
  );

  it.each(["transport", "malformed", "facade"] as const)(
    "keeps an uncertain automatic check fenced after %s failure through cached remount and background refresh",
    async (failure) => {
      const h = await mount("folders", settings());
      const saved = withFolder();
      saved.computer.workspaces[0]!.access = "write";
      vi.mocked(h.f.api.configure)
        .mockResolvedValueOnce({
          ok: true,
          snapshot: h.configuration,
          evidence: { kind: "computer.workspace-pick", selectionId },
        })
        .mockResolvedValueOnce({
          ok: true,
          snapshot: { status: "ready", settings: saved },
          evidence: { kind: "computer.workspace-selection", workspaceId },
        });
      if (failure === "transport")
        vi.mocked(h.f.api.configure).mockRejectedValueOnce(
          new Error("reply lost"),
        );
      if (failure === "malformed")
        vi.mocked(h.f.api.configure).mockResolvedValueOnce({ ok: true });
      if (failure === "facade") {
        vi.mocked(h.f.api.configure).mockResolvedValueOnce({
          ok: true,
          snapshot: { status: "ready", settings: saved },
        });
        const configure = h.c.configure.bind(h.c);
        vi.spyOn(h.c, "configure").mockImplementation(async (command, id) => {
          const result = await configure(command, id);
          if (command.kind === "computer.verify-workspace")
            throw new Error("adapter failed after dispatch");
          return result;
        });
      }
      await h.click("Add workspace…");
      const calls = h.calls().length;
      expect(h.button("Add workspace…").disabled).toBe(true);
      await h.remount();
      expect(h.button("Add workspace…").disabled).toBe(true);
      // Even a matching checked projection is observation, not an explicit
      // request-owned native readback receipt for the guided controller.
      const checked = structuredClone(saved);
      checked.setup.computer.reachable = "reachable";
      checked.setup.computer.verified = proof(checked);
      const issued = h.calls()[2]!;
      if (issued.kind !== "computer.verify-workspace")
        throw new Error("wrong fixture check");
      checked.computer.workspaces[0]!.accessCheck = {
        checkId: issued.checkId,
        rootIdentity: checked.computer.workspaces[0]!.rootIdentity!,
        buildId: "3".repeat(64),
        computerGeneration: checked.computer.generation,
        verifiedAt: "2026-10-02T20:00:00.000Z",
      };
      vi.mocked(h.f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: { status: "ready", settings: checked },
      });
      await act(async () => h.f.emit("configuration", undefined));
      await h.pageTo("general");
      await h.pageTo("folders");
      await h.remount();
      expect(h.button("Add workspace…").disabled).toBe(true);
      await h.click("Add workspace…");
      expect(h.calls()).toHaveLength(calls);
      expect(visibleText(h.host)).toContain("unconfirmed outcome");
      await h.click("Refresh status");
      expect(h.button("Add workspace…").disabled).toBe(failure === "facade");
      expect(h.calls()).toHaveLength(calls);
      if (failure !== "facade")
        expect(
          h.c.getSnapshot().intents[
            `settings:computer.verify-workspace:${workspaceId}`
          ],
        ).toMatchObject({
          state: "applied",
          code: "WORKSPACE_READBACK_CONFIRMED",
        });
    },
  );

  it("keeps a lost-before-native check fenced on an already checked workspace until its exact issued result is read", async () => {
    const saved = withFolder();
    saved.computer.workspaces[0]!.access = "write";
    saved.setup.computer.reachable = "reachable";
    saved.setup.computer.verified = proof(saved);
    saved.computer.workspaces[0]!.accessCheck = {
      checkId: "55555555-5555-4555-8555-555555555555",
      rootIdentity: saved.computer.workspaces[0]!.rootIdentity!,
      buildId: "3".repeat(64),
      computerGeneration: saved.computer.generation,
      verifiedAt: "2026-10-02T20:00:00.000Z",
    };
    const h = await mount("folders", saved);
    vi.mocked(h.f.api.configure)
      .mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: { kind: "computer.workspace-pick", selectionId },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: { kind: "computer.workspace-selection", workspaceId },
      })
      .mockRejectedValueOnce(
        new Error("request lost before native inspection"),
      );
    await h.click("Add workspace…");
    const issued = h.calls()[2]!;
    if (issued.kind !== "computer.verify-workspace" || !issued.checkId)
      throw new Error("missing issued fixture check");
    expect(issued.checkId).not.toBe(
      saved.computer.workspaces[0]!.accessCheck!.checkId,
    );
    await h.click("Refresh status");
    await h.remount();
    expect(h.button("Add workspace…").disabled).toBe(true);
    const other = structuredClone(saved);
    other.revision++;
    other.computer.workspaces[0]!.accessCheck!.checkId =
      "66666666-6666-4666-8666-666666666666";
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: { status: "ready", settings: other },
    });
    await h.click("Refresh status");
    expect(h.button("Add workspace…").disabled).toBe(true);
    const exact = structuredClone(other);
    exact.revision++;
    // Adapter fixture of the actual producer echo after the issued check lands;
    // the durable producer path is exercised in onboarding-evidence.test.ts.
    exact.computer.workspaces[0]!.accessCheck!.checkId = issued.checkId;
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: { status: "ready", settings: exact },
    });
    await h.click("Refresh status");
    expect(h.button("Add workspace…").disabled).toBe(false);
    expect(h.calls()).toHaveLength(3);
  });

  it.each(["superseded", "remount", "navigation"] as const)(
    "does not reconcile a late explicit Settings refresh after %s",
    async (condition) => {
      const h = await mount("folders", settings());
      const saved = withFolder();
      saved.computer.workspaces[0]!.access = "write";
      vi.mocked(h.f.api.configure)
        .mockResolvedValueOnce({
          ok: true,
          snapshot: h.configuration,
          evidence: { kind: "computer.workspace-pick", selectionId },
        })
        .mockResolvedValueOnce({
          ok: true,
          snapshot: { status: "ready", settings: saved },
          evidence: { kind: "computer.workspace-selection", workspaceId },
        })
        .mockRejectedValueOnce(new Error("reply lost"));
      await h.click("Add workspace…");
      const checked = structuredClone(saved);
      checked.setup.computer.reachable = "reachable";
      checked.setup.computer.verified = proof(checked);
      const issued = h.calls()[2]!;
      if (issued.kind !== "computer.verify-workspace")
        throw new Error("wrong fixture check");
      checked.computer.workspaces[0]!.accessCheck = {
        checkId: issued.checkId,
        rootIdentity: checked.computer.workspaces[0]!.rootIdentity!,
        buildId: "3".repeat(64),
        computerGeneration: checked.computer.generation,
        verifiedAt: "2026-10-02T20:00:00.000Z",
      };
      const response = {
        ...bootstrap(),
        configuration: { status: "ready", settings: checked },
      };
      const late = deferred<unknown>();
      vi.mocked(h.f.api.bootstrap)
        .mockReturnValueOnce(late.promise)
        .mockResolvedValue(response);
      await h.click("Refresh status");
      if (condition === "superseded") await act(async () => h.c.refresh());
      if (condition === "remount") await h.remount();
      if (condition === "navigation") await h.pageTo("general");
      await act(async () => late.resolve(response));
      if (condition === "navigation") await h.pageTo("folders");
      expect(h.button("Add workspace…").disabled).toBe(true);
      expect(
        h.c.getSnapshot().intents[
          `settings:computer.verify-workspace:${workspaceId}`
        ]?.state,
      ).toBe("unknown");
      await h.click("Refresh status");
      expect(h.button("Add workspace…").disabled).toBe(false);
      expect(h.calls()).toHaveLength(3);
    },
  );

  it("adds and checks a fresh workspace in one user action without a manual Verify step", async () => {
    const h = await mountSetup("folders", settings());
    const saved = withFolder();
    saved.computer.workspaces[0]!.access = "write";
    const checked = structuredClone(saved);
    checked.setup.computer.reachable = "reachable";
    checked.setup.computer.verified = proof(checked);
    checked.computer.workspaces[0]!.accessCheck = {
      rootIdentity: checked.computer.workspaces[0]!.rootIdentity!,
      buildId: "3".repeat(64),
      computerGeneration: checked.computer.generation,
      verifiedAt: "2026-10-02T20:00:00.000Z",
    };
    vi.mocked(h.f.api.configure)
      .mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: {
          kind: "computer.workspace-pick",
          selectionId,
          displayPath: "/approved/project",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { status: "ready", settings: saved },
        evidence: { kind: "computer.workspace-selection", workspaceId },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { status: "ready", settings: checked },
      });
    await h.click("Add workspace…");
    expect(visibleText(h.host)).toContain("Access checked · Current workspace");
    expect(visibleText(h.host)).not.toContain("Workspace access checked:");
    const details = h.host.querySelector<HTMLDetailsElement>(
      ".workspace-technical",
    )!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(
      "Workspace access checked: /approved/project. Saved access: Read & write",
    );
    expect(() => h.button("Verify workspace")).toThrow();
    expect(h.calls()).toEqual([
      { kind: "computer.choose-workspace" },
      { kind: "computer.add-workspace", selectionId, access: "write" },
      {
        kind: "computer.verify-workspace",
        workspaceId,
        checkId: expect.any(String),
      },
    ]);
  });

  it("shows a retained checked attachment with Continue and no first-time copy ritual", async () => {
    const value = connectionSettings();
    value.connectors.secureMcp.challenge = null;
    const h = await mountSetup("attachment", value);
    expect(visibleText(h.host)).toContain(
      "Attachment checked · Computer ready",
    );
    expect(visibleText(h.host)).toContain(
      "retained attachment check matches this build",
    );
    expect(h.host.querySelector(".attachment-steps")).toBeNull();
    expect(() => h.button("Copy verification request")).toThrow();
    expect(() => h.button("Check attachment")).toThrow();
    expect(h.button("Open connection guide")).toBeTruthy();
    await h.click("Back to overview");
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "setup",
      setupStep: "overview",
    });
    expect(h.calls()).toEqual([]);
  });

  it.each(["missing", "stale", "unknown"] as const)(
    "keeps unfinished attachment steps useful with a %s challenge and no unavailable copy instruction",
    async (condition) => {
      const value = connectionSettings();
      value.connectors.secureMcp.attachment = null;
      value.setup.connect.verified = null;
      if (condition === "missing") value.connectors.secureMcp.challenge = null;
      if (condition === "stale")
        value.connectors.secureMcp.challenge!.buildId = "f".repeat(64);
      if (condition === "unknown") value.setup.connect.outcomeUnknown = true;
      const h = await mountSetup("attachment", value);
      expect(visibleText(h.host)).toContain(
        "No current verification request is available",
      );
      expect(visibleText(h.host)).not.toContain(
        "Copy the current verification request",
      );
      expect(visibleText(h.host)).not.toContain("Computer ready");
      expect(() => h.button("Copy verification request")).toThrow();
      expect(h.button("Open Tunnels")).toBeTruthy();
      expect(h.button("Check attachment").disabled).toBe(
        condition === "unknown",
      );
      if (condition === "unknown")
        expect(visibleText(h.host)).toContain("Do not repeat");
      await h.stepTo("folders");
      await h.stepTo("attachment");
      expect(h.calls()).toEqual([]);
    },
  );

  it("offers Copy only for the unfinished current challenge and keeps the existing footer", async () => {
    const value = connectionSettings();
    value.connectors.secureMcp.attachment = null;
    value.setup.connect.verified = null;
    const h = await mountSetup("attachment", value);
    expect(visibleText(h.host)).toContain(
      "Copy the current verification request",
    );
    expect(h.button("Copy verification request").disabled).toBe(false);
    expect(h.button("Back to overview")).toBeTruthy();
    expect(h.calls()).toEqual([]);
  });

  it.each(["authenticated", "signed_out", "unsupported"] as const)(
    "Settings reports its own %s verification after retiring an older authenticated sample",
    async (state) => {
      const h = await mount("connection", connectionSettings());
      const wait = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockImplementation((command) =>
        command.kind === "chatgpt.observe-sign-in"
          ? Promise.resolve(
              signInReply(command, "authenticated", h.configuration),
            )
          : wait.promise,
      );
      await act(async () =>
        h.c.navigate({ area: "setup", setupStep: "signin" }),
      );
      expect(h.c.getSnapshot().signInObservation?.state).toBe("authenticated");
      await act(async () =>
        h.c.navigate({ area: "settings", page: "connection" }),
      );
      await h.click("Check sign-in");
      expect(h.c.getSnapshot().signInObservation).toBeNull();
      const readiness = {
        kind: "chatgpt.readiness",
        state,
        code:
          state === "authenticated"
            ? null
            : state === "signed_out"
              ? "CHATGPT_SIGN_IN_REQUIRED"
              : "CHATGPT_UI_UNRECOGNIZED",
      };
      await act(async () =>
        wait.resolve({
          ok: true,
          snapshot: h.configuration,
          evidence: readiness,
        }),
      );
      expect(
        h.c.getSnapshot().intents["settings:chatgpt.verify:"],
      ).toMatchObject({
        state: "applied",
        chatGptReadiness: readiness,
      });
      expect(visibleText(h.host)).toContain(
        state === "authenticated"
          ? "This check observed a signed-in ChatGPT page."
          : state === "signed_out"
            ? "This check observed a signed-out ChatGPT page."
            : "This check could not recognize the ChatGPT page.",
      );
      expect(h.c.getSnapshot().signInObservation).toBeNull();
      expect(
        h.calls().filter((command) => command.kind === "chatgpt.verify"),
      ).toHaveLength(1);
      await h.remount();
      expect(
        h.calls().filter((command) => command.kind === "chatgpt.verify"),
      ).toHaveLength(1);
    },
  );

  it("Settings reports authenticated verification from its own receipt with no previous sample", async () => {
    const h = await mount("connection", connectionSettings());
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: {
        kind: "chatgpt.readiness",
        state: "authenticated",
        code: null,
      },
    });
    await h.click("Check sign-in");
    expect(visibleText(h.host)).toContain(
      "This check observed a signed-in ChatGPT page.",
    );
    expect(h.c.getSnapshot().signInObservation).toBeNull();
    expect(h.calls()).toEqual([{ kind: "chatgpt.verify" }]);
  });

  it("Settings retains its original check result after refresh wins publication and remount", async () => {
    const h = await mount("connection", connectionSettings());
    const wait = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
    await h.click("Check sign-in");
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: { status: "ready", settings: settings(99) },
    });
    await act(async () => h.c.refresh());
    await h.remount();
    const readiness = {
      kind: "chatgpt.readiness",
      state: "signed_out",
      code: "CHATGPT_SIGN_IN_REQUIRED",
    };
    await act(async () =>
      wait.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: readiness,
      }),
    );
    expect(h.c.getSnapshot().configuration).toMatchObject({
      settings: { revision: 99 },
    });
    expect(h.c.getSnapshot().intents["settings:chatgpt.verify:"]).toMatchObject(
      { chatGptReadiness: readiness },
    );
    expect(visibleText(h.host)).toContain(
      "This check observed a signed-out ChatGPT page.",
    );
    expect(h.c.getSnapshot().signInObservation).toBeNull();
    expect(h.calls()).toEqual([{ kind: "chatgpt.verify" }]);
  });

  it.each(["missing", "wrong-kind", "malformed"])(
    "Settings cannot promote %s evidence into this check's sign-in result",
    async (kind) => {
      const h = await mount("connection", connectionSettings());
      const evidence =
        kind === "missing"
          ? undefined
          : kind === "wrong-kind"
            ? {
                kind: "chatgpt.sign-in-status",
                observationId: randomUUID(),
                buildId: "3".repeat(64),
                state: "authenticated",
                binding: { documentGeneration: 1, sequence: 1 },
              }
            : {
                kind: "chatgpt.readiness",
                state: "authenticated",
                code: null,
                content: "excluded",
              };
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        ...(evidence ? { evidence } : {}),
      });
      await h.click("Check sign-in");
      expect(
        h.c.getSnapshot().intents["settings:chatgpt.verify:"]?.chatGptReadiness,
      ).toBeUndefined();
      expect(visibleText(h.host)).not.toContain(
        "This check observed a signed-in ChatGPT page.",
      );
      expect(h.c.getSnapshot().signInObservation).toBeNull();
      await h.remount();
      expect(h.calls()).toEqual([{ kind: "chatgpt.verify" }]);
    },
  );

  it("ready sign-in uses Continue without Sign in, launcher or Check actions", async () => {
    const h = await mountSetup("signin", connectionSettings(), "authenticated");
    expect(visibleText(h.host)).toContain("Current sign-in was observed");
    for (const label of [
      "Sign in",
      "Open ChatGPT",
      "Check sign-in",
      "Skip for now",
    ])
      expect(() => h.button(label)).toThrow();
    await h.click("Continue");
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "setup",
      setupStep: "connection",
    });
    await h.stepTo("signin");
    expect(() => h.button("Sign in")).toThrow();
    expect(h.calls().map((command) => command.kind)).toEqual([
      "chatgpt.observe-sign-in",
      "chatgpt.observe-sign-in",
    ]);
  });

  it("signed-out Skip uses facade navigation and preserves unchecked account and grants on return", async () => {
    const value = connectionSettings();
    value.setup.chatgpt.verified = null;
    const h = await mountSetup("signin", value);
    const navigate = vi.spyOn(h.c, "navigate");
    expect(h.button("Sign in").disabled).toBe(false);
    expect(visibleText(h.host)).not.toContain("Sign-in is checked");
    await h.click("Skip for now");
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      area: "setup",
      setupStep: "connection",
    });
    expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
    await h.stepTo("signin");
    expect(h.button("Sign in").disabled).toBe(false);
    expect(h.button("Skip for now")).toBeTruthy();
    expect(h.calls().map((command) => command.kind)).toEqual([
      "chatgpt.observe-sign-in",
      "chatgpt.observe-sign-in",
    ]);
  });

  it("opening sign-in keeps its original UNKNOWN visible after a fresh entry observation", async () => {
    const value = connectionSettings();
    value.setup.chatgpt.verified = null;
    const h = await mountSetup("signin", value);
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(new Error("reply lost"));
    await h.click("Sign in");
    const receipt = h.c.getSnapshot().intents["settings:chatgpt.open-sign-in:"];
    await h.click("Skip for now");
    await refreshSetup(h, connectionSettings());
    await h.stepTo("signin");
    expect(h.c.getSnapshot().intents["settings:chatgpt.open-sign-in:"]).toBe(
      receipt,
    );
    expect(visibleText(h.host)).toContain("Outcome unknown");
    expect(visibleText(h.host)).not.toContain("Current sign-in was observed");
    expect(h.button("Sign in").disabled).toBe(true);
    for (const label of ["Check sign-in", "Open ChatGPT"])
      expect(() => h.button(label)).toThrow();
    await h.click("Sign in");
    expect(h.calls().map((command) => command.kind)).toEqual([
      "chatgpt.observe-sign-in",
      "chatgpt.open-sign-in",
      "chatgpt.observe-sign-in",
    ]);
  });
  it.each(["signed_out", "unknown"] as const)(
    "exact saved Ready plus current %s keeps honest status, Skip and no Open/Check ritual across refresh/remount",
    async (state) => {
      const value = connectionSettings();
      const h = await mountSetup("signin", value, state);
      expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
      const label =
        state === "signed_out" ? "Signed out" : "Current sign-in is unknown";
      expect(visibleText(h.host)).toContain(label);
      expect(visibleText(h.host)).not.toContain("Current sign-in was observed");
      expect(h.button("Skip for now")).toBeTruthy();
      if (state === "signed_out")
        expect(h.button("Sign in").disabled).toBe(false);
      else expect(h.button("Sign in").disabled).toBe(false);
      for (const control of ["Open ChatGPT", "Check sign-in"])
        expect(() => h.button(control)).toThrow();
      const read = h.c.getSnapshot().signInObservation;
      await refreshSetup(h, connectionSettings());
      await h.remount();
      expect(h.c.getSnapshot().signInObservation).toBe(read);
      expect(visibleText(h.host)).toContain(label);
      expect(h.calls().map((command) => command.kind)).toEqual([
        "chatgpt.observe-sign-in",
      ]);
    },
  );
  it("native return updates the mounted step once with Signed in + Continue and does not navigate or dispatch a writer", async () => {
    const h = await mountSetup("signin");
    const destination = h.c.getSnapshot().destination;
    vi.mocked(h.f.api.configure).mockImplementation(async (command) =>
      command.kind === "chatgpt.observe-sign-in"
        ? signInReply(command, "authenticated", h.configuration)
        : {},
    );
    const event = {
      action: "sign-in-returned",
      source: "auth-window-closed",
      eventId: randomUUID(),
      authWindowGeneration: 1,
    };
    await act(async () => {
      h.f.emit("action", event);
      h.f.emit("action", event);
    });
    expect(h.c.getSnapshot().destination).toBe(destination);
    expect(visibleText(h.host)).toContain("Signed in");
    expect(h.button("Continue")).toBeTruthy();
    for (const control of [
      "Sign in",
      "Open ChatGPT",
      "Check sign-in",
      "Skip for now",
    ])
      expect(() => h.button(control)).toThrow();
    await h.remount();
    expect(h.calls().map((command) => command.kind)).toEqual([
      "chatgpt.observe-sign-in",
      "chatgpt.observe-sign-in",
    ]);
    expect(h.c.getSnapshot().intents).toEqual({});
  });
  it("actual React remount shares a pending observation and reports an unknown read honestly", async () => {
    const h = await mountSetup("signin");
    const wait = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValue(wait.promise);
    await act(async () =>
      h.f.emit("action", {
        action: "sign-in-returned",
        source: "auth-window-closed",
        eventId: randomUUID(),
        authWindowGeneration: 1,
      }),
    );
    const pending = h.c.getSnapshot().signInObservation;
    expect(pending?.pending).toBe(true);
    await h.remount();
    expect(h.c.getSnapshot().signInObservation).toBe(pending);
    expect(h.calls()).toHaveLength(2);
    const command = h.calls()[1]!;
    if (command.kind !== "chatgpt.observe-sign-in")
      throw new Error("Expected read");
    await act(async () =>
      wait.resolve(signInReply(command, "unknown", h.configuration)),
    );
    expect(visibleText(h.host)).toContain("Current sign-in is unknown");
    expect(h.button("Skip for now")).toBeTruthy();
    expect(h.calls()).toHaveLength(2);
  });
  it("fresh profile without a retained document offers the first explicit Sign in and Skip without any automatic effect", async () => {
    const h = await mountSetup("signin", settings(), "unknown");
    expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
    expect(h.c.getSnapshot().signInObservation).toMatchObject({
      state: "unknown",
      binding: null,
      pending: false,
    });
    expect(visibleText(h.host)).toContain("Current sign-in is unknown");
    expect(h.button("Sign in").disabled).toBe(false);
    expect(h.button("Sign in").classList.contains("primary")).toBe(true);
    expect(
      [...h.host.querySelectorAll("button.primary")].filter(
        (button) =>
          button.textContent === "Sign in" && !button.closest("[hidden]"),
      ).length,
    ).toBe(1);
    expect(h.button("Skip for now").disabled).toBe(false);
    for (const control of ["Open ChatGPT", "Check sign-in"])
      expect(() => h.button(control)).toThrow();
    await h.remount();
    expect(h.calls().map((command) => command.kind)).toEqual([
      "chatgpt.observe-sign-in",
    ]);
    expect(h.c.getSnapshot().intents).toEqual({});
    await h.click("Sign in");
    expect(h.calls().map((command) => command.kind)).toEqual([
      "chatgpt.observe-sign-in",
      "chatgpt.open-sign-in",
    ]);
    expect(h.c.getSnapshot().signInObservation?.state).toBe("unknown");
    await h.click("Skip for now");
    expect(h.c.getSnapshot().destination.setupStep).toBe("connection");
  });
});
