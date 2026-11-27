import { describe, expect, it } from "vitest";
import {
  dismissInstantPowerPickerScript,
  focusInstantPowerSliderScript,
  lowerInstantPowerSliderScript,
  openInstantPowerPickerScript,
  openTemporaryPersonalizationScript,
  selectTemporaryPersonalizationScript,
  temporaryInstantProfileProbe,
} from "../../../src/apps/desktop/chatgpt/scripts";
import { BEST_EFFORT_SETTLE_MS, createBestEffortProfilePreparer } from "./ping";

const HOME = "https://chatgpt.com/";
const TEMPORARY = "https://chatgpt.com/?temporary-chat=true";

type Page = {
  composerReady: boolean;
  draftPresent: boolean;
  temporary: boolean;
  personalized: boolean;
  personalizationReady: boolean;
  instant: boolean;
  modelReady: boolean;
  modelControlCount: number;
};
const fresh: Page = {
  composerReady: true,
  draftPresent: false,
  temporary: true,
  personalized: false,
  personalizationReady: true,
  instant: false,
  modelReady: true,
  modelControlCount: 1,
};

const LABELS = new Map<string, string>([
  [temporaryInstantProfileProbe, "probe"],
  [openInstantPowerPickerScript, "open-picker"],
  [focusInstantPowerSliderScript, "slider"],
  [lowerInstantPowerSliderScript, "lower"],
  [dismissInstantPowerPickerScript, "dismiss"],
  [openTemporaryPersonalizationScript, "open-personalization"],
  [selectTemporaryPersonalizationScript, "select-personalization"],
]);

// A scripted page the test drives by hand. The clock moves only by delays, so
// nothing here sleeps. Any script that is not one of the known profile scripts
// throws: the preparer has no way to write to the composer.
function harness(
  input: { page?: Partial<Page>; afterNavigation?: Partial<Page> } = {},
) {
  let clock = 1_000_000;
  let page: Page = { ...fresh, ...input.page };
  const log: string[] = [];
  const handlers: Record<string, (count: number) => unknown> = {
    probe: () => page,
    "open-picker": () => true,
    slider: () => ({ ready: true, atMinimum: true }),
    lower: () => true,
    dismiss: () => true,
    "open-personalization": () => true,
    "select-personalization": () => {
      page = { ...page, personalized: true };
      return true;
    },
  };
  const counts = new Map<string, number>();
  const control = { navigateFails: false };
  const prepare = createBestEffortProfilePreparer({
    execute: async (script) => {
      const label = LABELS.get(script);
      if (!label) throw new Error("Unexpected provider script");
      const count = (counts.get(label) ?? 0) + 1;
      counts.set(label, count);
      log.push(label);
      return handlers[label]!(count);
    },
    navigate: async (url) => {
      log.push(`navigate ${url}`);
      if (control.navigateFails) throw new Error("navigation failed");
      page = { ...fresh, ...input.afterNavigation };
    },
    snapshot: () => {
      throw new Error("the best-effort preparation never reads identity");
    },
    now: () => clock,
    delay: async (ms) => {
      log.push(`delay ${ms}`);
      clock += ms;
    },
    report: undefined,
  });
  return {
    log,
    handlers,
    control,
    setPage: (next: Partial<Page>) => {
      page = { ...page, ...next };
    },
    count: (label: string) => counts.get(label) ?? 0,
    run: (navigate = true) =>
      prepare({
        homeUrl: HOME,
        taskDeadline: clock + 180_000,
        navigate,
      }),
  };
}

type Harness = ReturnType<typeof harness>;

