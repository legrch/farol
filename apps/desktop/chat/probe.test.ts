import { describe, expect, it } from "vitest";
import { MAX_PREPARED_COMPOSER_CHARACTERS } from "../../../src/apps/desktop/chatgpt/scripts";
import {
  activatedControlSchema,
  activatedTaskSchema,
  activityProbeSchema,
  appBindingSchema,
  instantPowerSliderSchema,
  preparedTaskSchema,
  probeSchema,
  taskProbeSchema,
  temporaryInstantProfileSchema,
} from "./probe";

const accepts =
  (schema: { safeParse(value: unknown): { success: boolean } }) =>
  (value: unknown) =>
    schema.safeParse(value).success;

describe("the readiness probe", () => {
  const ok = accepts(probeSchema);

  it("takes exactly the two flags", () => {
    expect(ok({ composerVisible: true, signInVisible: false })).toBe(true);
    expect(ok({ composerVisible: true })).toBe(false);
    expect(ok({ composerVisible: 1, signInVisible: false })).toBe(false);
    expect(
      ok({ composerVisible: true, signInVisible: false, extra: true }),
    ).toBe(false);
  });
});

describe("the prepared task reply", () => {
  const parse = (value: unknown) => preparedTaskSchema.safeParse(value);
  const prepared = {
    ready: true,
    baselineAssistantCount: 0,
    baselineUserCount: 1,
  };

  it("accepts each in-page refusal as its own closed shape", () => {
    for (const refusal of [
      { navigated: true },
      { appSelectionLost: true },
      { draftPresent: true },
    ]) {
      expect(parse(refusal).success).toBe(true);
    }
    expect(parse({ navigated: false }).success).toBe(false);
    expect(parse({ navigated: true, ready: true }).success).toBe(false);
  });

  it("defaults the baseline message ids to none", () => {
    const parsed = parse(prepared);
    expect(parsed.success && parsed.data).toEqual({
      ...prepared,
      baselineMessageIds: [],
    });
  });

  it("keeps the prepared composer text within the prompt limit", () => {
    const text = (length: number) => ({
      ...prepared,
      preparedComposerText: "x".repeat(length),
    });
    expect(parse(text(MAX_PREPARED_COMPOSER_CHARACTERS)).success).toBe(true);
    expect(parse(text(MAX_PREPARED_COMPOSER_CHARACTERS + 1)).success).toBe(
      false,
    );
  });

  it("bounds the baseline counts and ids", () => {
    expect(parse({ ...prepared, baselineUserCount: -1 }).success).toBe(false);
    expect(parse({ ...prepared, baselineAssistantCount: 1.5 }).success).toBe(
      false,
    );
    expect(
      parse({ ...prepared, baselineMessageIds: ["a".repeat(256)] }).success,
    ).toBe(true);
    expect(
      parse({ ...prepared, baselineMessageIds: ["a".repeat(257)] }).success,
    ).toBe(false);
    expect(parse({ ...prepared, baselineMessageIds: [""] }).success).toBe(
      false,
    );
    expect(
      parse({
        ...prepared,
        baselineMessageIds: Array.from({ length: 512 }, (_, i) => `m${i}`),
      }).success,
    ).toBe(true);
    expect(
      parse({
        ...prepared,
        baselineMessageIds: Array.from({ length: 513 }, (_, i) => `m${i}`),
      }).success,
    ).toBe(false);
  });
});

describe("the send acknowledgement", () => {
  it("is a control click, or one of the in-page refusals", () => {
    const ok = accepts(activatedTaskSchema);
    expect(ok({ activated: true })).toBe(true);
    expect(ok({ activated: false })).toBe(true);
    expect(ok({ navigated: true })).toBe(true);
    expect(ok({ appSelectionLost: true })).toBe(true);
    expect(ok({ profileLost: true })).toBe(true);
    expect(ok({ draftPresent: true })).toBe(true);
    expect(ok({ profileLost: false })).toBe(false);
    expect(ok({ activated: true, navigated: true })).toBe(false);
    expect(ok({})).toBe(false);
  });

  it("takes the stop control's acknowledgement as exactly one flag", () => {
    const ok = accepts(activatedControlSchema);
    expect(ok({ activated: true })).toBe(true);
    expect(ok({ navigated: true })).toBe(false);
    expect(ok({ activated: true, extra: 1 })).toBe(false);
  });
});

