import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_LANES, laneContract } from "./evidence-cases.mjs";
import { listEvidenceAttempts } from "./evidence-attempt.mjs";
import { EFFECT_OBSERVER_SCHEMA } from "./evidence-observe.mjs";

// Decides whether one recorded attempt may count as acceptance evidence for an
// exact candidate.  Two axes stay separate: the raw outcome the run recorded
// (PASS, FAIL, BLOCKED, INTERRUPTED, NOT_RUN, ...) and whether that evidence is
// eligible for the current claim (CURRENT, WRONG_SUBJECT, WRONG_BOUNDARY,
// INCOMPLETE, UNVERIFIED).  A green label is never enough by itself: every
// refusal below names the missing fact instead. Where a lane requires an
// effect observer, eligibility additionally binds the observer's own
// independently hashed inventory (`effects.byproducts`,
// `effects.terminalSha256`) against the attempt's current byproducts and
// terminal.json bytes, so a coordinated post-run rewrite of both together
// cannot pass merely because they still agree with each other.

const SUBJECT_FIELDS = Object.freeze([
  "sourceCommit",
  "sourceTreeDigest",
  "artifactSha256",
]);

function subjectFields(lane) {
  return lane === "hunt" ? SUBJECT_FIELDS.slice(0, 2) : SUBJECT_FIELDS;
}

function observerRequired(lane) {
  // Every product lane drives effects that an independent observer must
  // corroborate; the hermetic Hunt model has no external effect to observe.
  return lane !== "hunt";
}

function eligibilityOf(reasons) {
  if (
    reasons.some(
      (reason) =>
        reason.startsWith("RECEIPT_") ||
        reason.startsWith("BYPRODUCT_") ||
        reason === "VERIFICATION_MISSING",
    )
  ) {
    return "INVALID";
  }
  if (reasons.some((reason) => reason.startsWith("WRONG_SUBJECT:"))) {
    return "WRONG_SUBJECT";
  }
  if (reasons.some((reason) => reason.startsWith("BOUNDARY_INSUFFICIENT:"))) {
    return "WRONG_BOUNDARY";
  }
  if (
    reasons.some(
      (reason) =>
        reason.startsWith("CASE_") ||
        reason === "NO_CASES_EXECUTED" ||
        reason === "RAW_OUTCOME_NOT_RUN",
    )
  ) {
    return "INCOMPLETE";
  }
  if (
    reasons.some(
      (reason) =>
        reason.startsWith("REVIEW_") || reason.startsWith("OBSERVER_"),
    )
  ) {
    return "UNVERIFIED";
  }
  return "CURRENT";
}

function boundaryReasons(lane, requiredBoundary = {}) {
  const boundary = laneContract(lane).boundary;
  return Object.entries(requiredBoundary)
    .filter(([key, value]) => boundary[key] !== value)
    .map(([key]) => `BOUNDARY_INSUFFICIENT:${key}`);
}

function reviewReason(lane, review, candidate) {
  if (!review) return "REVIEW_MISSING";
  if (review.reviewer !== "independent") return "REVIEW_NOT_INDEPENDENT";
  const fields = subjectFields(lane).filter(
    (field) => field !== "sourceTreeDigest",
  );
  if (fields.some((field) => review.subject?.[field] !== candidate[field])) {
    return "REVIEW_STALE";
  }
  if (review.verdict !== "ACCEPT") return "REVIEW_NOT_ACCEPT";
  return null;
}

function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

