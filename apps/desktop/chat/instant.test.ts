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
import {
  createInstantProfilePreparer,
  type ChatGptProfilePreparationDiagnostic,
  type InstantSurfaceSnapshot,
} from "./instant";

const HOME = "https://chatgpt.com/";
const TEMPORARY = "https://chatgpt.com/?temporary-chat=true";

type Profile = {
  composerReady: boolean;
  draftPresent: boolean;
  temporary: boolean;
  personalized: boolean;
  personalizationReady: boolean;
  instant: boolean;
  modelReady: boolean;
};

const regular: Profile = {
  composerReady: true,
  draftPresent: false,
  temporary: false,
  personalized: false,
  personalizationReady: false,
  instant: false,
  modelReady: true,
};
const temporaryProfile: Profile = {
  ...regular,
  temporary: true,
  personalizationReady: true,
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

// A scripted page and route the test drives by hand. `log` records every page
// script, navigation and delay in order; the clock moves only by delays.
function harness(
  input: {
    page?: Profile;
    afterLoad?: Profile;
    url?: string;
    deadline?: number;
    originalDocumentCurrent?: () => boolean;
    temporary?: boolean;
  } = {},
) {
  let clock = 1_000_000;
  let page: Profile = input.page ?? regular;
  const state: {
    -readonly [K in keyof InstantSurfaceSnapshot]: InstantSurfaceSnapshot[K];
  } = {
    surfaceCurrent: true,
    disposing: false,
    documentLoadFailed: false,
    documentAwaitingCommit: false,
    documentGeneration: 1,
    physicalDocumentGeneration: 1,
    operationGeneration: 0,
    url: input.url ?? HOME,
    frame: null,
  };
  const log: string[] = [];
  const deadlines: number[] = [];
  const reports: ChatGptProfilePreparationDiagnostic[] = [];
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
  const control = {
    navigateFails: false,
    reportThrows: false,
    onNavigate: () => {
      state.url = TEMPORARY;
      state.documentGeneration += 1;
      page = input.afterLoad ?? temporaryProfile;
    },
  };
  const taskDeadline = input.deadline ?? clock + 180_000;
  const prepare = createInstantProfilePreparer({
    execute: async (script, _gesture, deadline) => {
      const label = LABELS.get(script) ?? "unexpected";
      const count = (counts.get(label) ?? 0) + 1;
      counts.set(label, count);
      log.push(label);
      deadlines.push(deadline);
      const handler = handlers[label];
      if (!handler) throw new Error("Unexpected provider script");
      return handler(count);
    },
    navigate: async (url, deadline) => {
      log.push(`navigate ${url} ${deadline === taskDeadline}`);
      if (control.navigateFails) throw new Error("navigation failed");
      control.onNavigate();
    },
    snapshot: () => ({ ...state }),
    now: () => clock,
    delay: async (ms) => {
      log.push(`delay ${ms}`);
      clock += ms;
    },
    report: (diagnostic) => {
      reports.push(diagnostic);
      if (control.reportThrows) throw new Error("observer failed");
    },
  });
  return {
    state,
    log,
    deadlines,
    reports,
    handlers,
    control,
    setPage: (profile: Profile) => {
      page = profile;
    },
    run: () =>
      prepare({
        homeUrl: HOME,
        temporary: input.temporary ?? true,
        taskDeadline,
        originalDocumentCurrent: input.originalDocumentCurrent,
      }),
    count: (label: string) => counts.get(label) ?? 0,
  };
}

describe("preparing the temporary Instant profile", () => {
  it("walks the page in a fixed order and is ready only when every witness agrees", async () => {
    const h = harness();
    h.handlers.slider = (count) => ({ ready: true, atMinimum: count > 1 });
    h.handlers.lower = () => {
      h.setPage({ ...temporaryProfile, instant: true });
      return true;
    };
    await expect(h.run()).resolves.toBeNull();
    expect(h.log).toEqual([
      "probe",
      `navigate ${TEMPORARY} true`,
      "probe",
      "open-picker",
      "slider",
      "lower",
      "delay 80",
      "slider",
      "dismiss",
      "probe",
      "open-personalization",
      "select-personalization",
      "probe",
      "probe",
    ]);
    expect(h.reports).toEqual([]);
  });

  it("passes the task deadline to every script that does not carry its own", async () => {
    const h = harness({ deadline: 5_000_000 });
    h.handlers.lower = () => {
      h.setPage({ ...temporaryProfile, instant: true });
      return true;
    };
    h.handlers.slider = (count) => ({ ready: true, atMinimum: count > 1 });
    await h.run();
    expect(new Set(h.deadlines)).toEqual(new Set([5_000_000]));
  });

  it("neither opens a picker nor lowers a slider when Instant is already shown", async () => {
    const h = harness({
      page: { ...regular, instant: true },
      afterLoad: { ...temporaryProfile, instant: true },
    });
    await expect(h.run()).resolves.toBeNull();
    expect(h.count("open-picker")).toBe(0);
    expect(h.count("slider")).toBe(0);
    expect(h.count("lower")).toBe(0);
    expect(h.count("open-personalization")).toBe(1);
  });

  it("keeps an ordinary Instant profile free of personalization and reloads the home page", async () => {
    const h = harness({
      temporary: false,
      page: { ...regular, instant: true },
      afterLoad: { ...regular, instant: true },
    });
    await expect(h.run()).resolves.toBeNull();
    expect(h.log).toContain(`navigate ${HOME} true`);
    expect(h.count("open-personalization")).toBe(0);
    expect(h.count("select-personalization")).toBe(0);
  });

  it("does not reload a temporary chat that is already open", async () => {
    const h = harness({
      url: TEMPORARY,
      page: { ...temporaryProfile, instant: true },
    });
    h.state.frame = { identity: {}, isDestroyed: () => false, url: TEMPORARY };
    h.handlers["select-personalization"] = () => {
      h.setPage({ ...temporaryProfile, instant: true, personalized: true });
      return true;
    };
    await expect(h.run()).resolves.toBeNull();
    expect(h.log.some((entry) => entry.startsWith("navigate"))).toBe(false);
  });

  it("waits for an already open chat to turn temporary in 200 ms steps, then gives up at its own bound", async () => {
    const h = harness({ url: TEMPORARY, page: { ...regular, instant: true } });
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    const delays = h.log.filter((entry) => entry.startsWith("delay"));
    expect(delays.slice(0, 3)).toEqual(["delay 200", "delay 200", "delay 200"]);
    // 12 s bound: the last wait is shortened to what remains, never longer.
    expect(delays.every((entry) => Number(entry.slice(6)) <= 200)).toBe(true);
    expect(h.count("probe")).toBeGreaterThan(10);
    expect(h.log.some((entry) => entry.startsWith("navigate"))).toBe(false);
  });

  it.each([
    [
      "document",
      (h: ReturnType<typeof harness>) => (h.state.documentGeneration += 1),
    ],
    [
      "physical document",
      (h: ReturnType<typeof harness>) =>
        (h.state.physicalDocumentGeneration += 1),
    ],
    [
      "operation",
      (h: ReturnType<typeof harness>) => (h.state.operationGeneration += 1),
    ],
    [
      "surface",
      (h: ReturnType<typeof harness>) => (h.state.surfaceCurrent = false),
    ],
    ["disposal", (h: ReturnType<typeof harness>) => (h.state.disposing = true)],
    [
      "load failure",
      (h: ReturnType<typeof harness>) => (h.state.documentLoadFailed = true),
    ],
    [
      "pending commit",
      (h: ReturnType<typeof harness>) =>
        (h.state.documentAwaitingCommit = true),
    ],
    [
      "address",
      (h: ReturnType<typeof harness>) =>
        (h.state.url = "https://chatgpt.com/c/other"),
    ],
    [
      "frame",
      (h: ReturnType<typeof harness>) =>
        (h.state.frame = {
          identity: {},
          isDestroyed: () => false,
          url: TEMPORARY,
        }),
    ],
    [
      "destroyed frame",
      (h: ReturnType<typeof harness>) =>
        (h.state.frame = {
          identity: h.state.frame?.identity ?? {},
          isDestroyed: () => true,
          url: TEMPORARY,
        }),
    ],
  ])(
    "stops an already open chat's wait at once when its %s changes",
    async (_label, change) => {
      const h = harness({ url: TEMPORARY, page: regular });
      h.state.frame = {
        identity: {},
        isDestroyed: () => false,
        url: TEMPORARY,
      };
      h.handlers.probe = () => {
        change(h);
        return regular;
      };
      await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
      expect(h.log).toEqual(["probe"]);
    },
  );

  it("stops at once with a draft, before any page change", async () => {
    const h = harness({ page: { ...regular, draftPresent: true } });
    await expect(h.run()).resolves.toBe("CHATGPT_COMPOSER_DRAFT_PRESENT");
    expect(h.log).toEqual(["probe"]);
  });

  it("refuses an unrecognized first read without touching the page again", async () => {
    const h = harness();
    h.handlers.probe = () => ({ unexpected: true });
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.log).toEqual(["probe"]);
  });

  it("treats a failing probe as unrecognized, never as ready", async () => {
    const h = harness();
    h.handlers.probe = () => {
      throw new Error("probe failed");
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.log).toEqual(["probe"]);
  });

  it("refuses without any page script when the original document is already gone", async () => {
    const h = harness({ originalDocumentCurrent: () => false });
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.log).toEqual([]);
  });

  it("stops before navigating when the original document is lost after the first read", async () => {
    let current = true;
    const h = harness({ originalDocumentCurrent: () => current });
    h.handlers.probe = () => {
      current = false;
      return regular;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.log).toEqual(["probe"]);
  });

  it("answers a failed navigation as a missing temporary chat and does not retry it", async () => {
    const h = harness();
    h.control.navigateFails = true;
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.log.filter((entry) => entry.startsWith("navigate"))).toHaveLength(
      1,
    );
    expect(h.count("probe")).toBe(1);
  });

  it("stops when the surface is gone after the navigation", async () => {
    const h = harness();
    h.control.onNavigate = () => {
      h.state.surfaceCurrent = false;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.count("probe")).toBe(1);
  });

  it("waits 200 ms between readiness reads until the model is ready, then proceeds", async () => {
    const h = harness();
    let reads = 0;
    h.handlers.probe = () => {
      reads += 1;
      if (reads === 1) return regular;
      if (reads <= 3) return { ...temporaryProfile, modelReady: false };
      return { ...temporaryProfile, instant: true, personalized: true };
    };
    await expect(h.run()).resolves.toBeNull();
    expect(h.log.filter((entry) => entry.startsWith("delay"))).toEqual([
      "delay 200",
      "delay 200",
    ]);
  });

  it("gives up on a model that never becomes ready, after the 12 s bound", async () => {
    const h = harness();
    let reads = 0;
    h.handlers.probe = () =>
      ++reads === 1 ? regular : { ...temporaryProfile, modelReady: false };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(
      h.log.filter((entry) => entry === "delay 200").length,
    ).toBeGreaterThanOrEqual(50);
    expect(h.count("open-picker")).toBe(0);
  });

  it("rebinds to the in-place navigation hydration produced before any interaction", async () => {
    const h = harness({ page: { ...regular, instant: true } });
    let reads = 0;
    h.handlers.probe = () => {
      reads += 1;
      if (reads === 2) h.state.documentGeneration += 1;
      if (reads === 1) return regular;
      return { ...temporaryProfile, instant: true, personalized: true };
    };
    await expect(h.run()).resolves.toBeNull();
    expect(reads).toBe(4);
  });

  it("refuses with a diagnostic when the document changes before any interaction", async () => {
    const h = harness();
    h.state.operationGeneration = 0;
    let reads = 0;
    h.handlers.probe = () => {
      reads += 1;
      if (reads === 2) h.state.operationGeneration = 1;
      return reads === 1 ? regular : temporaryProfile;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("open-picker")).toBe(0);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "hydrate",
      expectedTemporary: true,
      operationChanged: true,
      logicalDocumentChanged: false,
      surfaceChanged: false,
      sliderReady: false,
      sliderAtMinimum: false,
    });
  });
});

