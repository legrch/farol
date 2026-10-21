import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_FIELD,
  CURRENT_PACKAGE_COMMAND,
  EXPECTED_COUNT_FIELD,
  RETIRED_PACKAGE_COMMAND,
  RETIRED_PACKAGE_STEP,
  VERDICT_FIELD,
  validateLedger,
} from "../../tooling/completion-ledger-validate.mjs";

const CLI = fileURLToPath(
  new URL("../../tooling/completion-ledger-validate.mjs", import.meta.url),
);

const CANDIDATE = "a".repeat(40);
const OTHER_CANDIDATE = "b".repeat(40);
const THIRD_CANDIDATE = "c".repeat(40);

// A ledger and catalog pair that agrees with itself in every way the five
// rules check: two rows, both accounted for in `summary`, both present
// exactly once in the catalog, both current subjects equal to the declared
// candidate, the DONE row backed by a non-historical binding and a PROVEN
// currentProof, and no retired command witness anywhere.
function baseCatalog() {
  return {
    expectedCount: 2,
    requirements: [
      { id: "R1", title: "one" },
      { id: "R2", title: "two" },
    ],
  };
}

function baseLedger() {
  return {
    candidate: { sourceCommit: CANDIDATE },
    catalog: "./catalog.json",
    summary: { DONE: 1, VISIBLE_OPEN: 1 },
    requirements: [
      {
        id: "R1",
        [VERDICT_FIELD]: "DONE",
        bindings: [{ lane: "sealed-package", attemptId: "x", cases: [] }],
        commandWitnesses: [],
        currentProof: { candidate: CANDIDATE, verdict: "PROVEN" },
      },
      {
        id: "R2",
        [VERDICT_FIELD]: "VISIBLE_OPEN",
        bindings: [],
        commandWitnesses: [],
        currentProof: { candidate: CANDIDATE, verdict: "UNPROVEN" },
      },
    ],
  };
}

describe("completion-ledger-validate: a consistent ledger passes", () => {
  it("reports no violations for the base fixture", () => {
    const result = validateLedger({
      ledger: baseLedger(),
      catalog: baseCatalog(),
    });
    expect(result.violations).toEqual([]);
    expect(result.verdictField).toBe(VERDICT_FIELD);
    expect(result.declaredCandidate).toBe(CANDIDATE);
  });

  it("passes a history-marked binding on a non-DONE row and alongside a current binding on a DONE row", () => {
    const ledger = baseLedger();
    // R2 is not DONE, so an entirely historical binding is fine.
    ledger.requirements[1].bindings = [
      {
        lane: "sealed-package",
        attemptId: "old",
        cases: [],
        historical: { reason: "cited under candidate aaaa or earlier" },
      },
    ];
    // R1 is DONE; the historical binding sits alongside a current one, so
    // the row still has current proof.
    ledger.requirements[0].bindings.push({
      lane: "sealed-package",
      attemptId: "old",
      cases: [],
      historical: { reason: "cited under candidate aaaa or earlier" },
    });
    const result = validateLedger({ ledger, catalog: baseCatalog() });
    expect(result.violations).toEqual([]);
  });
});

describe("completion-ledger-validate: rule 1 - summary must equal the rows' verdict field", () => {
  it("flags a summary count that disagrees with the rows' declared verdict field", () => {
    const ledger = baseLedger();
    ledger.summary.DONE = 2; // rows only have one DONE row
    const result = validateLedger({ ledger, catalog: baseCatalog() });
    const violation = result.violations.find(
      (entry) => entry.rule === "SUMMARY_COUNT_MISMATCH",
    );
    expect(violation).toBeDefined();
    expect(violation.detail).toContain(VERDICT_FIELD);
    expect(violation.detail).toContain("summary.DONE=2");
  });
});

describe("completion-ledger-validate: rule 2 - requirement identity", () => {
  it("flags a duplicate id and a requirement missing from the catalog's declared total", () => {
    const catalog = baseCatalog();
    const ledger = baseLedger();
    // Two rows named R1, none named R2: the count still matches
    // catalog.expectedCount (2), so this isolates duplicate/missing
    // detection from the count check.
    ledger.requirements[1] = { ...ledger.requirements[0] };
    const result = validateLedger({ ledger, catalog });
    expect(
      result.violations.some(
        (entry) =>
          entry.rule === "DUPLICATE_REQUIREMENT_ID" && entry.id === "R1",
      ),
    ).toBe(true);
    expect(
      result.violations.some(
        (entry) => entry.rule === "MISSING_REQUIREMENT_ID" && entry.id === "R2",
      ),
    ).toBe(true);
  });

  it("flags a row count other than the catalog's declared total, naming the field", () => {
    const catalog = baseCatalog();
    const ledger = baseLedger();
    ledger.requirements.pop();
    ledger.summary = { DONE: 1 };
    const result = validateLedger({ ledger, catalog });
    const violation = result.violations.find(
      (entry) => entry.rule === "REQUIREMENT_COUNT_MISMATCH",
    );
    expect(violation).toBeDefined();
    expect(violation.detail).toContain(EXPECTED_COUNT_FIELD);
    expect(violation.detail).toContain("requirements.length=1");
  });
});

