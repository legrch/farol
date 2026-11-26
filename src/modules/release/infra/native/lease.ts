import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// A verifier extraction is a disposable `farol-update-verify-XXXXXX` directory
// in a staging parent. Its path lives only in memory, so a process that dies
// first leaves it behind. The lease is the durable proof of who owns it: the
// owner process, every extractor child it spawned, and whether a spawn was in
// flight. A later launch reclaims the directory only on that proof.
export const EXTRACTION_PREFIX = "farol-update-verify-";
export const LEASE_FILE = "lease.json";
export const LEASE_SCHEMA = "farol.update-extraction-lease/1";
export const LEASE_MAX_BYTES = 16384;
export const ProcessStartText = z
  .string()
  .max(128)
  .regex(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u,
  );
const Pid = z.number().int().min(2).max(Number.MAX_SAFE_INTEGER);
const StartedAt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// What `ps` printed for a process, and the same instant as epoch milliseconds
// when the lease was written. The text depends on the timezone in force when it
// was read; the instant does not, so a timezone change never renames a process.
const LeaseChild = z.strictObject({
  pid: Pid,
  processStart: ProcessStartText.nullable(),
  startedAtMs: StartedAt.nullable(),
});
export const ExtractionLease = z.strictObject({
  schema: z.literal(LEASE_SCHEMA),
  ownerPid: Pid,
  ownerProcessStart: ProcessStartText,
  ownerStartedAtMs: StartedAt.nullable(),
  handle: z.string().min(1).max(4096),
  // The `TZ` of the writing process. `ps` prints in the system zone, which a
  // `TZ` override does not change but does change how this process parses that
  // text, so a reader under another `TZ` cannot trust an ordering of starts.
  zone: z.string().max(128).nullable(),
  // `spawning` is written before a child exists; `spawned` once its pid is
  // recorded, which happens right after the spawn, before its start is read.
  // Only `spawning` can have a child the lease does not list.
  phase: z.enum(["created", "spawning", "spawned"]),
  createdAt: StartedAt,
  updatedAt: StartedAt,
  children: z.array(LeaseChild).max(16),
});
export type ExtractionLease = z.infer<typeof ExtractionLease>;

/**
 * One `ps -p <pid> -o lstart=` answer. The reader is a port: the launches of
 * `/bin/ps` are declared where they live (`installed-update-helper`), and this
 * module never starts a process.
 */
