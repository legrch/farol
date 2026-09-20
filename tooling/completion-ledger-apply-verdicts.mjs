import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_LANES } from "./evidence-cases.mjs";
import { listEvidenceAttempts } from "./evidence-attempt.mjs";
import { evaluateBindings } from "./evidence-bindings.mjs";

// Merges a Completion-Ledger's per-requirement `bindings` into its
// `currentProof`, `u2`, `summary`, and `currentProofSummary` fields --
// mechanically, from the same real-attempt evaluation evidence-bindings.mjs
// performs, never by hand-typing a candidate SHA or a row count.
//
// This tool never invents proof. A row's bindings are set by something else
// (rebind-completion-ledger.py, today); this tool only asks evaluateBindings()
// what those bindings are actually worth against real attempt receipts, then
// writes that answer into the row instead of leaving a stale hand-typed one:
//
//   - currentProof.{candidate,verdict,reasons} always reflects the fresh
//     evaluation, for every row, whether or not the row is DONE.
//   - a row whose u2 was "DONE" and is no longer PROVEN is downgraded to
//     "NOT_RUN" -- it never keeps a stale DONE just because its bindings cite
//     an attempt of an older candidate. The reason is recorded both in the
//     returned `downgraded` list and prepended to the row's own `next` field.
//   - a row whose u2 was never "DONE" keeps it unconditionally: those verdicts
//     (PARTIAL, LIVE_OPEN, VISIBLE_OPEN, REVIEW_OPEN, DESTINATION_OPEN, U3, ...)
//     are gates the row's own `next` text already names (an owner action, a
//     live scenario, a boundary decision) and are independent of which
//     candidate SHA is under test; recomputing them is out of this tool's
//     scope, so it is never attempted, upward or downward.
//   - `summary` is always the exact tally of `u2` across `requirements`,
//     never a hand-maintained block that can drift from the rows it claims
//     to describe.
//   - `currentProofSummary` (a cached, ungoverned block -- no rule in
//     completion-ledger-validate.mjs or evidence-bindings.mjs reads it) is
//     rebuilt from this same run rather than left stale. A verdict label it
//     previously used that evaluateBindings() cannot produce (for example a
//     hand-added "COMMAND_ONLY") is not guessed at or preserved; it is
//     reported in `unresolved` and dropped.

export const APPLY_VERDICTS_SCHEMA = "farol.next.completion-ledger-apply-verdicts/v1";

// The only verdict values evaluateBindings() can produce today (see
// evidence-bindings.mjs's evaluateRequirement). currentProofSummary must only
// ever be built from these.
const KNOWN_VERDICTS = new Set(["PROVEN", "UNPROVEN", "NO_BINDINGS"]);

function collectReasons(entry) {
  const reasons = new Set();
  for (const binding of entry?.bindings ?? []) {
    if (binding.historical) continue;
    for (const reason of binding.reasons ?? []) reasons.add(reason);
  }
  return [...reasons].sort();
}