// An effect observer counts only for the exact run it watched: this lane,
// this attempt, this candidate, over an interval that covers the attempt
// from its start to its terminal receipt, and healthy throughout. A receipt
// that says `healthy: true` about another run, or about no run in
// particular, is not an observation of this one. Beyond that binding, the
// observer's own inventory -- `effects.byproducts`, hashed independently of
// the attempt's own receipts, and `effects.terminalSha256`, its last
// sampled digest of terminal.json's bytes -- must still agree with what the
// attempt claims now. Without this, a coordinated post-run replacement of a
// byproduct together with a consistent rewrite of terminal.json passes the
// loader's self-consistency check (both files still agree with each other)
// even though neither agrees with what the observer actually watched.
function observerReasons(lane, observer, attempt, candidate) {
  if (!observer) return ["OBSERVER_MISSING"];
  const reasons = [];
  if (observer.healthy !== true) reasons.push("OBSERVER_UNHEALTHY");
  if (observer.lane !== lane) reasons.push("OBSERVER_LANE_MISMATCH");
  if (observer.attemptId !== attempt.attemptId) {
    reasons.push("OBSERVER_ATTEMPT_MISMATCH");
  }
  for (const field of subjectFields(lane).filter(
    (candidateField) => candidateField !== "sourceTreeDigest",
  )) {
    if (observer.subject?.[field] !== candidate[field]) {
      reasons.push(`OBSERVER_SUBJECT_MISMATCH:${field}`);
    }
  }
  const from = timestamp(observer.interval?.startedAt);
  const to = timestamp(observer.interval?.endedAt);
  const startedAt = timestamp(attempt.started?.startedAt);
  const endedAt = timestamp(attempt.terminal?.endedAt);
  if (
    from === null ||
    to === null ||
    startedAt === null ||
    endedAt === null ||
    from > startedAt ||
    to < endedAt
  ) {
    reasons.push("OBSERVER_INTERVAL_UNCOVERED");
  }
  // The receipt's own facts decide, not its healthy flag: a receipt that is
  // not an observer's, has too few or failed samples, never saw the terminal
  // receipt, or never saw the product inside this attempt's own interval
  // corroborates nothing, however its flag reads.
  if (observer.schema !== EFFECT_OBSERVER_SCHEMA) {
    reasons.push("OBSERVER_SCHEMA_INVALID");
  }
  const samples = Array.isArray(observer.effects?.processSamples)
    ? observer.effects.processSamples
    : [];
  if (
    samples.length < 2 ||
    samples.some(
      (sample) =>
        timestamp(sample?.at) === null ||
        sample.error !== undefined ||
        !Number.isInteger(sample.processes) ||
        sample.processes < 0,
    )
  ) {
    reasons.push("OBSERVER_SAMPLES_INVALID");
  }
  if (timestamp(observer.effects?.terminalSeenAt) === null) {
    reasons.push("OBSERVER_TERMINAL_NOT_SEEN");
  }
  if (
    startedAt === null ||
    endedAt === null ||
    !samples.some((sample) => {
      const at = timestamp(sample?.at);
      return (
        Number.isInteger(sample?.processes) &&
        sample.processes > 0 &&
        at !== null &&
        at >= startedAt &&
        at <= endedAt
      );
    })
  ) {
    reasons.push("OBSERVER_PRODUCT_NOT_OBSERVED");
  }
  if (Array.isArray(observer.observedCases)) {
    const observed = new Set(observer.observedCases);
    for (const name of attempt.terminal?.cases?.normalized ?? []) {
      if (!observed.has(name)) reasons.push(`OBSERVER_CASE_UNCOVERED:${name}`);
    }
  }

  // Byproduct binding: the observer hashed the attempt directory itself, so
  // its inventory must name the same paths with the same bytes and sha256
  // as the attempt's own terminal receipt claims right now.
  const attemptByproducts = new Map(
    (attempt.terminal?.byproducts ?? []).map((record) => [
      record?.path,
      record,
    ]),
  );
  const observerByproducts = new Map(
    (observer.effects?.byproducts ?? []).map((record) => [
      record?.path,
      record,
    ]),
  );
  const byproductPaths = [
    ...new Set([...attemptByproducts.keys(), ...observerByproducts.keys()]),
  ].sort();
  for (const recordPath of byproductPaths) {
    const attemptRecord = attemptByproducts.get(recordPath);
    const observerRecord = observerByproducts.get(recordPath);
    if (
      !attemptRecord ||
      !observerRecord ||
      attemptRecord.bytes !== observerRecord.bytes ||
      attemptRecord.sha256 !== observerRecord.sha256
    ) {
      reasons.push(`OBSERVER_BYPRODUCT_MISMATCH:${recordPath}`);
    }
  }

  // Terminal binding: the observer's last sampled digest of terminal.json's
  // own bytes must equal the current file, so the receipt that describes
  // the byproducts above cannot itself have been rewritten after the
  // observer stopped watching. An older receipt that never recorded a
  // digest is unsealed, not merely stale.
  const observerTerminalSha256 = observer.effects?.terminalSha256;
  if (observerTerminalSha256 === undefined || observerTerminalSha256 === null) {
    reasons.push("OBSERVER_TERMINAL_UNSEALED");
  } else if (observerTerminalSha256 !== attempt.terminalSha256) {
    reasons.push("OBSERVER_TERMINAL_MISMATCH");
  }

  return reasons;
}

