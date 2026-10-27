// _output retention. Reports every top-level entry and removes only what is
// provably finished: owned scratch whose recorded owner is gone, and
// undeclared evidence that is quiet, unopened and unreferenced, beyond its
// TTL or size cap. Declared evidence lanes, current outputs and anything of
// unknown state are kept and reported. Trust model: cooperating agents and
// crash recovery, not a same-account adversary.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EVIDENCE_LANES } from "./evidence-cases.mjs";
import { OWNER_FILE } from "./owned-scratch.mjs";

export { OWNER_FILE };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const POLICY = Object.freeze({
  evidenceTtlMs: 7 * DAY,
  evidenceCapBytes: 2 * 1024 ** 3,
  quietMs: HOUR,
  budgetBytes: 15 * 1024 ** 3,
});

// Consumers read these by path (qualification lanes, Hunt, test scopes and
// one recorded recovery input). They are counted, never removed here.
export const PROTECTED_EVIDENCE = Object.freeze(
  [
    ...new Set([
      ...Object.values(EVIDENCE_LANES).map(({ root }) =>
        path.relative("_output/evidence", root),
      ),
      "hunt",
      "test-scopes",
      "owner-setup-recovery-20261007",
    ]),
  ].sort(),
);

// Current outputs that their producers overwrite or manage in place.
export const CURRENT_OUTPUTS = Object.freeze([
  ".dev-lifecycle.lock",
  "build",
  "coverage",
  "dev-core",
  "dev-core-resources.json",
  "dev-runtime",
  "evidence",
  "farol-state",
  "go-build-inputs.json",
  "logs",
  "package",
  "preview",
  "preview-assets",
  "shell-screens",
  "testops",
  "tests",
  "tmp",
  "toolchains",
]);

// The process table and open files in one observation. A failed read is
// `null`, which every caller treats as "unknown: keep".
export function observeProcesses(run = spawnSync) {
  const ps = run("/bin/ps", ["-axww", "-o", "pid=,pgid=,lstart=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  if (ps.error || ps.status !== 0) return null;
  const processes = [];
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s(.*)$/u.exec(line);
    if (match)
      processes.push({
        pid: Number(match[1]),
        pgid: Number(match[2]),
        start: match[3].trim(),
        command: match[4],
      });
  }
  const lsof = run("/usr/sbin/lsof", ["-n", "-P", "-w", "-F", "n"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 30_000,
  });
  // lsof exits 1 when some processes could not be read; that is still a
  // complete list for this account's processes, which are what matter here.
  if (lsof.error || ![0, 1].includes(lsof.status) || !lsof.stdout) return null;
  const open = lsof.stdout
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1));
  return { processes, open };
}

function referenced(directory, observation) {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return (
    observation.processes.some(
      ({ command }) => command.includes(prefix) || command.endsWith(directory),
    ) ||
    observation.open.some(
      (file) => file === directory || file.startsWith(prefix),
    )
  );
}

async function readOwner(directory) {
  try {
    const handle = await fs.open(
      path.join(directory, OWNER_FILE),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const value = JSON.parse(await handle.readFile("utf8"));
      return value?.schema === 1 &&
        Number.isInteger(value.pid) &&
        Number.isInteger(value.pgid) &&
        typeof value.start === "string"
        ? value
        : "invalid";
    } finally {
      await handle.close();
    }
  } catch (error) {
    return error.code === "ENOENT" ? null : "invalid";
  }
}

// Owned scratch is finished once its recorded owner process, its process
// group and every reference to its path are gone.
function ownerFinished(owner, directory, observation) {
  if (
    observation.processes.some(
      ({ pid, start }) => pid === owner.pid && start === owner.start,
    )
  )
    return "owner running";
  if (observation.processes.some(({ pgid }) => pgid === owner.pgid))
    return "owner process group running";
  if (referenced(directory, observation)) return "path in use";
  return null;
}

async function measure(directory) {
  let bytes = 0;
  let newest = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const info = await fs.lstat(current);
    bytes += info.blocks * 512;
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory())
      for (const name of await fs.readdir(current))
        pending.push(path.join(current, name));
  }
  return { bytes, newest };
}

async function classifyChild(directory, kind, observation, now, policy) {
  const info = await fs.lstat(directory);
  const { bytes, newest } = await measure(directory);
  const entry = { path: directory, kind, bytes, newest };
  if (info.uid !== process.getuid() || info.isSymbolicLink())
    return { ...entry, state: "unknown", reason: "not an owned entry" };
  if (!observation)
    return { ...entry, state: "unknown", reason: "process table unreadable" };
  const owner = info.isDirectory() ? await readOwner(directory) : null;
  if (owner === "invalid")
    return { ...entry, state: "unknown", reason: "invalid owner record" };
  if (owner) {
    const busy = ownerFinished(owner, directory, observation);
    return busy
      ? { ...entry, state: "active", reason: busy }
      : { ...entry, state: "finished", reason: "owner gone" };
  }
  if (kind === "tmp")
    return { ...entry, state: "unknown", reason: "no owner record" };
  if (now - newest < policy.quietMs)
    return { ...entry, state: "active", reason: "written within the hour" };
  if (referenced(directory, observation))
    return { ...entry, state: "active", reason: "path in use" };
  return { ...entry, state: "finished", reason: "quiet and unreferenced" };
}

