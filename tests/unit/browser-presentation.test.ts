import { describe, expect, it } from "vitest";
import {
  compactBrowserSelected,
  embeddedBrowserSelected,
} from "../../src/pkg/product-settings/browser-presentation";
import { deriveSurfaceLayout } from "../../src/apps/desktop/surface-layout";

describe("Browser presentation selection", () => {
  it.each(["preview", "dev"] as const)(
    "uses the current tab and status layout in normal %s",
    (environment) => {
      const selected = compactBrowserSelected({ environment });
      expect(selected).toBe(true);
      expect(
        deriveSurfaceLayout({
          width: 1180,
          height: 760,
          sidebar: "full",
          overlay: "none",
          section: "browser",
          setupOpen: false,
          runtimeReady: true,
          selectedTaskPresent: true,
          compactBrowser: selected,
        }).pageBounds,
      ).toEqual({ x: 216, y: 52, width: 964, height: 683 });
    },
  );
  it.each(["preview", "dev"] as const)(
    "preserves explicit demo/legacy presentation in %s",
    (environment) => {
      expect(compactBrowserSelected({ environment, demoMode: true })).toBe(
        false,
      );
      expect(
        compactBrowserSelected({ environment, legacySetupTestMode: true }),
      ).toBe(false);
    },
  );
});

describe("Embedded Browser selection", () => {
  it.each(["preview", "dev"] as const)(
    "uses the owned embedded surface in normal %s",
    (environment) => {
      expect(embeddedBrowserSelected({ environment })).toBe(true);
      expect(embeddedBrowserSelected({ environment, demoMode: true })).toBe(
        false,
      );
      expect(
        embeddedBrowserSelected({ environment, legacySetupTestMode: true }),
      ).toBe(false);
    },
  );
});
