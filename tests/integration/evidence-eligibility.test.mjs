import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listEvidenceAttempts,
  openEvidenceAttempt,
} from "../../tooling/evidence-attempt.mjs";
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
const TERMINAL_SHA256 = "e".repeat(64);

// A complete attempt as the loader returns it: receipts that name this
// attempt and lane, recorded outputs the loader re-read unchanged, the
// interval its receipts span, and the loader's own hash of the terminal
// receipt's current bytes.
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
    terminalSha256: TERMINAL_SHA256,
    verification: { receipts: [], byproducts: [] },
    ...extra,
  };
}

// An observer that watched exactly this run: its own inventory of the
// attempt's byproducts and the last sha256 it sampled of terminal.json,
// both consistent with `passingAttempt`'s defaults above.
const observer = Object.freeze({
  schema: "farol.next.effect-observer/v1",
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
  effects: {
    processSamples: [
      { at: "2026-09-18T09:05:00.000Z", processes: 1 },
      { at: "2026-09-18T09:10:30.000Z", processes: 0 },
    ],
    terminalSeenAt: "2026-09-18T09:10:30.000Z",
    byproducts: [{ path: "report.json", bytes: 10, sha256: "d".repeat(64) }],
    terminalSha256: TERMINAL_SHA256,
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
  it.each([
    [
      "is not an observer receipt",
      { ...observer, schema: undefined },
      "OBSERVER_SCHEMA_INVALID",
    ],
    [
      "claims health without samples",
      { ...observer, effects: { ...observer.effects, processSamples: [] } },
      "OBSERVER_SAMPLES_INVALID",
    ],
    [
      "saw the product only before the attempt began",
      {
        ...observer,
        effects: {
          ...observer.effects,
          processSamples: [
            { at: "2026-09-18T08:59:30.000Z", processes: 2 },
            { at: "2026-09-18T09:05:00.000Z", processes: 0 },
          ],
        },
      },
      "OBSERVER_PRODUCT_NOT_OBSERVED",
    ],
    [
      "never saw the terminal receipt",
      { ...observer, effects: { ...observer.effects, terminalSeenAt: null } },
      "OBSERVER_TERMINAL_NOT_SEEN",
    ],
  ])(
    "refuses an observer receipt that %s, whatever its healthy flag says",
    (_case, receipt, reason) => {
      const result = evaluate({ observer: receipt });
      expect(result.reasons).toContain(reason);
      expect(result.acceptable).toBe(false);
    },
  );

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
    // Both cases below deliberately hand the observer a matching inventory,
    // so only the missing-required-output check under test fires.
    const otherByproducts = [
      { path: "other.json", bytes: 4, sha256: "d".repeat(64) },
    ];
    expect(
      evaluate({
        attempt: passingAttempt("sealed-package", {
          byproducts: otherByproducts,
        }),
        observer: {
          ...observer,
          effects: { ...observer.effects, byproducts: otherByproducts },
        },
      }).reasons,
    ).toEqual(["BYPRODUCT_REQUIRED_MISSING:report.json"]);
    const emptyByproducts = [
      { path: "report.json", bytes: 0, sha256: "d".repeat(64) },
    ];
    expect(
      evaluate({
        attempt: passingAttempt("sealed-package", {
          byproducts: emptyByproducts,
        }),
        observer: {
          ...observer,
          effects: { ...observer.effects, byproducts: emptyByproducts },
        },
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

// P2 (independent review, Tests/Infra — evidence integrity): a coordinated
// post-run replacement of a lane's report.json together with a consistent
// rewrite of terminal.json must not slip past acceptance just because the
// two files still agree with each other. The observer's own inventory,
// hashed independently while it watched, is the thing that must still agree
// with what the attempt claims now.
describe("P2 observer inventory binds byproducts and the terminal receipt", () => {
  const roots = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function sealedAttempt() {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-eligibility-"),
    );
    roots.push(root);
    const laneRoot = path.join(root, "artifacts", "e2e");
    const opened = await openEvidenceAttempt(laneRoot, {
      lane: "sealed-package",
      input: { ...candidate },
    });
    await fs.writeFile(
      path.join(opened.directory, "report.json"),
      JSON.stringify({ status: "PASS" }),
    );
    await opened.finish("PASS", {
      cases: [...EVIDENCE_LANES["sealed-package"].cases],
    });
    // Mirrors the exit receipt a real runner process writes on exit, so the
    // unrelated EXIT_RECEIPT_MISSING reason never crowds out what this
    // describe block is testing.
    await fs.writeFile(
      path.join(opened.directory, "exit.json"),
      JSON.stringify({
        schema: "farol.next.evidence-attempt/v1",
        attemptId: opened.attemptId,
        exitCode: 0,
        exitedAt: new Date().toISOString(),
      }),
    );
    return {
      laneRoot,
      attemptId: opened.attemptId,
      directory: opened.directory,
    };
  }

  // The observer receipt a healthy run would actually have produced: its
  // own inventory of the byproducts and the last sha256 it sampled of
  // terminal.json, both read from the attempt before any tamper below.
  async function healthyObserverFor(laneRoot, attemptIdentifier) {
    const [loaded] = await listEvidenceAttempts(laneRoot);
    return {
      schema: "farol.next.effect-observer/v1",
      healthy: true,
      lane: "sealed-package",
      attemptId: attemptIdentifier,
      subject: { ...candidate },
      interval: {
        startedAt: "2000-01-01T00:00:00.000Z",
        endedAt: "2100-01-01T00:00:00.000Z",
      },
      effects: {
        processSamples: [
          { at: loaded.started.startedAt, processes: 1 },
          { at: loaded.terminal.endedAt, processes: 0 },
        ],
        terminalSeenAt: loaded.terminal.endedAt,
        byproducts: loaded.terminal.byproducts,
        terminalSha256: loaded.terminalSha256,
      },
    };
  }

  async function evaluateLoaded(laneRoot, observerReceipt) {
    const [loaded] = await listEvidenceAttempts(laneRoot);
    return evaluateEligibility({
      lane: "sealed-package",
      attempt: loaded,
      candidate,
      review: {
        reviewer: "independent",
        verdict: "ACCEPT",
        subject: { ...candidate },
      },
      observer: observerReceipt,
    });
  }

  it("(a) refuses a coordinated post-run replacement of report.json and a consistent rewrite of terminal.json", async () => {
    const {
      laneRoot,
      attemptId: identifier,
      directory,
    } = await sealedAttempt();
    const observerReceipt = await healthyObserverFor(laneRoot, identifier);

    // Coordinated tamper: replace report.json, then rewrite terminal.json's
    // own byproduct record to match the new bytes -- the loader's
    // self-consistency check (byproductReasons in evidence-attempt.mjs)
    // sees nothing wrong, because both files were rewritten together.
    const reportPath = path.join(directory, "report.json");
    const newReport = JSON.stringify({ status: "PASS", tampered: true });
    await fs.writeFile(reportPath, newReport);
    const newHash = createHash("sha256")
      .update(Buffer.from(newReport))
      .digest("hex");

    const terminalPath = path.join(directory, "terminal.json");
    const terminal = JSON.parse(await fs.readFile(terminalPath, "utf8"));
    terminal.byproducts = terminal.byproducts.map((record) =>
      record.path === "report.json"
        ? { ...record, bytes: Buffer.byteLength(newReport), sha256: newHash }
        : record,
    );
    await fs.writeFile(terminalPath, JSON.stringify(terminal));

    const [loaded] = await listEvidenceAttempts(laneRoot);
    expect(loaded.verification).toEqual({ receipts: [], byproducts: [] });

    const result = await evaluateLoaded(laneRoot, observerReceipt);
    expect(result.acceptable).toBe(false);
    expect(result.reasons).toContain("OBSERVER_BYPRODUCT_MISMATCH:report.json");
    expect(result.reasons).toContain("OBSERVER_TERMINAL_MISMATCH");
  });

  it("(b) accepts an untouched attempt against the observer's own inventory", async () => {
    const { laneRoot, attemptId: identifier } = await sealedAttempt();
    const observerReceipt = await healthyObserverFor(laneRoot, identifier);
    expect(await evaluateLoaded(laneRoot, observerReceipt)).toMatchObject({
      acceptable: true,
      reasons: [],
    });
  });

  it("(c) refuses an observer receipt that never sealed a terminal digest", async () => {
    const { laneRoot, attemptId: identifier } = await sealedAttempt();
    const observerReceipt = await healthyObserverFor(laneRoot, identifier);
    delete observerReceipt.effects.terminalSha256;
    const result = await evaluateLoaded(laneRoot, observerReceipt);
    expect(result.acceptable).toBe(false);
    expect(result.reasons).toEqual(["OBSERVER_TERMINAL_UNSEALED"]);
  });
});
