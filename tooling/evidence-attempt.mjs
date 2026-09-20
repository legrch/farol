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
//   <laneRoot>/attempts/<attemptId>/exit.json      the process exit code,
//                                                  written when the runner
//                                                  process actually exits
//   <laneRoot>/attempts/<attemptId>/interrupted.json
//                                                  written by a later attempt
//                                                  when the owner died first
//   <laneRoot>/latest.json                         pointer only, never a copy
//
// No run deletes or rewrites another run's files, so a failed attempt stays
// addressable after a later attempt starts or crashes.

export const EVIDENCE_ATTEMPT_SCHEMA = "farol.next.evidence-attempt/v1";

const ATTEMPT_ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/u;
const RECEIPTS = new Set([
  "started.json",
  "terminal.json",
  "exit.json",
  "interrupted.json",
]);
// SELECTED is a deliberately partial run: the runner drove only the segments
// a `--only` selector named.  It is a terminal outcome so the attempt closes
// honestly, and it is not PASS, so `evidence-eligibility` — which rejects
// every non-PASS outcome — can never bind it.
const TERMINAL_STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "SELECTED"]);
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

// A receipt counts only for the attempt whose directory holds it and the
// lane its start named. A receipt that names another attempt or lane is a
// contradiction, never repaired by taking the directory's word for it.
function receiptReasons(attemptId, { started, terminal, exit, interrupted }) {
  const reasons = [];
  const bound = (name, receipt) => {
    if (receipt.schema !== EVIDENCE_ATTEMPT_SCHEMA) {
      reasons.push(`RECEIPT_SCHEMA:${name}`);
    }
    if (receipt.attemptId !== attemptId) {
      reasons.push(`RECEIPT_IDENTITY:${name}`);
    }
  };
  if (!started) reasons.push("RECEIPT_MISSING:started");
  else {
    bound("started", started);
    if (typeof started.lane !== "string" || started.lane.length === 0) {
      reasons.push("RECEIPT_LANE:started");
    }
  }
  if (terminal) {
    bound("terminal", terminal);
    if (started && terminal.lane !== started.lane) {
      reasons.push("RECEIPT_LANE:terminal");
    }
    if (!TERMINAL_STATUSES.has(terminal.status)) {
      reasons.push("RECEIPT_STATUS:terminal");
    }
    if (!Array.isArray(terminal.byproducts)) {
      reasons.push("RECEIPT_BYPRODUCTS:terminal");
    }
  }
  if (exit) {
    bound("exit", exit);
    if (!Number.isInteger(exit.exitCode))
      reasons.push("RECEIPT_EXIT_CODE:exit");
  }
  if (interrupted) bound("interrupted", interrupted);
  return reasons;
}

