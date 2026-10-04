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
  it("places the page below the single toolbar beside a full sidebar", () => {
    expect(deriveSurfaceLayout(base)).toEqual({
      sidebarWidth: 294,
      autoRail: false,
      pageVisible: true,
      pageBounds: { x: 294, y: 58, width: 886, height: 702 },
    });
  });

  it("uses a 62 px rail by preference and automatically below 980 px", () => {
    expect(deriveSurfaceLayout({ ...base, sidebar: "rail" })).toMatchObject({
      sidebarWidth: 62,
      autoRail: false,
      pageBounds: { x: 62, y: 58, width: 1_118, height: 702 },
    });
    expect(
      deriveSurfaceLayout({ ...base, width: 940, sidebar: "full" }),
    ).toMatchObject({
      sidebarWidth: 62,
      autoRail: true,
      pageBounds: { x: 62, y: 58, width: 878, height: 702 },
    });
  });

  it("gives embedded sign-in the full browser height without task controls", () => {
    expect(
      deriveSurfaceLayout({ ...base, browserChromeVisible: false }),
    ).toMatchObject({
      pageVisible: true,
      pageBounds: { x: 294, y: 58, width: 886, height: 702 },
    });
  });

  it("gives the normal Browser a compact tab strip and a status strip", () => {
    expect(
      deriveSurfaceLayout({ ...base, compactBrowser: true }),
    ).toMatchObject({
      pageBounds: { x: 294, y: 58, width: 886, height: 702 },
    });
    expect(
      deriveSurfaceLayout({
        ...base,
        compactBrowser: true,
        browserChromeVisible: false,
      }),
    ).toMatchObject({
      pageBounds: { x: 294, y: 58, width: 886, height: 702 },
    });
  });

  it("uses the single toolbar for the approved renderer", () => {
    expect(
      deriveSurfaceLayout({
        ...base,
        compactBrowser: true,
        checkFeedbackVisible: true,
      }),
    ).toMatchObject({
      pageBounds: { x: 294, y: 58, width: 886, height: 702 },
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
