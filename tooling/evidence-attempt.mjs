import { createHash, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Every run of an evidence lane owns one immutable attempt directory:
//
//   <laneRoot>/attempts/<attemptId>/started.json   written before any work
//   <laneRoot>/attempts/<attemptId>/...            the run's own evidence
//   <laneRoot>/attempts/<attemptId>/terminal.json  outcome, first failure,
//                                                  cases and byproduct hashes
//   <laneRoot>/attempts/<attemptId>/interrupted.json
//                                                  written by a later attempt
//                                                  when the owner died first
//   <laneRoot>/latest.json                         pointer only, never a copy
//
// No run deletes or rewrites another run's files, so a failed attempt stays
// addressable after a later attempt starts or crashes.

export const EVIDENCE_ATTEMPT_SCHEMA = "farol.next.evidence-attempt/v1";

const ATTEMPT_ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/u;
const RECEIPTS = new Set(["started.json", "terminal.json", "interrupted.json"]);
const TERMINAL_STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FAILURE_TEXT = 500;

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Attempt IDs sort in creation order: a UTC timestamp with milliseconds,
// moved past the newest existing attempt when the clock has not advanced.
function stampOf(date) {
  return date.toISOString().replace(/[-:.]/gu, "");
}

function dateOfStamp(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(
    stamp,
  );
  if (!match) throw new Error("EVIDENCE_ATTEMPT_ID_INVALID");
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`,
  );
}

function nextStamp(now, existingIds) {
  const stamp = stampOf(now);
  const newest = existingIds.at(-1)?.split("-", 1)[0];
  if (newest === undefined || stamp > newest) return stamp;
  return stampOf(new Date(dateOfStamp(newest).getTime() + 1));
}

function failureRecord(caseName, error) {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    case: String(caseName),
    message: text.split("\n", 1)[0].slice(0, MAX_FAILURE_TEXT),
  };
}

function ownerGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means a process with that ID exists but belongs to someone else.
    return error?.code === "ESRCH";
  }
}

function readJsonSync(file) {
  try {
    return JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeLatestSync(laneRoot, pointer) {
  const temporary = path.join(
    laneRoot,
    `.latest-${process.pid}-${randomBytes(4).toString("hex")}.json`,
  );
  fsSync.writeFileSync(
    temporary,
    serialize({ schema: EVIDENCE_ATTEMPT_SCHEMA, ...pointer }),
    { flag: "wx", mode: 0o600 },
  );
  fsSync.renameSync(temporary, path.join(laneRoot, "latest.json"));
}

function attemptStatus(terminal, interrupted) {
  if (terminal) return terminal.status;
  if (interrupted) return "INTERRUPTED";
  return "RUNNING_OR_UNKNOWN";
}

function attemptIdsSync(laneRoot) {
  let names;
  try {
    names = fsSync.readdirSync(path.join(laneRoot, "attempts"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => ATTEMPT_ID.test(name)).sort();
}

function byproductsSync(directory, prefix = "") {
  const entries = fsSync
    .readdirSync(path.join(directory, prefix), { withFileTypes: true })
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  const records = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && RECEIPTS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      records.push(...byproductsSync(directory, relative));
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

class EvidenceAttempt {
  constructor({ laneRoot, directory, attemptId, started }) {
    this.laneRoot = laneRoot;
    this.directory = directory;
    this.attemptId = attemptId;
    this.started = started;
    this.firstFailure = null;
    this.terminal = null;
  }

  path(name) {
    if (!EVIDENCE_NAME.test(name) || RECEIPTS.has(name)) {
      throw new Error("EVIDENCE_NAME_INVALID");
    }
    return path.join(this.directory, name);
  }

  recordFailure(caseName, error) {
    this.firstFailure ??= failureRecord(caseName, error);
  }

  finishSync(status, details = {}) {
    if (this.terminal) throw new Error("EVIDENCE_ATTEMPT_ALREADY_TERMINAL");
    if (!TERMINAL_STATUSES.has(status)) {
      throw new Error("EVIDENCE_ATTEMPT_STATUS_INVALID");
    }
    const byproducts = byproductsSync(this.directory);
    const empty = byproducts.find((record) => record.bytes === 0);
    let outcome = status;
    if (empty && status === "PASS") {
      // An empty capture can never certify a passing run.
      this.recordFailure("evidence", `EVIDENCE_EMPTY_BYPRODUCT:${empty.path}`);
      outcome = "FAIL";
    }
    const raw = [...(details.cases ?? [])].map(String);
    const terminal = {
      schema: EVIDENCE_ATTEMPT_SCHEMA,
      attemptId: this.attemptId,
      lane: this.started.lane,
      status: outcome,
      startedAt: this.started.startedAt,
      endedAt: new Date().toISOString(),
      exitCode: details.exitCode ?? null,
      firstFailure: this.firstFailure,
      cases: { raw, normalized: [...new Set(raw)].sort() },
      blockedCases: details.blockedCases ?? [],
      skippedCases: details.skippedCases ?? [],
      byproducts,
    };
    fsSync.writeFileSync(
      path.join(this.directory, "terminal.json"),
      serialize(terminal),
      { flag: "wx", mode: 0o600 },
    );
    this.terminal = terminal;
    writeLatestSync(this.laneRoot, {
      attemptId: this.attemptId,
      status: outcome,
    });
    return terminal;
  }

  async finish(status, details = {}) {
    return this.finishSync(status, details);
  }

  // A runner that throws, rejects or exits without its own terminal receipt
  // still records a FAIL with the first failure it observed.
  installProcessHandlers() {
    process.on("uncaughtExceptionMonitor", (error) => {
      this.recordFailure("uncaught", error);
    });
    process.on("exit", (code) => {
      if (this.terminal) return;
      this.recordFailure("runner", "EVIDENCE_EXIT_WITHOUT_TERMINAL_RECEIPT");
      this.finishSync("FAIL", { exitCode: code });
    });
  }
}

export async function openEvidenceAttempt(laneRoot, { lane, input }) {
  if (typeof lane !== "string" || lane.length === 0) {
    throw new Error("EVIDENCE_LANE_INVALID");
  }
  await fs.mkdir(path.join(laneRoot, "attempts"), { recursive: true });
  const now = new Date();
  const existingIds = attemptIdsSync(laneRoot);
  const attemptId = `${nextStamp(now, existingIds)}-${randomBytes(4).toString("hex")}`;

  // Settle earlier attempts first: a dead owner without a terminal receipt is
  // recorded as interrupted, and a live one means the lane is still in use.
  for (const previousId of existingIds) {
    const directory = path.join(laneRoot, "attempts", previousId);
    if (
      fsSync.existsSync(path.join(directory, "terminal.json")) ||
      fsSync.existsSync(path.join(directory, "interrupted.json"))
    ) {
      continue;
    }
    const started = readJsonSync(path.join(directory, "started.json"));
    if (!Number.isSafeInteger(started?.pid) || !ownerGone(started.pid)) {
      throw new Error(`EVIDENCE_LANE_BUSY:${previousId}`);
    }
    fsSync.writeFileSync(
      path.join(directory, "interrupted.json"),
      serialize({
        schema: EVIDENCE_ATTEMPT_SCHEMA,
        attemptId: previousId,
        observedAt: now.toISOString(),
        observedBy: attemptId,
        reason: "owner-process-gone",
        pid: started.pid,
      }),
      { flag: "wx", mode: 0o600 },
    );
  }

  const latest = readJsonSync(path.join(laneRoot, "latest.json"));
  let previousAttempt = null;
  if (latest && ATTEMPT_ID.test(latest.attemptId ?? "")) {
    const previousDirectory = path.join(laneRoot, "attempts", latest.attemptId);
    previousAttempt = {
      attemptId: latest.attemptId,
      status: attemptStatus(
        readJsonSync(path.join(previousDirectory, "terminal.json")),
        readJsonSync(path.join(previousDirectory, "interrupted.json")),
      ),
    };
  }

  const directory = path.join(laneRoot, "attempts", attemptId);
  await fs.mkdir(directory, { mode: 0o700 });
  const started = {
    schema: EVIDENCE_ATTEMPT_SCHEMA,
    attemptId,
    lane,
    startedAt: now.toISOString(),
    pid: process.pid,
    input: input ?? {},
    previousAttempt,
  };
  await fs.writeFile(path.join(directory, "started.json"), serialize(started), {
    flag: "wx",
    mode: 0o600,
  });
  writeLatestSync(laneRoot, { attemptId, status: "started" });
  return new EvidenceAttempt({ laneRoot, directory, attemptId, started });
}

export async function listEvidenceAttempts(laneRoot) {
  return attemptIdsSync(laneRoot).map((attemptId) => {
    const directory = path.join(laneRoot, "attempts", attemptId);
    const started = readJsonSync(path.join(directory, "started.json"));
    const terminal = readJsonSync(path.join(directory, "terminal.json"));
    const interrupted = readJsonSync(path.join(directory, "interrupted.json"));
    return {
      attemptId,
      directory,
      status: attemptStatus(terminal, interrupted),
      started,
      terminal,
      interrupted,
    };
  });
}
