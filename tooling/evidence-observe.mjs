import { productName } from "./harness-identity.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { laneContract } from "./evidence-cases.mjs";

// An effect observer for one evidence lane attempt. It runs beside the lane
// as its own process and takes nothing from the runner's report: it hashes
// the attempt directory's files itself, samples the operating system's
// process table for the product's own processes, and records when it looked.
// Its receipt is bound to the exact lane, attempt and candidate it watched
// and to the interval it covered, so it cannot be moved to another run, and
// it says `healthy` only when it sampled without gaps from before the
// attempt started until after its terminal receipt appeared. It also keeps
// re-hashing terminal.json's own bytes on every sample once the file
// appears, so `effects.terminalSha256` holds the last digest it actually
// saw before it stopped watching -- eligibility binds against that digest,
// not merely against the receipt's presence.

export const EFFECT_OBSERVER_SCHEMA = "farol.effect-observer/v1";

const ATTEMPT_ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/u;
const RECEIPTS = new Set([
  "started.json",
  "terminal.json",
  "exit.json",
  "interrupted.json",
]);

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1];
}

function readJson(file) {
  try {
    return JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// The files of the attempt directory, hashed here rather than trusted from
// the terminal receipt; receipts are listed by name only.
function inventory(directory, prefix = "") {
  let entries;
  try {
    entries = fsSync
      .readdirSync(path.join(directory, prefix), { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && RECEIPTS.has(entry.name)) {
      records.push({ path: relative, receipt: true });
    } else if (entry.isDirectory()) {
      records.push(...inventory(directory, relative));
    } else if (entry.isFile()) {
      const bytes = fsSync.readFileSync(path.join(directory, relative));
      records.push({
        path: relative,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } else {
      records.push({ path: relative, bytes: null, sha256: null });
    }
  }
  return records;
}

// Owned processes as the kernel lists them, matched on the command line.
export function countProcesses(pattern, table) {
  const lines = table.split("\n").slice(1);
  return lines.filter((line) => line.length > 0 && pattern.test(line)).length;
}

export function processTable() {
  return execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

// A gap is time the observer was not looking: from the end of one sample,
// process table read and directory hashed, to the start of the next. The
// sample's own work is observation, however long the kernel takes to answer
// under load. Several intervals with a floor are tolerated; a longer silence
// means it was not watching.
export const GAP_FLOOR_MS = 2_000;

export function summarizeSamples(samples, intervalMs) {
  let maxGapMs = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const idleFrom = Date.parse(previous.at) + (previous.durationMs ?? 0);
    maxGapMs = Math.max(maxGapMs, Date.parse(samples[index].at) - idleFrom);
  }
  const counts = samples.map((sample) => sample.processes);
  return {
    samples: samples.length,
    maxGapMs,
    processes: {
      first: counts[0] ?? null,
      max: counts.length ? Math.max(...counts) : null,
      last: counts.at(-1) ?? null,
    },
    errors: samples.filter((sample) => sample.error).length,
    gapTolerated: maxGapMs <= Math.max(intervalMs * 4, GAP_FLOOR_MS),
  };
}

export async function observeAttempt({
  laneRoot,
  lane,
  attemptId,
  subject,
  processPattern,
  intervalMs,
  timeoutMs,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  table = processTable,
}) {
  const startedAt = now().toISOString();
  const deadline = Date.now() + timeoutMs;
  let bound = attemptId ?? null;
  const samples = [];
  const firstSeen = new Map();
  let terminalSeenAt = null;
  let terminalSha256 = null;
  let interruptedSeenAt = null;

  const sample = () => {
    const begun = Date.now();
    const record = {
      at: now().toISOString(),
      processes: null,
      error: null,
      durationMs: 0,
    };
    try {
      record.processes = countProcesses(processPattern, table());
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    if (bound) {
      const directory = path.join(laneRoot, "attempts", bound);
      try {
        for (const entry of inventory(directory)) {
          const key = entry.receipt
            ? entry.path
            : `${entry.path}@${entry.sha256}`;
          if (!firstSeen.has(key)) firstSeen.set(key, record.at);
        }
        const terminalFile = path.join(directory, "terminal.json");
        if (fsSync.existsSync(terminalFile)) {
          if (terminalSeenAt === null) terminalSeenAt = record.at;
          // Re-hashed every sample so the last value before the observer
          // stops is the last one it actually observed, not merely the
          // first: a rewrite between samples must change this digest.
          terminalSha256 = createHash("sha256")
            .update(fsSync.readFileSync(terminalFile))
            .digest("hex");
        }
        if (
          interruptedSeenAt === null &&
          fsSync.existsSync(path.join(directory, "interrupted.json"))
        ) {
          interruptedSeenAt = record.at;
        }
      } catch (error) {
        record.error ??= error instanceof Error ? error.message : String(error);
      }
    }
    record.durationMs = Date.now() - begun;
    samples.push(record);
  };

  // Watch until the attempt is bound, ended, and observed once more after
  // its terminal receipt, or until the deadline. Only an attempt that
  // started after this observer did can be bound through the lane's latest
  // pointer: the pointer still names the previous run until the new one
  // opens, and that run was not watched.
  let afterTerminal = 0;
  for (;;) {
    if (!bound) {
      const latest = readJson(path.join(laneRoot, "latest.json"));
      if (latest && ATTEMPT_ID.test(latest.attemptId ?? "")) {
        const candidateStart = readJson(
          path.join(laneRoot, "attempts", latest.attemptId, "started.json"),
        )?.startedAt;
        if (
          typeof candidateStart === "string" &&
          Date.parse(candidateStart) >= Date.parse(startedAt)
        ) {
          bound = latest.attemptId;
        }
      }
    }
    sample();
    if (terminalSeenAt !== null || interruptedSeenAt !== null) {
      afterTerminal += 1;
      if (afterTerminal >= 2) break;
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  const endedAt = now().toISOString();
  const directory = bound ? path.join(laneRoot, "attempts", bound) : null;
  const started = directory
    ? readJson(path.join(directory, "started.json"))
    : null;
  const terminal = directory
    ? readJson(path.join(directory, "terminal.json"))
    : null;
  const summary = summarizeSamples(samples, intervalMs);
  const coversStart =
    started?.startedAt !== undefined &&
    Date.parse(startedAt) <= Date.parse(started.startedAt);
  const coversEnd =
    terminal?.endedAt !== undefined &&
    Date.parse(endedAt) >= Date.parse(terminal.endedAt);
  // An effect observer that never saw the product's own process corroborated
  // files only; a pattern that names no running process says nothing about
  // the product, however clean the hashed receipts are. Only a sighting
  // inside the attempt's own interval counts: the watch begins before the
  // attempt does, and a process seen then -- a previous run's leftover -- is
  // not this run's product.
  const attemptBegan = Date.parse(started?.startedAt ?? "");
  const attemptEnded = Date.parse(terminal?.endedAt ?? "");
  const productObserved = samples.some(
    (sample) =>
      (sample.processes ?? 0) > 0 &&
      Date.parse(sample.at) >= attemptBegan &&
      Date.parse(sample.at) <= attemptEnded,
  );
  const healthy =
    bound !== null &&
    terminalSeenAt !== null &&
    productObserved &&
    summary.samples >= 2 &&
    summary.errors === 0 &&
    summary.gapTolerated &&
    coversStart &&
    coversEnd;
  return {
    schema: EFFECT_OBSERVER_SCHEMA,
    lane,
    attemptId: bound,
    subject: {
      sourceCommit: subject.sourceCommit,
      artifactSha256: subject.artifactSha256,
    },
    interval: { startedAt, endedAt },
    healthy,
    reasons: [
      ...(bound === null ? ["ATTEMPT_NOT_BOUND"] : []),
      ...(terminalSeenAt === null ? ["TERMINAL_NOT_OBSERVED"] : []),
      ...(productObserved ? [] : ["PRODUCT_NOT_OBSERVED"]),
      ...(summary.samples < 2 ? ["TOO_FEW_SAMPLES"] : []),
      ...(summary.errors > 0 ? ["SAMPLING_ERRORS"] : []),
      ...(summary.gapTolerated ? [] : ["SAMPLING_GAP"]),
      ...(coversStart ? [] : ["INTERVAL_MISSES_START"]),
      ...(coversEnd ? [] : ["INTERVAL_MISSES_END"]),
    ],
    intervalMs,
    summary,
    effects: {
      processPattern: processPattern.source,
      processSamples: samples.map((sample) => ({
        at: sample.at,
        durationMs: sample.durationMs,
        processes: sample.processes,
        ...(sample.error ? { error: sample.error } : {}),
      })),
      terminalSeenAt,
      terminalSha256,
      interruptedSeenAt,
      byproducts: directory
        ? inventory(directory).filter((entry) => !entry.receipt)
        : [],
      firstSeen: Object.fromEntries(firstSeen),
    },
    observer: {
      pid: process.pid,
      host: os.hostname(),
      platform: process.platform,
    },
  };
}

// node tooling/evidence-observe.mjs --lane <lane> --output <file>
//   [--root <repository>] [--candidate <artifact.json>] [--attempt <id>]
//   [--process <regex>] [--interval-ms 500] [--timeout-ms 7200000]
// Exits 0 when the receipt says healthy, 1 otherwise; the receipt is written
// either way.
async function main(arguments_) {
  const root = path.resolve(option(arguments_, "--root") ?? process.cwd());
  const lane = option(arguments_, "--lane");
  const output = option(arguments_, "--output");
  if (!lane || !output) throw new Error("EVIDENCE_OBSERVE_ARGUMENTS_INVALID");
  const candidateFile =
    option(arguments_, "--candidate") ??
    path.join(root, "_output/package/artifact.json");
  const subject = JSON.parse(await fs.readFile(candidateFile, "utf8"));
  const receipt = await observeAttempt({
    laneRoot: path.join(root, laneContract(lane).root),
    lane,
    attemptId: option(arguments_, "--attempt"),
    subject,
    processPattern: new RegExp(
      option(arguments_, "--process") ?? `${productName}(?:\\.app/|$)`,
      "u",
    ),
    intervalMs: Number(option(arguments_, "--interval-ms") ?? 500),
    timeoutMs: Number(option(arguments_, "--timeout-ms") ?? 7_200_000),
  });
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(
    path.resolve(output),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  return receipt.healthy ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
