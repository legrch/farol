import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  listEvidenceAttempts,
  openEvidenceAttempt,
} from "../../tooling/evidence-attempt.mjs";
import { EVIDENCE_LANES } from "../../tooling/evidence-cases.mjs";
import { evaluateBindings } from "../../tooling/evidence-bindings.mjs";

const CLI = fileURLToPath(
  new URL("../../tooling/evidence-bindings.mjs", import.meta.url),
);

const candidate = Object.freeze({
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  artifactSha256: "c".repeat(64),
});

const TERMINAL_SHA256 = "e".repeat(64);

// A loaded attempt shaped exactly like listEvidenceAttempts returns, built
// without touching disk. `input` overrides only the named fields of the
// started receipt's subject, so a single-field drift (e.g. an old
// sourceCommit) can be tested in isolation from the other two.
function fixtureAttempt(lane, attemptId, options = {}) {
  const {
    status = "PASS",
    input = {},
    cases,
    blockedCases = [],
    byproducts,
    verification = { receipts: [], byproducts: [] },
    terminalSha256 = TERMINAL_SHA256,
    exitCode = 0,
  } = options;
  const contractCases = [...EVIDENCE_LANES[lane].cases];
  const normalized = cases ?? contractCases;
  const requiredPath = lane === "hunt" ? "path.json" : "report.json";
  return {
    attemptId,
    status,
    started: {
      attemptId,
      lane,
      input: { ...candidate, ...input },
      startedAt: "2026-09-18T09:00:00.000Z",
    },
    terminal: {
      attemptId,
      lane,
      status,
      startedAt: "2026-09-18T09:00:00.000Z",
      endedAt: "2026-09-18T09:10:00.000Z",
      firstFailure: null,
      cases: { raw: normalized, normalized: [...normalized].sort() },
      blockedCases,
      skippedCases: [],
      byproducts: byproducts ?? [
        { path: requiredPath, bytes: 10, sha256: "d".repeat(64) },
      ],
    },
    exit: { attemptId, exitCode },
    terminalSha256,
    verification,
  };
}

// An observer receipt that watched exactly the attempt named above, over an
// interval covering fixtureAttempt's default started/ended timestamps.
function observerFixture(lane, attemptId, overrides = {}) {
  const requiredPath = lane === "hunt" ? "path.json" : "report.json";
  return {
    schema: "farol.next.effect-observer/v1",
    healthy: true,
    lane,
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
      byproducts: [{ path: requiredPath, bytes: 10, sha256: "d".repeat(64) }],
      terminalSha256: TERMINAL_SHA256,
    },
    ...overrides,
  };
}

