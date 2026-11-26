import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { Update } from "./update";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: { unmount(): void; host: HTMLElement }[] = [];
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
function mount(
  update: Record<string, unknown>,
  over: Record<string, unknown> = {},
  recoveryMode = false,
) {
  const snapshot = {
    status: "current",
    runtime: "ready",
    intents: {},
    activity: [],
    installedVersion: null,
    update,
    ...over,
  } as unknown as WindowSnapshot;
  const calls: unknown[][] = [];
  const facade = {
    getSnapshot: () => snapshot,
    overlay: vi.fn(),
    navigate: vi.fn(),
    update: vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return { id: "update", state: "applied", code: null };
    }),
  } as unknown as RendererFacade;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ unmount: () => root.unmount(), host });
  act(() =>
    root.render(createElement(Update, { snapshot, facade, recoveryMode })),
  );
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  return { host, facade, calls, button };
}

describe("Update sheet", () => {
  it("titles an idle, checked sheet as up to date", () => {
    const { host } = mount({ phase: "idle", checkedAt: 1, deferred: false });
    expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "You’re up to date",
    );
    expect(host.querySelector(".update-state")).toBeNull();
  });

  it("offers download, skip and later for an available version", () => {
    const { host, button, facade } = mount({
      phase: "available",
      version: "1.0.0",
      deferred: false,
      checkedAt: 1,
    });
    expect(host.querySelector(".update-state")?.textContent).toBe(
      "Version 1.0.0 is available to download.",
    );
    act(() => button("Download Update")?.click());
    expect(facade.update).toHaveBeenCalledWith("download");
    act(() => button("Skip This Version")?.click());
    expect(facade.update).toHaveBeenCalledWith("skip");
  });

  it("disables the available actions while an update intent is pending", () => {
    const { button } = mount(
      { phase: "available", version: "1.0.0", deferred: false, checkedAt: 1 },
      { intents: { update: { id: "update", state: "pending", code: null } } },
    );
    expect(button("Download Update")?.disabled).toBe(true);
    expect(button("Skip This Version")?.disabled).toBe(true);
  });

  it("restarts only with the confirmed version and closes after later", async () => {
    const { button, facade } = mount({
      phase: "ready",
      version: "1.0.0",
      deferred: false,
      blockedBy: null,
      checkedAt: 1,
    });
    act(() => button("Install and Relaunch")?.click());
    expect(facade.update).toHaveBeenCalledWith("restart-confirmed", "1.0.0");
    await act(async () => button("Remind Me Later")?.click());
    expect(facade.update).toHaveBeenCalledWith("later");
    expect(facade.overlay).toHaveBeenCalledWith("none");
  });

  it("blocks the restart when an unconfirmed block is recorded", () => {
    const { button } = mount({
      phase: "ready",
      version: "1.0.0",
      deferred: false,
      blockedBy: "UPDATE_UNKNOWN_BLOCK",
      checkedAt: 1,
    });
    expect(button("Install and Relaunch")?.disabled).toBe(true);
  });

  it("cannot be dismissed while the update is applying", () => {
    const { host } = mount({ phase: "applying", version: "1.0.0" });
    expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "Restarting to update",
    );
    expect(host.querySelector('button[aria-label="Close"]')).toBeNull();
    expect(host.querySelector(".update-state")?.textContent).toBe(
      "Applying version 1.0.0…",
    );
  });

  it("reports an unknown update outcome without offering another apply", () => {
    const { host } = mount(
      { phase: "idle", checkedAt: 1, deferred: false },
      { intents: { update: { id: "update", state: "unknown", code: null } } },
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Outcome unknown",
    );
    expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "Update status unconfirmed",
    );
  });

  it("titles the recovery view and explains that none is needed", () => {
    const { host } = mount(
      { phase: "idle", checkedAt: 1, deferred: false },
      {},
      true,
    );
    expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "Update recovery",
    );
    expect(host.querySelector(".update-state")?.textContent).toBe(
      "No interrupted update needs recovery.",
    );
  });
});