export type ProcessRead = (
  pid: number,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;
export type ProcessIdentity = Readonly<{
  processStart: string;
  /** Null when the text cannot be converted to one instant unambiguously. */
  startedAtMs: number | null;
}>;
/** Local-time `ps` text as one epoch instant, or NaN when it is not one. */
export type ParseStart = (text: string) => number;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/**
 * `ps` prints the start in local time. One wall-clock text is one instant only
 * when exactly one UTC offset in force around it maps back to the same wall
 * clock: the repeated hour of a clock change (two instants) and the skipped
 * hour (none) are refused, never guessed. `offsetAt(ms)` is the offset in
 * minutes (UTC minus local) in force at that instant.
 */
export function localStartParser(offsetAt: (ms: number) => number): ParseStart {
  return (text) => {
    const match =
      /^[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(
        text,
      );
    const month = match ? MONTHS.indexOf(match[1]!) : -1;
    if (!match || month < 0) return Number.NaN;
    const wall = Date.UTC(
      Number(match[6]),
      month,
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
    );
    const day = 86_400_000;
    const offsets = new Set([offsetAt(wall - day), offsetAt(wall + day)]);
    const instants = [...offsets]
      .map((offset) => wall + offset * 60_000)
      .filter((instant) => offsetAt(instant) === (instant - wall) / 60_000);
    return instants.length === 1 ? instants[0]! : Number.NaN;
  };
}
const parseLocalStart: ParseStart = localStartParser((ms) =>
  new Date(ms).getTimezoneOffset(),
);

function cleanAbsence(error: unknown): boolean {
  const result = error as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  } | null;
  return result?.code === 1 && result.stdout === "" && result.stderr === "";
}

/**
 * The identity of a live process, or `null` when `ps` cleanly reports no such
 * process. Anything else (a failed probe, unparsable text) throws.
 */
export async function readProcessIdentity(
  pid: number,
  read: ProcessRead,
  parse: ParseStart = parseLocalStart,
): Promise<ProcessIdentity | null> {
  try {
    const { stdout, stderr } = await read(pid);
    const text = stdout.trim();
    if (stderr || !ProcessStartText.safeParse(text).success)
      throw new Error("process start unreadable");
    const startedAtMs = parse(text);
    return {
      processStart: text,
      startedAtMs: Number.isSafeInteger(startedAtMs) ? startedAtMs : null,
    };
  } catch (error) {
    if (cleanAbsence(error)) return null;
    throw error;
  }
}

/**
 * Whether the process a lease recorded is still running.
 *
 * Instants are compared, never text: the text moves with the timezone.
 * `live`: the pid's start is the recorded instant.
 * `ended`: no such pid, or the pid now names a process that started later than
 *   the recorded one (the pid was reused).
 * `unknown`: a failed probe, a running pid whose recorded or observed start is
 *   not one unambiguous instant, or a start that is not later than the
 *   recorded one. A later start counts as `ended` only when `sameZone`: under
 *   another `TZ` the same process can parse as later, so it stays `unknown`.
 *   Only `ended` permits removal.
 */
export async function observeLeaseProcess(
  recorded: Readonly<{
    pid: number;
    processStart: string | null;
    startedAtMs: number | null;
  }>,
  read: ProcessRead,
  parse: ParseStart = parseLocalStart,
  sameZone = true,
): Promise<"live" | "ended" | "unknown"> {
  let current: ProcessIdentity | null;
  try {
    current = await readProcessIdentity(recorded.pid, read, parse);
  } catch {
    return "unknown";
  }
  if (current === null) return "ended";
  if (recorded.startedAtMs === null || current.startedAtMs === null)
    return "unknown";
  if (current.startedAtMs === recorded.startedAtMs) return "live";
  return sameZone && current.startedAtMs > recorded.startedAtMs
    ? "ended"
    : "unknown";
}

/**
 * Writes one extraction's lease. Every revision is a new file renamed over
 * `lease.json`, so a reader sees a whole lease or none, and a crash never
 * leaves a torn one. Revisions are serialised.
 */
export function createLeaseWriter(
  input: Readonly<{
    directory: string;
    ownerPid: number;
    owner: ProcessIdentity;
    handle: string;
    zone: string | null;
    now?: () => number;
  }>,
) {
  const now = input.now ?? Date.now;
  const createdAt = now();
  let lease: ExtractionLease = {
    schema: LEASE_SCHEMA,
    ownerPid: input.ownerPid,
    ownerProcessStart: input.owner.processStart,
    ownerStartedAtMs: input.owner.startedAtMs,
    handle: input.handle,
    zone: input.zone,
    phase: "created",
    createdAt,
    updatedAt: createdAt,
    children: [],
  };
  let sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const revise = (
    edit: (current: ExtractionLease) => ExtractionLease,
  ): Promise<void> => {
    const run = queue.then(async () => {
      const next = { ...edit(lease), updatedAt: now() };
      const temporary = path.join(
        input.directory,
        `${LEASE_FILE}.${sequence++}.tmp`,
      );
      await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        await fs.rename(temporary, path.join(input.directory, LEASE_FILE));
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      lease = next;
    });
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    /** The first revision, written before anything is extracted. */
    create: () => revise((current) => current),
    /** Written before a child exists: its pid is not yet knowable. */
    beginSpawn: () => revise((current) => ({ ...current, phase: "spawning" })),
    /**
     * Written the moment the child exists, from the spawn handle's pid, before
     * anything is awaited: from here the lease lists the child.
     */
    childSpawned: (pid: number) =>
      revise((current) => ({
        ...current,
        phase: "spawned",
        children: [
          ...current.children,
          { pid, processStart: null, startedAtMs: null },
        ],
      })),
    /**
     * Fills in the child's start once `ps` has been read. Never required: a
     * child left without a start is unknown while its pid runs.
     */
    childIdentified: (pid: number, identity: ProcessIdentity) =>
      revise((current) => ({
        ...current,
        children: current.children.map((child) =>
          child.pid === pid
            ? {
                pid,
                processStart: identity.processStart,
                startedAtMs: identity.startedAtMs,
              }
            : child,
        ),
      })),
  };
}
