import { describe, expect, it } from "vitest";
import {
  advanceSetup,
  createSetupJourney,
  reopenSetup,
  retreatSetup,
  setupSteps,
} from "../../src/ui/setup-journey";
import { initialSetupPresentation } from "../../src/pkg/product-settings/setup-entry";

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

  it("preserves the packaged Preview wizard and completed DEV preference", () => {
    expect(
      initialSetupPresentation({
        environment: "preview",
        dismissed: false,
        currentStep: "computer",
        openAtLaunch: "activity",
      }),
    ).toEqual({
      setupOpen: true,
      setupStep: 1,
      section: "activity",
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
});