export async function inspectOutput(
  root,
  { observation = observeProcesses(), now = Date.now(), policy = POLICY } = {},
) {
  const output = path.join(root, "_output");
  const entries = [];
  let names;
  try {
    names = await fs.readdir(output);
  } catch (error) {
    if (error.code === "ENOENT") return { output, entries, totalBytes: 0 };
    throw error;
  }
  for (const name of names.sort()) {
    const full = path.join(output, name);
    if (name === "tmp" || name === "evidence") {
      for (const child of (await fs.readdir(full)).sort()) {
        const childPath = path.join(full, child);
        if (name === "evidence" && PROTECTED_EVIDENCE.includes(child)) {
          const { bytes, newest } = await measure(childPath);
          entries.push({
            path: childPath,
            kind: "evidence",
            bytes,
            newest,
            state: "protected",
            reason: "declared evidence consumer",
          });
        } else
          entries.push(
            await classifyChild(childPath, name, observation, now, policy),
          );
      }
      continue;
    }
    const { bytes, newest } = await measure(full);
    entries.push({
      path: full,
      kind: "output",
      bytes,
      newest,
      state: CURRENT_OUTPUTS.includes(name) ? "current" : "unknown",
      reason: CURRENT_OUTPUTS.includes(name)
        ? "managed in place"
        : name.startsWith(".dev-core-")
          ? "Dev transition leftover; the next task dev reaps it"
          : "no producer owns this entry",
    });
  }
  // Retention applies to finished entries only: owned tmp is removable at
  // once; finished undeclared evidence beyond its TTL, then oldest first
  // while finished evidence exceeds its cap.
  for (const entry of entries)
    if (entry.state === "finished" && entry.kind === "tmp")
      entry.state = "removable";
  const evidence = entries
    .filter(({ kind, state }) => kind === "evidence" && state === "finished")
    .sort((left, right) => left.newest - right.newest);
  let kept = evidence.reduce((sum, { bytes }) => sum + bytes, 0);
  for (const entry of evidence) {
    const expired = now - entry.newest > policy.evidenceTtlMs;
    if (expired || kept > policy.evidenceCapBytes) {
      entry.state = "removable";
      entry.reason = expired ? "older than 7 days" : "over the 2 GB cap";
      kept -= entry.bytes;
    } else entry.state = "kept";
  }
  const totalBytes = entries.reduce((sum, { bytes }) => sum + bytes, 0);
  return { output, entries, totalBytes };
}

export async function pruneOutput(root, options = {}) {
  const report = await inspectOutput(root, options);
  const removed = [];
  for (const entry of report.entries) {
    if (entry.state !== "removable") continue;
    await fs.rm(entry.path, { recursive: true, force: true });
    removed.push(entry);
  }
  return { ...report, removed };
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

export function formatReport({ output, entries, totalBytes, removed = [] }) {
  const lines = [`_output ${gb(totalBytes)} (${output})`];
  const byState = new Map();
  for (const entry of entries) {
    const list = byState.get(entry.state) ?? [];
    list.push(entry);
    byState.set(entry.state, list);
  }
  for (const [state, list] of byState) {
    const bytes = list.reduce((sum, { bytes }) => sum + bytes, 0);
    lines.push(`  ${state}: ${list.length} entries, ${gb(bytes)}`);
    if (["unknown", "active"].includes(state))
      for (const entry of list
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, 10))
        lines.push(
          `    ${gb(entry.bytes)}  ${path.relative(output, entry.path)}  (${entry.reason})`,
        );
  }
  if (removed.length)
    lines.push(
      `  removed now: ${removed.length} entries, ${gb(removed.reduce((sum, { bytes }) => sum + bytes, 0))}`,
    );
  return lines.join("\n");
}

async function main([command = "status"]) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (command === "status") {
    console.log(formatReport(await inspectOutput(root)));
    return 0;
  }
  if (command === "prune" || command === "guard") {
    const report = await pruneOutput(root);
    console.log(formatReport(report));
    const remaining =
      report.totalBytes -
      report.removed.reduce((sum, { bytes }) => sum + bytes, 0);
    if (command === "guard" && remaining > POLICY.budgetBytes) {
      console.error(
        `\n_output is over its ${gb(POLICY.budgetBytes)} budget after pruning (${gb(remaining)}). ` +
          "Heavy work is refused until the unknown or active entries above are resolved. " +
          "`task output:status` and `task output:prune` remain available.",
      );
      return 1;
    }
    return 0;
  }
  console.error("usage: output-retention.mjs status|prune|guard");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
