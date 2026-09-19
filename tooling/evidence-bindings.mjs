import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_LANES, laneContract } from "./evidence-cases.mjs";
import { listEvidenceAttempts } from "./evidence-attempt.mjs";
import { evaluateEligibility, observerFor } from "./evidence-eligibility.mjs";

// Proves a completion ledger's per-requirement evidence bindings against the
// real attempt receipts, instead of trusting the ledger's own free-text
// citations. A ledger can list every row and still be wrong: a row can cite
// an attempt of an older candidate while the ledger's own header now claims a
// newer one. This tool never trusts the ledger's own PASS/DONE label; it walks
// every binding back to a loaded attempt record and re-derives the verdict.
//
// Two kinds of reasons never propagate here from evidence-eligibility.mjs:
// lane-wide reasons (CASE_*, REVIEW_*, BOUNDARY_*, FINDING_*, RAW_OUTCOME_*)
// that describe the *lane's* overall run rather than the one cited case, and
// anything not about attempt integrity. A lane whose overall raw outcome is
// BLOCKED can still contain one PASS-ing case that legitimately proves a
// row -- so this tool checks the cited case by name, not the lane's summary
// label.

export const EVIDENCE_BINDINGS_SCHEMA = "farol.next.evidence-bindings/v1";

const HEADER_FIELDS = Object.freeze([
  "sourceCommit",
  "sourceTreeDigest",
  "artifactSha256",
]);

// Attempt-integrity reasons evaluateEligibility can produce that this tool
// re-publishes verbatim. Everything else it produces (CASE_*, REVIEW_*,
// BOUNDARY_*, FINDING_*, RAW_OUTCOME_*, NO_CASES_EXECUTED, ...) describes the
// lane's own run as a whole and is deliberately dropped: a case-level proof
// may legitimately come from an attempt whose lane is BLOCKED on other
// cases.
const INTEGRITY_PREFIXES = Object.freeze([
  "RECEIPT_",
  "BYPRODUCT_",
  "EXIT_",
  "OBSERVER_",
  "WRONG_SUBJECT:",
]);

function isIntegrityReason(reason) {
  return (
    reason === "VERIFICATION_MISSING" ||
    INTEGRITY_PREFIXES.some((prefix) => reason.startsWith(prefix))
  );
}

// Attempt integrity, reused from evaluateEligibility rather than
// reimplemented: passing no review and no required boundary means only the
// receipt/byproduct/exit/subject/observer checks below can ever fire, then
// this filters even those down to the integrity subset.
function integrityReasons(lane, attempt, candidate, observers) {
  const evaluation = evaluateEligibility({
    lane,
    attempt,
    candidate,
    observer: observerFor(observers, lane),
  });
  return evaluation.reasons.filter(isIntegrityReason);
}

// Per-cited-case proof, independent of the lane's own overall label: a case
// the binding names must appear in the attempt's normalized executed cases,
// must be declared by the lane's contract at all, and must not be one the
// attempt itself reported as blocked.
function caseReasons(lane, attempt, names) {
  const contract = laneContract(lane);
  const executed = new Set(attempt?.terminal?.cases?.normalized ?? []);
  const blocked = new Set(
    (attempt?.terminal?.blockedCases ?? []).map((entry) => entry.name),
  );
  const reasons = [];
  for (const name of names ?? []) {
    if (!contract.cases.includes(name)) {
      reasons.push(`CASE_UNDECLARED:${name}`);
      continue;
    }
    if (executed.has(name)) continue;
    reasons.push(
      blocked.has(name) ? `CASE_BLOCKED:${name}` : `CASE_NOT_EXECUTED:${name}`,
    );
  }
  return reasons;
}

