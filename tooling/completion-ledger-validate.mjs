import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Checks a Completion-Ledger.json for internal disagreement with itself. It
// never touches the repository, an attempt directory, or the Requirement
// Catalog's own correctness -- it only compares the ledger's declared
// summary, requirement rows, and requirement catalog against each other and
// reports every place they disagree, naming the exact rule and field.
//
// This is deliberately not evidence-bindings.mjs: that tool re-derives a
// row's PROVEN/UNPROVEN verdict from real attempt receipts on disk. This
// tool trusts nothing it cannot see inside the ledger and the catalog it
// names, and it judges CURRENT rows only -- a binding explicitly marked
// `historical` is read (so a DONE row backed only by history is caught by
// rule 4) but never counted as current proof of anything.

export const COMPLETION_LEDGER_VALIDATE_SCHEMA =
  "farol.next.completion-ledger-validate/v1";

// The rows' single defined verdict field. `summary` is expected to be the
// count of rows grouped by this field's value.
export const VERDICT_FIELD = "u2";
// The ledger's own declared current-candidate subject.
export const CANDIDATE_FIELD = "candidate.sourceCommit";
// The catalog field naming how many requirement rows must exist.
export const EXPECTED_COUNT_FIELD = "catalog.expectedCount";
// The retired npm entrypoint and the entrypoint that replaced it.
export const RETIRED_PACKAGE_STEP = "package";
export const RETIRED_PACKAGE_COMMAND = "npm run package";
export const CURRENT_PACKAGE_COMMAND = "task package";

function pushViolation(violations, violation) {
  violations.push(violation);
  return violations;
}

// Rule 1: the summary block must equal what the rows themselves say, using
// the rows' one defined verdict field (VERDICT_FIELD). Every verdict named
// by either side is checked, so a verdict the summary invents and the rows
// never use is caught too.
function checkSummaryAgreesWithRows(ledger, requirements, violations) {
  const summary = ledger.summary ?? {};
  const actual = new Map();
  for (const row of requirements) {
    const verdict = row[VERDICT_FIELD];
    actual.set(verdict, (actual.get(verdict) ?? 0) + 1);
  }
  const verdicts = new Set([...Object.keys(summary), ...actual.keys()]);
  for (const verdict of verdicts) {
    const declared = summary[verdict] ?? 0;
    const derived = actual.get(verdict) ?? 0;
    if (declared !== derived) {
      pushViolation(violations, {
        rule: "SUMMARY_COUNT_MISMATCH",
        detail:
          `summary.${verdict}=${declared} but ${derived} row(s) have ` +
          `${VERDICT_FIELD}="${verdict}"`,
      });
    }
  }
}

// Rule 2: the row count and requirement IDs must agree with the catalog the
// ledger itself names (`catalog`, resolved by the caller). "94" never
// appears literally here -- it is read from EXPECTED_COUNT_FIELD.
function checkRequirementIdentity(catalog, requirements, violations) {
  const expectedCount = catalog?.expectedCount;
  if (typeof expectedCount !== "number") {
    pushViolation(violations, {
      rule: "CATALOG_EXPECTED_COUNT_UNREADABLE",
      detail: `${EXPECTED_COUNT_FIELD} is missing or not a number`,
    });
  } else if (requirements.length !== expectedCount) {
    pushViolation(violations, {
      rule: "REQUIREMENT_COUNT_MISMATCH",
      detail:
        `requirements.length=${requirements.length} but ` +
        `${EXPECTED_COUNT_FIELD}=${expectedCount}`,
    });
  }

  const seen = new Map();
  for (const row of requirements) {
    seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      pushViolation(violations, {
        rule: "DUPLICATE_REQUIREMENT_ID",
        id,
        detail: `id "${id}" appears ${count} times in requirements`,
      });
    }
  }

  const catalogIds = new Set(
    (Array.isArray(catalog?.requirements) ? catalog.requirements : []).map(
      (entry) => entry.id,
    ),
  );
  const ledgerIds = new Set(seen.keys());
  if (catalogIds.size > 0) {
    for (const id of catalogIds) {
      if (!ledgerIds.has(id)) {
        pushViolation(violations, {
          rule: "MISSING_REQUIREMENT_ID",
          id,
          detail: `catalog id "${id}" has no requirement row in the ledger`,
        });
      }
    }
    for (const id of ledgerIds) {
      if (!catalogIds.has(id)) {
        pushViolation(violations, {
          rule: "UNKNOWN_REQUIREMENT_ID",
          id,
          detail: `requirement row "${id}" is not a catalog id`,
        });
      }
    }
  }
}