describe("evidence-bindings: proving a ledger row against real attempt receipts", () => {
  it("PROVEN row: current attempt, matching cited case, agreeing lane summary", () => {
    const attemptId = "20260918T090000000Z-0000000a";
    const attempt = fixtureAttempt("sealed-package", attemptId);
    const attempts = { "sealed-package": [attempt] };
    const observers = {
      "sealed-package": observerFixture("sealed-package", attemptId),
    };
    const citedCase = EVIDENCE_LANES["sealed-package"].cases[0];
    const ledger = {
      candidate,
      lanes: [{ lane: "sealed-package", attemptId, rawOutcome: "PASS" }],
      requirements: [
        {
          id: "R1",
          u2: "DONE",
          bindings: [{ lane: "sealed-package", attemptId, cases: [citedCase] }],
        },
      ],
    };
    const result = evaluateBindings({ ledger, candidate, attempts, observers });
    expect(result.header.reasons).toEqual([]);
    expect(result.lanes).toEqual([
      { lane: "sealed-package", attemptId, rawOutcome: "PASS", reasons: [] },
    ]);
    expect(result.requirements).toEqual([
      {
        id: "R1",
        u2: "DONE",
        verdict: "PROVEN",
        bindings: [
          {
            lane: "sealed-package",
            attemptId,
            historical: false,
            verdict: "OK",
            reasons: [],
          },
        ],
        reasons: [],
      },
    ]);
    expect(result.summary).toEqual({ counts: { PROVEN: 1 }, doneUnproven: [] });
  });

  it("holds a development lane to the development build of the same source", () => {
    const developmentCandidate = Object.freeze({
      sourceCommit: candidate.sourceCommit,
      sourceTreeDigest: candidate.sourceTreeDigest,
      artifactSha256: "f".repeat(64),
    });
    const attemptId = "20260918T090000000Z-0000000d";
    const attempt = fixtureAttempt("development-build", attemptId, {
      input: { artifactSha256: developmentCandidate.artifactSha256 },
    });
    const observer = observerFixture("development-build", attemptId, {
      subject: {
        sourceCommit: candidate.sourceCommit,
        artifactSha256: developmentCandidate.artifactSha256,
      },
    });
    const ledger = {
      candidate: {
        ...candidate,
        developmentArtifactSha256: developmentCandidate.artifactSha256,
      },
      lanes: [],
      requirements: [
        {
          id: "R-DEV",
          u2: "DONE",
          bindings: [
            {
              lane: "development-build",
              attemptId,
              cases: ["development-build-identity"],
            },
          ],
        },
      ],
    };
    const attempts = { "development-build": [attempt] };
    const observers = { "development-build": observer };

    const proven = evaluateBindings({
      ledger,
      candidate,
      attempts,
      observers,
      developmentCandidate,
    });
    expect(proven.header.reasons).toEqual([]);
    expect(proven.requirements[0].verdict).toBe("PROVEN");

    // Without the development subject the same attempt is measured against
    // the sealed package and is refused rather than silently accepted.
    const sealedOnly = evaluateBindings({
      ledger,
      candidate,
      attempts,
      observers,
    });
    expect(sealedOnly.requirements[0].bindings[0].reasons).toContain(
      "WRONG_SUBJECT:artifactSha256",
    );
    expect(sealedOnly.requirements[0].reasons).toEqual(["DONE_UNPROVEN"]);

    // A development build of another source, or a header naming another
    // development build, is a header mismatch.
    const foreign = evaluateBindings({
      ledger: {
        ...ledger,
        candidate: { ...candidate, developmentArtifactSha256: "0".repeat(64) },
      },
      candidate,
      attempts,
      observers,
      developmentCandidate: {
        ...developmentCandidate,
        sourceCommit: "9".repeat(40),
      },
    });
    expect(foreign.header.reasons).toEqual([
      "DEVELOPMENT_SOURCE_MISMATCH:sourceCommit",
      "HEADER_MISMATCH:developmentArtifactSha256",
    ]);
  });

  it("a case executed before a lane stopped BLOCKED proves its row; a failed run's exit does not", () => {
    const [executedCase, blockedCase] = EVIDENCE_LANES["sealed-package"].cases;
    const row = (attemptId) => ({
      candidate,
      lanes: [],
      requirements: [
        {
          id: "R-EXIT",
          u2: "DONE",
          bindings: [
            { lane: "sealed-package", attemptId, cases: [executedCase] },
          ],
        },
      ],
    });
    const blockedId = "20260918T090000000Z-000000b1";
    const blocked = fixtureAttempt("sealed-package", blockedId, {
      status: "BLOCKED",
      exitCode: 1,
      cases: [executedCase],
      blockedCases: [{ name: blockedCase, reason: "display unavailable" }],
    });
    const provenByBlocked = evaluateBindings({
      ledger: row(blockedId),
      candidate,
      attempts: { "sealed-package": [blocked] },
      observers: {
        "sealed-package": observerFixture("sealed-package", blockedId),
      },
    });
    expect(provenByBlocked.requirements[0].bindings[0].reasons).toEqual([]);
    expect(provenByBlocked.requirements[0].verdict).toBe("PROVEN");

    const failedId = "20260918T090000000Z-000000f1";
    const failed = fixtureAttempt("sealed-package", failedId, {
      status: "FAIL",
      exitCode: 1,
      cases: [executedCase],
    });
    const refusedByFailure = evaluateBindings({
      ledger: row(failedId),
      candidate,
      attempts: { "sealed-package": [failed] },
      observers: {
        "sealed-package": observerFixture("sealed-package", failedId),
      },
    });
    expect(refusedByFailure.requirements[0].bindings[0].reasons).toContain(
      "EXIT_NONZERO:1",
    );
    expect(refusedByFailure.requirements[0].reasons).toEqual(["DONE_UNPROVEN"]);
  });

  it("a binding that cites no case stands for the whole lane, which only a passing run proves", () => {
    const [executedCase, blockedCase] = EVIDENCE_LANES["sealed-package"].cases;
    const wholeLane = (attemptId) => ({
      candidate,
      lanes: [],
      requirements: [
        {
          id: "R-WHOLE",
          u2: "DONE",
          bindings: [{ lane: "sealed-package", attemptId, cases: [] }],
        },
      ],
    });
    const blockedId = "20260918T090000000Z-000000b2";
    const blocked = fixtureAttempt("sealed-package", blockedId, {
      status: "BLOCKED",
      exitCode: 1,
      cases: [executedCase],
      blockedCases: [{ name: blockedCase, reason: "display unavailable" }],
    });
    const byBlocked = evaluateBindings({
      ledger: wholeLane(blockedId),
      candidate,
      attempts: { "sealed-package": [blocked] },
      observers: {
        "sealed-package": observerFixture("sealed-package", blockedId),
      },
    });
    expect(byBlocked.requirements[0].bindings[0].reasons).toEqual([
      "LANE_NOT_PASSED:BLOCKED",
    ]);
    expect(byBlocked.requirements[0].verdict).toBe("UNPROVEN");
    expect(byBlocked.requirements[0].reasons).toEqual(["DONE_UNPROVEN"]);

    const passedId = "20260918T090000000Z-000000a2";
    const passed = fixtureAttempt("sealed-package", passedId);
    const byPassed = evaluateBindings({
      ledger: wholeLane(passedId),
      candidate,
      attempts: { "sealed-package": [passed] },
      observers: {
        "sealed-package": observerFixture("sealed-package", passedId),
      },
    });
    expect(byPassed.requirements[0].bindings[0].reasons).toEqual([]);
    expect(byPassed.requirements[0].verdict).toBe("PROVEN");
  });

  it("refuses a structured lane entry that is incomplete and a requirement id given twice", () => {
    const result = evaluateBindings({
      ledger: {
        candidate,
        lanes: [
          { name: "root gate", command: "task ci:fast", result: "PASS" },
          { lane: "sealed-package", attemptId: 7, rawOutcome: "PASS" },
        ],
        requirements: [
          { id: "R-A", u2: "OPEN", bindings: [] },
          { id: "R-A", u2: "OPEN", bindings: [] },
          { u2: "OPEN", bindings: [] },
        ],
      },
      candidate,
      attempts: {},
      observers: null,
    });
    expect(result.header.reasons).toEqual(
      expect.arrayContaining([
        "LANE_ENTRY_MALFORMED:1",
        "REQUIREMENT_ID_DUPLICATE:R-A",
        "REQUIREMENT_ID_INVALID:2",
      ]),
    );
    expect(result.header.reasons).not.toContain("LANE_ENTRY_MALFORMED:0");
  });

  it("refuses a ledger that declares no requirements at all", () => {
    const result = evaluateBindings({
      ledger: { candidate, lanes: [], requirements: [] },
      candidate,
      attempts: {},
      observers: null,
    });
    expect(result.header.reasons).toContain("LEDGER_EMPTY");
  });

  it("refuses a candidate whose identity fields are missing or malformed, however equal they compare", () => {
    const hollow = {
      sourceCommit: undefined,
      sourceTreeDigest: "x",
      artifactSha256: undefined,
    };
    const attemptId = "20260918T090000000Z-000000c3";
    const attempt = fixtureAttempt("sealed-package", attemptId, {
      input: {
        sourceCommit: undefined,
        sourceTreeDigest: "x",
        artifactSha256: undefined,
      },
    });
    const result = evaluateBindings({
      ledger: {
        candidate: hollow,
        lanes: [],
        requirements: [
          {
            id: "R-HOLLOW",
            u2: "DONE",
            bindings: [
              {
                lane: "sealed-package",
                attemptId,
                cases: [EVIDENCE_LANES["sealed-package"].cases[0]],
              },
            ],
          },
        ],
      },
      candidate: hollow,
      attempts: { "sealed-package": [attempt] },
      observers: {
        "sealed-package": observerFixture("sealed-package", attemptId, {
          subject: { sourceCommit: undefined, artifactSha256: undefined },
        }),
      },
    });
    expect(result.header.reasons).toEqual(
      expect.arrayContaining([
        "CANDIDATE_IDENTITY_INVALID:sourceCommit",
        "CANDIDATE_IDENTITY_INVALID:sourceTreeDigest",
        "CANDIDATE_IDENTITY_INVALID:artifactSha256",
      ]),
    );
    expect(result.requirements[0].verdict).toBe("UNPROVEN");
  });

  it("does not hold a development lane to the sealed subject when no development candidate is named", () => {
    const [firstCase] = EVIDENCE_LANES["development-build"].cases;
    const attemptId = "20260918T090000000Z-000000d4";
    const attempt = fixtureAttempt("development-build", attemptId);
    const result = evaluateBindings({
      ledger: {
        candidate,
        lanes: [],
        requirements: [
          {
            id: "R-DEV",
            u2: "DONE",
            bindings: [
              { lane: "development-build", attemptId, cases: [firstCase] },
            ],
          },
        ],
      },
      candidate,
      attempts: { "development-build": [attempt] },
      observers: {
        "development-build": observerFixture("development-build", attemptId),
      },
    });
    expect(result.requirements[0].bindings[0].reasons).toContain(
      "DEVELOPMENT_CANDIDATE_REQUIRED",
    );
    expect(result.requirements[0].verdict).toBe("UNPROVEN");
  });

  it("a clean binding marked historical never proves a row on its own", () => {
    // The same current, observed attempt as the positive control, only
    // declared historical: its integrity is clean, but a historical citation
    // is never current proof, so the DONE row stays unproven.
    const attemptId = "20260918T090000000Z-0000000a";
    const attempts = {
      "sealed-package": [fixtureAttempt("sealed-package", attemptId)],
    };
    const observers = {
      "sealed-package": observerFixture("sealed-package", attemptId),
    };
    const citedCase = EVIDENCE_LANES["sealed-package"].cases[0];
    const ledger = {
      candidate,
      lanes: [],
      requirements: [
        {
          id: "R-HIST",
          u2: "DONE",
          bindings: [
            {
              lane: "sealed-package",
              attemptId,
              cases: [citedCase],
              historical: { reason: "earlier freeze" },
            },
          ],
        },
      ],
    };
    const result = evaluateBindings({ ledger, candidate, attempts, observers });
    expect(result.requirements[0].bindings[0]).toMatchObject({
      historical: true,
      verdict: "HISTORICAL",
      reasons: [],
    });
    expect(result.requirements[0].verdict).toBe("UNPROVEN");
    expect(result.requirements[0].reasons).toEqual(["DONE_UNPROVEN"]);
  });

  it("ATTEMPT_LANE_MISMATCH: the cited attemptId exists only under another lane", () => {
    const foreignId = "20260918T080000000Z-0000000b";
    const foreignAttempt = fixtureAttempt("development-build", foreignId);
    const attempts = {
      "development-build": [foreignAttempt],
      "sealed-package": [],
    };
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R2",
          u2: "OPEN",
          bindings: [
            { lane: "sealed-package", attemptId: foreignId, cases: [] },
          ],
        },
      ],
    };
    const result = evaluateBindings({
      ledger,
      candidate,
      attempts,
      observers: null,
    });
    expect(result.requirements[0].bindings[0]).toEqual({
      lane: "sealed-package",
      attemptId: foreignId,
      historical: false,
      verdict: "INVALID",
      reasons: ["ATTEMPT_LANE_MISMATCH"],
    });
    expect(result.requirements[0].verdict).toBe("UNPROVEN");
  });

  it("BINDING_ATTEMPT_MISSING: the cited attemptId does not exist in any lane", () => {
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R3",
          u2: "OPEN",
          bindings: [
            { lane: "sealed-package", attemptId: "does-not-exist", cases: [] },
          ],
        },
      ],
    };
    const result = evaluateBindings({
      ledger,
      candidate,
      attempts: { "sealed-package": [] },
      observers: null,
    });
    expect(result.requirements[0].bindings[0].reasons).toEqual([
      "BINDING_ATTEMPT_MISSING",
    ]);
  });

  it("WRONG_SUBJECT:artifactSha256: correct lane, but the attempt's recorded subject names another artifact", () => {
    const attemptId = "20260918T090000000Z-0000000c";
    const attempt = fixtureAttempt("sealed-package", attemptId, {
      input: { artifactSha256: "f".repeat(64) },
    });
    const attempts = { "sealed-package": [attempt] };
    const observers = {
      "sealed-package": observerFixture("sealed-package", attemptId),
    };
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R4",
          u2: "OPEN",
          bindings: [{ lane: "sealed-package", attemptId, cases: [] }],
        },
      ],
    };
    const result = evaluateBindings({ ledger, candidate, attempts, observers });
    expect(result.requirements[0].bindings[0].reasons).toEqual([
      "WRONG_SUBJECT:artifactSha256",
    ]);
  });

  it("DONE_UNPROVEN: a DONE row's bound attempt predates the header commit (WRONG_SUBJECT:sourceCommit)", () => {
    const attemptId = "20260918T090000000Z-0000000d";
    const attempt = fixtureAttempt("sealed-package", attemptId, {
      input: { sourceCommit: "f".repeat(40) },
    });
    const attempts = { "sealed-package": [attempt] };
    const observers = {
      "sealed-package": observerFixture("sealed-package", attemptId),
    };
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R5",
          u2: "DONE",
          bindings: [{ lane: "sealed-package", attemptId, cases: [] }],
        },
      ],
    };
    const result = evaluateBindings({ ledger, candidate, attempts, observers });
    expect(result.requirements[0].bindings[0].reasons).toEqual([
      "WRONG_SUBJECT:sourceCommit",
    ]);
    expect(result.requirements[0].verdict).toBe("UNPROVEN");
    expect(result.requirements[0].reasons).toEqual(["DONE_UNPROVEN"]);
    expect(result.summary.doneUnproven).toEqual(["R5"]);
  });

  it("CASE_NOT_EXECUTED: the cited case never appears among the attempt's executed cases", () => {
    const attemptId = "20260918T090000000Z-0000000e";
    const contractCases = EVIDENCE_LANES["sealed-package"].cases;
    const missingCase = contractCases[2];
    const executed = contractCases.filter((name) => name !== missingCase);
    const attempt = fixtureAttempt("sealed-package", attemptId, {
      cases: executed,
    });
    const attempts = { "sealed-package": [attempt] };
    const observers = {
      "sealed-package": observerFixture("sealed-package", attemptId),
    };
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R6",
          u2: "OPEN",
          bindings: [
            { lane: "sealed-package", attemptId, cases: [missingCase] },
          ],
        },
      ],
    };
    const result = evaluateBindings({ ledger, candidate, attempts, observers });
    expect(result.requirements[0].bindings[0].reasons).toEqual([
      `CASE_NOT_EXECUTED:${missingCase}`,
    ]);
  });

  it("CASE_BLOCKED: the cited case is explicitly blocked, not merely absent", () => {
    const attemptId = "20260918T090000000Z-0000000f";
    const contractCases = EVIDENCE_LANES["sealed-package"].cases;
    const blockedCase = contractCases[3];
    const executed = contractCases.filter((name) => name !== blockedCase);
    const attempt = fixtureAttempt("sealed-package", attemptId, {
      cases: executed,
      blockedCases: [{ name: blockedCase, reason: "no secondary display" }],
    });
    const attempts = { "sealed-package": [attempt] };
    const observers = {
      "sealed-package": observerFixture("sealed-package", attemptId),
    };
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R7",
          u2: "OPEN",
          bindings: [
            { lane: "sealed-package", attemptId, cases: [blockedCase] },
          ],
        },
      ],
    };
    const result = evaluateBindings({ ledger, candidate, attempts, observers });
    expect(result.requirements[0].bindings[0].reasons).toEqual([
      `CASE_BLOCKED:${blockedCase}`,
    ]);
  });

  it("CASE_UNDECLARED: the cited case is not part of the lane's own contract", () => {
    const attemptId = "20260918T090000000Z-00000010";
    const attempt = fixtureAttempt("sealed-package", attemptId);
    const attempts = { "sealed-package": [attempt] };
    const observers = {
      "sealed-package": observerFixture("sealed-package", attemptId),
    };
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R8",
          u2: "OPEN",
          bindings: [
            {
              lane: "sealed-package",
              attemptId,
              cases: ["not-a-real-case"],
            },
          ],
        },
      ],
    };
    const result = evaluateBindings({ ledger, candidate, attempts, observers });
    expect(result.requirements[0].bindings[0].reasons).toEqual([
      "CASE_UNDECLARED:not-a-real-case",
    ]);
  });

  it("LANE_SUMMARY_MISMATCH: header claims PASS over a really-BLOCKED attempt, yet a passing cited case still proves its row", () => {
    const attemptId = "20260918T090000000Z-00000011";
    const contractCases = EVIDENCE_LANES["development-build"].cases;
    const blockedCase = contractCases[0];
    const provenCase = contractCases[1];
    const executed = contractCases.slice(1);
    const attempt = fixtureAttempt("development-build", attemptId, {
      status: "BLOCKED",
      cases: executed,
      blockedCases: [{ name: blockedCase, reason: "no secondary display" }],
    });
    const attempts = { "development-build": [attempt] };
    const observers = {
      "development-build": observerFixture("development-build", attemptId),
    };
    const ledger = {
      candidate: {
        ...candidate,
        developmentArtifactSha256: candidate.artifactSha256,
      },
      lanes: [{ lane: "development-build", attemptId, rawOutcome: "PASS" }],
      requirements: [
        {
          id: "R9",
          u2: "DONE",
          bindings: [
            { lane: "development-build", attemptId, cases: [provenCase] },
          ],
        },
      ],
    };
    const result = evaluateBindings({
      ledger,
      candidate,
      attempts,
      observers,
      developmentCandidate: candidate,
    });
    expect(result.lanes).toEqual([
      {
        lane: "development-build",
        attemptId,
        rawOutcome: "PASS",
        reasons: ["LANE_SUMMARY_MISMATCH:development-build"],
      },
    ]);
    expect(result.requirements[0].verdict).toBe("PROVEN");
    expect(result.requirements[0].reasons).toEqual([]);
    expect(result.summary.doneUnproven).toEqual([]);
  });

  it("OBSERVER_ATTEMPT_MISMATCH: the observer receipt names a different attempt", () => {
    const attemptId = "20260918T090000000Z-00000012";
    const attempt = fixtureAttempt("sealed-package", attemptId);
    const attempts = { "sealed-package": [attempt] };
    const observers = {
      "sealed-package": observerFixture(
        "sealed-package",
        "20260918T080000000Z-00000099",
      ),
    };
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R10",
          u2: "OPEN",
          bindings: [{ lane: "sealed-package", attemptId, cases: [] }],
        },
      ],
    };
    const result = evaluateBindings({ ledger, candidate, attempts, observers });
    expect(result.requirements[0].bindings[0].reasons).toEqual([
      "OBSERVER_ATTEMPT_MISMATCH",
    ]);
  });

  it("HEADER_MISMATCH: the ledger's own header disagrees with the candidate being accepted", () => {
    const ledger = {
      candidate: {
        ...candidate,
        sourceCommit: "f".repeat(40),
        artifactSha256: "f".repeat(64),
      },
      requirements: [],
    };
    const result = evaluateBindings({
      ledger,
      candidate,
      attempts: {},
      observers: null,
    });
    expect(result.header.reasons).toEqual([
      "HEADER_MISMATCH:sourceCommit",
      "HEADER_MISMATCH:artifactSha256",
      "LEDGER_EMPTY",
    ]);
  });

  it("current header over historical row refs: every DONE row bound only to an old attempt stays DONE_UNPROVEN, marking it historical does not rescue it", () => {
    const oldCandidate = {
      sourceCommit: "f".repeat(40),
      sourceTreeDigest: "g".repeat(64),
      artifactSha256: "h".repeat(64),
    };
    const oldAttemptId = "20260910T090000000Z-000000aa";
    const oldAttempt = fixtureAttempt("sealed-package", oldAttemptId, {
      input: oldCandidate,
    });
    const attempts = { "sealed-package": [oldAttempt] };
    const observers = {
      "sealed-package": observerFixture("sealed-package", oldAttemptId, {
        subject: {
          sourceCommit: oldCandidate.sourceCommit,
          artifactSha256: oldCandidate.artifactSha256,
        },
      }),
    };
    const rows = ["ROW-1", "ROW-2", "ROW-3"].map((id) => ({
      id,
      u2: "DONE",
      bindings: [
        { lane: "sealed-package", attemptId: oldAttemptId, cases: [] },
      ],
    }));

    // Header is the new candidate; every row still cites the old attempt.
    const current = evaluateBindings({
      ledger: { candidate, requirements: rows },
      candidate,
      attempts,
      observers,
    });
    for (const requirement of current.requirements) {
      expect(requirement.verdict).toBe("UNPROVEN");
      expect(requirement.reasons).toEqual(["DONE_UNPROVEN"]);
      expect(requirement.bindings[0].verdict).toBe("INVALID");
      expect(requirement.bindings[0].reasons).toContain(
        "WRONG_SUBJECT:sourceCommit",
      );
    }
    expect(current.summary.doneUnproven).toEqual(["ROW-1", "ROW-2", "ROW-3"]);

    // Marking the same bindings historical documents the fact honestly, but
    // a historical binding never counts as current proof, so a DONE row
    // stays DONE_UNPROVEN either way.
    const historicalRows = rows.map((requirement) => ({
      ...requirement,
      bindings: requirement.bindings.map((binding) => ({
        ...binding,
        historical: { reason: "superseded by a newer attempt" },
      })),
    }));
    const historical = evaluateBindings({
      ledger: { candidate, requirements: historicalRows },
      candidate,
      attempts,
      observers,
    });
    for (const requirement of historical.requirements) {
      expect(requirement.verdict).toBe("UNPROVEN");
      expect(requirement.reasons).toEqual(["DONE_UNPROVEN"]);
      expect(requirement.bindings[0].verdict).toBe("HISTORICAL");
      expect(requirement.bindings[0].reasons).toContain(
        "WRONG_SUBJECT:sourceCommit",
      );
    }
    expect(historical.summary.doneUnproven).toEqual([
      "ROW-1",
      "ROW-2",
      "ROW-3",
    ]);
  });
});