// Resolves a binding's {lane, attemptId} against the loaded attempts. An
// attempt that exists only under a different lane key is a lane mismatch,
// never silently accepted as evidence for this lane; an attemptId that
// exists nowhere at all is simply missing.
function locateAttempt(attempts, lane, attemptId) {
  const named = (attempts?.[lane] ?? []).find(
    (attempt) => attempt.attemptId === attemptId,
  );
  if (named) return { attempt: named, mismatch: null };
  for (const [otherLane, list] of Object.entries(attempts ?? {})) {
    if (otherLane === lane) continue;
    if ((list ?? []).some((attempt) => attempt.attemptId === attemptId)) {
      return { attempt: null, mismatch: "ATTEMPT_LANE_MISMATCH" };
    }
  }
  return { attempt: null, mismatch: "BINDING_ATTEMPT_MISSING" };
}

function evaluateBinding(binding, candidate, attempts, observers) {
  const { lane, attemptId, cases = [], historical = null } = binding;
  const isHistorical = Boolean(historical);
  const located = locateAttempt(attempts, lane, attemptId);
  if (!located.attempt) {
    return {
      lane,
      attemptId,
      historical: isHistorical,
      verdict: isHistorical ? "HISTORICAL" : "INVALID",
      reasons: [located.mismatch],
    };
  }
  const reasons = [
    ...integrityReasons(lane, located.attempt, candidate, observers),
    ...caseReasons(lane, located.attempt, cases),
  ];
  return {
    lane,
    attemptId,
    historical: isHistorical,
    verdict: isHistorical
      ? "HISTORICAL"
      : reasons.length === 0
        ? "OK"
        : "INVALID",
    reasons,
  };
}

// PROVEN needs at least one non-historical binding, and every non-historical
// binding must be clean; a historical binding never counts toward proof on
// its own, however clean its own integrity check reads (a wrong-subject
// reason there is expected, not an error). NO_BINDINGS is reserved for a row
// that cites nothing at all -- a row whose only bindings are historical is
// UNPROVEN, not NO_BINDINGS, because it does cite something, just nothing
// current.
function evaluateRequirement(requirement, candidate, attempts, observers) {
  const bindings = (requirement.bindings ?? []).map((binding) =>
    evaluateBinding(binding, candidate, attempts, observers),
  );
  let verdict;
  if (bindings.length === 0) {
    verdict = "NO_BINDINGS";
  } else {
    const current = bindings.filter((binding) => !binding.historical);
    verdict =
      current.length > 0 &&
      current.every((binding) => binding.reasons.length === 0)
        ? "PROVEN"
        : "UNPROVEN";
  }
  const reasons = [];
  if (requirement.u2 === "DONE" && verdict !== "PROVEN") {
    reasons.push("DONE_UNPROVEN");
  }
  return {
    id: requirement.id,
    u2: requirement.u2,
    verdict,
    bindings,
    reasons,
  };
}

function isStructuredLaneEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.lane === "string" &&
    typeof entry.attemptId === "string" &&
    typeof entry.rawOutcome === "string"
  );
}

// A structured lanes[] entry is the ledger's own summary of one lane's
// outcome. It must agree with the attempt it names, and with whichever
// attempt the requirement rows actually bind current proof to for that same
// lane -- a header that says PASS over an attempt the rows never cite as
// current is exactly the drift this tool exists to catch.
function evaluateLaneSummary(entry, attempts, requirements) {
  const { lane, attemptId, rawOutcome } = entry;
  const reasons = [];
  const found = (attempts?.[lane] ?? []).find(
    (attempt) => attempt.attemptId === attemptId,
  );
  if (!found || found.status !== rawOutcome) {
    reasons.push(`LANE_SUMMARY_MISMATCH:${lane}`);
  }
  const currentIds = new Set();
  for (const requirement of requirements ?? []) {
    for (const binding of requirement.bindings ?? []) {
      if (binding.lane === lane && !binding.historical) {
        currentIds.add(binding.attemptId);
      }
    }
  }
  if (
    currentIds.size > 0 &&
    !currentIds.has(attemptId) &&
    !reasons.includes(`LANE_SUMMARY_MISMATCH:${lane}`)
  ) {
    reasons.push(`LANE_SUMMARY_MISMATCH:${lane}`);
  }
  return { lane, attemptId, rawOutcome, reasons };
}

