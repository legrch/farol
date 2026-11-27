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
import { TaskScriptNotDispatchedError } from "./observe";
import {
  createInstantProfilePreparer,
  instantProfileRefusalReasons,
  type ChatGptProfilePreparationDiagnostic,
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

// The route's plain facts, which a test changes by hand, and the frame as plain
// data. The harness hands the preparer functions over them (see `snapshot`).
type HarnessState = {
  surfaceCurrent: boolean;
  disposing: boolean;
  documentLoadFailed: boolean;
  documentAwaitingCommit: boolean;
  documentGeneration: number;
  physicalDocumentGeneration: number;
  operationGeneration: number;
  url: string;
  frame: { identity: object; isDestroyed: () => boolean; url: string } | null;
};

// What a real destroyed window or frame does on access: it throws. A test sets
// `control.throwsOn` to make a read throw from then on; `reads` records every
// read in order, so a read made too early is visible.
type Read = "url" | "frame" | "frame.url";

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
  const state: HarnessState = {
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
  const reads: Read[] = [];
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
    throwsOn: (_read: Read) => false,
    onDelay: () => {},
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
    snapshot: () => {
      const read = <T>(what: Read, value: () => T): T => {
        reads.push(what);
        if (control.throwsOn(what)) throw new Error(`${what} is gone`);
        return value();
      };
      return {
        surfaceCurrent: state.surfaceCurrent,
        disposing: state.disposing,
        documentLoadFailed: state.documentLoadFailed,
        documentAwaitingCommit: state.documentAwaitingCommit,
        documentGeneration: state.documentGeneration,
        physicalDocumentGeneration: state.physicalDocumentGeneration,
        operationGeneration: state.operationGeneration,
        url: () => read("url", () => state.url),
        frame: () =>
          read("frame", () => {
            const frame = state.frame;
            return frame
              ? {
                  identity: frame.identity,
                  isDestroyed: () => frame.isDestroyed(),
                  url: () => read("frame.url", () => frame.url),
                }
              : null;
          }),
      };
    },
    now: () => clock,
    delay: async (ms) => {
      log.push(`delay ${ms}`);
      clock += ms;
      control.onDelay();
    },
    report: (diagnostic) => {
      reports.push(diagnostic);
      if (control.reportThrows) throw new Error("observer failed");
    },
  });
  return {
    state,
    log,
    reads,
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

// A preparation that is only waiting for the page has issued nothing but
// reads of the page and waits: no navigation, no click.
const onlyReadsAndWaits = (log: readonly string[]) =>
  log.every((entry) => entry === "probe" || entry.startsWith("delay "));

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
    expect(h.reports[0]).toMatchObject({
      stage: "initial",
      reason: "not_temporary",
      elapsedMs: 12_000,
    });
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
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "initial",
      code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
      reason: "draft_present",
    });
  });

  it("keeps reading an unrecognized probe within the bound and then refuses, touching nothing else", async () => {
    const h = harness();
    h.handlers.probe = () => ({ unexpected: true });
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(onlyReadsAndWaits(h.log)).toBe(true);
    expect(h.count("probe")).toBeGreaterThan(10);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "initial",
      code: "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      reason: "read_failed",
      elapsedMs: 12_000,
    });
  });

  it("treats a failing probe as unrecognized, never as ready", async () => {
    const h = harness();
    h.handlers.probe = () => {
      throw new Error("probe failed");
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(onlyReadsAndWaits(h.log)).toBe(true);
    expect(h.reports[0]).toMatchObject({ reason: "read_failed" });
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
    expect(h.reports[0]).toMatchObject({
      stage: "hydrate",
      code: "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      reason: "model_not_ready",
    });
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

describe("waiting for a page that is still loading", () => {
  const instantTemporary = { ...temporaryProfile, instant: true };

  // The page the first reads see while it loads; afterwards the harness page.
  function loading(
    h: ReturnType<typeof harness>,
    reads: number,
    answer: () => unknown,
  ) {
    const ready = h.handlers.probe;
    if (!ready) throw new Error("harness has no probe handler");
    h.handlers.probe = (count) => (count <= reads ? answer() : ready(count));
  }

  it("keeps waiting while the composer is not ready, then goes on", async () => {
    const h = harness({
      page: regular,
      afterLoad: instantTemporary,
    });
    loading(h, 3, () => ({ ...regular, composerReady: false }));
    await expect(h.run()).resolves.toBeNull();
    expect(h.log.slice(0, 7)).toEqual([
      "probe",
      "delay 200",
      "probe",
      "delay 200",
      "probe",
      "delay 200",
      "probe",
    ]);
    expect(h.log.filter((entry) => entry.startsWith("navigate"))).toHaveLength(
      1,
    );
    expect(h.reports).toEqual([]);
  });

  it("keeps waiting while the probe throws, then goes on", async () => {
    const h = harness({ page: regular, afterLoad: instantTemporary });
    loading(h, 2, () => {
      throw new Error("not hydrated");
    });
    await expect(h.run()).resolves.toBeNull();
    expect(h.log.slice(0, 4)).toEqual([
      "probe",
      "delay 200",
      "probe",
      "delay 200",
    ]);
    expect(h.reports).toEqual([]);
  });

  it("keeps waiting while the probe answers something unrecognized, then goes on", async () => {
    const h = harness({ page: regular, afterLoad: instantTemporary });
    loading(h, 2, () => ({ unexpected: true }));
    await expect(h.run()).resolves.toBeNull();
    expect(h.count("probe")).toBeGreaterThan(2);
    expect(h.reports).toEqual([]);
  });

  it("waits for an already open temporary chat whose composer is not ready, then goes on", async () => {
    const h = harness({ url: TEMPORARY, page: instantTemporary });
    h.state.frame = { identity: {}, isDestroyed: () => false, url: TEMPORARY };
    loading(h, 2, () => ({ ...instantTemporary, composerReady: false }));
    await expect(h.run()).resolves.toBeNull();
    expect(h.count("probe")).toBeGreaterThanOrEqual(3);
    expect(h.log.some((entry) => entry.startsWith("navigate"))).toBe(false);
  });

  it("refuses at the 12 s bound for a composer that never becomes ready, with nothing sent or changed", async () => {
    const h = harness({ page: regular });
    h.handlers.probe = () => ({ ...regular, composerReady: false });
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(onlyReadsAndWaits(h.log)).toBe(true);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "initial",
      code: "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      reason: "composer_not_ready",
      elapsedMs: 12_000,
    });
  });

  it("is bound by a task deadline that is nearer than 12 s", async () => {
    const h = harness({ page: regular, deadline: 1_003_000 });
    h.handlers.probe = () => ({ ...regular, composerReady: false });
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.reports[0]).toMatchObject({
      reason: "composer_not_ready",
      elapsedMs: 3_000,
    });
  });

  it("refuses with reason deadline when the bound has passed before any read", async () => {
    const h = harness({ deadline: 1_000_000 });
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.log).toEqual([]);
    expect(h.reports[0]).toMatchObject({
      stage: "initial",
      reason: "deadline",
    });
  });

  it("refuses a draft at once, even in the middle of the wait, as a draft", async () => {
    const h = harness({ page: regular });
    h.handlers.probe = (count) =>
      count <= 2
        ? { ...regular, composerReady: false }
        : { ...regular, draftPresent: true };
    await expect(h.run()).resolves.toBe("CHATGPT_COMPOSER_DRAFT_PRESENT");
    expect(h.count("probe")).toBe(3);
    expect(onlyReadsAndWaits(h.log)).toBe(true);
    expect(h.reports[0]).toMatchObject({ reason: "draft_present" });
  });

  it("refuses at once when the original document is replaced while waiting", async () => {
    let current = true;
    const h = harness({
      page: regular,
      originalDocumentCurrent: () => current,
    });
    h.handlers.probe = (count) => {
      if (count === 2) current = false;
      return { ...regular, composerReady: false };
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.count("probe")).toBe(2);
    expect(h.reports[0]).toMatchObject({
      stage: "initial",
      reason: "document_replaced",
    });
  });

  it("refuses at once when the surface is lost while waiting for a chat that will be navigated", async () => {
    const h = harness({ page: regular });
    h.handlers.probe = (count) => {
      if (count === 2) h.state.surfaceCurrent = false;
      return { ...regular, composerReady: false };
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.count("probe")).toBe(2);
    expect(h.reports[0]).toMatchObject({
      reason: "surface_not_current",
      surfaceChanged: true,
    });
  });
});

