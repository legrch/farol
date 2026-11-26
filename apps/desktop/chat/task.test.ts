import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_POLL_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  MANUAL_SUBMISSION_BUDGET_MS,
  STABLE_POLLS_REQUIRED,
  SUBMIT_WINDOW_MS,
  activationDecision,
  appBindingRefusal,
  appVerificationRefusal,
  appendAnswerItem,
  assistantCorrelation,
  connectorTimingElapsed,
  conversationCreatedBySubmission,
  initialReadinessRefusal,
  instantProfileFailureCode,
  isTaskDocumentUnavailable,
  isValidAppTargetName,
  nextStablePolls,
  observationAdmissionRefusal,
  observedProbeFailureCode,
  observedReadinessCode,
  observedTurnDecision,
  pageLostAcrossAwait,
  pinnedConversationAfter,
  preparedTaskDecision,
  probeWaitMs,
  readinessRefusal,
  remainingMs,
  submissionMayHaveOccurred,
  submittedProbeFailureCode,
  taskCallRefusal,
  taskDeadline,
  taskInProgressRefusal,
  taskThrowOutcome,
  textGrowth,
  textTurnCompleted,
  userCorrelation,
  type SubmissionPhase,
  type TaskCallFacts,
} from "./task";

describe("budgets", () => {
  it("keeps the documented constants", () => {
    expect(MANUAL_SUBMISSION_BUDGET_MS).toBe(15_000);
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(180_000);
    expect(SUBMIT_WINDOW_MS).toBe(5_000);
    expect(DEFAULT_TASK_POLL_MS).toBe(250);
    expect(STABLE_POLLS_REQUIRED).toBe(3);
  });

  it.each([
    [1_000, true, undefined, 16_000],
    [1_000, true, 60_000, 16_000],
    [1_000, false, undefined, 181_000],
    [1_000, false, 60_000, 61_000],
    [1_000, false, 0, 1_000],
  ])(
    "taskDeadline(now=%i, manual=%s, timeout=%s) is %i",
    (now, manual, timeout, expected) => {
      expect(taskDeadline(now, manual, timeout)).toBe(expected);
    },
  );

  it.each([
    [100, 99, 1],
    [100, 100, 0],
    [100, 101, 0],
    [100, 1_000, 0],
  ])("remainingMs(%i, %i) is %i and never negative", (deadline, now, out) => {
    expect(remainingMs(deadline, now)).toBe(out);
  });

  it("rounds a fractional remaining time up to a whole timer delay", () => {
    expect(remainingMs(100, 0.4)).toBe(100);
    expect(remainingMs(100, 99.9)).toBe(1);
    expect(remainingMs(100, 100.4)).toBe(0);
    expect(probeWaitMs(250, 100, 0.4)).toBe(100);
  });

  it.each([
    [250, 1_000, 0, 250],
    [250, 100, 0, 100],
    [250, 100, 100, 0],
    [250, 100, 200, 0],
    [250, 1_000, 750, 250],
    [250, 1_000, 751, 249],
  ])("probeWaitMs(poll=%i, deadline=%i, now=%i) is %i", (p, d, n, out) => {
    expect(probeWaitMs(p, d, n)).toBe(out);
  });

  it.each([
    [10, 10, 0],
    [10, 10.4, 0],
    [10, 10.5, 1],
    [10, 110.6, 101],
    [10, 9.999, null],
    [10, Number.NaN, null],
    [10, Number.POSITIVE_INFINITY, null],
  ])("connectorTimingElapsed(%f, %f) is %s", (start, now, out) => {
    expect(connectorTimingElapsed(start, now)).toBe(out);
  });
});

