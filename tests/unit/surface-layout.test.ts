import { describe, expect, it } from "vitest";
import { deriveSurfaceLayout } from "../../src/apps/desktop/surface-layout";
import { ShellLayoutSchema } from "../../src/pkg/ipc/shell-state";

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
      sidebarWidth: 236,
      autoRail: false,
      pageVisible: true,
      pageBounds: { x: 236, y: 58, width: 944, height: 702 },
    });
  });

  it("uses a 56 px rail by preference and automatically below 980 px", () => {
    expect(deriveSurfaceLayout({ ...base, sidebar: "rail" })).toMatchObject({
      sidebarWidth: 56,
      autoRail: false,
      pageBounds: { x: 56, y: 58, width: 1_124, height: 702 },
    });
    expect(
      deriveSurfaceLayout({ ...base, width: 940, sidebar: "full" }),
    ).toMatchObject({
      sidebarWidth: 56,
      autoRail: true,
      pageBounds: { x: 56, y: 58, width: 884, height: 702 },
    });
  });

  it("gives embedded sign-in the full browser height without task controls", () => {
    expect(
      deriveSurfaceLayout({ ...base, browserChromeVisible: false }),
    ).toMatchObject({
      pageVisible: true,
      pageBounds: { x: 236, y: 58, width: 944, height: 702 },
    });
  });

  it("gives the normal Browser a compact tab strip and a status strip", () => {
    expect(
      deriveSurfaceLayout({ ...base, compactBrowser: true }),
    ).toMatchObject({
      pageBounds: { x: 236, y: 58, width: 944, height: 702 },
    });
    expect(
      deriveSurfaceLayout({
        ...base,
        compactBrowser: true,
        browserChromeVisible: false,
      }),
    ).toMatchObject({
      pageBounds: { x: 236, y: 58, width: 944, height: 702 },
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
      pageBounds: { x: 236, y: 58, width: 944, height: 702 },
    });
  });

  it("uses bounded page-list widths and retains rail geometry while an overlay owns input", () => {
    expect(
      deriveSurfaceLayout({ ...base, sidebarWidth: 240 }).pageBounds,
    ).toEqual({
      x: 296,
      y: 58,
      width: 884,
      height: 702,
    });
    expect(
      deriveSurfaceLayout({ ...base, sidebarWidth: 900 }).pageBounds.x,
    ).toBe(344);
    expect(
      deriveSurfaceLayout({ ...base, sidebarWidth: -10 }).pageBounds.x,
    ).toBe(208);
    expect(
      deriveSurfaceLayout({ ...base, sidebarWidth: NaN }).pageBounds.x,
    ).toBe(236);
    expect(
      deriveSurfaceLayout({
        ...base,
        sidebar: "overlay",
        sidebarWidth: 240,
        overlay: "sidebar",
      }),
    ).toMatchObject({
      pageVisible: false,
      sidebarWidth: 56,
    });
  });

  it("rejects out-of-range and fractional renderer widths at the IPC boundary", () => {
    const layout = {
      section: "browser",
      taskId: "",
      setupOpen: false,
      sidebar: "full",
      overlay: "none",
    };
    expect(ShellLayoutSchema.parse(layout).sidebarWidth).toBe(180);
    expect(
      ShellLayoutSchema.parse({ ...layout, sidebarWidth: 240 }).sidebarWidth,
    ).toBe(240);
    for (const width of [0, 151, 289, 180.5, Infinity, NaN, "180"])
      expect(
        ShellLayoutSchema.safeParse({ ...layout, sidebarWidth: width }).success,
      ).toBe(false);
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
