import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import {
  guidedSetupSelected,
  initialSetupPresentation,
} from "../../src/pkg/product-settings/setup-entry";

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
              general: { openAtLaunch: "activity" },
              connectors: {
                secureMcp: {
                  lastVerifiedAttachment: attachment
                    ? { verified: true }
                    : null,
                },
              },
            };
      for (const source of ["../../src/apps/desktop/main.ts"]) {
        const text = fs.readFileSync(new URL(source, import.meta.url), "utf8");
        const calls = [
          ...text.matchAll(/initialSetupPresentation\((\{[^;]+?\})\)/gu),
        ];
        expect(calls).toHaveLength(1);
        const result = vm.runInNewContext(
          `initialSetupPresentation(${calls[0]![1]})`,
          {
            initialSetupPresentation: (
              input: Parameters<typeof initialSetupPresentation>[0],
            ) => {
              expect(Object.keys(input).sort()).toEqual([
                "currentStep",
                "demoMode",
                "dismissed",
                "environment",
                "legacySetupTestMode",
                "openAtLaunch",
              ]);
              return initialSetupPresentation(guarded(input) as typeof input);
            },
            initialSettings: initialSettings && guarded(initialSettings),
            activeDesktopIdentity: { environment: "preview" },
            bootstrap: { environment: "preview" },
            demoMode: false,
            legacySetupTestMode: false,
          },
        );
        expect(result).toMatchObject({ setupOpen: false, section });
      }
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