describe("opening the Instant power picker", () => {
  it("retries only a reported not-clicked result, 100 ms apart", async () => {
    const h = harness();
    h.handlers["open-picker"] = (count) => count >= 3;
    h.handlers.dismiss = () => {
      h.setPage({ ...temporaryProfile, instant: true });
      return true;
    };
    await expect(h.run()).resolves.toBeNull();
    expect(h.count("open-picker")).toBe(3);
    expect(h.log.slice(h.log.indexOf("open-picker")).slice(0, 5)).toEqual([
      "open-picker",
      "delay 100",
      "open-picker",
      "delay 100",
      "open-picker",
    ]);
  });

  it("never repeats the opener after an unrecognized answer", async () => {
    const h = harness();
    h.handlers["open-picker"] = () => "clicked?";
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("open-picker")).toBe(1);
    expect(h.count("slider")).toBe(0);
    expect(h.reports[0]).toMatchObject({ stage: "picker" });
  });

  it("never repeats the opener after it throws", async () => {
    const h = harness();
    h.handlers["open-picker"] = () => {
      throw new Error("script failed");
    };
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("open-picker")).toBe(1);
  });

  it("gives up after the 2 s window of not-clicked answers", async () => {
    const h = harness();
    h.handlers["open-picker"] = () => false;
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("open-picker")).toBe(20);
    expect(h.count("slider")).toBe(0);
  });

  it("stops without another script when the document changes under the click", async () => {
    const h = harness();
    h.handlers["open-picker"] = () => {
      h.state.documentGeneration += 1;
      return true;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("slider")).toBe(0);
    expect(h.reports[0]).toMatchObject({
      stage: "picker",
      logicalDocumentChanged: true,
    });
  });

  it("reports a lost surface, a changed URL and a changed physical document apart", async () => {
    const h = harness();
    h.handlers["open-picker"] = () => {
      h.state.surfaceCurrent = false;
      h.state.url = "https://chatgpt.com/c/other";
      h.state.physicalDocumentGeneration += 1;
      return true;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.reports[0]).toMatchObject({
      surfaceChanged: true,
      urlChanged: true,
      physicalDocumentChanged: true,
      logicalDocumentChanged: false,
      operationChanged: false,
    });
  });

  it("still refuses when the diagnostic observer throws", async () => {
    const h = harness();
    h.control.reportThrows = true;
    h.handlers["open-picker"] = () => "clicked?";
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.reports).toHaveLength(1);
  });
});

