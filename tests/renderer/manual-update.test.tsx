import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import { AutomaticUpdateChoice } from "../../src/ui/renderer/automatic-update-choice";
import {
  confirmedRestartAllowed,
  updateVersionLabel,
} from "../../src/ui/renderer/update-eligibility";
import type { InstalledUpdateView } from "../../src/modules/release/contract/installed-update";
import type { Intent, WindowSnapshot } from "../../src/ui/renderer/contract";
import { fixture } from "./fixture";

// DOM/controller fixtures only. Direct preference projections exercise rendering;
// controller integration still uses the real strict Release response parser.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const ready: InstalledUpdateView = {
  phase: "ready",
  version: "0.2.1",
  deferred: false,
  blockedBy: null,
};
async function controller(update: InstalledUpdateView = ready) {
  const f = fixture();
  vi.mocked(f.api.installedUpdate).mockResolvedValue(update);
  const c = new WindowController(f.api);
  await c.start();
  vi.mocked(f.api.installedUpdate).mockClear();
  cleanups.push(async () => c.dispose());
  return { f, c };
}

it.each<InstalledUpdateView>([
  { phase: "ready", version: "0.2.4", deferred: false, blockedBy: null },
  { phase: "failed", code: "UPDATE_HANDOFF_UNKNOWN", recoveryRequired: true },
  { phase: "applying", version: "0.2.4" },
])(
  "preserves newer $phase progress when the check reply arrives late",
  async (newer) => {
    const { c, f } = await controller({ phase: "idle", checkedAt: null });
    let reply!: (view: InstalledUpdateView) => void;
    vi.mocked(f.api.installedUpdate).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const checking = c.update("check");
    await vi.waitFor(() =>
      expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
        kind: "check",
      }),
    );
    f.emit("update", newer);
    reply({ phase: "downloading" });
    await checking;
    expect(c.getSnapshot().update).toEqual(newer);
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
  },
);

it("does not replace a newer invalid update projection with a stale valid check reply", async () => {
  const { c, f } = await controller({ phase: "idle", checkedAt: null });
  let reply!: (view: InstalledUpdateView) => void;
  vi.mocked(f.api.installedUpdate).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const checking = c.update("check");
  await vi.waitFor(() =>
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1),
  );
  f.emit("update", {
    phase: "ready",
    version: "0.2.4",
    deferred: "invalid",
    blockedBy: null,
  });
  expect(c.getSnapshot().update).toMatchObject({
    phase: "unavailable",
    code: "UPDATE_STATE_INVALID",
  });
  reply({ phase: "available", version: "0.2.4", deferred: false });
  await checking;
  expect(c.getSnapshot().update).toMatchObject({
    phase: "unavailable",
    code: "UPDATE_STATE_INVALID",
  });
});

it("keeps the original command UNKNOWN even when a newer ready event is visible", async () => {
  const { c, f } = await controller({ phase: "idle", checkedAt: null });
  let reply!: (view: InstalledUpdateView) => void;
  vi.mocked(f.api.installedUpdate).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const checking = c.update("check");
  await vi.waitFor(() =>
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1),
  );
  f.emit("update", ready);
  reply({
    phase: "failed",
    code: "UPDATE_HANDOFF_UNKNOWN",
    recoveryRequired: true,
  });
  expect(await checking).toMatchObject({
    state: "unknown",
    code: "UPDATE_HANDOFF_UNKNOWN",
  });
  expect(c.getSnapshot().update).toEqual(ready);
  expect(c.getSnapshot().intents.update?.state).toBe("unknown");
  expect(await c.update("check")).toMatchObject({
    state: "unknown",
    code: "UPDATE_HANDOFF_UNKNOWN",
  });
  expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
});

