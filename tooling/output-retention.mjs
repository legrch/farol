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
import { OWNER_FILE, PS_ENVIRONMENT } from "./owned-scratch.mjs";

export { OWNER_FILE };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const POLICY = Object.freeze({
  evidenceTtlMs: 7 * DAY,
  quietMs: HOUR,
  budgetBytes: 15 * 1024 ** 3,
});

// Declared qualification lanes and roots tooling reads by path. They are
// counted, never removed here; protectedEvidence() adds every other name the
// repository refers to as `_output/evidence/<name>`.
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

// Every `_output/evidence/<name>` the tracked source mentions is a by-path
// consumer (a sealed predecessor, a journey's screenshots, ...). A trailing
// `-` marks a name prefix. `null` (git unreadable) protects all evidence.
export function protectedEvidence(root, run = spawnSync) {
  const grep = run(
    "/usr/bin/git",
    ["-C", root, "grep", "-ohE", "_output/evidence/[A-Za-z0-9._-]+"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (grep.error || ![0, 1].includes(grep.status)) return null;
  const names = new Set(PROTECTED_EVIDENCE);
  for (const line of grep.stdout.split("\n"))
    // Prose may end a path with a period; the directory name never does.
    if (line)
      names.add(line.slice("_output/evidence/".length).replace(/\.+$/u, ""));
  return [...names].filter(Boolean);
}

function isProtected(child, names) {
  return (
    names === null ||
    names.some((name) =>
      name.endsWith("-") ? child.startsWith(name) : child === name,
    )
  );
}

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
    env: PS_ENVIRONMENT,
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
  // Only this account's processes can use its private outputs. Any lsof error
  // (status 1 included) may hide a holder, so it is unknown, never "unused".
  const lsof = run(
    "/usr/sbin/lsof",
    ["-n", "-P", "-w", "-F", "n", "-u", String(process.getuid())],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 30_000 },
  );
  if (lsof.error || lsof.status !== 0 || !lsof.stdout) return null;
  const open = lsof.stdout
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1));
  return { processes, open };
}

// A command refers to the directory when its path appears followed by a path
// separator, whitespace, a quote, a delimiter or the end of the line.
function mentions(command, directory) {
  for (
    let at = command.indexOf(directory);
    at !== -1;
    at = command.indexOf(directory, at + 1)
  ) {
    const next = command[at + directory.length];
    if (next === undefined || /[\s/'"=:,;)]/u.test(next)) return true;
  }
  return false;
}

function referenced(directory, observation) {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  // Tools run from the checkout root also name entries relative to it.
  const relative = directory.slice(directory.lastIndexOf("/_output/") + 1);
  return (
    observation.processes.some(
      ({ command }) =>
        mentions(command, directory) || mentions(command, relative),
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
  // A process group outlives its leader only through the leader's children;
  // an owner inside a shell's or harness's group is judged by references.
  if (
    owner.pid === owner.pgid &&
    observation.processes.some(({ pgid }) => pgid === owner.pgid)
  )
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
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      // A producer may remove its own scratch while this scan runs.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    bytes += info.blocks * 512;
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory())
      for (const name of await fs.readdir(current).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }))
        pending.push(path.join(current, name));
  }
  return { bytes, newest };
}

