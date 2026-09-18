import { describe, expect, it } from "vitest";
import { EVIDENCE_LANES } from "../../tooling/evidence-cases.mjs";
import {
  evaluateEligibility,
  observerFor,
  summarizeRequirements,
} from "../../tooling/evidence-eligibility.mjs";

const candidate = Object.freeze({
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  artifactSha256: "c".repeat(64),
});

const attemptId = "20260918T090000000Z-0000000a";

// A complete attempt as the loader returns it: receipts that name this
// attempt and lane, recorded outputs the loader re-read unchanged, and the
// interval its receipts span.
function passingAttempt(lane, terminalOverrides = {}, extra = {}) {
  const cases = [...EVIDENCE_LANES[lane].cases];
  const byproducts =
    lane === "hunt"
      ? [{ path: "path.json", bytes: 10, sha256: "d".repeat(64) }]
      : [{ path: "report.json", bytes: 10, sha256: "d".repeat(64) }];
  return {
    attemptId,
    status: terminalOverrides.status ?? "PASS",
    started: {
      attemptId,
      lane,
      input: { ...candidate },
      startedAt: "2026-09-18T09:00:00.000Z",
    },
    terminal: {
      attemptId,
      lane,
      status: "PASS",
      startedAt: "2026-09-18T09:00:00.000Z",
      endedAt: "2026-09-18T09:10:00.000Z",
      firstFailure: null,
      cases: { raw: cases, normalized: [...cases].sort() },
      blockedCases: [],
      skippedCases: [],
      byproducts,
      ...terminalOverrides,
    },
    exit: { attemptId, exitCode: 0 },
    verification: { receipts: [], byproducts: [] },
    ...extra,
  };
}

// An observer that watched exactly this run.
const observer = Object.freeze({
  healthy: true,
  lane: "sealed-package",
  attemptId,
  subject: {
    sourceCommit: candidate.sourceCommit,
    artifactSha256: candidate.artifactSha256,
  },
  interval: {
    startedAt: "2026-09-18T08:59:00.000Z",
    endedAt: "2026-09-18T09:11:00.000Z",
  },
});

const review = Object.freeze({
  subject: {
    sourceCommit: candidate.sourceCommit,
    artifactSha256: candidate.artifactSha256,
  },
  reviewer: "independent",
  policy: "critic-risk-4",
  verdict: "ACCEPT",
});

function evaluate(overrides = {}) {
  return evaluateEligibility({
    lane: "sealed-package",
    attempt: passingAttempt("sealed-package"),
    candidate,
    review,
    observer,
    findings: [],
    ...overrides,
  });
}

