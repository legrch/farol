import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// A read-only answer to one question the Farol Model Setup control needs
// after it writes config.toml: is a Codex host started from the discovered
// executable running right now? A running host read its config at start
// and will only see the new block after it is restarted; a host that is
// not running picks the block up at its next start. This module only ever
// reads the process table — it never signals, kills, or starts anything —
// and it says `unknown` rather than guessing when the table cannot be read.
//
// Limits: detection is by command line. It recognises the discovered
// executable path itself (and its resolved real path) as the command or as
// an argument (an npm shim is `node <path>`), so a host launched from a
// different copy of Codex — a desktop app's bundled binary, for instance
// — is not "this executable" and is reported as not running.

export type ProcessEntry = Readonly<{ pid: number; command: string }>;

/** Lists the live processes with their full command lines. */
export type ProcessLister = () => Promise<readonly ProcessEntry[]>;

export type CodexHostPresence =
  | Readonly<{ state: "running"; pids: readonly number[] }>
  | Readonly<{ state: "not_running" }>
  | Readonly<{
      state: "unknown";
      reason: "process_table_unavailable" | "executable_path_invalid";
    }>;

const execFileAsync = promisify(execFile);

/** Parses `ps -axo pid=,command=` output: one `<pid> <command line>` per line. */
export function parseProcessTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = (match[2] ?? "").trimEnd();
    if (!Number.isInteger(pid) || pid <= 0 || command.length === 0) continue;
    entries.push({ pid, command });
  }
  return entries;
}

/** The production lister: the system `ps`, by absolute path, read-only. */
export const psProcessLister: ProcessLister = async () => {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseProcessTable(stdout);
};

/**
 * True when `command` runs one of `candidates`: as the command itself or
 * as a whole argument (a shim is `node <path>`). A candidate only ever
 * matches as a whole token bounded by spaces or the line's ends, so
 * `/usr/local/bin/codex` never matches `/usr/local/bin/codex-other`.
 */
export function commandRunsExecutable(
  command: string,
  candidates: readonly string[],
): boolean {
  return candidates.some(
    (candidate) =>
      candidate.length > 0 &&
      (command === candidate ||
        command.startsWith(`${candidate} `) ||
        command.endsWith(` ${candidate}`) ||
        command.includes(` ${candidate} `)),
  );
}

export type CodexHostPresenceInput = Readonly<{
  /** The verified Codex executable, as Settings recorded it. */
  executablePath: string;
  listProcesses?: ProcessLister;
  /** Resolves symlinks; defaults to the real filesystem. */
  resolveRealPath?: (target: string) => Promise<string>;
  /** Never counted as a host; defaults to this process. */
  ownPid?: number;
}>;

export async function detectCodexHostPresence(
  input: CodexHostPresenceInput,
): Promise<CodexHostPresence> {
  if (
    !path.isAbsolute(input.executablePath) ||
    input.executablePath.includes("\0")
  ) {
    return { state: "unknown", reason: "executable_path_invalid" };
  }
  const candidates = new Set<string>([input.executablePath]);
  try {
    const resolve = input.resolveRealPath ?? ((target) => fs.realpath(target));
    candidates.add(await resolve(input.executablePath));
  } catch {
    // An unresolvable link still leaves the recorded path to match on.
  }
  let entries: readonly ProcessEntry[];
  try {
    entries = await (input.listProcesses ?? psProcessLister)();
  } catch {
    return { state: "unknown", reason: "process_table_unavailable" };
  }
  const ownPid = input.ownPid ?? process.pid;
  const pids = entries
    .filter(
      (entry) =>
        entry.pid !== ownPid &&
        commandRunsExecutable(entry.command, [...candidates]),
    )
    .map((entry) => entry.pid);
  return pids.length > 0
    ? { state: "running", pids }
    : { state: "not_running" };
}