it("keeps applying through a malformed event and an older ready command reply", async () => {
  const { c, f } = await controller({ phase: "idle", checkedAt: null });
  let reply!: (view: InstalledUpdateView) => void;
  vi.mocked(f.api.installedUpdate).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const checking = c.update("check");
  await vi.waitFor(() =>
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1),
  );
  f.emit("update", { phase: "applying", version: "0.2.4" });
  f.emit("update", { phase: "invalid" });
  reply(ready);
  await checking;
  expect(c.getSnapshot().update).toEqual({
    phase: "applying",
    version: "0.2.4",
  });
});

it("fences a late command reply after the current startup status read fails", async () => {
  const f = fixture();
  let rejectStatus!: (error: Error) => void;
  let replyCheck!: (view: InstalledUpdateView) => void;
  vi.mocked(f.api.installedUpdate).mockImplementation((request) => {
    if (request.kind === "status")
      return new Promise((_, reject) => {
        rejectStatus = reject;
      });
    if (request.kind === "check")
      return new Promise((resolve) => {
        replyCheck = resolve;
      });
    throw new Error("unexpected fixture command");
  });
  const c = new WindowController(f.api);
  cleanups.push(async () => c.dispose());
  const starting = c.start();
  await vi.waitFor(() =>
    expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "status" }),
  );
  const checking = c.update("check");
  await vi.waitFor(() =>
    expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "check" }),
  );
  rejectStatus(new Error("controlled status read failure"));
  await starting;
  replyCheck({ phase: "available", version: "0.2.4", deferred: false });
  await checking;
  expect(c.getSnapshot().update).toMatchObject({
    phase: "unavailable",
    code: "UPDATE_STATUS_UNAVAILABLE",
  });
  expect(f.api.installedUpdate).toHaveBeenCalledTimes(2);
});

it("does not release applying when its startup status read fails", async () => {
  const f = fixture();
  const bootstrap = vi.mocked(f.api.bootstrap).getMockImplementation()!;
  vi.mocked(f.api.bootstrap).mockImplementation(async () => {
    f.emit("update", { phase: "applying", version: "0.2.4" });
    return await bootstrap();
  });
  let rejectStatus!: (error: Error) => void;
  vi.mocked(f.api.installedUpdate).mockImplementation((request) => {
    if (request.kind !== "status")
      throw new Error("unexpected fixture command");
    return new Promise((_, reject) => {
      rejectStatus = reject;
    });
  });
  const c = new WindowController(f.api);
  cleanups.push(async () => c.dispose());
  const starting = c.start();
  await vi.waitFor(() =>
    expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "status" }),
  );
  rejectStatus(new Error("controlled status read failure"));
  await starting;
  expect(c.getSnapshot().update).toEqual({
    phase: "applying",
    version: "0.2.4",
  });
});