// Rule 3: a row's CURRENT evidence -- its `currentProof.candidate` and every
// `commandWitnesses[].head` -- must name exactly one subject, and that
// subject must be the ledger's own declared candidate (CANDIDATE_FIELD).
// `bindings` are not read here: an attemptId alone names no subject, and a
// binding's real subject lives in an attempt receipt this tool does not
// open (see evidence-bindings.mjs, which does).
function checkCurrentSubjectAgreement(
  declaredCandidate,
  requirements,
  violations,
) {
  for (const row of requirements) {
    const subjects = new Set();
    if (row.currentProof?.candidate) subjects.add(row.currentProof.candidate);
    for (const witness of row.commandWitnesses ?? []) {
      if (witness?.head) subjects.add(witness.head);
    }
    if (subjects.size > 1) {
      pushViolation(violations, {
        rule: "MIXED_CURRENT_SUBJECT",
        id: row.id,
        detail:
          `row's current evidence names ${subjects.size} different ` +
          `subjects: ${[...subjects].sort().join(", ")}`,
      });
      continue;
    }
    if (subjects.size === 1) {
      const [subject] = subjects;
      if (declaredCandidate && subject !== declaredCandidate) {
        pushViolation(violations, {
          rule: "SUBJECT_NOT_CURRENT_CANDIDATE",
          id: row.id,
          detail:
            `row's current subject ${subject} does not match the ` +
            `declared ${CANDIDATE_FIELD}=${declaredCandidate}`,
        });
      }
    }
  }
}

// Rule 4: a row claiming DONE (VERDICT_FIELD === "DONE") must have a
// non-empty `bindings` proof field, at least one binding not marked
// `historical` (a DONE row backed only by a stale attempt reused under a
// new header is exactly what `historical` records), and a `currentProof`
// that actually says PROVEN for the current subject.
function checkDoneRowsHaveCurrentProof(requirements, violations) {
  for (const row of requirements) {
    if (row[VERDICT_FIELD] !== "DONE") continue;
    const bindings = Array.isArray(row.bindings) ? row.bindings : [];
    if (bindings.length === 0) {
      pushViolation(violations, {
        rule: "DONE_PROOF_MISSING",
        id: row.id,
        detail: `${VERDICT_FIELD}="DONE" but bindings is absent or empty`,
      });
      continue;
    }
    const current = bindings.filter((binding) => !binding.historical);
    if (current.length === 0) {
      pushViolation(violations, {
        rule: "DONE_PROOF_STALE_ATTEMPT",
        id: row.id,
        detail:
          `${VERDICT_FIELD}="DONE" but every binding is marked historical ` +
          "(a stale attempt reused under a new header, not current proof)",
      });
      continue;
    }
    const verdict = row.currentProof?.verdict;
    if (!verdict) {
      pushViolation(violations, {
        rule: "DONE_PROOF_MISSING",
        id: row.id,
        detail: `${VERDICT_FIELD}="DONE" but currentProof.verdict is absent or empty`,
      });
    } else if (verdict !== "PROVEN") {
      pushViolation(violations, {
        rule: "DONE_PROOF_UNPROVEN",
        id: row.id,
        detail:
          `${VERDICT_FIELD}="DONE" but currentProof.verdict="${verdict}" ` +
          "(not PROVEN for the current subject)",
      });
    }
  }
}