describe("taskCallRefusal", () => {
  const connectionCheck: TaskCallFacts = {
    profile: "temporary-instant",
    hasAppTarget: true,
    attachmentCount: 0,
    connectionCheck: true,
    manualDeepTest: false,
    manualSubmissionOnly: false,
    hasConnectorReceipt: true,
  };
  const manual: TaskCallFacts = {
    profile: "ordinary",
    hasAppTarget: true,
    attachmentCount: 0,
    connectionCheck: false,
    manualDeepTest: true,
    manualSubmissionOnly: true,
    hasConnectorReceipt: false,
  };
  const ordinary: TaskCallFacts = {
    profile: "ordinary",
    hasAppTarget: false,
    attachmentCount: 2,
    connectionCheck: false,
    manualDeepTest: false,
    manualSubmissionOnly: false,
    hasConnectorReceipt: false,
  };

  it("accepts the three well-formed shapes", () => {
    expect(taskCallRefusal(connectionCheck)).toBeNull();
    expect(taskCallRefusal(manual)).toBeNull();
    expect(taskCallRefusal(ordinary)).toBeNull();
  });

  it("accepts a manual deep test that is not submission-only", () => {
    expect(
      taskCallRefusal({
        ...ordinary,
        manualDeepTest: true,
        hasConnectorReceipt: true,
        hasAppTarget: false,
      }),
    ).toBeNull();
  });

  it.each([
    ["wrong profile", { profile: "connector-instant" as const }],
    ["ordinary profile", { profile: "ordinary" as const }],
    ["no app target", { hasAppTarget: false }],
    ["one attachment", { attachmentCount: 1 }],
    ["no connector receipt", { hasConnectorReceipt: false }],
    ["manual deep test", { manualDeepTest: true }],
    ["manual submission", { manualSubmissionOnly: true }],
  ])("refuses a connection check with %s", (_name, change) => {
    expect(taskCallRefusal({ ...connectionCheck, ...change })).toBe(
      "CHATGPT_SUBMIT_UNAVAILABLE",
    );
  });

  it.each([
    ["no manual deep test", { manualDeepTest: false }],
    ["no app target", { hasAppTarget: false }],
    ["one attachment", { attachmentCount: 1 }],
    ["a connector receipt", { hasConnectorReceipt: true }],
  ])("refuses a manual submission with %s", (_name, change) => {
    expect(taskCallRefusal({ ...manual, ...change })).toBe(
      "CHATGPT_SUBMIT_UNAVAILABLE",
    );
  });

  it("refuses a connection check that is also a manual submission", () => {
    expect(
      taskCallRefusal({ ...connectionCheck, manualSubmissionOnly: true }),
    ).toBe("CHATGPT_SUBMIT_UNAVAILABLE");
  });
});

describe("app target and admission", () => {
  it.each([
    ["Farol", true],
    ["a", true],
    ["0", true],
    ["My App_1.2-x", true],
    ["a".repeat(64), true],
    ["a".repeat(65), false],
    ["", false],
    [" lead", false],
    [".dot", false],
    ["-dash", false],
    ["bad/name", false],
    ["line\nbreak", false],
    ["tail\n", false],
    ["émoji", false],
  ])("isValidAppTargetName(%j) is %s", (name, ok) => {
    expect(isValidAppTargetName(name)).toBe(ok);
  });

  it.each([
    [false, false, null],
    [true, false, "CHATGPT_TASK_IN_PROGRESS"],
    [false, true, "CHATGPT_TASK_IN_PROGRESS"],
    [true, true, "CHATGPT_TASK_IN_PROGRESS"],
  ])(
    "taskInProgressRefusal(update=%s, inFlight=%s) is %s",
    (updateAdmission, taskInFlight, out) => {
      expect(taskInProgressRefusal({ updateAdmission, taskInFlight })).toBe(
        out,
      );
    },
  );
});

