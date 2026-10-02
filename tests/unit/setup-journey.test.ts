import { describe, expect, it } from "vitest";
import {
  advanceSetup,
  createSetupJourney,
  reopenSetup,
  retreatSetup,
  setupSteps,
} from "../../src/ui/setup-journey";
import {
  guidedSetupSelected,
  initialSetupPresentation,
} from "../../src/pkg/product-settings/setup-entry";

describe("setup journey", () => {
  it("keeps the five product-level stages in the required order", () => {
    expect(setupSteps.map((step) => step.id)).toEqual([
      "chatgpt",
      "computer",
      "connect",
      "hosts",
      "verify",
    ]);
    expect(setupSteps.every((step) => step.details.length > 0)).toBe(true);
  });

  it("opens on first run, advances once per action, and closes only after verify", () => {
    let journey = createSetupJourney();
    expect(journey).toEqual({ open: true, mode: "first-run", step: 0 });

    for (let index = 0; index < setupSteps.length - 1; index += 1) {
      journey = advanceSetup(journey);
      expect(journey).toMatchObject({ open: true, step: index + 1 });
    }

    expect(advanceSetup(journey)).toEqual({
      open: false,
      mode: "first-run",
      step: setupSteps.length - 1,
    });
  });

  it("bounds Back and reopens the same journey from Settings", () => {
    const first = createSetupJourney();
    expect(retreatSetup(first)).toEqual(first);

    const reviewed = reopenSetup(advanceSetup(first));
    expect(reviewed).toEqual({ open: true, mode: "review", step: 1 });
  });

  it("opens unfinished DEV onboarding in the Connections sidebar", () => {
    expect(
      initialSetupPresentation({
        environment: "dev",
        dismissed: false,
        currentStep: "connect",
        openAtLaunch: "browser",
      }),
    ).toEqual({
      setupOpen: false,
      setupStep: 2,
      section: "computer",
    });
  });

  it("opens packaged Preview setup inside the app and preserves completed DEV preference", () => {
    expect(
      initialSetupPresentation({
        environment: "preview",
        dismissed: false,
        currentStep: "computer",
        openAtLaunch: "activity",
      }),
    ).toEqual({
      setupOpen: false,
      setupStep: 1,
      section: "computer",
    });
    expect(
      initialSetupPresentation({
        environment: "dev",
        dismissed: true,
        currentStep: "verify",
        openAtLaunch: "settings",
      }),
    ).toEqual({
      setupOpen: false,
      setupStep: 4,
      section: "settings",
    });
  });

  it.each(["preview", "dev"] as const)(
    "keeps a previously completed %s setup out of the launch path after an update",
    (environment) => {
      expect(
        initialSetupPresentation({
          environment,
          dismissed: false,
          completedPreviously: true,
          currentStep: "verify",
          openAtLaunch: "browser",
        }),
      ).toEqual({ setupOpen: false, setupStep: 4, section: "browser" });
      expect(
        initialSetupPresentation({
          environment,
          dismissed: false,
          completedPreviously: true,
          currentStep: "connect",
          openAtLaunch: "activity",
        }),
      ).toEqual({ setupOpen: false, setupStep: 2, section: "activity" });
    },
  );
});

describe("guided Setup selection", () => {
  it.each(["preview", "dev"] as const)(
    "selects sidebar Setup in normal %s",
    (environment) => {
      expect(guidedSetupSelected({ environment, demoMode: false })).toBe(true);
      expect(
        initialSetupPresentation({
          environment,
          demoMode: false,
          dismissed: false,
          currentStep: "computer",
          openAtLaunch: "browser",
        }),
      ).toEqual({ setupOpen: false, setupStep: 1, section: "computer" });
    },
  );
  it.each(["preview", "dev"] as const)(
    "keeps explicit demo and legacy fixture modes separate in %s",
    (environment) => {
      expect(guidedSetupSelected({ environment, demoMode: true })).toBe(false);
      expect(
        guidedSetupSelected({
          environment,
          demoMode: false,
          legacySetupTestMode: true,
        }),
      ).toBe(false);
      expect(
        initialSetupPresentation({
          environment,
          demoMode: false,
          legacySetupTestMode: true,
          dismissed: false,
          currentStep: "chatgpt",
          openAtLaunch: "browser",
        }),
      ).toEqual({ setupOpen: true, setupStep: 0, section: "browser" });
    },
  );
});