// Rule 5: no row's current command evidence may name the retired
// `npm run package` entrypoint (package.json's "package" script now
// only prints its retirement notice and exits 1). The only candidate
// entrypoint is CURRENT_PACKAGE_COMMAND.
function checkNoRetiredEntrypoint(requirements, violations) {
  for (const row of requirements) {
    for (const witness of row.commandWitnesses ?? []) {
      if (witness?.step === RETIRED_PACKAGE_STEP) {
        pushViolation(violations, {
          rule: "RETIRED_ENTRYPOINT",
          id: row.id,
          detail:
            `commandWitnesses step "${RETIRED_PACKAGE_STEP}" names the ` +
            `retired "${RETIRED_PACKAGE_COMMAND}"; the only candidate ` +
            `entrypoint is "${CURRENT_PACKAGE_COMMAND}"`,
        });
      }
    }
  }
}

// Runs all five rules against an already-parsed ledger and catalog. Pure:
// no filesystem access, so tests build fixtures in memory or from a temp
// directory and call this directly.
export function validateLedger({ ledger, catalog }) {
  const requirements = Array.isArray(ledger?.requirements)
    ? ledger.requirements
    : [];
  const declaredCandidate = ledger?.candidate?.sourceCommit ?? null;
  const violations = [];

  checkSummaryAgreesWithRows(ledger ?? {}, requirements, violations);
  checkRequirementIdentity(catalog ?? {}, requirements, violations);
  checkCurrentSubjectAgreement(declaredCandidate, requirements, violations);
  checkDoneRowsHaveCurrentProof(requirements, violations);
  checkNoRetiredEntrypoint(requirements, violations);

  return {
    schema: COMPLETION_LEDGER_VALIDATE_SCHEMA,
    verdictField: VERDICT_FIELD,
    expectedCountField: EXPECTED_COUNT_FIELD,
    declaredCandidateField: CANDIDATE_FIELD,
    declaredCandidate,
    rowCount: requirements.length,
    judgesCurrentRowsOnly: true,
    note:
      "Bindings marked `historical` are read but never counted as current " +
      "proof; only current bindings, commandWitnesses, and currentProof " +
      "are judged. History sections pass as long as they stay marked.",
    violations,
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1];
}

const USAGE =
  "usage: completion-ledger-validate.mjs <ledger.json> [--catalog <file>]";

// node tooling/completion-ledger-validate.mjs <ledger.json> [--catalog <file>]
// Reads the ledger, resolves its `catalog` field relative to the ledger's
// own directory (or takes --catalog explicitly, for tests), runs all five
// rules, prints every disagreement with its rule name, and exits 0 only
// when there are none.
async function main(arguments_) {
  if (arguments_.includes("--help")) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const catalogOverride = option(arguments_, "--catalog");
  const positional = arguments_.filter((value, index) => {
    if (value.startsWith("--")) return false;
    if (index > 0 && arguments_[index - 1] === "--catalog") return false;
    return true;
  });
  const ledgerFile = positional[0];
  if (!ledgerFile) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const ledgerPath = path.resolve(ledgerFile);
  const ledger = await readJson(ledgerPath);
  const catalogPath = catalogOverride
    ? path.resolve(catalogOverride)
    : path.resolve(path.dirname(ledgerPath), String(ledger.catalog ?? ""));

  let catalog = {};
  let catalogError = null;
  try {
    catalog = await readJson(catalogPath);
  } catch (error) {
    catalogError = error;
  }

  const output = validateLedger({ ledger, catalog });
  if (catalogError) {
    output.violations.unshift({
      rule: "CATALOG_UNREADABLE",
      detail: `could not read the catalog at ${catalogPath}: ${catalogError.message}`,
    });
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  for (const violation of output.violations) {
    const id = violation.id ? ` ${violation.id}` : "";
    process.stdout.write(`[${violation.rule}]${id} ${violation.detail}\n`);
  }
  process.stdout.write(
    output.violations.length === 0
      ? "RESULT: PASS\n"
      : `RESULT: FAIL (${output.violations.length} disagreement(s))\n`,
  );
  return output.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