// Pure: takes the ledger (already carrying fresh `bindings` and a fresh
// `candidate` header from whatever rebound them) and the evaluateBindings()
// output for that same ledger/candidate/attempts, and returns the ledger
// with currentProof/u2/summary/currentProofSummary mechanically recomputed,
// plus what it downgraded and what it could not resolve.
export function applyVerdicts({ ledger, bindingsResult }) {
  const candidate = ledger.candidate?.sourceCommit ?? null;
  const byId = new Map(
    (bindingsResult.requirements ?? []).map((entry) => [entry.id, entry]),
  );
  const downgraded = [];
  for (const row of ledger.requirements ?? []) {
    const entry = byId.get(row.id);
    const verdict = entry?.verdict ?? "NO_BINDINGS";
    const reasons = collectReasons(entry);
    const previousU2 = row.u2;
    row.currentProof = { candidate, verdict, reasons };
    if (previousU2 === "DONE" && verdict !== "PROVEN") {
      row.u2 = "NOT_RUN";
      const named = reasons.length > 0 ? reasons.join("; ") : verdict;
      const note =
        `rebind ${candidate ? candidate.slice(0, 8) : "unknown"}: no current ` +
        `proof (${named}); downgraded from DONE`;
      row.next = row.next ? `${note}\n${row.next}` : note;
      downgraded.push({ id: row.id, from: "DONE", to: "NOT_RUN", verdict, reasons });
    }
  }

  const summary = {};
  for (const row of ledger.requirements ?? []) {
    summary[row.u2] = (summary[row.u2] ?? 0) + 1;
  }
  ledger.summary = summary;

  const byVerdict = {};
  for (const entry of bindingsResult.requirements ?? []) {
    byVerdict[entry.verdict] = (byVerdict[entry.verdict] ?? 0) + 1;
  }
  const recordedDoneByVerdict = {};
  for (const row of ledger.requirements ?? []) {
    if (row.u2 !== "DONE") continue;
    const verdict = row.currentProof?.verdict ?? "UNKNOWN";
    recordedDoneByVerdict[verdict] = (recordedDoneByVerdict[verdict] ?? 0) + 1;
  }

  const unresolved = [];
  const previousByVerdict = ledger.currentProofSummary?.byVerdict ?? {};
  for (const verdict of Object.keys(previousByVerdict)) {
    if (!KNOWN_VERDICTS.has(verdict)) {
      unresolved.push(
        `currentProofSummary.byVerdict had "${verdict}" ` +
          `(${previousByVerdict[verdict]} row(s)), a label evidence-bindings.mjs ` +
          "does not produce; dropped rather than guessed at",
      );
    }
  }

  const outputSha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(bindingsResult))
    .digest("hex");
  const blocking =
    bindingsResult.header.reasons.length > 0 ||
    bindingsResult.lanes.some((lane) => lane.reasons.length > 0) ||
    bindingsResult.summary.doneUnproven.length > 0;

  ledger.currentProofSummary = {
    candidate,
    byVerdict,
    recordedDoneByVerdict,
    validator: {
      tool: "vnext/tooling/evidence-bindings.mjs",
      exit: blocking ? 1 : 0,
      header: bindingsResult.header.reasons,
      laneMismatches: bindingsResult.lanes
        .filter((lane) => lane.reasons.length > 0)
        .map((lane) => lane.lane),
      doneUnproven: bindingsResult.summary.doneUnproven,
      outputSha256,
    },
  };

  return { ledger, downgraded, unresolved };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1];
}

const USAGE =
  "usage: completion-ledger-apply-verdicts.mjs --ledger <file> --root <vnext> " +
  "[--candidate <file>] [--dev-candidate <file>] [--observer <file>] [--write]";

// node tooling/completion-ledger-apply-verdicts.mjs --ledger <file> --root <vnext>
//   [--candidate <artifact.json>] [--dev-candidate <file>] [--observer <file>] [--write]
// Loads every EVIDENCE_LANES lane's attempts under --root, evaluates the
// ledger's own bindings against them via evidence-bindings.mjs's
// evaluateBindings(), merges the result into currentProof/u2/summary/
// currentProofSummary, prints a short report, and -- only with --write --
// writes the merged ledger back to --ledger. Exit 0 means the merge itself
// completed; it says nothing about how many rows ended up proven, which is
// exactly the honest information the merge exists to surface.
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
  const ledgerPath = path.resolve(ledgerFile);
  const candidateFile =
    option(arguments_, "--candidate") ??
    path.join(root, "dist/package/artifact.json");
  const developmentCandidateFile = option(arguments_, "--dev-candidate");
  const observerFile = option(arguments_, "--observer");
  const write = arguments_.includes("--write");

  const ledger = await readJson(ledgerPath);
  const candidate = await readJson(candidateFile);
  const developmentCandidate = developmentCandidateFile
    ? await readJson(developmentCandidateFile)
    : null;
  const observers = observerFile ? await readJson(observerFile) : null;

  const attempts = {};
  for (const [lane, contract] of Object.entries(EVIDENCE_LANES)) {
    attempts[lane] = await listEvidenceAttempts(path.join(root, contract.root));
  }

  const bindingsResult = evaluateBindings({
    ledger,
    candidate,
    attempts,
    observers,
    developmentCandidate,
  });
  const { ledger: merged, downgraded, unresolved } = applyVerdicts({
    ledger,
    bindingsResult,
  });

  const report = {
    schema: APPLY_VERDICTS_SCHEMA,
    candidate: candidate.sourceCommit,
    downgraded,
    unresolved,
    summary: merged.summary,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (write) {
    await fs.writeFile(
      ledgerPath,
      `${JSON.stringify(merged, null, 2)}\n`,
      "utf8",
    );
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