async function classifyChild(directory, kind, observation, now, policy) {
  const info = await fs.lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
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
  {
    observation = observeProcesses(),
    now = Date.now(),
    policy = POLICY,
    protect = protectedEvidence(root),
  } = {},
) {
  const output = path.join(root, "_output");
  const entries = [];
  let names;
  try {
    const info = await fs.lstat(output);
    // A redirected _output is never walked: removal stays in the checkout.
    if (!info.isDirectory() || info.uid !== process.getuid())
      throw Error("OUTPUT_ROOT_NOT_OWNED_DIRECTORY");
    names = await fs.readdir(output);
  } catch (error) {
    if (error.code === "ENOENT")
      return { output, entries, totalBytes: 0, budgetedBytes: 0 };
    throw error;
  }
  for (const name of names.sort()) {
    const full = path.join(output, name);
    const parentInfo = await fs.lstat(full);
    if (
      (name === "tmp" || name === "evidence") &&
      (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid())
    ) {
      // A redirected scratch root is never walked: removal stays inside _output.
      entries.push({
        path: full,
        kind: "output",
        bytes: parentInfo.blocks * 512,
        newest: parentInfo.mtimeMs,
        state: "unknown",
        reason: "not an owned directory; not walked",
      });
      continue;
    }
    if (name === "tmp" || name === "evidence") {
      for (const child of (await fs.readdir(full)).sort()) {
        const childPath = path.join(full, child);
        if (name === "evidence" && isProtected(child, protect)) {
          const { bytes, newest } = await measure(childPath);
          entries.push({
            path: childPath,
            kind: "evidence",
            bytes,
            newest,
            state: "protected",
            reason: "declared evidence consumer",
          });
        } else {
          const entry = await classifyChild(
            childPath,
            name,
            observation,
            now,
            policy,
          );
          if (entry) entries.push(entry);
        }
      }
      continue;
    }
    const { bytes, newest } = await measure(full);
    entries.push({
      path: full,
      kind: "output",
      bytes,
      newest,
      state: CURRENT_OUTPUTS.includes(name)
        ? "current"
        : name === "testops"
          ? "kept"
          : "unknown",
      reason: CURRENT_OUTPUTS.includes(name)
        ? "managed in place"
        : name === "testops"
          ? "testops runs and leases: counted toward the budget, never pruned here"
          : name.startsWith(".dev-core-")
            ? "Dev transition leftover; the next task dev reaps it"
            : "no producer owns this entry",
    });
  }
  // Retention applies to finished entries only: owned tmp is removable at
  // once; finished undeclared evidence beyond its TTL. There is no size-based
  // removal: its eligibility depends on every other entry and cannot be
  // re-checked per entry, so size pressure surfaces through the budget guard.
  for (const entry of entries)
    if (entry.state === "finished" && entry.kind === "tmp")
      entry.state = "removable";
  for (const entry of entries) {
    if (entry.kind !== "evidence" || entry.state !== "finished") continue;
    if (now - entry.newest > policy.evidenceTtlMs) {
      entry.state = "removable";
      entry.reason = "older than 7 days";
    } else entry.state = "kept";
  }
  const totalBytes = entries.reduce((sum, { bytes }) => sum + bytes, 0);
  // Current outputs are bounded by their producers and protected evidence is
  // never removed here, so only what can accumulate counts toward the budget.
  const budgetedBytes = entries
    .filter(({ state }) => !["current", "protected"].includes(state))
    .reduce((sum, { bytes }) => sum + bytes, 0);
  return { output, entries, totalBytes, budgetedBytes };
}

export async function pruneOutput(root, options = {}) {
  const report = await inspectOutput(root, options);
  const removed = [];
  if (!report.entries.some(({ state }) => state === "removable"))
    return { ...report, removed, failed: [] };
  // Removal needs a second, fresh observation: an entry first used after the
  // first scan is no longer removable and stays.
  const { observe = observeProcesses } = options;
  const confirmed = await inspectOutput(root, {
    ...options,
    observation: observe(),
  });
  const removable = new Set(
    confirmed.entries
      .filter(({ state }) => state === "removable")
      .map(({ path: item }) => item),
  );
  const failed = [];
  for (const entry of report.entries) {
    if (entry.state !== "removable" || !removable.has(entry.path)) continue;
    // A fresh observation right before each removal: scans and earlier
    // removals take time, and a use that began meanwhile keeps its entry.
    const final = observe();
    if (!final) break;
    try {
      if (!(await stillRemovable(entry, final, root, options))) continue;
    } catch (error) {
      failed.push({ ...entry, error: error.code ?? error.message });
      continue;
    }
    try {
      await fs.rm(entry.path, { recursive: true, force: true });
      removed.push(entry);
    } catch (error) {
      // Keep going: every completed removal stays reported.
      failed.push({ ...entry, error: error.code ?? error.message });
    }
  }
  return { ...report, removed, failed };
}

// Re-derives every eligibility input on fresh state right before a removal:
// the same classification (finished, content unchanged), current by-path
// protection.
async function stillRemovable(entry, observation, root, options) {
  const policy = options.policy ?? POLICY;
  const fresh = await classifyChild(
    entry.path,
    entry.kind,
    observation,
    options.now ?? Date.now(),
    policy,
  );
  if (!fresh || fresh.state !== "finished" || fresh.newest !== entry.newest)
    return false;
  if (entry.kind !== "evidence") return true;
  const protect =
    options.protect === undefined ? protectedEvidence(root) : options.protect;
  if (isProtected(path.basename(entry.path), protect)) return false;
  return true;
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
    if (report.failed.length) {
      for (const entry of report.failed)
        console.error(
          `Could not remove ${path.relative(report.output, entry.path)}: ${entry.error}`,
        );
      console.error(
        `Pruning was partial: removed ${report.removed.length}, failed ${report.failed.length}.`,
      );
      return 1;
    }
    const remaining =
      report.budgetedBytes -
      report.removed.reduce((sum, { bytes }) => sum + bytes, 0);
    if (command === "guard" && remaining > POLICY.budgetBytes) {
      console.error(
        `\n_output holds ${gb(remaining)} of unknown, active or kept entries after pruning, over its ${gb(POLICY.budgetBytes)} budget. ` +
          "Heavy work is refused until the unknown or active entries above are resolved (delete what nothing needs, or finish what is running). " +
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
  process.exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(
      `_output retention refused: ${error.message}. Nothing was removed.`,
    );
    return 1;
  });
