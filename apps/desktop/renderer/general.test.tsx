import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { General } from "./general";
import type { Actions, PageProps } from "./page";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const hosts: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of hosts.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
const base = () => ({
  environment: "preview",
  status: "current",
  runtime: "ready",
  buildId: "b1",
  intents: {} as Record<string, unknown>,
  installedVersion: { version: "1.2.3", buildVersion: "45" },
  update: {
    phase: "idle",
    recoveryRequired: false,
    blockedBy: null,
    automaticUpdatePreference: {
      status: "confirmed",
      enabled: true,
      scope: "download-and-install",
    },
  },
});
function setup(over: Record<string, unknown> = {}, update = "applied") {
  const snapshot = { ...base(), ...over };
  const facade = {
    navigate: vi.fn(),
    overlay: vi.fn(),
    setAutomaticDownloads: vi.fn(async () => ({ state: "applied" })),
    update: vi.fn(async () => ({ state: update })),
    getSnapshot: () => snapshot,
  };
  const run = vi.fn(async () => null);
  const actions = { allowed: () => true, run } as unknown as Actions;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(General, {
        snapshot,
        facade,
        actions,
      } as unknown as PageProps),
    ),
  );
  hosts.push({ unmount: () => root.unmount(), host });
  return { host, facade, run };
}
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("General", () => {
  it("shows setup status, version and support copy", () => {
    const { host } = setup();
    expect(host.querySelector("h2")?.textContent).toBe("General");
    expect(host.querySelector(".settings-setup-status h3")?.textContent).toBe(
      "Finish setting up Farol",
    );
    expect(host.textContent).toContain("1.2.3 · 45");
    expect(host.textContent).toContain("Save a support file");
    expect(
      host.querySelector('section[aria-label="Something wrong?"]'),
    ).not.toBeNull();
  });
  it("falls back to Unavailable without an installed version", () => {
    const { host } = setup({ installedVersion: null });
    expect(host.textContent).toContain("Unavailable");
  });
  it("opens Setup through the facade", () => {
    const { host, facade } = setup();
    act(() => button(host, "Open Setup").click());
    expect(facade.navigate).toHaveBeenCalledWith({
      area: "setup",
      setupStep: "overview",
    });
  });
  it("runs the support export command", () => {
    const { host, run } = setup();
    act(() => button(host, "Save support file…").click());
    expect(run).toHaveBeenCalledWith({ kind: "support.export" }, undefined);
  });
  it("opens update recovery", () => {
    const { host, facade } = setup();
    act(() => button(host, "Update recovery…").click());
    expect(facade.overlay).toHaveBeenCalledWith("update-recovery");
  });
  it("toggles automatic downloads with the checked value", () => {
    const { host, facade } = setup();
    const box = host.querySelector(
      'input[aria-label="Install updates automatically"]',
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    act(() => box.click());
    expect(facade.setAutomaticDownloads).toHaveBeenCalledWith(false);
  });
  it.each([
    [
      { update: { ...base().update, automaticUpdatePreference: null } },
      "The update preference is unavailable in this session.",
    ],
    [
      {
        intents: {
          "update-automatic-downloads": {
            id: "settings:update-automatic-downloads:",
            state: "unknown",
            code: null,
          },
        },
      },
      "The update preference could not be confirmed. Wait for its saved result before changing it again.",
    ],
    [
      {
        intents: {
          "update-automatic-downloads": {
            id: "settings:update-automatic-downloads:",
            state: "refused",
            code: null,
          },
        },
      },
      "The update preference could not be saved.",
    ],
  ])("explains the preference state %#", (over, text) => {
    const { host } = setup(over);
    expect(host.textContent).toContain(text);
  });
  it.each([
    ["applied", "Update check completed."],
    ["unknown", "The update check could not be confirmed. Do not repeat it."],
    ["refused", "The update check could not be completed."],
  ])("reports a %s update check", async (state, text) => {
    const { host, facade } = setup({}, state);
    await act(async () => button(host, "Check for updates").click());
    expect(facade.update).toHaveBeenCalledWith("check");
    expect(host.querySelector('p[role="status"]')?.textContent).toBe(text);
    expect(button(host, "Check for updates").disabled).toBe(false);
  });
  it("disables the check outside the preview environment", () => {
    const { host } = setup({ environment: "production" });
    expect(button(host, "Check for updates").disabled).toBe(true);
  });
});
