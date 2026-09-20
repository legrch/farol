import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// The run marker: `farol-next-state/running.json`, written by the desktop
// as the first thing it does once Electron is ready and removed only after a
// quit whose drain was confirmed (`QuitDrainReceipt.drained === true`). Its
// presence therefore means one of two things and nothing else: this
// generation is still running, or it stopped without confirming its drain —
// a crash, a kill, a power loss, or a quit whose receipt could not be
// written. A clean `last-quit.json` on its own cannot tell those apart: a
// crash leaves the previous quit's clean receipt exactly where it was, and
// a promotion that trusted it would place a new generation over state the
// old one may still be writing.
//
// The reader (`tooling/promotion-obligations.mjs`) decides between the two
// with the pid and the boot time recorded here:
//
// - `pid` liveness is `process.kill(pid, 0)`. ESRCH means no such process:
//   the writer is gone and its quit was never confirmed. Any other error —
//   in practice EPERM, a process this user may not signal — counts as
//   alive: the process exists, and refusing a promotion because a process
//   might be the app is the closed outcome; treating it as dead would be the
//   one that places over a running generation.
// - `bootTime` protects the pid check against pid reuse across reboots. A
//   pid is only unique within one boot: after a restart the kernel hands
//   the same numbers out again, so a marker left by a crash could name a
//   pid that is now, say, a shell or a daemon, and liveness alone would call
//   the crashed generation "running" for as long as that unrelated process
//   lives. A marker whose boot time is not this boot's is a crash, whatever
//   its pid is doing now.
// - `processStart` closes pid reuse *within* one boot, which the boot time
//   alone cannot (S35-H1-3). It is the exact `ps -o lstart= -p <pid>` string
//   the writer read for itself, kept verbatim and compared verbatim against
//   the same reading for the marker's pid now: a different process wearing
//   that number started at a different time, so the string differs and the
//   marker is a crash. Only an exact match on a live pid on this boot is
//   `running`. `ps` is the one reading available here, and it may be
//   unavailable (a sandbox that denies it) or answer nothing for a pid that
//   is alive; either way the marker is reported `boot_unknown` — unreadable,
//   never guessed at, because guessing here either places a generation over
//   a running app or refuses a promotion forever.
//
// Boot time is `Date.now() - os.uptime() * 1000`, rounded to whole seconds
// because `os.uptime()` itself is whole seconds, and compared with a small
// tolerance because the two readings are taken at different instants and
// the wall clock may be stepped between them. A writer that cannot read
// the uptime (a sandbox that denies the sysctl behind it) records `null`;
// the reader then cannot prove the boot and reports the marker unreadable
// rather than guessing.
//
// Plain module by design: no class, no parameter properties, no enum, no
// relative import, so Node's unflagged type stripping can load it from the
// `.mjs` CLI.

export const RUN_MARKER_FILE_NAME = "running.json";
export const MAX_RUN_MARKER_BYTES = 4 * 1_024;
export const SAME_BOOT_TOLERANCE_MS = 5_000;
const BOOT_TIME_GRANULARITY_MS = 1_000;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

const canonicalTimestampSchema = z
  .string()
  .max(64)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  });

export const RunMarkerSchema = z.strictObject({
  schema: z.literal(1),
  pid: z
    .number()
    .int()
    .positive()
    .max(2 ** 31 - 1),
  startedAt: canonicalTimestampSchema,
  // Milliseconds since the epoch at which the writer's machine booted,
  // rounded to whole seconds; null when the writer could not read it.
  bootTime: z.number().int().nonnegative().nullable(),
  // The writer's own `ps -o lstart= -p <pid>` line, trimmed, or null when
  // that reading could not be taken. A marker written by a build that did
  // not record it does not parse, and is therefore reported unreadable
  // rather than classified: the closed outcome, and the one that keeps this
  // field from silently degrading back into a pid-only check.
  processStart: z.string().min(1).max(128).nullable(),
});

export type RunMarker = z.infer<typeof RunMarkerSchema>;

export type RunMarkerVerdict = "running" | "crashed" | "boot_unknown";

