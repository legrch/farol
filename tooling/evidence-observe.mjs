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
// attempt started until after its terminal receipt appeared.

export const EFFECT_OBSERVER_SCHEMA = "farol.next.effect-observer/v1";

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

function processTable() {
  return execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function summarizeSamples(samples, intervalMs) {
  let maxGapMs = 0;
  for (let index = 1; index < samples.length; index += 1) {
    maxGapMs = Math.max(
      maxGapMs,
      Date.parse(samples[index].at) - Date.parse(samples[index - 1].at),
    );
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
    gapTolerated: maxGapMs <= intervalMs * 4,
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
  let interruptedSeenAt = null;

  const sample = () => {
    const record = { at: now().toISOString(), processes: null, error: null };
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
        if (
          terminalSeenAt === null &&
          fsSync.existsSync(path.join(directory, "terminal.json"))
        ) {
          terminalSeenAt = record.at;
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
    samples.push(record);
  };

  // Watch until the attempt is bound, ended, and observed once more after
  // its terminal receipt, or until the deadline.
  let afterTerminal = 0;
  for (;;) {
    if (!bound) {
      const latest = readJson(path.join(laneRoot, "latest.json"));
      if (latest && ATTEMPT_ID.test(latest.attemptId ?? "")) {
        bound = latest.attemptId;
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
  const healthy =
    bound !== null &&
    terminalSeenAt !== null &&
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
        processes: sample.processes,
        ...(sample.error ? { error: sample.error } : {}),
      })),
      terminalSeenAt,
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
//   [--root <vnext>] [--candidate <artifact.json>] [--attempt <id>]
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
    path.join(root, "dist/package/artifact.json");
  const subject = JSON.parse(await fs.readFile(candidateFile, "utf8"));
  const receipt = await observeAttempt({
    laneRoot: path.join(root, laneContract(lane).root),
    lane,
    attemptId: option(arguments_, "--attempt"),
    subject,
    processPattern: new RegExp(
      option(arguments_, "--process") ?? "Farol Next Preview",
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
