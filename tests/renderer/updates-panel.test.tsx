import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import {
  projectUpdates,
  attachUpdatesOwner,
  UpdatesWindow,
} from "../../apps/desktop/renderer/updates/entry";
import {
  isUpdatesDocument,
  type UpdatesAPI,
} from "../../apps/desktop/renderer/updates/contract";
import type { InstalledUpdateView } from "../../src/modules/release/contract/installed-update";
import { fixture } from "./fixture";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const idle: InstalledUpdateView = { phase: "idle", checkedAt: null };
const ready: InstalledUpdateView = {
  phase: "ready",
  version: "0.4.1",
  blockedBy: null,
  deferred: false,
};
async function owner(update: InstalledUpdateView = idle) {
  const f = fixture();
  vi.mocked(f.api.installedUpdate).mockResolvedValue(update);
  const open = vi.fn();
  let receive!: (value: unknown) => void;
  const api = {
    ...f.api,
    openUpdates: open,
    publishUpdates: vi.fn(),
    settleUpdates: vi.fn(),
    onUpdatesCommand: (listener: (value: unknown) => void) => {
      receive = listener;
      return vi.fn();
    },
  };
  const c = new WindowController(api);
  const detach = attachUpdatesOwner(c, api);
  await c.start();
  vi.mocked(f.api.installedUpdate).mockClear();
  cleanups.push(() => {
    detach();
    c.dispose();
  });
  return { c, f, api, receive, open, detach };
}

it("uses a fixed local document mode", () => {
  expect(
    isUpdatesDocument(new URL("file:///app/shell.html#farol-updates")),
  ).toBe(true);
  for (const url of [
    "https://site/shell.html#farol-updates",
    "file:///app/other.html#farol-updates",
    "file:///app/shell.html?x=1#farol-updates",
    "file://other/app/shell.html#farol-updates",
  ])
    expect(isUpdatesDocument(new URL(url))).toBe(false);
});
it("opens an observer without checking, changing the shell overlay or projecting private state", async () => {
  const f = await owner();
  f.c.overlay("update");
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.c.getSnapshot().overlay).toBe("none");
  expect(f.f.api.installedUpdate).not.toHaveBeenCalled();
  const projection = projectUpdates(f.c.getSnapshot());
  expect(Object.keys(projection).sort()).toEqual([
    "allowed",
    "automaticEnabled",
    "installedVersion",
    "outcome",
    "update",
  ]);
});
it("lets the existing menu action check once through the original controller", async () => {
  const f = await owner();
  f.f.emit("action", {
    eventId: "11111111-1111-4111-8111-111111111111",
    authWindowGeneration: null,
    action: "open-updates",
    source: "update-command",
  });
  await vi.waitFor(() =>
    expect(f.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "check",
    }),
  );
  expect(f.open).toHaveBeenCalledOnce();
});
it("keeps pending in the owner after detaching and reattaching the projection", async () => {
  const f = await owner();
  let finish!: (view: InstalledUpdateView) => void;
  vi.mocked(f.f.api.installedUpdate).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.receive({ sequence: 1, intent: { kind: "check" } });
  await vi.waitFor(() =>
    expect(f.f.api.installedUpdate).toHaveBeenCalledOnce(),
  );
  f.receive({ sequence: 1, intent: { kind: "check" } });
  f.detach();
  const reattach = attachUpdatesOwner(f.c, f.api);
  cleanups.push(reattach);
  f.receive({ sequence: 2, intent: { kind: "check" } });
  expect(f.c.getSnapshot().intents.update?.state).toBe("pending");
  expect(f.f.api.installedUpdate).toHaveBeenCalledOnce();
  finish(idle);
  await vi.waitFor(() =>
    expect(f.c.getSnapshot().intents.update?.state).toBe("applied"),
  );
});
it("retains command UNKNOWN when newer ready events arrive, with no relay retry", async () => {
  const f = await owner();
  vi.mocked(f.f.api.installedUpdate).mockRejectedValueOnce(Error("lost reply"));
  f.receive({ sequence: 1, intent: { kind: "check" } });
  await vi.waitFor(() =>
    expect(f.api.settleUpdates).toHaveBeenCalledWith({ sequence: 1 }),
  );
  f.f.emit("update", ready);
  f.c.overlay("update");
  f.receive({ sequence: 2, intent: { kind: "check" } });
  f.receive({
    sequence: 3,
    intent: { kind: "restart-confirmed", version: "0.4.1" },
  });
  expect(f.f.api.installedUpdate).toHaveBeenCalledOnce();
  expect(projectUpdates(f.c.getSnapshot())).toMatchObject({
    outcome: "unknown",
    update: ready,
    allowed: { check: false, "restart-confirmed": false, automatic: false },
  });
});
it("retains preference UNKNOWN and does not replay it after later status", async () => {
  const f = await owner({
    ...idle,
    automaticUpdatePreference: {
      status: "confirmed",
      enabled: false,
      scope: "download-and-install",
    },
  });
  vi.mocked(f.f.api.installedUpdate).mockRejectedValueOnce(
    Error("lost preference reply"),
  );
  f.receive({ sequence: 1, intent: { kind: "automatic", enabled: true } });
  await vi.waitFor(() =>
    expect(f.api.settleUpdates).toHaveBeenCalledWith({ sequence: 1 }),
  );
  f.f.emit("update", {
    ...idle,
    automaticUpdatePreference: {
      status: "confirmed",
      enabled: true,
      scope: "download-and-install",
    },
  });
  f.receive({ sequence: 2, intent: { kind: "automatic", enabled: true } });
  expect(f.f.api.installedUpdate).toHaveBeenCalledOnce();
  expect(projectUpdates(f.c.getSnapshot()).outcome).toBe("unknown");
});
it("rechecks version and applying admission at the existing owner", async () => {
  const f = await owner(ready);
  f.receive({
    sequence: 1,
    intent: { kind: "restart-confirmed", version: "0.4.0" },
  });
  await vi.waitFor(() =>
    expect(f.api.settleUpdates).toHaveBeenCalledWith({ sequence: 1 }),
  );
  expect(f.f.api.installedUpdate).not.toHaveBeenCalled();
  f.f.emit("update", { phase: "applying", version: "0.4.1" });
  f.receive({
    sequence: 2,
    intent: { kind: "restart-confirmed", version: "0.4.1" },
  });
  f.c.overlay("update");
  expect(f.f.api.installedUpdate).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});