export function evaluateEligibility({
  lane,
  attempt,
  candidate,
  requiredBoundary = {},
  review = null,
  observer = null,
  findings = [],
}) {
  const contract = laneContract(lane);
  if (!attempt) {
    return {
      lane,
      attemptId: null,
      rawOutcome: "NOT_RUN",
      eligibility: "INCOMPLETE",
      acceptable: false,
      reasons: ["RAW_OUTCOME_NOT_RUN"],
    };
  }
  const reasons = [];
  const rawOutcome = attempt.status;
  if (rawOutcome !== "PASS") reasons.push(`RAW_OUTCOME_${rawOutcome}`);

  // Only the loader can vouch for receipts and byproducts; an attempt that
  // did not pass through it carries no verification and is not accepted.
  if (!attempt.verification) reasons.push("VERIFICATION_MISSING");
  else {
    reasons.push(...attempt.verification.receipts);
    reasons.push(...attempt.verification.byproducts);
  }
  if (attempt.started && attempt.started.lane !== lane) {
    reasons.push(`RECEIPT_LANE_MISMATCH:${String(attempt.started.lane)}`);
  }

  if (attempt.terminal) {
    if (!attempt.exit) reasons.push("EXIT_RECEIPT_MISSING");
    else if (attempt.exit.exitCode !== 0) {
      reasons.push(`EXIT_NONZERO:${attempt.exit.exitCode}`);
    }
    const recorded = new Map(
      (attempt.terminal.byproducts ?? []).map((record) => [
        record?.path,
        record,
      ]),
    );
    for (const required of contract.requiredByproducts ?? []) {
      const record = recorded.get(required);
      if (!record || !(record.bytes > 0)) {
        reasons.push(`BYPRODUCT_REQUIRED_MISSING:${required}`);
      }
    }
  }

  const input = attempt.started?.input ?? {};
  for (const field of subjectFields(lane)) {
    if (input[field] !== candidate[field]) {
      reasons.push(`WRONG_SUBJECT:${field}`);
    }
  }

  if (attempt.terminal) {
    const executed = new Set(attempt.terminal.cases?.normalized ?? []);
    const blocked = new Set(
      (attempt.terminal.blockedCases ?? []).map((entry) => entry.name),
    );
    if (executed.size === 0) reasons.push("NO_CASES_EXECUTED");
    for (const name of contract.cases) {
      if (executed.has(name)) continue;
      reasons.push(
        blocked.has(name) ? `CASE_BLOCKED:${name}` : `CASE_MISSING:${name}`,
      );
    }
  }

  reasons.push(...boundaryReasons(lane, requiredBoundary));

  const review_ = reviewReason(lane, review, candidate);
  if (review_) reasons.push(review_);

  if (observerRequired(lane)) {
    reasons.push(...observerReasons(lane, observer, attempt, candidate));
  }

  for (const finding of findings) {
    if (finding.blocking === true && finding.resolved !== true) {
      reasons.push(`FINDING_UNRESOLVED:${finding.id}`);
    }
  }

  return {
    lane,
    attemptId: attempt.attemptId,
    rawOutcome,
    eligibility: eligibilityOf(reasons),
    acceptable: reasons.length === 0,
    reasons,
  };
}