// One way each step can go, and the outcome it must report.
const temporaryCases: readonly [
  string,
  Partial<Page>,
  "temporary" | "not_temporary",
][] = [
  ["a Temporary chat", { temporary: true }, "temporary"],
  ["an ordinary chat", { temporary: false }, "not_temporary"],
];
const modelCases: readonly [
  string,
  Partial<Page>,
  (h: Harness) => void,
  "instant" | "instant_unavailable" | "other_model" | "model_unrecognized",
][] = [
  ["Instant already shown", { instant: true }, () => {}, "instant"],
  [
    "Instant selected through the picker",
    {},
    (h) => {
      h.handlers.dismiss = () => {
        h.setPage({ instant: true });
        return true;
      };
    },
    "instant",
  ],
  [
    "a picker that cannot be opened",
    {},
    (h) => {
      h.handlers["open-picker"] = () => false;
    },
    "instant_unavailable",
  ],
  [
    "a picker script that throws",
    {},
    (h) => {
      h.handlers["open-picker"] = () => {
        throw new Error("script failed");
      };
    },
    "instant_unavailable",
  ],
  [
    "a slider that is not there",
    {},
    (h) => {
      h.handlers.slider = () => ({ ready: false });
    },
    "instant_unavailable",
  ],
  [
    "a model control that is not usable",
    { modelReady: false },
    () => {},
    "instant_unavailable",
  ],
  [
    "a slider lowered while the chip still shows another model",
    {},
    () => {},
    "other_model",
  ],
  [
    "no model control at all",
    { modelReady: false, modelControlCount: 0 },
    () => {},
    "model_unrecognized",
  ],
];
const personalizationCases: readonly [
  string,
  Partial<Page>,
  (h: Harness) => void,
  "set" | "unavailable",
][] = [
  ["already personalized", { personalized: true }, () => {}, "set"],
  ["selected through the legacy control", {}, () => {}, "set"],
  [
    "a control that is absent (the new layout)",
    { personalizationReady: false },
    () => {},
    "unavailable",
  ],
  [
    "a selection that is never acknowledged",
    {},
    (h) => {
      h.handlers["select-personalization"] = () => false;
    },
    "unavailable",
  ],
  [
    "an opener that throws",
    {},
    (h) => {
      h.handlers["open-personalization"] = () => {
        throw new Error("script failed");
      };
    },
    "unavailable",
  ],
];

describe("every combination of failed steps still sends, and reports each step", () => {
  const rows = temporaryCases.flatMap((temporary) =>
    modelCases.flatMap((model) =>
      personalizationCases.map((personalization) => ({
        name: `${temporary[0]} / ${model[0]} / ${personalization[0]}`,
        temporary,
        model,
        personalization,
      })),
    ),
  );

  it.each(rows)("$name", async ({ temporary, model, personalization }) => {
    const h = harness({
      page: { ...temporary[1], ...model[1], ...personalization[1] },
    });
    model[2](h);
    personalization[2](h);
    // Never navigates here: the check opened its chat before this runs.
    await expect(h.run(false)).resolves.toEqual({
      refusal: null,
      steps: {
        temporary: temporary[2],
        model: model[3],
        personalization: personalization[3],
      },
    });
    expect(h.log.some((entry) => entry.startsWith("navigate"))).toBe(false);
  });

  it("covers every outcome of every step", () => {
    expect(new Set(temporaryCases.map((c) => c[2]))).toEqual(
      new Set(["temporary", "not_temporary"]),
    );
    expect(new Set(modelCases.map((c) => c[3]))).toEqual(
      new Set([
        "instant",
        "instant_unavailable",
        "other_model",
        "model_unrecognized",
      ]),
    );
    expect(new Set(personalizationCases.map((c) => c[3]))).toEqual(
      new Set(["set", "unavailable"]),
    );
  });

  it("opens a Temporary chat when asked to and reports a failed navigation", async () => {
    const opened = harness({ page: { temporary: false } });
    await expect(opened.run(true)).resolves.toMatchObject({
      refusal: null,
      steps: { temporary: "temporary" },
    });
    expect(opened.log.filter((e) => e.startsWith("navigate"))).toEqual([
      `navigate ${TEMPORARY}`,
    ]);

    const failed = harness({ page: { temporary: false } });
    failed.control.navigateFails = true;
    await expect(failed.run(true)).resolves.toMatchObject({
      refusal: null,
      steps: { temporary: "not_temporary" },
    });
  });

  it("goes on with no composer at all and says what it could not do", async () => {
    const h = harness({
      page: { composerReady: false, modelReady: false, modelControlCount: 0 },
    });
    const result = await h.run(false);
    // Typing and sending are what fail then, and they say so themselves.
    expect(result.refusal).toBeNull();
    expect(result.steps.model).toBe("model_unrecognized");
    expect(
      h.log.filter((entry) => entry.startsWith("delay")).length,
    ).toBeGreaterThan(10);
  });

  it("waits only a short bounded settle for a page that is still loading", async () => {
    const h = harness({ page: { composerReady: false } });
    let reads = 0;
    h.handlers.probe = () => {
      reads += 1;
      return reads <= 3
        ? { ...fresh, composerReady: false, modelReady: false }
        : { ...fresh, instant: true };
    };
    const result = await h.run(false);
    expect(result.refusal).toBeNull();
    expect(result.steps.model).toBe("instant");
    expect(h.log.slice(0, 6)).toEqual([
      "probe",
      "delay 200",
      "probe",
      "delay 200",
      "probe",
      "delay 200",
    ]);
    const settle = h.log
      .filter((entry) => entry.startsWith("delay"))
      .reduce((total, entry) => total + Number(entry.slice(6)), 0);
    expect(settle).toBeLessThanOrEqual(
      BEST_EFFORT_SETTLE_MS + 2_000 + 2_000 + 2_000,
    );
  });

  it("does not read the document's identity", async () => {
    // The harness throws from `snapshot`; every case above passes through it.
    const h = harness({ page: { instant: true } });
    await expect(h.run(false)).resolves.toMatchObject({ refusal: null });
  });
});

