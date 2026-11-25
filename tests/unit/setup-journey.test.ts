import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  guidedSetupSelected,
  initialSetupPresentation,
} from "../../src/pkg/product-settings/setup-entry";
import { startupEntry } from "../../apps/desktop/shell/entry";

describe("initial setup presentation", () => {
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
});

describe("persisted startup entry", () => {
  const guarded = (value: Record<string, unknown>): unknown =>
    new Proxy(value, {
      get(target, field) {
        if (typeof field !== "string" || !(field in target))
          throw new Error(`Unexpected startup signal: ${String(field)}`);
        const result = target[field];
        return result !== null && typeof result === "object"
          ? guarded(result as Record<string, unknown>)
          : result;
      },
    });

  it.each([
    [false, true, "computer"],
    [true, true, "activity"],
    [true, false, "activity"],
    [null, false, "computer"],
  ] as const)(
    "main: dismissed=%s, attachment=%s opens %s",
    (dismissed, attachment, section) => {
      const initialSettings =
        dismissed === null
          ? null
          : {
              setup: { journey: { dismissed, currentStep: "verify" } },
              general: { openAtLaunch: "activity", sidebarDefault: "full" },
              connectors: {
                secureMcp: {
                  lastVerifiedAttachment: attachment
                    ? { verified: true }
                    : null,
                },
              },
            };
      const text = fs.readFileSync(
        new URL("../../src/apps/desktop/main.ts", import.meta.url),
        "utf8",
      );
      // Main hands the entry its saved settings and assigns all three results.
      expect([...text.matchAll(/startupEntry\(\{/gu)]).toHaveLength(1);
      expect(text).toMatch(/settings: initialSettings,/u);
      expect(text).toMatch(/section = entry\.section;/u);
      expect(text).toMatch(/setupOpen = entry\.setupOpen;/u);
      const result = startupEntry({
        environment: "preview",
        demoMode: false,
        legacySetupTestMode: false,
        settings: initialSettings && (guarded(initialSettings) as never),
      });
      expect(result).toMatchObject({ setupOpen: false, section });
    },
  );

  it("rejects any completion signal beyond dismissed in the entry function", () => {
    for (const dismissed of [false, true]) {
      expect(
        initialSetupPresentation(
          guarded({
            environment: "preview",
            demoMode: false,
            legacySetupTestMode: false,
            dismissed,
            currentStep: "verify",
            openAtLaunch: "browser",
          }) as Parameters<typeof initialSetupPresentation>[0],
        ),
      ).toMatchObject({ section: dismissed ? "browser" : "computer" });
    }
  });
});

describe("guided Setup selection", () => {
  it("keeps Home on the non-browser native surface without rewriting explicit launch choices", () => {
    for (const [openAtLaunch, section] of [
      ["home", "settings"],
      ["browser", "browser"],
      ["computer", "computer"],
      ["activity", "activity"],
      ["settings", "settings"],
    ] as const) {
      const input = {
        environment: "dev",
        dismissed: true,
        currentStep: "verify",
        openAtLaunch,
      } as const;
      expect(initialSetupPresentation(input)).toMatchObject({
        setupOpen: false,
        section,
      });
      expect(input.openAtLaunch).toBe(openAtLaunch);
    }
  });
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
