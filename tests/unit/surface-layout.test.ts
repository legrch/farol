import { describe, expect, it } from "vitest";
import { deriveSurfaceLayout } from "../../src/apps/desktop/surface-layout";

const base = {
  width: 1_180,
  height: 760,
  sidebar: "full" as const,
  overlay: "none" as const,
  section: "browser" as const,
  setupOpen: false,
  runtimeReady: true,
  selectedTaskPresent: true,
};

describe("native Browser surface layout", () => {
  it("places the page below the task dossier beside a full sidebar", () => {
    expect(deriveSurfaceLayout(base)).toEqual({
      sidebarWidth: 216,
      autoRail: false,
      pageVisible: true,
      pageBounds: { x: 216, y: 178, width: 964, height: 582 },
    });
  });

  it("uses a 72 px rail by preference and automatically below 980 px", () => {
    expect(deriveSurfaceLayout({ ...base, sidebar: "rail" })).toMatchObject({
      sidebarWidth: 72,
      autoRail: false,
      pageBounds: { x: 72, y: 178, width: 1_108, height: 582 },
    });
    expect(
      deriveSurfaceLayout({ ...base, width: 940, sidebar: "full" }),
    ).toMatchObject({
      sidebarWidth: 72,
      autoRail: true,
      pageBounds: { x: 72, y: 178, width: 868, height: 582 },
    });
  });

  it("gives embedded sign-in the full browser height without task controls", () => {
    expect(
      deriveSurfaceLayout({ ...base, browserChromeVisible: false }),
    ).toMatchObject({
      pageVisible: true,
      pageBounds: { x: 216, y: 52, width: 964, height: 708 },
    });
  });

  it("gives the DEV browser a compact tab strip and a status strip", () => {
    expect(
      deriveSurfaceLayout({ ...base, compactDevBrowser: true }),
    ).toMatchObject({
      pageBounds: { x: 216, y: 52, width: 964, height: 683 },
    });
    expect(
      deriveSurfaceLayout({
        ...base,
        compactDevBrowser: true,
        browserChromeVisible: false,
      }),
    ).toMatchObject({
      pageBounds: { x: 216, y: 52, width: 964, height: 708 },
    });
  });

  it.each([
    { setupOpen: true },
    { overlay: "sidebar" as const },
    { overlay: "task-menu" as const },
    { overlay: "quick-switcher" as const },
    { section: "computer" as const },
    { runtimeReady: false },
    { selectedTaskPresent: false },
  ])("hides the native page for shell-owned state %#", (change) => {
    expect(deriveSurfaceLayout({ ...base, ...change }).pageVisible).toBe(false);
  });
});
