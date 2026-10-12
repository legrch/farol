import { describe, expect, it } from "vitest";
import {
  parseAllowPrimaryDisplay,
  parseBuiltInDisplayOnly,
  parseSidecarDisplayOnly,
  parsePreviewWindowSize,
  parsePreviewWindowMode,
  selectPreviewWindowPlacement,
  type PreviewDisplay,
} from "../../src/apps/desktop/window-placement";

const externalPrimary: PreviewDisplay = {
  id: 5,
  internal: false,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 30, width: 2560, height: 1320 },
};
const builtInSecondary: PreviewDisplay = {
  id: 1,
  internal: true,
  bounds: { x: -1512, y: 458, width: 1512, height: 982 },
  workArea: { x: -1512, y: 491, width: 1512, height: 949 },
};

describe("preview window mode", () => {
  it("keeps ordinary launches unchanged and accepts only the two test modes", () => {
    expect(parsePreviewWindowMode(["electron", "main.cjs"])).toBe("default");
    expect(
      parsePreviewWindowMode([
        "electron",
        "main.cjs",
        "--preview-window-mode=secondary-visible",
      ]),
    ).toBe("secondary-visible");
    expect(
      parsePreviewWindowMode([
        "electron",
        "main.cjs",
        "--preview-window-mode=hidden",
      ]),
    ).toBe("hidden");
  });

  it("fails closed on unknown or ambiguous window modes", () => {
    expect(() =>
      parsePreviewWindowMode(["--preview-window-mode=primary-visible"]),
    ).toThrow("PREVIEW_WINDOW_MODE_INVALID");
    expect(() =>
      parsePreviewWindowMode([
        "--preview-window-mode=hidden",
        "--preview-window-mode=secondary-visible",
      ]),
    ).toThrow("PREVIEW_WINDOW_MODE_INVALID");
  });
});