describe("lowering the Instant power slider", () => {
  it("waits for a slider that is not ready, 100 ms apart, then lowers it", async () => {
    const h = harness();
    let sliders = 0;
    h.handlers.slider = () => {
      sliders += 1;
      if (sliders <= 2) return { ready: false };
      return { ready: true, atMinimum: sliders >= 4 };
    };
    h.handlers.lower = () => {
      h.setPage({ ...temporaryProfile, instant: true });
      return true;
    };
    await expect(h.run()).resolves.toBeNull();
    const slice = h.log.slice(h.log.indexOf("slider"));
    expect(slice.slice(0, 7)).toEqual([
      "slider",
      "delay 100",
      "slider",
      "delay 100",
      "slider",
      "lower",
      "delay 80",
    ]);
    expect(h.count("lower")).toBe(1);
  });

  it("refuses a slider that never becomes ready and never lowers it", async () => {
    const h = harness();
    h.handlers.slider = () => ({ ready: false });
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("lower")).toBe(0);
    expect(h.reports[0]).toMatchObject({ stage: "slider", sliderReady: false });
  });

  it("refuses an unrecognized slider answer without lowering", async () => {
    const h = harness();
    h.handlers.slider = () => "ready";
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("lower")).toBe(0);
    expect(h.count("open-picker")).toBe(1);
  });

  it("refuses when lowering is not acknowledged, and does not lower again", async () => {
    const h = harness();
    h.handlers.slider = () => ({ ready: true, atMinimum: false });
    h.handlers.lower = () => false;
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("lower")).toBe(1);
    expect(h.count("dismiss")).toBe(0);
  });

  it("refuses after eight attempts that never reach the minimum", async () => {
    const h = harness();
    h.handlers.slider = () => ({ ready: true, atMinimum: false });
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("slider")).toBe(8);
    expect(h.count("lower")).toBe(8);
    expect(h.count("dismiss")).toBe(0);
    expect(h.reports[0]).toMatchObject({
      stage: "slider",
      sliderReady: true,
      sliderAtMinimum: false,
    });
  });

  it("refuses an unacknowledged dismissal", async () => {
    const h = harness();
    h.handlers.dismiss = () => false;
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.count("probe")).toBe(2);
  });

  it("waits up to 2 s for Instant to show after the slider, then refuses", async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.reports[0]).toMatchObject({ stage: "selected-model" });
    const waits = h.log.filter((entry) => entry === "delay 100");
    expect(waits).toHaveLength(20);
    expect(h.count("open-personalization")).toBe(0);
  });
});

