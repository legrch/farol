import { describe, expect, it } from "vitest";
import { readLaunchArguments } from "./launch";

// The launch flags over literal argument lists. The parsers are the real ones,
// so these cases pin the composition: which flags are read, which refusals
// fire, and in which order, exactly as main read them inline before.

const none = {};

describe("launch arguments", () => {
  it("reads an ordinary launch as visible, without demo or delay", () => {
    const launch = readLaunchArguments([], none, "preview");
    expect(launch.ownerBackgroundOnly).toBe(false);
    expect(launch.demoMode).toBe(false);
    expect(launch.expectedTasks).toEqual([]);
    expect(launch.startupDelayMs).toBe(0);
    expect(launch.legacySetupTestMode).toBe(false);
    expect(launch.devSecondaryDisplay).toBe(false);
    expect(launch.explicitPreviewWindowSize).toBe(false);
  });

  it("refuses a background-only launch that is not hidden", () => {
    expect(() =>
      readLaunchArguments(["--owner-background-only"], none, "preview"),
    ).toThrow("OWNER_BACKGROUND_PRESENTATION_INVALID");
  });

  it("refuses the dev display flag outside a dev build", () => {
    expect(() =>
      readLaunchArguments(["--display=secondary"], none, "preview"),
    ).toThrow("DEV_DISPLAY_ARGUMENT_INVALID");
    expect(
      readLaunchArguments(["--display=secondary"], none, "dev").windowMode,
    ).toBe("secondary-visible");
  });

  it("checks the background flag before the dev display flag", () => {
    expect(() =>
      readLaunchArguments(
        ["--owner-background-only", "--display=secondary"],
        none,
        "preview",
      ),
    ).toThrow("OWNER_BACKGROUND_PRESENTATION_INVALID");
  });

  it("selects the two demo tasks only with --demo", () => {
    const launch = readLaunchArguments(["--demo"], none, "preview");
    expect(launch.demoMode).toBe(true);
    expect(launch.expectedTasks.map((task) => task.taskId)).toEqual([
      "task-atlantic",
      "task-harbor",
    ]);
  });

  it("honours the legacy Setup and startup delay only in the E2E lane", () => {
    const argv = ["--preview-startup-delay-ms=250"];
    const legacy = { FAROL_E2E_LEGACY_SETUP: "1" };
    expect(readLaunchArguments(argv, legacy, "preview")).toMatchObject({
      legacySetupTestMode: false,
      startupDelayMs: 0,
    });
    expect(
      readLaunchArguments(argv, { ...legacy, FAROL_E2E: "1" }, "preview"),
    ).toMatchObject({ legacySetupTestMode: true, startupDelayMs: 250 });
  });

  it("notes an explicit window size for a hidden window", () => {
    const launch = readLaunchArguments(
      ["--preview-window-mode=hidden", "--preview-window-size=900x700"],
      none,
      "preview",
    );
    expect(launch.explicitPreviewWindowSize).toBe(true);
    expect(launch.initialWindowSize).toEqual({ width: 900, height: 700 });
  });
});