describe("preview window placement", () => {
  it("centers the visible test window on the non-primary built-in display", () => {
    const placement = selectPreviewWindowPlacement(
      [externalPrimary, builtInSecondary],
      externalPrimary.id,
      { width: 1180, height: 760 },
    );

    expect(placement).toEqual({
      displayId: builtInSecondary.id,
      internal: true,
      primary: false,
      selection: "non-primary-internal",
      bounds: { x: -1346, y: 585, width: 1180, height: 760 },
    });
  });

  it("chooses a deterministic non-primary display when none is internal", () => {
    const secondaryA: PreviewDisplay = {
      id: 8,
      internal: false,
      bounds: { x: 1920, y: 0, width: 1280, height: 720 },
      workArea: { x: 1920, y: 0, width: 1280, height: 700 },
    };
    const secondaryB: PreviewDisplay = {
      id: 3,
      internal: false,
      bounds: { x: -1024, y: 0, width: 1024, height: 768 },
      workArea: { x: -1024, y: 20, width: 1024, height: 748 },
    };

    const placement = selectPreviewWindowPlacement(
      [secondaryA, externalPrimary, secondaryB],
      externalPrimary.id,
      { width: 900, height: 600 },
    );

    expect(placement.displayId).toBe(secondaryB.id);
    expect(placement.selection).toBe("non-primary");
    expect(placement.primary).toBe(false);
  });

  it("refuses visible automation when only the primary display is available", () => {
    const primaryInternal: PreviewDisplay = {
      id: 1,
      internal: true,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      workArea: { x: 0, y: 24, width: 1000, height: 650 },
    };

    expect(() =>
      selectPreviewWindowPlacement([primaryInternal], primaryInternal.id, {
        width: 1180,
        height: 760,
      }),
    ).toThrow("SECONDARY_DISPLAY_UNAVAILABLE");
  });

  it("refuses a secondary that cannot preserve the required viewport", () => {
    expect(() =>
      selectPreviewWindowPlacement(
        [
          externalPrimary,
          {
            ...builtInSecondary,
            workArea: { x: -900, y: 100, width: 900, height: 700 },
          },
        ],
        externalPrimary.id,
        { width: 1180, height: 760 },
      ),
    ).toThrow("VISIBLE_TEST_VIEWPORT_UNAVAILABLE");
  });

  it("fails closed when Electron's display inventory is inconsistent", () => {
    expect(() =>
      selectPreviewWindowPlacement([], 1, { width: 1180, height: 760 }),
    ).toThrow("WINDOW_DISPLAY_UNAVAILABLE");
    expect(() =>
      selectPreviewWindowPlacement([externalPrimary], 999, {
        width: 1180,
        height: 760,
      }),
    ).toThrow("WINDOW_PRIMARY_DISPLAY_MISSING");
  });

  it("still refuses visible automation with only the primary display when the owner allowance is not passed", () => {
    const primaryInternal: PreviewDisplay = {
      id: 1,
      internal: true,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      workArea: { x: 0, y: 24, width: 1000, height: 650 },
    };

    expect(() =>
      selectPreviewWindowPlacement(
        [primaryInternal],
        primaryInternal.id,
        { width: 1180, height: 760 },
        false,
      ),
    ).toThrow("SECONDARY_DISPLAY_UNAVAILABLE");
  });

  it("falls back to the built-in primary display only when explicitly allowed and no non-primary display exists", () => {
    const primaryInternal: PreviewDisplay = {
      id: 1,
      internal: true,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 25, width: 1512, height: 949 },
    };

    const placement = selectPreviewWindowPlacement(
      [primaryInternal],
      primaryInternal.id,
      { width: 1180, height: 760 },
      true,
    );

    expect(placement).toEqual({
      displayId: primaryInternal.id,
      internal: true,
      primary: true,
      selection: "owner-allowed-primary",
      bounds: { x: 166, y: 119, width: 1180, height: 760 },
    });
  });

  it("prefers a real non-primary display over the owner allowance even when the allowance is passed", () => {
    const placement = selectPreviewWindowPlacement(
      [externalPrimary, builtInSecondary],
      externalPrimary.id,
      { width: 1180, height: 760 },
      true,
    );

    expect(placement.selection).toBe("non-primary-internal");
    expect(placement.primary).toBe(false);
  });

  it("still enforces the viewport requirement on the owner-allowed primary display", () => {
    const tooSmallPrimary: PreviewDisplay = {
      id: 1,
      internal: true,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      workArea: { x: 0, y: 24, width: 1000, height: 650 },
    };

    expect(() =>
      selectPreviewWindowPlacement(
        [tooSmallPrimary],
        tooSmallPrimary.id,
        { width: 1180, height: 760 },
        true,
      ),
    ).toThrow("VISIBLE_TEST_VIEWPORT_UNAVAILABLE");
  });
});

describe("allow-primary-display flag", () => {
  it("is explicit-only: absent unless the exact flag is passed", () => {
    expect(parseAllowPrimaryDisplay(["electron", "main.cjs"])).toBe(false);
    expect(
      parseAllowPrimaryDisplay([
        "electron",
        "main.cjs",
        "--preview-window-mode=secondary-visible",
      ]),
    ).toBe(false);
    expect(
      parseAllowPrimaryDisplay([
        "electron",
        "main.cjs",
        "--allow-primary-display",
      ]),
    ).toBe(true);
  });
});

describe("built-in-display-only test placement", () => {
  const builtInPrimary: PreviewDisplay = {
    id: 1,
    internal: true,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 25, width: 1512, height: 949 },
  };

  it("selects the built-in primary even when an external secondary exists", () => {
    const externalSecondary = { ...externalPrimary, id: 7 };
    const placement = selectPreviewWindowPlacement(
      [externalSecondary, builtInPrimary],
      builtInPrimary.id,
      { width: 1180, height: 760 },
      true,
      true,
    );
    expect(placement.displayId).toBe(builtInPrimary.id);
    expect(placement.selection).toBe("owner-allowed-primary");
  });

  it("refuses an external-only display inventory", () => {
    expect(() =>
      selectPreviewWindowPlacement(
        [externalPrimary],
        externalPrimary.id,
        { width: 1180, height: 760 },
        true,
        true,
      ),
    ).toThrow("BUILT_IN_DISPLAY_UNAVAILABLE");
  });

  it("requires the exact flag", () => {
    expect(parseBuiltInDisplayOnly(["electron", "main.cjs"])).toBe(false);
    expect(
      parseBuiltInDisplayOnly([
        "electron",
        "main.cjs",
        "--built-in-display-only",
      ]),
    ).toBe(true);
  });
});