describe("EV-03/EV-08 evidence eligibility", () => {
  it("accepts one complete, current, reviewed and observed attempt", () => {
    expect(evaluate()).toEqual({
      lane: "sealed-package",
      attemptId: "20260918T090000000Z-0000000a",
      rawOutcome: "PASS",
      eligibility: "CURRENT",
      acceptable: true,
      reasons: [],
    });
  });

  it("refuses a missing mandatory case even with zero blocked cases", () => {
    const cases = EVIDENCE_LANES["sealed-package"].cases.slice(1);
    const result = evaluate({
      attempt: passingAttempt("sealed-package", {
        cases: { raw: cases, normalized: [...cases].sort() },
      }),
    });
    expect(result.acceptable).toBe(false);
    expect(result.eligibility).toBe("INCOMPLETE");
    expect(result.reasons).toEqual([
      `CASE_MISSING:${EVIDENCE_LANES["sealed-package"].cases[0]}`,
    ]);
  });

  it("keeps a blocked mandatory case open instead of treating it as proof", () => {
    const [blocked, ...rest] = EVIDENCE_LANES["development-build"].cases;
    const result = evaluate({
      lane: "development-build",
      attempt: passingAttempt("development-build", {
        status: "BLOCKED",
        cases: { raw: rest, normalized: [...rest].sort() },
        blockedCases: [{ name: blocked, reason: "no secondary display" }],
      }),
      observer: { ...observer, lane: "development-build" },
    });
    expect(result.acceptable).toBe(false);
    expect(result.reasons).toEqual([
      "RAW_OUTCOME_BLOCKED",
      `CASE_BLOCKED:${blocked}`,
    ]);
  });

  it("never lets a fixture lane satisfy a live boundary", () => {
    const result = evaluate({
      requiredBoundary: { provider: "live", nativeHost: "installed" },
    });
    expect(result.eligibility).toBe("WRONG_BOUNDARY");
    expect(result.reasons).toEqual([
      "BOUNDARY_INSUFFICIENT:provider",
      "BOUNDARY_INSUFFICIENT:nativeHost",
    ]);
  });

  it.each([
    ["sourceCommit", { ...candidate, sourceCommit: "e".repeat(40) }],
    ["sourceTreeDigest", { ...candidate, sourceTreeDigest: "e".repeat(64) }],
    ["artifactSha256", { ...candidate, artifactSha256: "e".repeat(64) }],
  ])("refuses evidence about another %s", (field, other) => {
    const result = evaluate({ candidate: other, review: null });
    expect(result.eligibility).toBe("WRONG_SUBJECT");
    expect(result.reasons).toContain(`WRONG_SUBJECT:${field}`);
  });

  it("refuses an attempt that executed nothing", () => {
    const result = evaluate({
      attempt: passingAttempt("sealed-package", {
        cases: { raw: [], normalized: [] },
      }),
    });
    expect(result.reasons[0]).toBe("NO_CASES_EXECUTED");
    expect(result.acceptable).toBe(false);
  });

  it("refuses a green label over a nonzero or unobserved exit", () => {
    expect(
      evaluate({
        attempt: passingAttempt(
          "sealed-package",
          {},
          { exit: { exitCode: 1 } },
        ),
      }).reasons,
    ).toEqual(["EXIT_NONZERO:1"]);
    expect(
      evaluate({
        attempt: passingAttempt("sealed-package", {}, { exit: null }),
      }).reasons,
    ).toEqual(["EXIT_RECEIPT_MISSING"]);
  });

  it.each([
    ["missing", null, "REVIEW_MISSING"],
    ["self", { ...review, reviewer: "self" }, "REVIEW_NOT_INDEPENDENT"],
    [
      "stale",
      {
        ...review,
        subject: { ...review.subject, artifactSha256: "f".repeat(64) },
      },
      "REVIEW_STALE",
    ],
    ["rework", { ...review, verdict: "REWORK" }, "REVIEW_NOT_ACCEPT"],
  ])("refuses a %s review", (_name, candidateReview, reason) => {
    const result = evaluate({ review: candidateReview });
    expect(result.acceptable).toBe(false);
    expect(result.eligibility).toBe("UNVERIFIED");
    expect(result.reasons).toEqual([reason]);
  });

  it("refuses an unhealthy or absent required effect observer", () => {
    expect(
      evaluate({ observer: { ...observer, healthy: false } }),
    ).toMatchObject({
      eligibility: "UNVERIFIED",
      reasons: ["OBSERVER_UNHEALTHY"],
    });
    expect(evaluate({ observer: null }).reasons).toEqual(["OBSERVER_MISSING"]);
  });

  it.each([
    [
      "another attempt",
      { attemptId: "20260918T080000000Z-0000000b" },
      "OBSERVER_ATTEMPT_MISMATCH",
    ],
    ["another lane", { lane: "development-build" }, "OBSERVER_LANE_MISMATCH"],
    [
      "another candidate",
      { subject: { ...observer.subject, artifactSha256: "f".repeat(64) } },
      "OBSERVER_SUBJECT_MISMATCH:artifactSha256",
    ],
    [
      "an interval that started late",
      {
        interval: {
          ...observer.interval,
          startedAt: "2026-09-18T09:00:01.000Z",
        },
      },
      "OBSERVER_INTERVAL_UNCOVERED",
    ],
    [
      "an interval that ended early",
      {
        interval: { ...observer.interval, endedAt: "2026-09-18T09:09:59.000Z" },
      },
      "OBSERVER_INTERVAL_UNCOVERED",
    ],
    [
      "no interval at all",
      { interval: undefined },
      "OBSERVER_INTERVAL_UNCOVERED",
    ],
  ])(
    "CTRL-29-E1 refuses an observer receipt about %s",
    (_name, override, reason) => {
      const result = evaluate({ observer: { ...observer, ...override } });
      expect(result.acceptable).toBe(false);
      expect(result.eligibility).toBe("UNVERIFIED");
      expect(result.reasons).toEqual([reason]);
    },
  );

  it("CTRL-29-E1 refuses an observer that names cases but did not watch one the run executed", () => {
    const cases = EVIDENCE_LANES["sealed-package"].cases;
    const result = evaluate({
      observer: { ...observer, observedCases: cases.slice(1) },
    });
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/^OBSERVER_CASE_UNCOVERED:/u);
    expect(
      evaluate({ observer: { ...observer, observedCases: [...cases] } })
        .acceptable,
    ).toBe(true);
  });

  it("hands a lane only the observer receipt that names it", () => {
    const other = { ...observer, lane: "development-build" };
    expect(observerFor(observer, "sealed-package")).toBe(observer);
    expect(observerFor(observer, "development-build")).toBeNull();
    expect(
      observerFor(
        { "sealed-package": observer, "development-build": other },
        "development-build",
      ),
    ).toBe(other);
    expect(observerFor({ "sealed-package": observer }, "hunt")).toBeNull();
    expect(observerFor(null, "hunt")).toBeNull();
  });

  it("HR-010 refuses an attempt whose receipts or byproducts the loader could not verify, and one that never passed through the loader", () => {
    const tampered = evaluate({
      attempt: passingAttempt(
        "sealed-package",
        {},
        {
          verification: {
            receipts: ["RECEIPT_IDENTITY:terminal"],
            byproducts: ["BYPRODUCT_CHANGED:report.json"],
          },
        },
      ),
    });
    expect(tampered.acceptable).toBe(false);
    expect(tampered.eligibility).toBe("INVALID");
    expect(tampered.reasons).toEqual([
      "RECEIPT_IDENTITY:terminal",
      "BYPRODUCT_CHANGED:report.json",
    ]);
    const unverified = passingAttempt("sealed-package");
    delete unverified.verification;
    expect(evaluate({ attempt: unverified })).toMatchObject({
      eligibility: "INVALID",
      reasons: ["VERIFICATION_MISSING"],
    });
  });

  it("HR-010 refuses receipts of another lane and a run without its required output", () => {
    expect(
      evaluate({
        attempt: passingAttempt(
          "sealed-package",
          {},
          {
            started: {
              ...passingAttempt("sealed-package").started,
              lane: "hunt",
            },
          },
        ),
      }).reasons,
    ).toEqual(["RECEIPT_LANE_MISMATCH:hunt"]);
    expect(
      evaluate({
        attempt: passingAttempt("sealed-package", {
          byproducts: [
            { path: "other.json", bytes: 4, sha256: "d".repeat(64) },
          ],
        }),
      }).reasons,
    ).toEqual(["BYPRODUCT_REQUIRED_MISSING:report.json"]);
    expect(
      evaluate({
        attempt: passingAttempt("sealed-package", {
          byproducts: [
            { path: "report.json", bytes: 0, sha256: "d".repeat(64) },
          ],
        }),
      }).reasons,
    ).toEqual(["BYPRODUCT_REQUIRED_MISSING:report.json"]);
  });

  it("refuses while a blocking finding is unresolved", () => {
    const result = evaluate({
      findings: [
        { id: "C05-02", blocking: true, resolved: true },
        { id: "EV-05", blocking: true, resolved: false },
        { id: "OUX-07", blocking: false, resolved: false },
      ],
    });
    expect(result.reasons).toEqual(["FINDING_UNRESOLVED:EV-05"]);
  });

  it.each(["FAIL", "INTERRUPTED", "RUNNING_OR_UNKNOWN"])(
    "reports a %s attempt as its raw outcome",
    (status) => {
      const result = evaluate({
        attempt: {
          ...passingAttempt("sealed-package"),
          status,
          terminal:
            status === "FAIL"
              ? { ...passingAttempt("sealed-package").terminal, status }
              : null,
        },
      });
      expect(result.rawOutcome).toBe(status);
      expect(result.acceptable).toBe(false);
      expect(result.reasons[0]).toBe(`RAW_OUTCOME_${status}`);
    },
  );

  it("reports NOT_RUN without an attempt", () => {
    expect(evaluate({ attempt: null })).toMatchObject({
      rawOutcome: "NOT_RUN",
      acceptable: false,
      reasons: ["RAW_OUTCOME_NOT_RUN"],
    });
  });

  it("counts one execution once however many requirements it witnesses", () => {
    const accepted = evaluate();
    const summary = summarizeRequirements(
      [
        {
          id: "OP-10",
          witnesses: [
            { lane: "sealed-package", cases: ["workspace-app-list-search"] },
          ],
        },
        {
          id: "OP-11",
          witnesses: [
            {
              lane: "sealed-package",
              cases: ["workspace-guarded-edit-atomic"],
            },
          ],
        },
        {
          id: "OP-05",
          minimumBoundary: { provider: "live", connector: "authenticated" },
          witnesses: [
            { lane: "sealed-package", cases: ["computer-exact-correlation"] },
          ],
        },
        {
          id: "Q-10",
          witnesses: [],
        },
      ],
      { "sealed-package": accepted },
    );
    expect(summary.executions).toEqual(["20260918T090000000Z-0000000a"]);
    expect(summary.requirements).toEqual([
      {
        id: "OP-10",
        state: "ACCEPTED",
        witnesses: ["sealed-package:20260918T090000000Z-0000000a"],
        reasons: [],
      },
      {
        id: "OP-11",
        state: "ACCEPTED",
        witnesses: ["sealed-package:20260918T090000000Z-0000000a"],
        reasons: [],
      },
      {
        id: "OP-05",
        state: "OPEN",
        witnesses: [],
        reasons: [
          "BOUNDARY_INSUFFICIENT:provider",
          "BOUNDARY_INSUFFICIENT:connector",
        ],
      },
      {
        id: "Q-10",
        state: "OPEN",
        witnesses: [],
        reasons: ["NO_WITNESS_DECLARED"],
      },
    ]);
  });
});