describe("readiness", () => {
  it("passes an authenticated page", () => {
    expect(
      initialReadinessRefusal({ state: "authenticated", code: null }),
    ).toBeNull();
  });

  it("answers a signed-out page as not authenticated", () => {
    expect(
      initialReadinessRefusal({
        state: "signed_out",
        code: "CHATGPT_SIGN_IN_REQUIRED",
      }),
    ).toEqual({
      state: "not_authenticated",
      code: "CHATGPT_SIGN_IN_REQUIRED",
    });
  });

  it("keeps the unreachable code and reads anything else as unrecognized", () => {
    expect(
      initialReadinessRefusal({
        state: "unreachable",
        code: "CHATGPT_PAGE_UNREACHABLE",
      }),
    ).toEqual({
      state: "failed_before_submit",
      code: "CHATGPT_PAGE_UNREACHABLE",
    });
    expect(
      initialReadinessRefusal({
        state: "unsupported",
        code: "CHATGPT_UI_UNRECOGNIZED",
      }),
    ).toEqual({
      state: "failed_before_submit",
      code: "CHATGPT_UI_UNRECOGNIZED",
    });
    // An unreachable state without the unreachable code is not that code.
    expect(
      initialReadinessRefusal({ state: "unreachable", code: null }),
    ).toEqual({
      state: "failed_before_submit",
      code: "CHATGPT_UI_UNRECOGNIZED",
    });
  });

  it.each([
    ["signed_out", "not_authenticated", "CHATGPT_SIGN_IN_REQUIRED"],
    ["unreachable", "failed_before_submit", "CHATGPT_UI_UNRECOGNIZED"],
    ["unsupported", "failed_before_submit", "CHATGPT_UI_UNRECOGNIZED"],
    ["authenticated", "failed_before_submit", "CHATGPT_UI_UNRECOGNIZED"],
    [undefined, "failed_before_submit", "CHATGPT_UI_UNRECOGNIZED"],
  ] as const)("readinessRefusal(%s) is %s / %s", (observed, state, code) => {
    expect(readinessRefusal(observed)).toEqual({ state, code });
  });

  it.each([
    ["signed_out", "CHATGPT_SIGN_IN_REQUIRED"],
    ["unreachable", "CHATGPT_UI_UNRECOGNIZED"],
    ["unsupported", "CHATGPT_UI_UNRECOGNIZED"],
    ["authenticated", "CHATGPT_UI_UNRECOGNIZED"],
  ] as const)("observedReadinessCode(%s) is %s", (state, code) => {
    expect(observedReadinessCode(state)).toBe(code);
  });

  it("reads a missing temporary chat as unrecognized only for the connector profile", () => {
    expect(
      instantProfileFailureCode(
        "connector-instant",
        "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      ),
    ).toBe("CHATGPT_UI_UNRECOGNIZED");
    expect(
      instantProfileFailureCode(
        "temporary-instant",
        "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      ),
    ).toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(
      instantProfileFailureCode("ordinary", "CHATGPT_TEMPORARY_CHAT_REQUIRED"),
    ).toBe("CHATGPT_TEMPORARY_CHAT_REQUIRED");
    expect(
      instantProfileFailureCode(
        "connector-instant",
        "CHATGPT_INSTANT_MODEL_REQUIRED",
      ),
    ).toBe("CHATGPT_INSTANT_MODEL_REQUIRED");
  });
});

describe("app binding", () => {
  const blocked = (
    reason:
      | "missing"
      | "ambiguous"
      | "conflict"
      | "draft_present"
      | "selection_not_observed",
  ) => ({ state: "blocked" as const, reason });

  it.each([
    [{ state: "bound" as const }, null],
    [{ state: "navigated" as const }, "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"],
    [blocked("missing"), "CHATGPT_APP_SELECTION_MISSING"],
    [blocked("ambiguous"), "CHATGPT_APP_SELECTION_AMBIGUOUS"],
    [blocked("conflict"), "CHATGPT_APP_SELECTION_CONFLICT"],
    [blocked("draft_present"), "CHATGPT_COMPOSER_DRAFT_PRESENT"],
    [blocked("selection_not_observed"), "CHATGPT_APP_SELECTION_LOST"],
  ])("appBindingRefusal(%j) is %s", (binding, out) => {
    expect(appBindingRefusal(binding)).toBe(out);
  });

  it.each([
    [{ state: "bound" as const }, null],
    [{ state: "navigated" as const }, "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"],
    [blocked("missing"), "CHATGPT_APP_SELECTION_LOST"],
    [blocked("selection_not_observed"), "CHATGPT_APP_SELECTION_LOST"],
    [blocked("ambiguous"), "CHATGPT_APP_SELECTION_AMBIGUOUS"],
    [blocked("conflict"), "CHATGPT_APP_SELECTION_CONFLICT"],
    [blocked("draft_present"), "CHATGPT_COMPOSER_DRAFT_PRESENT"],
  ])("appVerificationRefusal(%j) is %s", (binding, out) => {
    expect(appVerificationRefusal(binding)).toBe(out);
  });
});

describe("preparedTaskDecision", () => {
  const snapshot = {
    ready: true,
    preparedComposerText: "hello",
    baselineAssistantCount: 0,
    baselineUserCount: 0,
    baselineMessageIds: [],
  };
  const plain = { requiresComposerText: false };
  const fenced = { requiresComposerText: true };

  it.each([
    [{ navigated: true as const }, "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"],
    [{ appSelectionLost: true as const }, "CHATGPT_APP_SELECTION_LOST"],
    [{ draftPresent: true as const }, "CHATGPT_COMPOSER_DRAFT_PRESENT"],
  ])("a page refusal %j refuses as %s", (prepared, code) => {
    expect(preparedTaskDecision(prepared, plain)).toEqual({
      kind: "refused",
      code,
    });
    expect(preparedTaskDecision(prepared, fenced)).toEqual({
      kind: "refused",
      code,
    });
  });

  it("is unavailable when the composer is not ready", () => {
    expect(preparedTaskDecision({ ...snapshot, ready: false }, plain)).toEqual({
      kind: "unavailable",
    });
  });

  it("requires the text fence only when asked to", () => {
    const { preparedComposerText: _text, ...unfenced } = snapshot;
    expect(preparedTaskDecision(unfenced, fenced)).toEqual({
      kind: "unavailable",
    });
    expect(preparedTaskDecision(unfenced, plain)).toEqual({
      kind: "ready",
      task: unfenced,
    });
    // An empty fence is still a fence.
    expect(
      preparedTaskDecision({ ...snapshot, preparedComposerText: "" }, fenced),
    ).toEqual({
      kind: "ready",
      task: { ...snapshot, preparedComposerText: "" },
    });
  });

  it("hands back the snapshot when ready", () => {
    expect(preparedTaskDecision(snapshot, fenced)).toEqual({
      kind: "ready",
      task: snapshot,
    });
  });
});

describe("the Send click", () => {
  it.each([
    [{ navigated: true as const }, "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"],
    [{ appSelectionLost: true as const }, "CHATGPT_APP_SELECTION_LOST"],
    [{ profileLost: true as const }, "CHATGPT_INSTANT_MODEL_REQUIRED"],
    [{ draftPresent: true as const }, "CHATGPT_COMPOSER_DRAFT_PRESENT"],
  ])("an in-page refusal %j refuses as %s", (activated, code) => {
    expect(activationDecision(activated)).toEqual({ kind: "refused", code });
  });

  it("is activated only on a positive acknowledgement", () => {
    expect(activationDecision({ activated: true })).toEqual({
      kind: "activated",
    });
    expect(activationDecision({ activated: false })).toEqual({
      kind: "not_activated",
    });
  });
});

describe("a throw never undoes a send", () => {
  const phases: SubmissionPhase[] = [
    "not_attempted",
    "awaiting_acknowledgement",
    "submitted",
  ];

  it.each([
    ["not_attempted", false],
    ["awaiting_acknowledgement", true],
    ["submitted", true],
  ] as const)("submissionMayHaveOccurred(%s) is %s", (phase, may) => {
    expect(submissionMayHaveOccurred(phase)).toBe(may);
  });

  it.each(["awaiting_acknowledgement", "submitted"] as const)(
    "is outcome_unknown, never failed_before_submit, in phase %s",
    (phase) => {
      expect(taskThrowOutcome({ phase, documentChanged: false })).toEqual({
        state: "outcome_unknown",
        code: "CHATGPT_TASK_ERROR",
      });
      expect(taskThrowOutcome({ phase, documentChanged: true })).toEqual({
        state: "outcome_unknown",
        code: "CHATGPT_TASK_PAGE_LOST",
      });
    },
  );

  it("is failed_before_submit only while nothing was attempted", () => {
    expect(
      taskThrowOutcome({ phase: "not_attempted", documentChanged: false }),
    ).toEqual({
      state: "failed_before_submit",
      code: "CHATGPT_SUBMIT_UNAVAILABLE",
    });
    expect(
      taskThrowOutcome({ phase: "not_attempted", documentChanged: true }),
    ).toEqual({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
  });

  it("only the attempted phases ever classify as unknown", () => {
    for (const phase of phases) {
      for (const documentChanged of [false, true]) {
        const outcome = taskThrowOutcome({ phase, documentChanged });
        expect(outcome.state === "outcome_unknown").toBe(
          phase !== "not_attempted",
        );
      }
    }
  });

  it.each([
    [new Error("ChatGPT task document unavailable"), true],
    [new Error("ChatGPT task document unavailable."), false],
    [new Error("CHATGPT_TASK_CANCELLED"), false],
    ["ChatGPT task document unavailable", false],
    [{ message: "ChatGPT task document unavailable" }, false],
    [null, false],
  ])("isTaskDocumentUnavailable(%j) is %s", (error, out) => {
    expect(isTaskDocumentUnavailable(error)).toBe(out);
  });
});

describe("the conversation a submission owns", () => {
  const a = "https://chatgpt.com/c/a";
  const b = "https://chatgpt.com/c/b";

  it.each([
    [null, null, false, null],
    [null, a, false, a],
    [a, a, false, a],
    [a, b, true, null],
    [a, null, true, null],
  ])("pinnedConversationAfter(%s, %s)", (pinned, current, lost, nextPinned) => {
    const outcome = pinnedConversationAfter(pinned, current);
    expect(outcome.lost).toBe(lost);
    if (!outcome.lost) expect(outcome.pinned).toBe(nextPinned);
  });

  it.each([
    [null, a, true, true],
    [null, a, false, false],
    [null, null, true, false],
    [a, a, true, false],
    [a, b, true, false],
  ])(
    "conversationCreatedBySubmission(%s, %s, allowed=%s) is %s",
    (pinned, created, allowed, out) => {
      expect(conversationCreatedBySubmission(pinned, created, allowed)).toBe(
        out,
      );
    },
  );

  it.each([
    [a, a, false, false],
    [a, a, true, false],
    [a, b, false, true],
    [a, b, true, false],
  ])(
    "pageLostAcrossAwait(%s -> %s, created=%s) is %s",
    (before, after, created, out) => {
      expect(pageLostAcrossAwait(before, after, created)).toBe(out);
    },
  );
});

describe("what a probe says", () => {
  const quiet = {
    signInVisible: false,
    errorVisible: false,
    errorKind: "none" as const,
  };

  it("says nothing for a quiet page", () => {
    expect(submittedProbeFailureCode(quiet)).toBeNull();
    expect(observedProbeFailureCode(quiet)).toBeNull();
    // An error kind without a visible error is not an error.
    expect(
      submittedProbeFailureCode({ ...quiet, errorKind: "usage_limited" }),
    ).toBeNull();
    expect(
      observedProbeFailureCode({ ...quiet, errorKind: "usage_limited" }),
    ).toBeNull();
  });

  it.each([
    [{ signInVisible: true }, "CHATGPT_TASK_PAGE_LOST"],
    [
      { signInVisible: true, errorVisible: true, errorKind: "usage_limited" },
      "CHATGPT_TASK_PAGE_LOST",
    ],
    [
      { errorVisible: true, errorKind: "usage_limited" },
      "CHATGPT_USAGE_LIMITED",
    ],
    [{ errorVisible: true, errorKind: "generic" }, "CHATGPT_TASK_ERROR"],
    [{ errorVisible: true, errorKind: "none" }, "CHATGPT_TASK_ERROR"],
  ] as const)("a submitted task with %j fails as %s", (change, code) => {
    expect(submittedProbeFailureCode({ ...quiet, ...change })).toBe(code);
  });

  it.each([
    [{ signInVisible: true }, "CHATGPT_SIGN_IN_REQUIRED"],
    [
      { signInVisible: true, errorVisible: true, errorKind: "usage_limited" },
      "CHATGPT_SIGN_IN_REQUIRED",
    ],
    [
      { errorVisible: true, errorKind: "usage_limited" },
      "CHATGPT_USAGE_LIMITED",
    ],
    [{ errorVisible: true, errorKind: "generic" }, "CHATGPT_TASK_ERROR"],
  ] as const)("an observed turn with %j fails as %s", (change, code) => {
    expect(observedProbeFailureCode({ ...quiet, ...change })).toBe(code);
  });
});

describe("turn correlation", () => {
  it.each([
    [null, null, "none"],
    [null, "u1", "none"],
    ["u1", null, "adopt"],
    ["u1", "u1", "keep"],
    ["u2", "u1", "changed"],
  ])("userCorrelation(%s, %s) is %s", (probe, held, kind) => {
    const step = userCorrelation(probe, held);
    expect(step.kind).toBe(kind);
    if (step.kind === "adopt") expect(step.id).toBe(probe);
  });

  it.each([
    // [probeUser, probeAssistant, heldUser, heldAssistant, kind]
    [null, null, null, null, "none"],
    ["u1", null, "u1", null, "none"],
    [null, "a1", "u1", null, "changed"],
    ["u2", "a1", "u1", null, "changed"],
    ["u1", "a1", null, null, "changed"],
    ["u1", "a1", "u1", null, "adopt"],
    ["u1", "a1", "u1", "a1", "keep"],
    ["u1", "a2", "u1", "a1", "changed"],
  ])(
    "assistantCorrelation(%s, %s, %s, %s) is %s",
    (probeUser, probeAssistant, heldUser, heldAssistant, kind) => {
      const step = assistantCorrelation(
        probeUser,
        probeAssistant,
        heldUser,
        heldAssistant,
      );
      expect(step.kind).toBe(kind);
      if (step.kind === "adopt") {
        expect(step.id).toBe(probeAssistant);
        expect(step.userId).toBe(heldUser);
      }
    },
  );

  it.each([
    ["u2", "a1", "u1", null, { kind: "wait" }],
    [null, "a1", "u1", null, { kind: "wait" }],
    ["u1", null, "u1", null, { kind: "wait" }],
    ["u1", null, "u1", "a1", { kind: "wait" }],
    ["u1", "a1", "u1", null, { kind: "adopt", assistantId: "a1" }],
    ["u1", "a1", "u1", "a1", { kind: "keep", assistantId: "a1" }],
    ["u1", "a2", "u1", "a1", { kind: "changed" }],
  ])(
    "observedTurnDecision(%s, %s, %s, %s)",
    (probeUser, probeAssistant, inputUser, held, out) => {
      expect(
        observedTurnDecision(probeUser, probeAssistant, inputUser, held),
      ).toEqual(out);
    },
  );

  it.each([
    [false, false, "u", "p", null],
    [true, false, "u", "p", "CHATGPT_TASK_IN_PROGRESS"],
    [false, true, "u", "p", "CHATGPT_TASK_IN_PROGRESS"],
    [true, true, "", "", "CHATGPT_TASK_IN_PROGRESS"],
    [false, false, "", "p", "CHATGPT_TASK_OUTPUT_CHANGED"],
    [false, false, "u", "", "CHATGPT_TASK_OUTPUT_CHANGED"],
  ])(
    "observationAdmissionRefusal(update=%s, inFlight=%s, user=%j, prompt=%j) is %s",
    (updateAdmission, taskInFlight, turnUserId, prompt, out) => {
      expect(
        observationAdmissionRefusal({
          updateAdmission,
          taskInFlight,
          turnUserId,
          prompt,
        }),
      ).toBe(out);
    },
  );
});

describe("the reply text", () => {
  it.each([
    ["", "", "unchanged"],
    ["abc", "abc", "unchanged"],
    ["abc", "ab", "regressed"],
    ["abc", "", "regressed"],
    ["abc", "abcd", "grew"],
    ["", "abc", "grew"],
    ["abc", "abx", "diverged"],
    ["abc", "xyz", "diverged"],
    ["abc", "xabc", "diverged"],
  ])("textGrowth(%j, %j) is %s", (observed, shown, out) => {
    expect(textGrowth(observed, shown)).toBe(out);
  });

  it("joins answer items with a blank line, but not the first", () => {
    expect(appendAnswerItem("", "one")).toBe("one");
    expect(appendAnswerItem("one", "two")).toBe("one\n\ntwo");
  });

  const base = {
    grew: false,
    correlated: true,
    observedCharacters: 5,
    busy: false,
    sendVisible: true,
    stablePolls: 1,
  };

  it.each([
    [{}, 2],
    [{ grew: true }, 0],
    [{ correlated: false }, 0],
    [{ observedCharacters: 0 }, 0],
    [{ busy: true }, 0],
    [{ sendVisible: false }, 0],
    [{ stablePolls: 0 }, 1],
    [{ stablePolls: 2 }, 3],
  ])("nextStablePolls(%j) is %i", (change, out) => {
    expect(nextStablePolls({ ...base, ...change })).toBe(out);
  });

  const done = {
    accepted: true,
    correlated: true,
    observedCharacters: 5,
    sendVisible: true,
    stablePolls: 3,
  };

  it("completes at exactly the required number of stable polls", () => {
    expect(textTurnCompleted(done)).toBe(true);
    expect(textTurnCompleted({ ...done, stablePolls: 4 })).toBe(true);
    expect(textTurnCompleted({ ...done, stablePolls: 2 })).toBe(false);
  });

  it.each([
    [{ accepted: false }],
    [{ correlated: false }],
    [{ observedCharacters: 0 }],
    [{ sendVisible: false }],
  ])("does not complete when %j", (change) => {
    expect(textTurnCompleted({ ...done, ...change })).toBe(false);
  });
});