describe("completion-ledger-validate: rule 3 - current subject agreement", () => {
  it("flags a row whose current subject is not the declared candidate", () => {
    const ledger = baseLedger();
    ledger.requirements[0].currentProof.candidate = OTHER_CANDIDATE;
    const result = validateLedger({ ledger, catalog: baseCatalog() });
    const violation = result.violations.find(
      (entry) =>
        entry.rule === "SUBJECT_NOT_CURRENT_CANDIDATE" && entry.id === "R1",
    );
    expect(violation).toBeDefined();
    expect(violation.detail).toContain(CANDIDATE_FIELD);
  });

  it("flags a row whose current evidence mixes two different subjects", () => {
    const ledger = baseLedger();
    ledger.requirements[0].commandWitnesses = [
      {
        label: "L-CMP",
        step: "computer-package",
        head: THIRD_CANDIDATE,
        exit: 0,
      },
    ];
    // currentProof.candidate stays CANDIDATE, so this row now names two
    // different subjects in its own current evidence.
    const result = validateLedger({ ledger, catalog: baseCatalog() });
    const violation = result.violations.find(
      (entry) => entry.rule === "MIXED_CURRENT_SUBJECT" && entry.id === "R1",
    );
    expect(violation).toBeDefined();
    expect(violation.detail).toContain(CANDIDATE);
    expect(violation.detail).toContain(THIRD_CANDIDATE);
  });
});

describe("completion-ledger-validate: rule 4 - DONE rows need current proof", () => {
  it("flags a DONE row with no bindings at all", () => {
    const ledger = baseLedger();
    ledger.requirements[0].bindings = [];
    const result = validateLedger({ ledger, catalog: baseCatalog() });
    expect(
      result.violations.some(
        (entry) => entry.rule === "DONE_PROOF_MISSING" && entry.id === "R1",
      ),
    ).toBe(true);
  });

  it("flags a DONE row whose only bindings are historical (a stale attempt reused under a new header)", () => {
    const ledger = baseLedger();
    ledger.requirements[0].bindings = [
      {
        lane: "sealed-package",
        attemptId: "old",
        cases: [],
        historical: { reason: "cited under candidate aaaa or earlier" },
      },
    ];
    const result = validateLedger({ ledger, catalog: baseCatalog() });
    expect(
      result.violations.some(
        (entry) =>
          entry.rule === "DONE_PROOF_STALE_ATTEMPT" && entry.id === "R1",
      ),
    ).toBe(true);
  });

  it("flags a DONE row whose currentProof.verdict is not PROVEN", () => {
    const ledger = baseLedger();
    ledger.requirements[0].currentProof.verdict = "UNPROVEN";
    const result = validateLedger({ ledger, catalog: baseCatalog() });
    const violation = result.violations.find(
      (entry) => entry.rule === "DONE_PROOF_UNPROVEN" && entry.id === "R1",
    );
    expect(violation).toBeDefined();
    expect(violation.detail).toContain("UNPROVEN");
  });
});

describe("completion-ledger-validate: rule 5 - no retired entrypoint", () => {
  it("flags a commandWitnesses step naming the retired npm run package entrypoint", () => {
    const ledger = baseLedger();
    ledger.requirements[0].commandWitnesses = [
      { label: "L-PKG", step: RETIRED_PACKAGE_STEP, head: CANDIDATE, exit: 0 },
    ];
    const result = validateLedger({ ledger, catalog: baseCatalog() });
    const violation = result.violations.find(
      (entry) => entry.rule === "RETIRED_ENTRYPOINT" && entry.id === "R1",
    );
    expect(violation).toBeDefined();
    expect(violation.detail).toContain(RETIRED_PACKAGE_COMMAND);
    expect(violation.detail).toContain(CURRENT_PACKAGE_COMMAND);
  });
});

describe("completion-ledger-validate: CLI wiring", () => {
  let tempDir;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("exits 0 on a consistent fixture and non-zero on a drifted one, printing rule names", async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-completion-ledger-validate-"),
    );
    const catalogPath = path.join(tempDir, "catalog.json");
    const cleanLedgerPath = path.join(tempDir, "clean-ledger.json");
    const driftedLedgerPath = path.join(tempDir, "drifted-ledger.json");

    await fs.writeFile(catalogPath, JSON.stringify(baseCatalog()));
    await fs.writeFile(cleanLedgerPath, JSON.stringify(baseLedger()));

    const drifted = baseLedger();
    drifted.summary.DONE = 2; // disagrees with the one DONE row
    await fs.writeFile(driftedLedgerPath, JSON.stringify(drifted));

    const clean = spawnSync(process.execPath, [CLI, cleanLedgerPath], {
      encoding: "utf8",
    });
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("RESULT: PASS");

    const failing = spawnSync(process.execPath, [CLI, driftedLedgerPath], {
      encoding: "utf8",
    });
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("[SUMMARY_COUNT_MISMATCH]");
    expect(failing.stdout).toContain("RESULT: FAIL");
  });

  it("prints usage and exits non-zero when no ledger path is given", () => {
    const result = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });
});