describe("a draft", () => {
  it("goes to a fresh Temporary chat and sends there, never touching the draft", async () => {
    const h = harness({
      page: { draftPresent: true },
      afterNavigation: { instant: true },
    });
    await expect(h.run(true)).resolves.toEqual({
      refusal: null,
      steps: {
        temporary: "temporary",
        model: "instant",
        personalization: "set",
      },
    });
    expect(h.log.filter((entry) => entry.startsWith("navigate"))).toEqual([
      `navigate ${TEMPORARY}`,
    ]);
    // The only page scripts are the profile's own: none types, clears or
    // replaces composer text (an unknown script would have thrown).
    expect(
      h.log.every(
        (entry) =>
          entry.startsWith("navigate") ||
          entry.startsWith("delay") ||
          [
            "probe",
            "open-picker",
            "slider",
            "lower",
            "dismiss",
            "open-personalization",
            "select-personalization",
          ].includes(entry),
      ),
    ).toBe(true);
    // Nothing is done before the fresh chat exists.
    expect(h.log.slice(0, 2)).toEqual(["probe", `navigate ${TEMPORARY}`]);
  });

  it("is not sent, not cleared and not changed when the fresh chat still has text", async () => {
    const h = harness({
      page: { draftPresent: true },
      afterNavigation: { draftPresent: true },
    });
    const result = await h.run(true);
    expect(result.refusal).toBe("CHATGPT_COMPOSER_DRAFT_PRESENT");
    expect(h.count("open-picker")).toBe(0);
    expect(h.count("open-personalization")).toBe(0);
    expect(h.count("select-personalization")).toBe(0);
    expect(h.log.filter((entry) => entry.startsWith("navigate"))).toHaveLength(
      1,
    );
  });

  it("is not sent when the chat cannot be replaced and still has the draft", async () => {
    const h = harness({ page: { draftPresent: true } });
    const result = await h.run(false);
    expect(result.refusal).toBe("CHATGPT_COMPOSER_DRAFT_PRESENT");
    expect(h.log.some((entry) => entry.startsWith("navigate"))).toBe(false);
    expect(h.count("open-picker")).toBe(0);
  });

  it("is not sent when the navigation to a fresh chat fails", async () => {
    const h = harness({ page: { draftPresent: true } });
    h.control.navigateFails = true;
    const result = await h.run(true);
    expect(result.refusal).toBe("CHATGPT_COMPOSER_DRAFT_PRESENT");
    expect(h.count("open-picker")).toBe(0);
  });

  it("is not mixed with the check when it appears after the steps", async () => {
    const h = harness({ page: { instant: true, personalized: true } });
    let reads = 0;
    h.handlers.probe = () => {
      reads += 1;
      return {
        ...fresh,
        instant: true,
        personalized: true,
        draftPresent: reads >= 2,
      };
    };
    const result = await h.run(false);
    expect(result.refusal).toBe("CHATGPT_COMPOSER_DRAFT_PRESENT");
  });
});