describe("choosing Personalized", () => {
  const instantReady = { ...temporaryProfile, instant: true };

  it("repeats only the selection, 100 ms apart, never the opener", async () => {
    const h = harness({ page: instantReady, afterLoad: instantReady });
    h.handlers["select-personalization"] = (count) => {
      if (count < 3) return false;
      h.setPage({ ...instantReady, personalized: true });
      return true;
    };
    await expect(h.run()).resolves.toBeNull();
    expect(h.count("open-personalization")).toBe(1);
    expect(h.count("select-personalization")).toBe(3);
  });

  it("gives up after ten unacknowledged selections", async () => {
    const h = harness({ page: instantReady, afterLoad: instantReady });
    h.handlers["select-personalization"] = () => false;
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.count("open-personalization")).toBe(1);
    expect(h.count("select-personalization")).toBe(10);
  });

  it("selects nothing when the opener is not acknowledged", async () => {
    const h = harness({ page: instantReady, afterLoad: instantReady });
    h.handlers["open-personalization"] = () => undefined;
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.count("select-personalization")).toBe(0);
  });

  it("does not repeat the opener after it throws", async () => {
    const h = harness({ page: instantReady, afterLoad: instantReady });
    h.handlers["open-personalization"] = () => {
      throw new Error("script failed");
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.count("open-personalization")).toBe(1);
  });

  it("waits for the personalization controls, then refuses if they never appear", async () => {
    const waiting = { ...instantReady, personalizationReady: false };
    const h = harness({ page: waiting, afterLoad: waiting });
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.count("open-personalization")).toBe(0);
    expect(h.log.filter((entry) => entry === "delay 100")).toHaveLength(20);
  });

  it("answers an Instant model that went missing at the last read as a model refusal", async () => {
    const h = harness({
      page: { ...instantReady, personalized: true },
      afterLoad: { ...instantReady, personalized: true },
    });
    let reads = 0;
    h.handlers.probe = () =>
      ++reads >= 3
        ? { ...instantReady, personalized: true, instant: false }
        : { ...instantReady, personalized: true };
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
  });

  it("is not ready when the document is replaced before the last read counts", async () => {
    const h = harness({
      page: { ...instantReady, personalized: true },
      afterLoad: { ...instantReady, personalized: true },
    });
    let reads = 0;
    h.handlers.probe = () => {
      reads += 1;
      if (reads === 3) h.state.url = "https://chatgpt.com/c/other";
      return { ...instantReady, personalized: true };
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
  });
});