it("preserves the existing shell recovery route without dispatching recovery automatically", async () => {
  const f = await owner({
    phase: "recovery",
    version: "0.4.1",
    blockedBy: null,
  });
  f.receive({ sequence: 1, intent: { kind: "recovery" } });
  expect(f.c.getSnapshot().overlay).toBe("update-recovery");
  expect(f.f.api.installedUpdate).not.toHaveBeenCalled();
});
it("preserves update revision fences when relay completion follows newer progress", async () => {
  const f = await owner();
  let finish!: (view: InstalledUpdateView) => void;
  vi.mocked(f.f.api.installedUpdate).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.receive({ sequence: 1, intent: { kind: "check" } });
  await vi.waitFor(() =>
    expect(f.f.api.installedUpdate).toHaveBeenCalledOnce(),
  );
  f.f.emit("update", { phase: "applying", version: "0.4.1" });
  finish(idle);
  await vi.waitFor(() =>
    expect(f.api.settleUpdates).toHaveBeenCalledWith({ sequence: 1 }),
  );
  expect(projectUpdates(f.c.getSnapshot())).toMatchObject({
    update: { phase: "applying", version: "0.4.1" },
    allowed: { check: false, "restart-confirmed": false },
  });
});
it("ignores commands after owner detachment", async () => {
  const f = await owner();
  f.detach();
  f.receive({ sequence: 1, intent: { kind: "check" } });
  expect(f.f.api.installedUpdate).not.toHaveBeenCalled();
  expect(f.api.settleUpdates).not.toHaveBeenCalled();
});
it("renders a nonmodal projection and does not initiate a check on mount", async () => {
  const f = await owner(ready);
  let emit!: (state: unknown) => void;
  let finishRead!: (state: unknown) => void;
  const api: UpdatesAPI = {
    state: () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    onState: (listener) => {
      emit = listener;
      return vi.fn();
    },
    intent: vi.fn(),
    close: vi.fn(),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<UpdatesWindow api={api} />));
  await act(async () => {
    emit({
      status: "ready",
      projection: projectUpdates(f.c.getSnapshot()),
      pending: true,
    });
    finishRead({ status: "unavailable" });
  });
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.textContent).toContain(
    "The update will continue in the background.",
  );
  expect(
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Install and Relaunch",
    )?.disabled,
  ).toBe(true);
  expect(api.intent).not.toHaveBeenCalled();
  await act(async () => emit({ status: "unavailable" }));
  expect(host.textContent).toContain("update owner is unavailable");
  expect(host.textContent).not.toContain("Install and Relaunch");
  await act(async () => root.unmount());
});
it("explains why the updater is unavailable in an uninstalled Dev", async () => {
  const f = await owner({ phase: "unavailable", code: "UPDATE_NOT_INSTALLED" });
  const api: UpdatesAPI = {
    state: async () => ({
      status: "ready",
      projection: projectUpdates(f.c.getSnapshot()),
      pending: false,
    }),
    onState: () => () => {},
    intent: vi.fn(),
    close: vi.fn(),
  };
  const host = document.createElement("div"),
    root = createRoot(host);
  await act(async () => root.render(<UpdatesWindow api={api} />));
  expect(host.textContent).toContain("Updates unavailable");
  expect(host.textContent).toContain(
    "Update checks are available in an installed Farol.",
  );
  expect(api.intent).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("offers recovery only for an interrupted update, not a retained predecessor", async () => {
  const f = await owner({
    phase: "idle",
    checkedAt: null,
    rollbackVersion: "0.3.0",
  });
  let emit!: (state: unknown) => void;
  const api: UpdatesAPI = {
    state: async () => ({
      status: "ready",
      projection: projectUpdates(f.c.getSnapshot()),
      pending: false,
    }),
    onState: (listener) => {
      emit = listener;
      return () => {};
    },
    intent: vi.fn(),
    close: vi.fn(),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<UpdatesWindow api={api} />));
  expect(host.textContent).not.toContain("Review Recovery in Farol");
  const recovery = await owner({
    phase: "recovery",
    version: "0.4.1",
    blockedBy: null,
  });
  await act(async () =>
    emit({
      status: "ready",
      projection: projectUpdates(recovery.c.getSnapshot()),
      pending: false,
    }),
  );
  expect(host.textContent).toContain("Review Recovery in Farol");
  expect(api.intent).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