it.each([
  "UPDATE_CONNECTOR_ACTIVE",
  "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
  "UPDATE_WORK_PENDING",
])(
  "allows a new version-bound admission check after known pre-dispatch refusal %s",
  async (blockedBy) => {
    const update = { ...ready, blockedBy };
    const { c, f } = await controller(update);
    expect(confirmedRestartAllowed(update)).toBe(true);
    await c.update("restart-confirmed", ready.version);
    expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "restart-confirmed",
      version: ready.version,
    });
    expect(c.getSnapshot().update).toEqual(update);
  },
);
it.each([
  "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
  "UPDATE_STATE_UNREADABLE",
  "UPDATE_WORK_DRAIN_UNCONFIRMED",
  "UPDATE_HANDOFF_UNKNOWN",
  "UPDATE_VERIFICATION_RECOVERY_REQUIRED",
  "UNCLASSIFIED",
])("never authorizes confirmed installation through %s", async (blockedBy) => {
  const update = { ...ready, blockedBy };
  const { c, f } = await controller(update);
  expect(confirmedRestartAllowed(update)).toBe(false);
  expect((await c.update("restart-confirmed", "0.2.1")).state).toBe("refused");
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it("rejects a stale or missing confirmed version without invoking the backend", async () => {
  const { c, f } = await controller();
  expect((await c.update("restart-confirmed", "0.2.0")).state).toBe("refused");
  expect((await c.update("restart-confirmed")).state).toBe("refused");
  f.emit("update", { ...ready, version: "0.2.2" });
  expect((await c.update("restart-confirmed", "0.2.1")).state).toBe("refused");
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it.each<InstalledUpdateView>([
  { phase: "recovery", version: "0.2.1", blockedBy: null },
  { phase: "failed", code: "UPDATE_HANDOFF_UNKNOWN", recoveryRequired: true },
  { phase: "applying", version: "0.2.1" },
  { phase: "available", version: "0.2.1", deferred: false },
])(
  "never reinterprets $phase as ready for confirmed installation",
  async (update) => {
    const { c, f } = await controller(update);
    expect((await c.update("restart-confirmed", "0.2.1")).state).toBe(
      "refused",
    );
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "never acknowledges legacy preference replies for enabled=%s",
  async (enabled) => {
    const legacy: InstalledUpdateView = {
      phase: "idle",
      checkedAt: null,
      automaticUpdatePreference: { status: "confirmed", enabled },
    };
    const { c, f } = await controller(legacy);
    const result = await c.setAutomaticDownloads(enabled);
    expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "set-automatic-update-preference",
      enabled,
      scope: "download-and-install",
    });
    expect(result).toMatchObject({
      state: "unknown",
      code: "UPDATE_AUTOMATIC_PREFERENCE_ACK_MISMATCH",
    });
    await c.setAutomaticDownloads(enabled);
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [{ status: "confirmed", enabled: true }, false],
  [{ status: "confirmed", enabled: false }, false],
  [{ status: "confirmed", enabled: true, scope: "download-and-install" }, true],
  [
    { status: "confirmed", enabled: false, scope: "download-and-install" },
    false,
  ],
  [
    {
      status: "unknown",
      enabled: false,
      code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
    },
    false,
  ],
] as const)(
  "checks only confirmed download-and-install consent: %j",
  async (preference, checked) => {
    const { c } = await controller();
    const snapshot: WindowSnapshot = {
      ...c.getSnapshot(),
      update: {
        phase: "idle",
        checkedAt: null,
        automaticUpdatePreference: preference,
      },
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(async () => {
      await act(async () => root.unmount());
    });
    await act(async () =>
      root.render(<AutomaticUpdateChoice snapshot={snapshot} facade={c} />),
    );
    const checkbox = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(checkbox.checked).toBe(checked);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(checkbox.closest("label")?.textContent).toContain(
      "Automatically install updates",
    );
    expect(
      document.getElementById(checkbox.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("Download and install updates when idle.");
  },
);
it.each(["pending", "unknown"] as const)(
  "never changes the preference while an update is %s",
  async (state) => {
    const { c, f } = await controller();
    const snapshot: WindowSnapshot = {
      ...c.getSnapshot(),
      update: {
        phase: "idle",
        checkedAt: null,
        automaticUpdatePreference: { status: "confirmed", enabled: true },
      },
      intents: { update: { id: "update", state, code: null } satisfies Intent },
    };
    const host = document.createElement("div");
    document.body.append(host);
    const rendered = createRoot(host);
    cleanups.push(async () => {
      await act(async () => rendered.unmount());
    });
    await act(async () =>
      rendered.render(<AutomaticUpdateChoice snapshot={snapshot} facade={c} />),
    );
    const checkbox = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(checkbox.disabled).toBe(true);
    await act(async () => checkbox.click());
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
  },
);
it("preserves distinct beta and release versions when compacting labels", () => {
  expect(updateVersionLabel("0.2.0-owner.beta.15")).toBe("0.2.0 beta 15");
  expect(updateVersionLabel("0.2.0-owner.beta.16")).toBe("0.2.0 beta 16");
  expect(updateVersionLabel("0.2.1")).toBe("0.2.1");
  expect(updateVersionLabel("0.2.1-owner.beta.1+build.31")).toBe(
    "0.2.1-owner.beta.1+build.31",
  );
});