export type RunMarkerProbe = Readonly<{
  // This machine's boot time as `currentBootTimeMs` reports it, or null
  // when it cannot be read.
  bootTime: number | null;
  isAlive: (pid: number) => boolean;
  // This machine's `ps -o lstart= -p <pid>` reading for one pid right now,
  // or null when `ps` is unavailable or answers nothing for it. Injected so
  // a test can drive every branch without a real process of its own.
  processStart: (pid: number) => string | null;
}>;

export type RunMarkerUnreadableReason =
  | "SYMLINK"
  | "UNSAFE"
  | "OVERSIZED"
  | "CORRUPT"
  | "UNKNOWN_VERSION"
  | "MALFORMED";

export type RunMarkerRead =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "unreadable"; reason: RunMarkerUnreadableReason }>
  | Readonly<{ status: "read"; marker: RunMarker }>;

export type RunMarkerRemoval =
  | Readonly<{ removed: true }>
  | Readonly<{
      removed: false;
      reason: "ABSENT" | "OTHER_PID" | RunMarkerUnreadableReason;
    }>;

function markerError(code: string): never {
  throw new Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrivateFile(info: Stats): boolean {
  const effectiveUser = process.geteuid?.();
  return (
    info.isFile() &&
    info.nlink === 1 &&
    (effectiveUser === undefined || info.uid === effectiveUser) &&
    (info.mode & 0o077) === 0
  );
}

export function currentBootTimeMs(
  now: number = Date.now(),
  uptimeSeconds: () => number = os.uptime,
): number | null {
  let uptime: number;
  try {
    uptime = uptimeSeconds();
  } catch {
    return null;
  }
  if (!Number.isFinite(uptime) || uptime < 0) return null;
  const boot = now - uptime * 1_000;
  if (boot < 0) return null;
  return Math.round(boot / BOOT_TIME_GRANULARITY_MS) * BOOT_TIME_GRANULARITY_MS;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * One pid's start time as `ps` prints it (`-o lstart=`), trimmed, or null
 * when `ps` cannot be run, exits non-zero, or prints nothing. The string is
 * never parsed: it is an opaque token compared for equality with the one
 * the marker recorded, so no locale, format or clock interpretation can
 * turn two different processes into the same answer. `execFileSync` with a
 * fixed absolute path and fixed arguments: nothing here takes a caller's
 * command.
 */
export function readProcessStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let printed: string;
  try {
    printed = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    return null;
  }
  const trimmed = printed.trim();
  return trimmed.length === 0 || trimmed.length > 128 ? null : trimmed;
}

export function sameBoot(
  markerBootTime: number | null,
  currentBootTime: number | null,
): boolean {
  return (
    markerBootTime !== null &&
    currentBootTime !== null &&
    Math.abs(markerBootTime - currentBootTime) <= SAME_BOOT_TOLERANCE_MS
  );
}

/**
 * What a present marker means. A dead pid is a crash on any boot: the
 * writer stopped without confirming its drain. A live pid is the running
 * app only when the marker was written on this boot AND the process
 * wearing that number now is the one that wrote it; on another boot, or
 * after pid reuse within this one, the number belongs to someone else and
 * the writer crashed. When either side's boot time, or either side's
 * process start time, cannot be read, a live pid cannot be attributed at
 * all, and the reader must say so instead of guessing.
 */
export function classifyRunMarker(
  marker: RunMarker,
  probe: RunMarkerProbe,
): RunMarkerVerdict {
  if (!probe.isAlive(marker.pid)) return "crashed";
  if (marker.bootTime === null || probe.bootTime === null) {
    return "boot_unknown";
  }
  if (!sameBoot(marker.bootTime, probe.bootTime)) return "crashed";
  // S35-H1-3: same boot and a live pid is not yet the app. Pids are reused
  // within one boot, so the process now holding this number must be shown
  // to be the one that wrote the marker.
  const current = probe.processStart(marker.pid);
  if (marker.processStart === null || current === null) return "boot_unknown";
  return current === marker.processStart ? "running" : "crashed";
}

async function ensureRoot(stateRoot: string): Promise<void> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(stateRoot);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    markerError("RUN_MARKER_ROOT_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) await fs.chmod(stateRoot, 0o700);
}

async function syncRoot(stateRoot: string): Promise<void> {
  const directory = await fs.open(
    stateRoot,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      NO_FOLLOW |
      CLOSE_ON_EXEC,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function runMarkerPath(stateRoot: string): string {
  if (!path.isAbsolute(stateRoot)) markerError("RUN_MARKER_ROOT_NOT_ABSOLUTE");
  return path.join(stateRoot, RUN_MARKER_FILE_NAME);
}

/**
 * Writes the marker the way every private state file here is written: a
 * private temporary file created next to the target, synced, renamed over
 * it, never a direct write a concurrent reader could see half-written or a
 * symlinked target could redirect. Replaces a marker a previous run left
 * behind; refuses to replace anything that is not a private regular file.
 */
export async function writeRunMarker(
  stateRoot: string,
  input: Readonly<{
    pid: number;
    now: number;
    bootTime: number | null;
    // The writer's own start time as `readProcessStart` reads it. Recorded
    // at write so the reader can prove the pid still names this process.
    processStart: string | null;
  }>,
): Promise<RunMarker> {
  const target = runMarkerPath(stateRoot);
  const marker = RunMarkerSchema.parse({
    schema: 1,
    pid: input.pid,
    startedAt: new Date(input.now).toISOString(),
    bootTime: input.bootTime,
    processStart: input.processStart,
  });
  await ensureRoot(stateRoot);
  try {
    if (!isPrivateFile(await fs.lstat(target)))
      markerError("RUN_MARKER_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const serialized = `${JSON.stringify(marker)}\n`;
  const temporary = path.join(
    stateRoot,
    `.${RUN_MARKER_FILE_NAME}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    await syncRoot(stateRoot);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return marker;
}

/**
 * Reads the marker with the same private-file discipline the promotion
 * reader applies, so the app and the CLI agree on what counts as a marker.
 */
export async function readRunMarker(stateRoot: string): Promise<RunMarkerRead> {
  const target = runMarkerPath(stateRoot);
  let handle;
  try {
    handle = await fs.open(
      target,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent" };
    if (code === "ELOOP") return { status: "unreadable", reason: "SYMLINK" };
    return { status: "unreadable", reason: "UNSAFE" };
  }
  let text: string;
  try {
    const info = await handle.stat();
    if (!isPrivateFile(info)) return { status: "unreadable", reason: "UNSAFE" };
    if (info.size > MAX_RUN_MARKER_BYTES) {
      return { status: "unreadable", reason: "OVERSIZED" };
    }
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "unreadable", reason: "CORRUPT" };
  }
  const parsed = RunMarkerSchema.safeParse(value);
  if (parsed.success) return { status: "read", marker: parsed.data };
  if (
    isPlainObject(value) &&
    value["schema"] !== undefined &&
    value["schema"] !== 1
  ) {
    return { status: "unreadable", reason: "UNKNOWN_VERSION" };
  }
  return { status: "unreadable", reason: "MALFORMED" };
}

/**
 * Removes the marker this process wrote, and only that one: a marker that
 * names another pid, or that is not a private regular marker any more, is
 * left in place so a promotion refuses on it instead of trusting a receipt.
 * Called after a confirmed drain only; an unconfirmed quit never calls it.
 */
export async function removeRunMarker(
  stateRoot: string,
  pid: number,
): Promise<RunMarkerRemoval> {
  const target = runMarkerPath(stateRoot);
  const current = await readRunMarker(stateRoot);
  if (current.status === "absent") return { removed: false, reason: "ABSENT" };
  if (current.status === "unreadable") {
    return { removed: false, reason: current.reason };
  }
  if (current.marker.pid !== pid)
    return { removed: false, reason: "OTHER_PID" };
  try {
    await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { removed: false, reason: "ABSENT" };
    }
    throw error;
  }
  return { removed: true };
}
