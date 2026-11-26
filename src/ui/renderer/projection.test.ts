import { describe, expect, it } from "vitest";
import {
  initialHistory,
  reduceHistory,
} from "../../../apps/desktop/renderer/history";
import { initial } from "../../../apps/desktop/renderer/snapshot";
import type { Destination, WindowSnapshot } from "./contract";
import {
  bootstrapPatch,
  browserPresentationDue,
  closedOverlayPatch,
  launchDestination,
  layoutArguments,
  navigatePatch,
  startupStatus,
  travelPatch,
  welcomeDestination,
} from "./projection";

const snap = (patch: Partial<WindowSnapshot> = {}): WindowSnapshot => ({
  ...initial,
  ...patch,
});
const dest = (patch: Partial<Destination>): Destination => ({
  ...initial.destination,
  ...patch,
});

describe("overlay closing", () => {
  it("closes the overlay and demotes only an overlay sidebar", () => {
    expect(closedOverlayPatch(snap({ sidebar: "overlay" }))).toEqual({
      overlay: "none",
      sidebar: "rail",
    });
    expect(closedOverlayPatch(snap({ sidebar: "full" }))).toEqual({
      overlay: "none",
      sidebar: "full",
    });
  });
});

describe("layoutArguments", () => {
  it("maps areas to host sections and overlays to host overlays", () => {
    const args = (patch: Partial<WindowSnapshot>, compact = false) =>
      layoutArguments(snap(patch), compact);
    expect(args({ destination: dest({ area: "chatgpt" }) })[0]).toBe("browser");
    expect(args({ destination: dest({ area: "setup" }) })[0]).toBe("settings");
    expect(args({ destination: dest({ area: "settings" }) })[0]).toBe(
      "settings",
    );
    expect(args({ destination: dest({ area: "home" }) })[0]).toBe("activity");
    expect(args({ overlay: "search" })[5]).toBe("quick-switcher");
    expect(args({ overlay: "update" })[5]).toBe("task-menu");
    expect(args({ overlay: "none" })[5]).toBe("none");
  });
  it("forces a rail on a compact viewport and never sets feedback", () => {
    const wide = layoutArguments(snap({ sidebar: "full" }), false);
    const compact = layoutArguments(snap({ sidebar: "full" }), true);
    expect(wide[4]).toBe("full");
    expect(compact[4]).toBe("rail");
    expect(wide[3]).toBe(false);
  });
  it("reports setup-open only while the window is not current", () => {
    expect(layoutArguments(snap({ status: "current" }), false)[2]).toBe(false);
    expect(
      layoutArguments(
        snap({ status: "stale", destination: dest({ area: "home" }) }),
        false,
      )[2],
    ).toBe(true);
  });
});

describe("launch and welcome destinations", () => {
  it("maps every launch preference", () => {
    expect(launchDestination("home")).toEqual({ area: "home" });
    expect(launchDestination("browser")).toEqual({ area: "chatgpt" });
    expect(launchDestination("computer")).toEqual({
      area: "setup",
      setupStep: "folders",
    });
    expect(launchDestination("settings")).toEqual({
      area: "settings",
      page: "general",
    });
    expect(launchDestination("activity")).toEqual({ area: "activity" });
  });
  it("starts incomplete setup at the overview", () => {
    expect(welcomeDestination(dest({ area: "home" }))).toMatchObject({
      area: "setup",
      page: "general",
      setupStep: "overview",
    });
  });
});

describe("history publication", () => {
  const next = dest({ area: "setup" });
  const pushed = reduceHistory(initialHistory, {
    kind: "push",
    destination: next,
  });
  it("remembers where setup was entered from, once", () => {
    const from = dest({ area: "home" });
    const patch = navigatePatch(snap({ destination: from }), next, pushed);
    expect(patch.setupReturn).toBe(from);
    expect(patch.destination).toBe(next);
    expect(patch.back).toBe(true);
    expect(patch.forward).toBe(false);
    expect(patch.overlay).toBe("none");
    const kept = navigatePatch(
      snap({ destination: dest({ area: "setup" }), setupReturn: from }),
      next,
      pushed,
    );
    expect(kept.setupReturn).toBe(from);
  });
  it("publishes travel without touching the setup return", () => {
    const patch = travelPatch(snap({ sidebar: "overlay" }), initialHistory);
    expect(patch).not.toHaveProperty("setupReturn");
    expect(patch.back).toBe(false);
    expect(patch.sidebar).toBe("rail");
  });
});

describe("bootstrapPatch", () => {
  const data = {
    environment: "preview",
    independentSession: true,
    browserHistoryState: { taskId: "t" },
    browserRouteState: { state: "loaded" },
    build: {
      buildId: "b",
      version: "1.0.0",
      builtAt: "now",
      sourceCommit: "c",
      sourceDirty: false,
    },
    runtimeState: "ready",
    windowState: { focused: true },
  } as never;
  const input = {
    data,
    state: snap({ runtime: "offline" }),
    browserHistoryMoved: false,
    browserRouteMoved: false,
    runtimeMoved: false,
    windowAtStart: initial.window,
  };
  it("adopts bootstrap values nothing newer has superseded", () => {
    const patch = bootstrapPatch(input);
    expect(patch.runtime).toBe("ready");
    expect(patch.route).toBe("loaded");
    expect(patch.browserHistory).toEqual({ taskId: "t" });
    expect(patch.buildId).toBe("b");
    expect(patch.installedVersion?.buildVersion).toBeNull();
  });
  it("keeps what a newer event already moved", () => {
    const patch = bootstrapPatch({
      ...input,
      browserHistoryMoved: true,
      browserRouteMoved: true,
      runtimeMoved: true,
      state: snap({ runtime: "failed", window: { ...initial.window } }),
    });
    expect(patch.runtime).toBe("failed");
    expect(patch).not.toHaveProperty("route");
    expect(patch).not.toHaveProperty("browserHistory");
    expect(patch.window).not.toBe(initial.window);
  });
});

describe("startupStatus", () => {
  it("is current only when settings and runtime are ready and nothing overflowed", () => {
    const ready = snap({
      configuration: { status: "ready" } as never,
      runtime: "ready",
    });
    expect(startupStatus(ready, false)).toBe("current");
    expect(startupStatus(ready, true)).toBe("stale");
    expect(startupStatus({ ...ready, runtime: "offline" }, false)).toBe(
      "stale",
    );
    expect(startupStatus(snap({ runtime: "ready" }), false)).toBe("stale");
  });
});

describe("browserPresentationDue", () => {
  it("is never due for a disposed or booting window", () => {
    expect(browserPresentationDue(snap(), true, false)).toBe(false);
    expect(browserPresentationDue(snap(), false, true)).toBe(false);
  });
  it("is not due outside the browser area", () => {
    expect(
      browserPresentationDue(
        snap({ destination: dest({ area: "home" }) }),
        false,
        false,
      ),
    ).toBe(false);
  });
});
