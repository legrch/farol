import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { QuitStage } from "../../../src/apps/desktop/quit-drain";

// A diagnostic trace of every Quit attempt, so a Quit that hangs leaves
// evidence of the last stage it reached. It is never authority: it does not
// confirm a drain, remove the run marker or replace `last-quit.json`. Every
// write is asynchronous and best effort; the real Quit never waits for it,
// so a record missing from disk is inconclusive by definition.

export const QUIT_TRACE_FILE_NAME = "quit-trace.jsonl";
export const QUIT_TRACE_MAX_ATTEMPTS = 10;
export const QUIT_TRACE_MAX_BYTES = 64 * 1024;
// Bounds the in-memory queue between writes; older pending records drop.
export const QUIT_TRACE_MAX_PENDING = 256;

export type QuitTracePhase = "startup" | "recovery" | "running";

/** Process-wide stages outside the drain itself. */
export type QuitTraceEvent =
  | QuitStage
  | Readonly<{ stage: "before-quit"; during: QuitTracePhase }>
  | Readonly<{
      stage: "signal";
      signal: "SIGINT" | "SIGTERM";
      ignored: boolean;
    }>
  | Readonly<{ stage: "marker"; result: "removed" | "kept" | "failed" }>;

export type QuitTraceRecord = Readonly<
  {
    // Process lifetime and attempt correlate records across a restart.
    lifetime: string;
    attempt: string;
    ms: number;
  } & QuitTraceEvent
>;

export type QuitTrace = Readonly<{
  /** Records one event. Synchronous, constant time, never throws. */
  record(event: QuitTraceEvent): void;
  /** Settles when every record queued so far has been written or dropped. */
  flushed(): Promise<void>;
  /** Records dropped from the bounded queue since this process started. */
  dropped(): number;
}>;

export type QuitTraceOptions = Readonly<{
  directory: string;
  pid: number;
  now?: () => number;
  write?: (directory: string, records: readonly string[]) => Promise<void>;
}>;

function unsafe(): never {
  throw new Error("QUIT_TRACE_STATE_UNSAFE");
}

function assertPrivateFile(info: Stats): void {
  const effectiveUser = process.geteuid?.();
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (effectiveUser !== undefined && info.uid !== effectiveUser) ||
    (info.mode & 0o077) !== 0
  )
    unsafe();
}

async function privateRoot(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser) ||
    (info.mode & 0o077) !== 0
  )
    unsafe();
}

const openFlags =
  (fsConstants.O_NOFOLLOW ?? 0) |
  ((fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0);

async function readExisting(target: string): Promise<string[]> {
  let handle;
  try {
    // Nonblocking: a stale FIFO or device in place of the trace cannot leave
    // this open pending and strand the trace queue.
    handle = await fs.open(
      target,
      fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | openFlags,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const info = await handle.stat();
    assertPrivateFile(info);
    // An oversized trace is not ours to parse; start a fresh one.
    if (info.size > QUIT_TRACE_MAX_BYTES * 2) return [];
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } finally {
    await handle.close();
  }
}

function attemptOf(line: string): string | null {
  try {
    const value = JSON.parse(line) as { lifetime?: unknown; attempt?: unknown };
    return typeof value.lifetime === "string" &&
      typeof value.attempt === "string"
      ? `${value.lifetime}/${value.attempt}`
      : null;
  } catch {
    return null;
  }
}

/** Keeps the newest attempts within both the attempt and byte limits. */
export function retainQuitTrace(lines: readonly string[]): string[] {
  const order: string[] = [];
  const byAttempt = new Map<string, string[]>();
  for (const line of lines) {
    const key = attemptOf(line);
    if (key === null) continue;
    if (!byAttempt.has(key)) {
      byAttempt.set(key, []);
      order.push(key);
    }
    byAttempt.get(key)!.push(line);
  }
  const kept: string[][] = [];
  let bytes = 0;
  for (const key of order.reverse()) {
    if (kept.length >= QUIT_TRACE_MAX_ATTEMPTS) break;
    const group = byAttempt.get(key)!;
    // Bytes on disk, not UTF-16 code units.
    const size = group.reduce(
      (sum, line) => sum + Buffer.byteLength(line, "utf8") + 1,
      0,
    );
    if (bytes + size > QUIT_TRACE_MAX_BYTES) break;
    bytes += size;
    kept.push(group);
  }
  return kept.reverse().flat();
}

/** Private temporary next to the target, then rename: never a torn file. */
export async function writeQuitTrace(
  directory: string,
  records: readonly string[],
): Promise<void> {
  await privateRoot(directory);
  const target = path.join(directory, QUIT_TRACE_FILE_NAME);
  const lines = retainQuitTrace([...(await readExisting(target)), ...records]);
  const temporary = path.join(
    directory,
    `.${QUIT_TRACE_FILE_NAME}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        openFlags,
      0o600,
    );
    await handle.writeFile(lines.length ? `${lines.join("\n")}\n` : "", "utf8");
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * One trace per process. An attempt starts at the first `before-quit` or
 * signal and every later record joins it, so a re-entrant Quit, the drain's
 * stages and the marker outcome read as one sequence.
 */
export function createQuitTrace(options: QuitTraceOptions): QuitTrace {
  const now = options.now ?? (() => performance.now());
  const write = options.write ?? writeQuitTrace;
  const lifetime = `${options.pid}-${randomUUID().slice(0, 8)}`;
  let attempt: { id: string; startedAt: number } | null = null;
  let pending: string[] = [];
  let droppedCount = 0;
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;
  const drain = () => {
    scheduled = false;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return Promise.resolve();
    return write(options.directory, batch).catch(() => undefined);
  };
  return {
    record(event) {
      try {
        if (attempt === null)
          attempt = { id: randomUUID().slice(0, 8), startedAt: now() };
        const record: QuitTraceRecord = {
          lifetime,
          attempt: attempt.id,
          ms: Math.max(0, Math.round(now() - attempt.startedAt)),
          ...event,
        };
        pending.push(JSON.stringify(record));
        if (pending.length > QUIT_TRACE_MAX_PENDING) {
          droppedCount += pending.length - QUIT_TRACE_MAX_PENDING;
          pending = pending.slice(-QUIT_TRACE_MAX_PENDING);
        }
        if (!scheduled) {
          scheduled = true;
          // Serialized: one write at a time, appended in record order.
          chain = chain.then(drain, drain);
        }
      } catch {
        // A diagnostic can never change Quit.
      }
    },
    flushed: async () => {
      for (;;) {
        const current = chain;
        await current;
        if (current === chain) return;
      }
    },
    dropped: () => droppedCount,
  };
}