describe("explicit iPad test presentation", () => {
  const sidecar: PreviewDisplay = {
    id: 7,
    internal: false,
    label: "Sidecar Display (AirPlay)",
    bounds: { x: -1135, y: 0, width: 1135, height: 789 },
    workArea: { x: -1135, y: 30, width: 1135, height: 759 },
  };
  it("selects the named Sidecar even with another built-in secondary", () => {
    const result = selectPreviewWindowPlacement(
      [externalPrimary, builtInSecondary, sidecar],
      5,
      { width: 1100, height: 740 },
      false,
      false,
      true,
    );
    expect(result).toMatchObject({
      displayId: 7,
      selection: "sidecar",
      bounds: { x: -1118, y: 39, width: 1100, height: 740 },
    });
  });
  it("hides when Sidecar disappears, is primary, or conflicts with a built-in constraint", () => {
    expect(() =>
      selectPreviewWindowPlacement(
        [externalPrimary, builtInSecondary],
        5,
        { width: 1100, height: 740 },
        true,
        false,
        true,
      ),
    ).toThrow("SIDECAR_DISPLAY_UNAVAILABLE");
    expect(() =>
      selectPreviewWindowPlacement(
        [sidecar, builtInSecondary],
        7,
        { width: 1100, height: 740 },
        false,
        false,
        true,
      ),
    ).toThrow("SIDECAR_DISPLAY_UNAVAILABLE");
    expect(() =>
      selectPreviewWindowPlacement(
        [externalPrimary, sidecar],
        5,
        { width: 1100, height: 740 },
        false,
        true,
        true,
      ),
    ).toThrow("VISIBLE_TEST_DISPLAY_CONFLICT");
  });
  it("does not reinterpret the existing exact-viewport constraint", () => {
    expect(() =>
      selectPreviewWindowPlacement(
        [externalPrimary, sidecar],
        5,
        { width: 1180, height: 760 },
        false,
        false,
        true,
      ),
    ).toThrow("VISIBLE_TEST_VIEWPORT_UNAVAILABLE");
  });
});

it("accepts a bounded explicit test viewport without changing normal launches", () => {
  expect(parseSidecarDisplayOnly([])).toBe(false);
  expect(parseSidecarDisplayOnly(["--sidecar-display-only"])).toBe(true);
  expect(parsePreviewWindowSize([], "default")).toEqual({
    width: 1180,
    height: 760,
  });
  expect(
    parsePreviewWindowSize(
      ["--preview-window-size=1100x740"],
      "secondary-visible",
    ),
  ).toEqual({ width: 1100, height: 740 });
  for (const mode of ["default", "hidden", "secondary-visible"] as const) {
    for (const value of ["10x20", "Infinityx740", "600x519", "4000x3000"])
      expect(() =>
        parsePreviewWindowSize([`--preview-window-size=${value}`], mode),
      ).toThrow("PREVIEW_WINDOW_SIZE_INVALID");
  }
  expect(() =>
    parsePreviewWindowSize(["--preview-window-size=1100x740"], "default"),
  ).toThrow("PREVIEW_WINDOW_SIZE_INVALID");
  expect(() =>
    parsePreviewWindowSize(
      ["--preview-window-size=1100x740", "--preview-window-size=1100x740"],
      "hidden",
    ),
  ).toThrow("PREVIEW_WINDOW_SIZE_INVALID");
});
