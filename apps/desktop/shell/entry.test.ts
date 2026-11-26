import { describe, expect, it } from "vitest";
import { startupEntry } from "./entry";

const base = {
  environment: "preview",
  demoMode: false,
  legacySetupTestMode: false,
} as const;

const settings = (
  dismissed: boolean,
  openAtLaunch: "home" | "activity",
  sidebarDefault: "full" | "rail",
) =>
  ({
    setup: { journey: { dismissed, currentStep: "verify" } },
    general: { openAtLaunch, sidebarDefault },
  }) as const;

describe("startup entry", () => {
  it("applies the first-run defaults without ready settings and leaves the sidebar alone", () => {
    expect(startupEntry({ ...base, settings: null })).toEqual({
      section: "computer",
      setupOpen: false,
      sidebarMode: null,
    });
  });

  it("takes the launch section and the sidebar from completed settings", () => {
    expect(
      startupEntry({ ...base, settings: settings(true, "activity", "rail") }),
    ).toEqual({ section: "activity", setupOpen: false, sidebarMode: "rail" });
  });

  it("maps Home to the non-browser surface once Setup is dismissed", () => {
    expect(
      startupEntry({ ...base, settings: settings(true, "home", "full") }),
    ).toMatchObject({ section: "settings", sidebarMode: "full" });
  });

  it("opens the Setup panel on first run when guided Setup is not selected", () => {
    expect(
      startupEntry({
        ...base,
        demoMode: true,
        settings: settings(false, "activity", "rail"),
      }),
    ).toEqual({ section: "activity", setupOpen: true, sidebarMode: "rail" });
  });
});