describe("evidence-bindings: loader-verified integrity and the CLI", () => {
  const roots = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function createSealedAttempt(candidateInput, { cases } = {}) {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-bindings-"),
    );
    const laneRoot = path.join(rootDir, "artifacts", "e2e");
    const opened = await openEvidenceAttempt(laneRoot, {
      lane: "sealed-package",
      input: candidateInput,
    });
    await fs.writeFile(
      path.join(opened.directory, "report.json"),
      JSON.stringify({ status: "PASS" }),
    );
    await opened.finish("PASS", {
      cases: cases ?? [...EVIDENCE_LANES["sealed-package"].cases],
    });
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
      rootDir,
      laneRoot,
      attemptId: opened.attemptId,
      directory: opened.directory,
    };
  }

  it("BYPRODUCT_CHANGED: report.json was rewritten after the run without updating the terminal receipt's own record", async () => {
    const { rootDir, laneRoot, attemptId, directory } =
      await createSealedAttempt(candidate);
    roots.push(rootDir);

    const [before] = await listEvidenceAttempts(laneRoot);
    const observerReceipt = {
      schema: "farol.next.effect-observer/v1",
      healthy: true,
      lane: "sealed-package",
      attemptId,
      subject: {
        sourceCommit: candidate.sourceCommit,
        artifactSha256: candidate.artifactSha256,
      },
      interval: {
        startedAt: "2000-01-01T00:00:00.000Z",
        endedAt: "2100-01-01T00:00:00.000Z",
      },
      effects: {
        processSamples: [
          { at: before.started.startedAt, processes: 1 },
          { at: before.terminal.endedAt, processes: 0 },
        ],
        terminalSeenAt: before.terminal.endedAt,
        byproducts: before.terminal.byproducts,
        terminalSha256: before.terminalSha256,
      },
    };

    // Rewrite only the byproduct, never the terminal receipt that describes
    // it: the loader's own re-hash must catch this on its own.
    await fs.writeFile(
      path.join(directory, "report.json"),
      JSON.stringify({ status: "PASS", tampered: true }),
    );

    const [loaded] = await listEvidenceAttempts(laneRoot);
    expect(loaded.verification.byproducts).toContain(
      "BYPRODUCT_CHANGED:report.json",
    );

    const citedCase = EVIDENCE_LANES["sealed-package"].cases[0];
    const result = evaluateBindings({
      ledger: {
        candidate,
        requirements: [
          {
            id: "R11",
            u2: "OPEN",
            bindings: [
              { lane: "sealed-package", attemptId, cases: [citedCase] },
            ],
          },
        ],
      },
      candidate,
      attempts: { "sealed-package": [loaded] },
      observers: { "sealed-package": observerReceipt },
    });
    expect(result.requirements[0].bindings[0].reasons).toEqual([
      "BYPRODUCT_CHANGED:report.json",
    ]);
    expect(result.requirements[0].verdict).toBe("UNPROVEN");
  });

  it("CLI: exits 0 for a fully current, cleanly bound ledger", async () => {
    const { rootDir, laneRoot, attemptId } =
      await createSealedAttempt(candidate);
    roots.push(rootDir);
    const [loaded] = await listEvidenceAttempts(laneRoot);
    const citedCase = EVIDENCE_LANES["sealed-package"].cases[0];
    const ledger = {
      candidate,
      lanes: [{ lane: "sealed-package", attemptId, rawOutcome: "PASS" }],
      requirements: [
        {
          id: "R12",
          u2: "DONE",
          bindings: [{ lane: "sealed-package", attemptId, cases: [citedCase] }],
        },
      ],
    };
    const observerReceipt = {
      schema: "farol.next.effect-observer/v1",
      healthy: true,
      lane: "sealed-package",
      attemptId,
      subject: {
        sourceCommit: candidate.sourceCommit,
        artifactSha256: candidate.artifactSha256,
      },
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

    const ledgerFile = path.join(rootDir, "ledger.json");
    const candidateFile = path.join(rootDir, "candidate.json");
    const observerFile = path.join(rootDir, "observer.json");
    await fs.writeFile(ledgerFile, JSON.stringify(ledger));
    await fs.writeFile(candidateFile, JSON.stringify(candidate));
    await fs.writeFile(
      observerFile,
      JSON.stringify({ "sealed-package": observerReceipt }),
    );

    const run = spawnSync(
      process.execPath,
      [
        CLI,
        "--ledger",
        ledgerFile,
        "--root",
        rootDir,
        "--candidate",
        candidateFile,
        "--observer",
        observerFile,
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout);
    expect(output.requirements[0].verdict).toBe("PROVEN");
    expect(output.summary.doneUnproven).toEqual([]);
  });

  it("CLI: exits 1 when a DONE row cites only a historical attempt of an older candidate", async () => {
    const oldCandidate = {
      sourceCommit: "f".repeat(40),
      sourceTreeDigest: "g".repeat(64),
      artifactSha256: "h".repeat(64),
    };
    const { rootDir, attemptId } = await createSealedAttempt(oldCandidate);
    roots.push(rootDir);
    const ledger = {
      candidate,
      requirements: [
        {
          id: "R13",
          u2: "DONE",
          bindings: [
            {
              lane: "sealed-package",
              attemptId,
              cases: [],
              historical: { reason: "superseded" },
            },
          ],
        },
      ],
    };
    const ledgerFile = path.join(rootDir, "ledger.json");
    const candidateFile = path.join(rootDir, "candidate.json");
    await fs.writeFile(ledgerFile, JSON.stringify(ledger));
    await fs.writeFile(candidateFile, JSON.stringify(candidate));

    const run = spawnSync(
      process.execPath,
      [
        CLI,
        "--ledger",
        ledgerFile,
        "--root",
        rootDir,
        "--candidate",
        candidateFile,
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    const output = JSON.parse(run.stdout);
    expect(output.summary.doneUnproven).toEqual(["R13"]);
    expect(output.requirements[0].bindings[0].verdict).toBe("HISTORICAL");
  });

  it("CLI: --help and a no-arg run fail cleanly with a one-line usage message, never a stack", () => {
    const helpRun = spawnSync(process.execPath, [CLI, "--help"], {
      encoding: "utf8",
    });
    expect(helpRun.status).not.toBe(0);
    expect(helpRun.stdout).toBe("");
    expect(helpRun.stderr.trim().split("\n")).toHaveLength(1);
    expect(helpRun.stderr).toMatch(/^usage:/u);

    const bareRun = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    expect(bareRun.status).not.toBe(0);
    expect(bareRun.stdout).toBe("");
    expect(bareRun.stderr.trim().split("\n")).toHaveLength(1);
    expect(bareRun.stderr).toMatch(/^usage:/u);
  });
});
