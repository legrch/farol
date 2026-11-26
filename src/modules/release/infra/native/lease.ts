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
/** Both package children run with this timeout (`update-package-verifier`). */
export const EXTRACTOR_TIMEOUT_MS = 600_000;
export const SPAWN_MARGIN_MS = 120_000;

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
  ownerStartedAtMs: StartedAt,
  handle: z.string().min(1).max(4096),
  // `spawning` is written before a child exists; `spawned` after its identity
  // (or its prior exit) is known. Only `spawning` has an unrecorded child.
  phase: z.enum(["created", "spawning", "spawned"]),
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
  startedAtMs: number;
}>;
/** Local-time text, parsed in the timezone `ps` printed it in. */
export type ParseStart = (text: string) => number;
const parseLocalStart: ParseStart = (text) => Date.parse(text);

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
    const startedAtMs = parse(text);
    if (
      stderr ||
      !ProcessStartText.safeParse(text).success ||
      !Number.isSafeInteger(startedAtMs)
    )
      throw new Error("process start unreadable");
    return { processStart: text, startedAtMs };
  } catch (error) {
    if (cleanAbsence(error)) return null;
    throw error;
  }
}

/**
 * Whether the process a lease recorded is still running.
 *
 * `live`: the recorded identity still names the process at that pid, by text
 *   or by instant.
 * `ended`: no such pid, or the pid now names a process that started later than
 *   the recorded one (the pid was reused).
 * `unknown`: a failed probe, an unrecorded identity for a running pid, or a
 *   start that is not later than the recorded one. Only `ended` permits
 *   removal.
 */
export async function observeLeaseProcess(
  recorded: Readonly<{
    pid: number;
    processStart: string | null;
    startedAtMs: number | null;
  }>,
  read: ProcessRead,
  parse: ParseStart = parseLocalStart,
): Promise<"live" | "ended" | "unknown"> {
  let current: ProcessIdentity | null;
  try {
    current = await readProcessIdentity(recorded.pid, read, parse);
  } catch {
    return "unknown";
  }
  if (current === null) return "ended";
  if (recorded.processStart === null || recorded.startedAtMs === null)
    return "unknown";
  if (
    current.processStart === recorded.processStart ||
    current.startedAtMs === recorded.startedAtMs
  )
    return "live";
  return current.startedAtMs > recorded.startedAtMs ? "ended" : "unknown";
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
    now?: () => number;
  }>,
) {
  const now = input.now ?? Date.now;
  let lease: ExtractionLease = {
    schema: LEASE_SCHEMA,
    ownerPid: input.ownerPid,
    ownerProcessStart: input.owner.processStart,
    ownerStartedAtMs: input.owner.startedAtMs,
    handle: input.handle,
    phase: "created",
    updatedAt: now(),
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
     * Written right after the spawn. A null start means the child's identity
     * could not be read; a child that had already ended is not listed.
     */
    childSpawned: (
      child: Readonly<{
        pid: number;
        processStart: string | null;
        startedAtMs: number | null;
      }> | null,
    ) =>
      revise((current) => ({
        ...current,
        phase: "spawned",
        children: child ? [...current.children, child] : current.children,
      })),
  };
}