function headerReasons(ledgerCandidate, candidate) {
  return HEADER_FIELDS.filter(
    (field) => ledgerCandidate?.[field] !== candidate[field],
  ).map((field) => `HEADER_MISMATCH:${field}`);
}

// evaluateBindings({ ledger, candidate, attempts, observers }):
//   ledger.candidate    the header {sourceCommit, sourceTreeDigest, artifactSha256}
//                        the ledger itself claims.
//   ledger.lanes[]       structured {lane, attemptId, rawOutcome} summaries;
//                        free-text-only entries are ignored.
//   ledger.requirements[] {id, u2, bindings: [{lane, attemptId, cases, historical?}]}.
//   candidate            the exact candidate being accepted right now.
//   attempts             { [lane]: loadedAttempt[] } as listEvidenceAttempts returns.
//   observers            the --observer map/receipt evaluateEligibility accepts.
export function evaluateBindings({
  ledger,
  candidate,
  attempts,
  observers = null,
}) {
  const requirements = (ledger.requirements ?? []).map((requirement) =>
    evaluateRequirement(requirement, candidate, attempts, observers),
  );
  const lanes = (ledger.lanes ?? [])
    .filter(isStructuredLaneEntry)
    .map((entry) =>
      evaluateLaneSummary(entry, attempts, ledger.requirements ?? []),
    );
  const header = { reasons: headerReasons(ledger.candidate, candidate) };
  const counts = {};
  const doneUnproven = [];
  for (const requirement of requirements) {
    counts[requirement.verdict] = (counts[requirement.verdict] ?? 0) + 1;
    if (requirement.reasons.includes("DONE_UNPROVEN")) {
      doneUnproven.push(requirement.id);
    }
  }
  return {
    schema: EVIDENCE_BINDINGS_SCHEMA,
    candidate,
    header,
    lanes,
    requirements,
    summary: { counts, doneUnproven },
  };
}

// Exit-worthy per the CLI contract: any header mismatch, any lane summary
// that does not agree with what it names, or any DONE row that is not
// PROVEN.
function hasBlockingIssues(output) {
  return (
    output.header.reasons.length > 0 ||
    output.lanes.some((lane) => lane.reasons.length > 0) ||
    output.summary.doneUnproven.length > 0
  );
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1];
}

const USAGE =
  "usage: evidence-bindings.mjs --ledger <file> --root <vnext> [--candidate <file>] [--observer <file>]";

// node tooling/evidence-bindings.mjs --ledger <file> --root <vnext>
//   [--candidate <artifact.json>] [--observer <file>]
// Loads every EVIDENCE_LANES lane's attempts under --root, evaluates every
// requirement's bindings against them, prints the result, and exits 0 only
// when nothing in it is a HEADER_MISMATCH, a LANE_SUMMARY_MISMATCH, or a
// DONE row that is not PROVEN.
async function main(arguments_) {
  if (arguments_.includes("--help")) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const ledgerFile = option(arguments_, "--ledger");
  const rootArgument = option(arguments_, "--root");
  if (!ledgerFile || !rootArgument) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const root = path.resolve(rootArgument);
  const candidateFile =
    option(arguments_, "--candidate") ??
    path.join(root, "dist/package/artifact.json");
  const observerFile = option(arguments_, "--observer");

  const ledger = await readJson(path.resolve(ledgerFile));
  const candidate = await readJson(candidateFile);
  const observers = observerFile ? await readJson(observerFile) : null;

  const attempts = {};
  for (const [lane, contract] of Object.entries(EVIDENCE_LANES)) {
    attempts[lane] = await listEvidenceAttempts(path.join(root, contract.root));
  }

  const output = evaluateBindings({ ledger, candidate, attempts, observers });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return hasBlockingIssues(output) ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
