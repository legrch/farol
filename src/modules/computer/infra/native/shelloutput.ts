import type { ShellRead } from "./shellinput";

export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const OUTPUT_WINDOW_BYTES = 64 * 1024;

export type ShellErrorCode =
  | "SHELL_SPAWN_FAILED"
  | "SHELL_SANDBOX_UNAVAILABLE"
  | "SHELL_WATCHDOG_LOST"
  | "SHELL_GROUP_CLEANUP_UNVERIFIED";

export type ShellOutcome = Readonly<{
  handle: string;
  state: "running" | "exited";
  groupCleanup: "pending" | "confirmed" | "unverified";
  detachedCleanup: "unverified";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBase64: string;
  stderrBase64: string;
  stdoutNextOffset: number;
  stderrNextOffset: number;
  stdoutBytes: number;
  stderrBytes: number;
  outputLimitReached: boolean;
  cancelRequested: boolean;
  timedOut: boolean;
  authorityExpired: boolean;
  errorCode: ShellErrorCode | null;
}>;

/** The record fields an outcome snapshot reads. */
export type OutcomeSource = Readonly<{
  handle: string;
  state: "running" | "exited";
  groupCleanup: "pending" | "confirmed" | "unverified";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: readonly Buffer[];
  stderr: readonly Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  outputLimitReached: boolean;
  cancelRequested: boolean;
  timedOut: boolean;
  authorityExpired: boolean;
  errorCode: ShellErrorCode | null;
}>;

export function window(bytes: readonly Buffer[], offset: number): Buffer {
  return Buffer.concat(bytes).subarray(offset, offset + OUTPUT_WINDOW_BYTES);
}

/** True when accepting this chunk would exceed the total output budget. */
export function exceedsOutputLimit(
  stdoutBytes: number,
  stderrBytes: number,
  chunkLength: number,
): boolean {
  return stdoutBytes + stderrBytes + chunkLength > MAX_OUTPUT_BYTES;
}

export function buildOutcome(
  record: OutcomeSource,
  read: ShellRead,
): ShellOutcome {
  const stdout = window(record.stdout, read.stdoutOffset);
  const stderr = window(record.stderr, read.stderrOffset);
  return {
    handle: record.handle,
    state: record.state,
    groupCleanup: record.groupCleanup,
    // A child can call setsid(), leave the watchdog's process group and
    // close its inherited pipes. Group disappearance cannot prove that such
    // a descendant has exited.
    detachedCleanup: "unverified",
    exitCode: record.state === "exited" ? record.exitCode : null,
    exitSignal: record.state === "exited" ? record.exitSignal : null,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    stdoutBase64: stdout.toString("base64"),
    stderrBase64: stderr.toString("base64"),
    stdoutNextOffset: read.stdoutOffset + stdout.length,
    stderrNextOffset: read.stderrOffset + stderr.length,
    stdoutBytes: record.stdoutBytes,
    stderrBytes: record.stderrBytes,
    outputLimitReached: record.outputLimitReached,
    cancelRequested: record.cancelRequested,
    timedOut: record.timedOut,
    authorityExpired: record.authorityExpired,
    errorCode: record.errorCode,
  };
}

/** Cancellation reports status only so it cannot bypass a fenced read. */
export function statusOnly(snapshot: ShellOutcome): ShellOutcome {
  return {
    ...snapshot,
    stdout: "",
    stderr: "",
    stdoutBase64: "",
    stderrBase64: "",
    stdoutNextOffset: 0,
    stderrNextOffset: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}