function containedRelativePath(relative) {
  return (
    typeof relative === "string" &&
    relative.length > 0 &&
    !relative.startsWith("/") &&
    !relative.includes("\\") &&
    !relative.includes("\0") &&
    relative
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

// Producer-time hashing is not acceptance-time verification: every byproduct
// the terminal receipt recorded is read again from the attempt's own
// directory, without following a symbolic link or leaving that directory,
// and must still have the recorded bytes. A file the receipt did not record
// is an addition after the fact.
function byproductReasons(directory, terminal) {
  if (!terminal || !Array.isArray(terminal.byproducts)) return [];
  const reasons = [];
  let root;
  try {
    root = fsSync.realpathSync(directory);
  } catch {
    return ["BYPRODUCT_DIRECTORY_UNREADABLE"];
  }
  const recorded = new Set();
  for (const record of terminal.byproducts) {
    const relative = record?.path;
    if (!containedRelativePath(relative)) {
      reasons.push(`BYPRODUCT_PATH_INVALID:${String(relative)}`);
      continue;
    }
    recorded.add(relative);
    const target = path.join(root, relative);
    let info;
    try {
      info = fsSync.lstatSync(target);
    } catch (error) {
      reasons.push(
        error?.code === "ENOENT"
          ? `BYPRODUCT_MISSING:${relative}`
          : `BYPRODUCT_UNREADABLE:${relative}`,
      );
      continue;
    }
    let parent;
    try {
      parent = fsSync.realpathSync(path.dirname(target));
    } catch {
      reasons.push(`BYPRODUCT_UNREADABLE:${relative}`);
      continue;
    }
    if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
      reasons.push(`BYPRODUCT_ESCAPES:${relative}`);
      continue;
    }
    if (record.bytes === null || !info.isFile()) {
      reasons.push(`BYPRODUCT_KIND:${relative}`);
      continue;
    }
    let bytes;
    try {
      bytes = fsSync.readFileSync(target);
    } catch {
      reasons.push(`BYPRODUCT_UNREADABLE:${relative}`);
      continue;
    }
    if (
      bytes.length !== record.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== record.sha256
    ) {
      reasons.push(`BYPRODUCT_CHANGED:${relative}`);
    }
  }
  let present;
  try {
    present = byproductsSync(root);
  } catch {
    return [...reasons, "BYPRODUCT_DIRECTORY_UNREADABLE"];
  }
  for (const entry of present) {
    if (!recorded.has(entry.path)) {
      reasons.push(`BYPRODUCT_UNRECORDED:${entry.path}`);
    }
  }
  return reasons;
}

// The terminal receipt's own bytes, hashed independently of its parsed
// content. This is the minimal read-only accessor an effect observer's
// receipt is bound against in evidence-eligibility.mjs: null when no
// terminal receipt exists yet.
function terminalSha256Sync(directory) {
  try {
    return createHash("sha256")
      .update(fsSync.readFileSync(path.join(directory, "terminal.json")))
      .digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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
    if (empty && (status === "PASS" || status === "SELECTED")) {
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
  // still records a FAIL with the first failure it observed.  The actual exit
  // code is recorded separately, so a green terminal label followed by a
  // nonzero exit cannot pass as a clean run.
  installProcessHandlers() {
    process.on("uncaughtExceptionMonitor", (error) => {
      this.recordFailure("uncaught", error);
    });
    process.on("exit", (code) => {
      if (!this.terminal) {
        this.recordFailure("runner", "EVIDENCE_EXIT_WITHOUT_TERMINAL_RECEIPT");
        this.finishSync("FAIL", { exitCode: code });
      }
      fsSync.writeFileSync(
        path.join(this.directory, "exit.json"),
        serialize({
          schema: EVIDENCE_ATTEMPT_SCHEMA,
          attemptId: this.attemptId,
          exitCode: code,
          exitedAt: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
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

// Loads every attempt of a lane with its receipts and, at this I/O
// boundary, what acceptance may not take on trust: `verification.receipts`
// names every receipt that contradicts its attempt or lane,
// `verification.byproducts` every recorded output that is missing, changed,
// unreadable, outside the directory or unrecorded, and `terminalSha256` the
// current bytes of terminal.json itself (independent of `receiptReasons`,
// which only checks the parsed identity fields). An effect observer's own
// last-sampled digest is bound against that same field in
// evidence-eligibility.mjs, so a coordinated post-run rewrite of a
// byproduct together with the terminal receipt that describes it cannot
// pass merely because the two files still agree with each other.
export async function listEvidenceAttempts(laneRoot) {
  return attemptIdsSync(laneRoot).map((attemptId) => {
    const directory = path.join(laneRoot, "attempts", attemptId);
    const started = readJsonSync(path.join(directory, "started.json"));
    const terminal = readJsonSync(path.join(directory, "terminal.json"));
    const interrupted = readJsonSync(path.join(directory, "interrupted.json"));
    const exit = readJsonSync(path.join(directory, "exit.json"));
    return {
      attemptId,
      directory,
      status: attemptStatus(terminal, interrupted),
      started,
      terminal,
      terminalSha256: terminalSha256Sync(directory),
      exit,
      interrupted,
      verification: {
        receipts: receiptReasons(attemptId, {
          started,
          terminal,
          exit,
          interrupted,
        }),
        byproducts: byproductReasons(directory, terminal),
      },
    };
  });
}