describe("the task probe", () => {
  const base = {
    assistantCount: 1,
    assistantCharacters: 5,
    assistantText: "hello",
    userCount: 1,
    turnUserId: "u1",
    turnAssistantId: null,
    busy: false,
    sendVisible: true,
    signInVisible: false,
    errorVisible: false,
  };
  const parse = (value: unknown) => taskProbeSchema.safeParse(value);

  it("defaults the error kind to none and leaves the public frame absent", () => {
    const parsed = parse(base);
    expect(parsed.success && parsed.data.errorKind).toBe("none");
    expect(parsed.success && parsed.data.publicFrame).toBeUndefined();
  });

  it("knows only the three error kinds", () => {
    for (const errorKind of ["none", "usage_limited", "generic"])
      expect(parse({ ...base, errorKind }).success).toBe(true);
    expect(parse({ ...base, errorKind: "other" }).success).toBe(false);
  });

  it("bounds the visible assistant text and the turn ids", () => {
    const text = (length: number) => ({
      ...base,
      assistantText: "x".repeat(length),
    });
    expect(parse(text(256 * 1_024)).success).toBe(true);
    expect(parse(text(256 * 1_024 + 1)).success).toBe(false);
    expect(parse({ ...base, turnUserId: "" }).success).toBe(false);
    expect(parse({ ...base, turnUserId: "u".repeat(257) }).success).toBe(false);
    expect(parse({ ...base, turnAssistantId: "a".repeat(256) }).success).toBe(
      true,
    );
  });

  it("refuses negative or fractional counts and unknown keys", () => {
    expect(parse({ ...base, assistantCount: -1 }).success).toBe(false);
    expect(parse({ ...base, userCount: 0.5 }).success).toBe(false);
    expect(parse({ ...base, assistantCharacters: -2 }).success).toBe(false);
    expect(parse({ ...base, extra: true }).success).toBe(false);
  });

  it("validates a supplied public frame with the public-turn schema", () => {
    expect(
      parse({
        ...base,
        publicFrame: { userId: "u1", messages: [], terminal: false },
      }).success,
    ).toBe(true);
    expect(parse({ ...base, publicFrame: {} }).success).toBe(false);
  });
});

describe("the activity probe", () => {
  it("is exactly the running flag", () => {
    const ok = accepts(activityProbeSchema);
    expect(ok({ running: false })).toBe(true);
    expect(ok({ running: "yes" })).toBe(false);
    expect(ok({ running: true, extra: 1 })).toBe(false);
  });
});

describe("the app binding reply", () => {
  const ok = accepts(appBindingSchema);

  it("is bound, navigated, or blocked for a known reason", () => {
    expect(ok({ state: "bound" })).toBe(true);
    expect(ok({ state: "navigated" })).toBe(true);
    for (const reason of [
      "missing",
      "ambiguous",
      "conflict",
      "draft_present",
      "selection_not_observed",
    ])
      expect(ok({ state: "blocked", reason })).toBe(true);
  });

  it("refuses an unknown state, an unknown reason and a stray reason", () => {
    expect(ok({ state: "unbound" })).toBe(false);
    expect(ok({ state: "blocked" })).toBe(false);
    expect(ok({ state: "blocked", reason: "lost" })).toBe(false);
    expect(ok({ state: "bound", reason: "missing" })).toBe(false);
  });
});

describe("the temporary instant profile", () => {
  const profile = {
    composerReady: true,
    draftPresent: false,
    temporary: true,
    personalized: false,
    personalizationReady: true,
    instant: true,
    modelReady: true,
  };
  const parse = (value: unknown) =>
    temporaryInstantProfileSchema.safeParse(value);

  it("needs the seven required flags and leaves the label evidence optional", () => {
    expect(parse(profile).success).toBe(true);
    const { modelReady: _modelReady, ...missing } = profile;
    expect(parse(missing).success).toBe(false);
  });

  it("bounds the visible model label and the control count", () => {
    expect(
      parse({ ...profile, visibleModelLabel: "x".repeat(80) }).success,
    ).toBe(true);
    expect(
      parse({ ...profile, visibleModelLabel: "x".repeat(81) }).success,
    ).toBe(false);
    expect(parse({ ...profile, visibleModelLabel: null }).success).toBe(true);
    expect(parse({ ...profile, modelControlCount: 0 }).success).toBe(true);
    expect(parse({ ...profile, modelControlCount: 100 }).success).toBe(true);
    expect(parse({ ...profile, modelControlCount: 101 }).success).toBe(false);
    expect(parse({ ...profile, modelControlCount: -1 }).success).toBe(false);
    expect(parse({ ...profile, modelControlCount: 1.5 }).success).toBe(false);
  });

  it("is not strict: an unknown key from a newer page script is dropped", () => {
    const parsed = parse({ ...profile, extra: true });
    expect(parsed.success && "extra" in parsed.data).toBe(false);
  });
});

describe("the instant power slider", () => {
  const parse = (value: unknown) => instantPowerSliderSchema.safeParse(value);

  it("needs ready and leaves atMinimum optional", () => {
    expect(parse({ ready: false }).success).toBe(true);
    expect(parse({ ready: true, atMinimum: true }).success).toBe(true);
    expect(parse({}).success).toBe(false);
    expect(parse({ ready: true, atMinimum: "yes" }).success).toBe(false);
  });
});