// Maps requirement IDs onto evaluated lane attempts.  One execution that
// witnesses several requirements is still one execution: `executions` lists
// each accepted attempt once, whatever number of requirements cite it.
export function summarizeRequirements(requirements, evaluations) {
  const executions = new Set();
  const rows = requirements.map((requirement) => {
    const reasons = [];
    const witnesses = [];
    const declared = requirement.witnesses ?? [];
    if (declared.length === 0) reasons.push("NO_WITNESS_DECLARED");
    for (const witness of declared) {
      const insufficient = boundaryReasons(
        witness.lane,
        requirement.minimumBoundary,
      );
      for (const reason of insufficient) {
        if (!reasons.includes(reason)) reasons.push(reason);
      }
      if (insufficient.length > 0) continue;
      const contract = laneContract(witness.lane);
      for (const name of witness.cases ?? []) {
        if (!contract.cases.includes(name)) {
          reasons.push(`WITNESS_CASE_UNDECLARED:${witness.lane}:${name}`);
        }
      }
      const evaluation = evaluations[witness.lane];
      if (!evaluation?.acceptable) {
        reasons.push(`WITNESS_NOT_ACCEPTED:${witness.lane}`);
        continue;
      }
      witnesses.push(`${witness.lane}:${evaluation.attemptId}`);
    }
    const accepted = reasons.length === 0 && witnesses.length > 0;
    if (accepted) {
      for (const witness of witnesses) executions.add(witness.split(":")[1]);
    }
    return {
      id: requirement.id,
      state: accepted ? "ACCEPTED" : "OPEN",
      witnesses: accepted ? witnesses : [],
      reasons,
    };
  });
  return { executions: [...executions], requirements: rows };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function latestAttempt(laneRoot) {
  let pointer;
  try {
    pointer = await readJson(path.join(laneRoot, "latest.json"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const attempts = await listEvidenceAttempts(laneRoot);
  return (
    attempts.find((attempt) => attempt.attemptId === pointer.attemptId) ?? null
  );
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1];
}

// One observer receipt per lane. The file holds either a map from lane to
// receipt or one receipt that names its lane; a receipt is never handed to
// a lane it does not name.
export function observerFor(observers, lane) {
  if (!observers || typeof observers !== "object") return null;
  if (typeof observers.lane === "string") {
    return observers.lane === lane ? observers : null;
  }
  const receipt = observers[lane];
  return receipt && typeof receipt === "object" ? receipt : null;
}

// node tooling/evidence-eligibility.mjs [--root <repository>] [--candidate <file>]
//   [--review <file>] [--observer <file>] [--findings <file>]
//   [--requirements <file>]
// Prints the evaluation of every lane's latest attempt; exits 0 only when
// every lane is acceptable for the candidate.
async function main(arguments_) {
  const root = path.resolve(option(arguments_, "--root") ?? process.cwd());
  const candidateFile =
    option(arguments_, "--candidate") ??
    path.join(root, "dist/package/artifact.json");
  const candidate = await readJson(candidateFile);
  const review = option(arguments_, "--review");
  const observer = option(arguments_, "--observer");
  const findings = option(arguments_, "--findings");
  const requirements = option(arguments_, "--requirements");
  const observers = observer ? await readJson(observer) : null;
  const evaluations = {};
  for (const [lane, contract] of Object.entries(EVIDENCE_LANES)) {
    evaluations[lane] = evaluateEligibility({
      lane,
      attempt: await latestAttempt(path.join(root, contract.root)),
      candidate,
      review: review ? await readJson(review) : null,
      observer: observerFor(observers, lane),
      findings: findings ? await readJson(findings) : [],
    });
  }
  const output = {
    schema: "farol.next.evidence-eligibility/v2",
    candidate: {
      sourceCommit: candidate.sourceCommit,
      sourceTreeDigest: candidate.sourceTreeDigest,
      artifactSha256: candidate.artifactSha256,
    },
    lanes: evaluations,
    ...(requirements
      ? {
          requirements: summarizeRequirements(
            await readJson(requirements),
            evaluations,
          ),
        }
      : {}),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return Object.values(evaluations).every((evaluation) => evaluation.acceptable)
    ? 0
    : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
