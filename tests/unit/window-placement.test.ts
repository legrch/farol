import { describe, expect, it } from "vitest";
import {
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

  it("falls back explicitly to the primary internal display on one screen", () => {
    const primaryInternal: PreviewDisplay = {
      id: 1,
      internal: true,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      workArea: { x: 0, y: 24, width: 1000, height: 650 },
    };

    expect(
      selectPreviewWindowPlacement([primaryInternal], primaryInternal.id, {
        width: 1180,
        height: 760,
      }),
    ).toEqual({
      displayId: primaryInternal.id,
      internal: true,
      primary: true,
      selection: "internal-primary-fallback",
      bounds: { x: 0, y: 24, width: 1000, height: 650 },
    });
  });

  it("uses an explicit primary fallback when the only display is external", () => {
    const placement = selectPreviewWindowPlacement(
      [externalPrimary],
      externalPrimary.id,
      { width: 1180, height: 760 },
    );

    expect(placement.displayId).toBe(externalPrimary.id);
    expect(placement.internal).toBe(false);
    expect(placement.primary).toBe(true);
    expect(placement.selection).toBe("primary-fallback");
    expect(placement.bounds).toEqual({
      x: 690,
      y: 310,
      width: 1180,
      height: 760,
    });
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
});