// Every refusal says why, with one closed value and never page content. Each
// row drives one branch of the preparation and names the reason it must give.
describe("the reason every refusal reports", () => {
  const instantTemporary = { ...temporaryProfile, instant: true };
  type Harness = ReturnType<typeof harness>;
  const openFrame = (h: Harness) => {
    h.state.frame = { identity: {}, isDestroyed: () => false, url: TEMPORARY };
  };

  const rows: readonly [
    string,
    () => Harness,
    (h: Harness) => void,
    string,
    ChatGptProfilePreparationDiagnostic["stage"],
    string,
  ][] = [
    [
      "an unreadable first probe",
      () => harness(),
      (h) => {
        h.handlers.probe = () => ({ unexpected: true });
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "initial",
      "read_failed",
    ],
    [
      "a composer that is not ready",
      () => harness(),
      (h) => {
        h.handlers.probe = () => ({ ...regular, composerReady: false });
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "initial",
      "composer_not_ready",
    ],
    [
      "a bound that has passed",
      () => harness({ deadline: 1_000_000 }),
      () => {},
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "initial",
      "deadline",
    ],
    [
      "an open chat that never turns temporary",
      () => harness({ url: TEMPORARY, page: { ...regular, instant: true } }),
      openFrame,
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "initial",
      "not_temporary",
    ],
    [
      "an open chat whose address changes",
      () => harness({ url: TEMPORARY, page: regular }),
      (h) => {
        openFrame(h);
        h.handlers.probe = () => {
          h.state.url = "https://chatgpt.com/c/other";
          return regular;
        };
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "initial",
      "identity_lost",
    ],
    [
      "an open chat whose document is replaced",
      () => harness({ url: TEMPORARY, page: regular }),
      (h) => {
        openFrame(h);
        h.handlers.probe = () => {
          h.state.documentGeneration += 1;
          return regular;
        };
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "initial",
      "identity_lost",
    ],
    [
      "a draft in the composer",
      () => harness({ page: { ...regular, draftPresent: true } }),
      () => {},
      "CHATGPT_COMPOSER_DRAFT_PRESENT",
      "initial",
      "draft_present",
    ],
    [
      "an original document that is gone",
      () => harness({ originalDocumentCurrent: () => false }),
      () => {},
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "initial",
      "document_replaced",
    ],
    [
      "a navigation that fails",
      () => harness(),
      (h) => {
        h.control.navigateFails = true;
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "navigate",
      "navigation_failed",
    ],
    [
      "a surface that is gone after the navigation",
      () => harness(),
      (h) => {
        h.control.onNavigate = () => {
          h.state.surfaceCurrent = false;
        };
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "navigate",
      "surface_not_current",
    ],
    [
      "a model that never becomes ready",
      () => harness({ afterLoad: { ...temporaryProfile, modelReady: false } }),
      () => {},
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "hydrate",
      "model_not_ready",
    ],
    [
      "a chat that is not temporary after the navigation",
      () => harness({ afterLoad: regular }),
      () => {},
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "hydrate",
      "not_temporary",
    ],
    [
      "a draft that appears after the navigation",
      () => harness({ afterLoad: { ...temporaryProfile, draftPresent: true } }),
      () => {},
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "hydrate",
      "draft_present",
    ],
    [
      "a picker that is not opened",
      () => harness(),
      (h) => {
        h.handlers["open-picker"] = () => false;
      },
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "picker",
      "picker_not_opened",
    ],
    [
      "a picker script that throws",
      () => harness(),
      (h) => {
        h.handlers["open-picker"] = () => {
          throw new Error("script failed");
        };
      },
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "picker",
      "script_failed",
    ],
    [
      "a document replaced under the click",
      () => harness(),
      (h) => {
        h.handlers["open-picker"] = () => {
          h.state.operationGeneration += 1;
          return true;
        };
      },
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "picker",
      "identity_lost",
    ],
    [
      "a slider that is not ready",
      () => harness(),
      (h) => {
        h.handlers.slider = () => ({ ready: false });
      },
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "slider",
      "slider_not_ready",
    ],
    [
      "a slider that never reaches the minimum",
      () => harness(),
      (h) => {
        h.handlers.slider = () => ({ ready: true, atMinimum: false });
      },
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "slider",
      "slider_not_minimum",
    ],
    [
      "a dismissal that is not acknowledged",
      () => harness(),
      (h) => {
        h.handlers.dismiss = () => false;
      },
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "slider",
      "picker_not_dismissed",
    ],
    [
      "an Instant model that does not show",
      () => harness(),
      () => {},
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "selected-model",
      "instant_not_selected",
    ],
    [
      "personalization controls that never appear",
      () =>
        harness({
          page: instantTemporary,
          afterLoad: { ...instantTemporary, personalizationReady: false },
        }),
      () => {},
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "personalization",
      "personalization_not_ready",
    ],
    [
      "a personalization that is never selected",
      () => harness({ page: instantTemporary, afterLoad: instantTemporary }),
      (h) => {
        h.handlers["select-personalization"] = () => false;
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "personalization",
      "personalization_not_selected",
    ],
    [
      "a personalization opener that throws",
      () => harness({ page: instantTemporary, afterLoad: instantTemporary }),
      (h) => {
        h.handlers["open-personalization"] = () => {
          throw new Error("script failed");
        };
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "personalization",
      "script_failed",
    ],
    [
      "an Instant model that is gone at the last read",
      () =>
        harness({
          page: { ...instantTemporary, personalized: true },
          afterLoad: { ...instantTemporary, personalized: true },
        }),
      (h) => {
        let reads = 0;
        h.handlers.probe = () =>
          ++reads >= 3
            ? { ...instantTemporary, personalized: true, instant: false }
            : { ...instantTemporary, personalized: true };
      },
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "final",
      "instant_not_selected",
    ],
    [
      "a document replaced before the last read counts",
      () =>
        harness({
          page: { ...instantTemporary, personalized: true },
          afterLoad: { ...instantTemporary, personalized: true },
        }),
      (h) => {
        let reads = 0;
        h.handlers.probe = () => {
          if (++reads === 3) h.state.url = "https://chatgpt.com/c/other";
          return { ...instantTemporary, personalized: true };
        };
      },
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "final",
      "identity_lost",
    ],
  ];

  it.each(rows)(
    "%s reports its own reason",
    async (_label, build, arrange, code, stage, reason) => {
      const h = build();
      arrange(h);
      await expect(h.run()).resolves.toBe(code);
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]).toMatchObject({ stage, code, reason });
    },
  );

  it("reports the original document replaced after the first read as such", async () => {
    let current = true;
    const h = harness({ originalDocumentCurrent: () => current });
    h.handlers.probe = () => {
      current = false;
      return regular;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.reports[0]).toMatchObject({ reason: "document_replaced" });
  });

  it("uses only the closed reasons, never page content, and still refuses when the observer throws", async () => {
    const seen = new Set<string>();
    for (const [, build, arrange] of rows) {
      const h = build();
      arrange(h);
      h.control.reportThrows = true;
      await h.run();
      for (const report of h.reports) {
        seen.add(report.reason);
        expect(instantProfileRefusalReasons).toContain(report.reason);
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain("chatgpt.com");
        expect(serialized).not.toContain("temporary-chat");
      }
    }
    expect([...seen].sort()).toEqual(
      [...new Set(rows.map((row) => row[5]))].sort(),
    );
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

  // The runner's refusal to issue a script is one more rejection to this
  // caller: it reads it exactly as it reads any other failed script.
  it.each(["document", "deadline"] as const)(
    "reads a not-dispatched %s refusal like any other failed script",
    async (reason) => {
      const generic = harness();
      generic.handlers["open-picker"] = () => {
        throw new Error("script failed");
      };
      const refused = harness();
      refused.handlers["open-picker"] = () => {
        throw new TaskScriptNotDispatchedError(reason);
      };
      await expect(refused.run()).resolves.toBe(await generic.run());
      expect(refused.log).toEqual(generic.log);
      expect(refused.reports).toEqual(generic.reports);
    },
  );

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

// A destroyed window or frame throws on access. These tests make every read of
// the address and the frame throw from the moment the window is lost, and then
// require the refusal the preparation always gave: the cheap identity facts are
// asked first, and the address or frame is read only where that order allows.
describe("preparing the profile when the window or frame is already gone", () => {
  // Marks the reads so far, then makes the window unreadable.
  function closeWindow(h: ReturnType<typeof harness>) {
    const mark = h.reads.length;
    h.state.surfaceCurrent = false;
    h.control.throwsOn = () => true;
    return mark;
  }

  it("refuses the temporary chat when the window closes during the wait for an open one", async () => {
    const h = harness({ url: TEMPORARY, page: regular });
    h.state.frame = {
      identity: {},
      isDestroyed: () => false,
      url: TEMPORARY,
    };
    let mark = -1;
    h.control.onDelay = () => {
      mark = closeWindow(h);
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(mark).toBeGreaterThan(-1);
    expect(h.reads.slice(mark)).toEqual([]);
  });

  it("does not read the address of a frame that is destroyed", async () => {
    const h = harness({ url: TEMPORARY, page: regular });
    h.state.frame = {
      identity: {},
      isDestroyed: () => false,
      url: TEMPORARY,
    };
    const frame = h.state.frame;
    let mark = -1;
    h.handlers.probe = () => {
      mark = h.reads.length;
      frame.isDestroyed = () => true;
      h.control.throwsOn = (what) => what === "frame.url";
      return regular;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.reads.slice(mark)).toEqual(["url", "frame"]);
  });

  it("refuses the temporary chat when the window closes during the navigation", async () => {
    const h = harness();
    let mark = -1;
    h.control.onNavigate = () => {
      mark = closeWindow(h);
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(h.reads.slice(mark)).toEqual([]);
  });

  it("refuses the temporary chat when the window closes during a hydration delay", async () => {
    const h = harness({
      afterLoad: { ...temporaryProfile, modelReady: false },
    });
    let mark = -1;
    h.control.onDelay = () => {
      mark = closeWindow(h);
    };
    await expect(h.run()).resolves.toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(mark).toBeGreaterThan(-1);
    expect(h.reads.slice(mark)).toEqual([]);
  });

  it("does not read the address once hydration sees the window lost, and still refuses Instant", async () => {
    const h = harness({ afterLoad: temporaryProfile });
    const probe = h.handlers.probe;
    if (!probe) throw new Error("harness has no probe handler");
    let mark = -1;
    h.handlers.probe = (count) => {
      const answer = probe(count);
      if (h.log.some((entry) => entry.startsWith("navigate")))
        mark = closeWindow(h);
      return answer;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    // The diagnostic does not ask a lost window for its address either.
    expect(h.reads.slice(mark)).toEqual([]);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      reason: "surface_not_current",
      surfaceChanged: true,
      urlChanged: true,
    });
  });

  it("refuses Instant, with a report that reads nothing, when the window closes while the picker opens", async () => {
    const h = harness({ afterLoad: temporaryProfile });
    let mark = -1;
    h.handlers["open-picker"] = () => {
      mark = closeWindow(h);
      return true;
    };
    await expect(h.run()).resolves.toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "picker",
      reason: "surface_not_current",
    });
    expect(h.reads.slice(mark)).toEqual([]);
    expect(h.count("slider")).toBe(0);
  });

  it("lets an unreadable address at the very start end the preparation as a thrown error", async () => {
    const h = harness({ url: TEMPORARY, page: regular });
    h.control.throwsOn = () => true;
    await expect(h.run()).rejects.toThrow("url is gone");
  });
});
