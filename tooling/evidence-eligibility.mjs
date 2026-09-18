import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_LANES, laneContract } from "./evidence-cases.mjs";
import { listEvidenceAttempts } from "./evidence-attempt.mjs";

// Decides whether one recorded attempt may count as acceptance evidence for an
// exact candidate.  Two axes stay separate: the raw outcome the run recorded
// (PASS, FAIL, BLOCKED, INTERRUPTED, NOT_RUN, ...) and whether that evidence is
// eligible for the current claim (CURRENT, WRONG_SUBJECT, WRONG_BOUNDARY,
// INCOMPLETE, UNVERIFIED).  A green label is never enough by itself: every
// refusal below names the missing fact instead.

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
  if (reasons.some((reason) => reason.startsWith("REVIEW_"))) {
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

  if (attempt.terminal) {
    if (!attempt.exit) reasons.push("EXIT_RECEIPT_MISSING");
    else if (attempt.exit.exitCode !== 0) {
      reasons.push(`EXIT_NONZERO:${attempt.exit.exitCode}`);
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
    if (!observer) reasons.push("OBSERVER_MISSING");
    else if (observer.healthy !== true) reasons.push("OBSERVER_UNHEALTHY");
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

// node tooling/evidence-eligibility.mjs [--root <vnext>] [--candidate <file>]
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
  const evaluations = {};
  for (const [lane, contract] of Object.entries(EVIDENCE_LANES)) {
    evaluations[lane] = evaluateEligibility({
      lane,
      attempt: await latestAttempt(path.join(root, contract.root)),
      candidate,
      review: review ? await readJson(review) : null,
      observer: observer ? await readJson(observer) : null,
      findings: findings ? await readJson(findings) : [],
    });
  }
  const output = {
    schema: "farol.next.evidence-eligibility/v1",
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
