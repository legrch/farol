import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXTRACTION_PREFIX,
  EXTRACTOR_TIMEOUT_MS,
  ExtractionLease,
  LEASE_FILE,
  LEASE_MAX_BYTES,
  observeLeaseProcess,
  SPAWN_MARGIN_MS,
  type ProcessRead,
} from "./lease";

// Startup reclaim of verifier extractions that a dead process left behind.
//
// Removal is destructive, so each entry must prove all of the following before
// anything is deleted: it is a real directory owned by this user with mode
// 0700, directly inside a staging parent this scan validated; its lease parses;
// and the owner and every extractor child it lists have positively ended. A
// probe that fails, a start time that is not provably later, or a lease still
// in its spawn window keeps the entry. An entry without a readable lease is a
// legacy leftover and is removed only after 24 hours, and never while another
// entry in the same parent has a live or unknown owner.

export const LEGACY_MINIMUM_AGE_MS = 24 * 3_600_000;
const DOWNLOAD_PARENT = /^download-[0-9a-f]{32}$/u;
const SCAN_LIMIT = 65_536;

export type KeptReason =
  | "identity mismatch"
  | "live owner"
  | "live child"
  | "unknown liveness"
  | "spawning window"
  | "legacy entry too recent"
  | "live owner in parent"
  | "removal failed";

export type ReclaimReport = Readonly<{
  /**
   * True only when every staging parent was scanned and every extraction found
   * is absent or reclaimed. Anything else leaves the outcome unknown.
   */
  complete: boolean;
  reclaimed: readonly string[];
  kept: readonly Readonly<{ entry: string; reason: KeptReason }>[];
  unscanned: readonly string[];
}>;

export type ReclaimPorts = Readonly<{
  /** `<userData>/installed-updates`. */
  root: string;
  /** The current uid; an entry owned by anyone else is never touched. */
  uid: number | undefined;
  read: ProcessRead;
  /** Physical removal: Electron's ASAR files are not directories to `fs`. */
  removeDirectory(directory: string, force: boolean): Promise<void>;
  now(): number;
  log(message: string): void;
}>;

type Identity = Readonly<{ dev: bigint; ino: bigint }>;
type Inspected = Readonly<{
  full: string;
  identity: Identity;
  modifiedMs: number;
  lease: ExtractionLease | null;
}>;
type Verdict =
  | Readonly<{ kind: "reclaim" }>
  | Readonly<{ kind: "keep"; reason: KeptReason }>;

// Verdicts are built through one function so no result-shaped `reason` literal
// sits in this file: these are diagnostics, not operation outcomes.
const keepFor = (reason: KeptReason): Verdict => ({ kind: "keep", reason });
const sameDirectory = (stat: BigIntStats, identity: Identity): boolean =>
  stat.isDirectory() &&
  !stat.isSymbolicLink() &&
  stat.dev === identity.dev &&
  stat.ino === identity.ino;

async function ownedDirectory(
  directory: string,
  uid: number | undefined,
  mode: "private" | "owner-only",
): Promise<BigIntStats | null> {
  if (uid === undefined) return null;
  let stat: BigIntStats;
  try {
    stat = await fs.lstat(directory, { bigint: true });
  } catch {
    return null;
  }
  const permissions = Number(stat.mode & 0o777n);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(uid) ||
    (mode === "private" ? permissions !== 0o700 : (permissions & 0o077) !== 0)
  )
    return null;
  return stat;
}

async function readLease(
  directory: string,
  uid: number | undefined,
): Promise<ExtractionLease | null> {
  const file = path.join(directory, LEASE_FILE);
  try {
    const before = await fs.lstat(file, { bigint: true });
    if (
      uid === undefined ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(uid) ||
      before.size < 1n ||
      before.size > BigInt(LEASE_MAX_BYTES)
    )
      return null;
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino) return null;
      const bytes = await handle.readFile({ encoding: "utf8" });
      const parsed = ExtractionLease.safeParse(JSON.parse(bytes));
      return parsed.success ? parsed.data : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function names(directory: string): Promise<string[] | null> {
  try {
    const found: string[] = [];
    for await (const entry of await fs.opendir(directory)) {
      found.push(entry.name);
      if (found.length > SCAN_LIMIT) return null;
    }
    return found;
  } catch {
    return null;
  }
}

async function syncDirectory(directory: string): Promise<boolean> {
  try {
    const handle = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

export async function reclaimExtractions(
  ports: ReclaimPorts,
): Promise<ReclaimReport> {
  const reclaimed: string[] = [];
  const kept: { entry: string; reason: KeptReason }[] = [];
  const unscanned: string[] = [];
  const keep = (entry: string, reason: KeptReason) => {
    kept.push({ entry, reason });
    ports.log(`Update staging entry kept (${reason}): ${entry}`);
  };
  const skip = (parent: string) => {
    unscanned.push(parent);
    ports.log(`Update staging parent not scanned: ${parent}`);
  };

  // Staging parents are root and each real download-<32 hex> directory in it.
  // Nothing else is a parent, whatever a marker or a lease says.
  const parents: string[] = [];
  const rootNames = (await ownedDirectory(ports.root, ports.uid, "owner-only"))
    ? await names(ports.root)
    : null;
  if (rootNames === null) skip(ports.root);
  else {
    parents.push(ports.root);
    for (const name of rootNames) {
      if (!DOWNLOAD_PARENT.test(name)) continue;
      const parent = path.join(ports.root, name);
      if (await ownedDirectory(parent, ports.uid, "owner-only"))
        parents.push(parent);
      else skip(parent);
    }
  }

  for (const parent of parents) {
    const entries = await names(parent);
    if (entries === null) {
      skip(parent);
      continue;
    }
    const inspected: Inspected[] = [];
    for (const name of entries) {
      if (!name.startsWith(EXTRACTION_PREFIX)) continue;
      const full = path.join(parent, name);
      const stat = await ownedDirectory(full, ports.uid, "private");
      if (!stat) {
        keep(full, "identity mismatch");
        continue;
      }
      inspected.push({
        full,
        identity: { dev: stat.dev, ino: stat.ino },
        modifiedMs: Number(stat.mtimeMs),
        lease: await readLease(full, ports.uid),
      });
    }

    // Liveness of every leased entry first: a leaseless leftover is judged
    // against what the leased ones in its own parent turn out to be.
    const verdicts = new Map<string, Verdict>();
    let ownerAtRisk = false;
    for (const entry of inspected) {
      if (entry.lease === null) continue;
      const verdict = await judgeLeased(entry.lease, ports);
      verdicts.set(entry.full, verdict);
      if (
        verdict.kind === "keep" &&
        (verdict.reason === "live owner" ||
          verdict.reason === "live child" ||
          verdict.reason === "unknown liveness")
      )
        ownerAtRisk = true;
    }
    for (const entry of inspected) {
      if (entry.lease !== null) continue;
      verdicts.set(
        entry.full,
        ports.now() - entry.modifiedMs <= LEGACY_MINIMUM_AGE_MS
          ? keepFor("legacy entry too recent")
          : ownerAtRisk
            ? keepFor("live owner in parent")
            : { kind: "reclaim" },
      );
    }

    let removedHere = false;
    for (const entry of inspected) {
      const verdict = verdicts.get(entry.full);
      if (verdict === undefined) continue;
      if (verdict.kind === "keep") {
        keep(entry.full, verdict.reason);
        continue;
      }
      if (await removeExtraction(entry, ports)) {
        reclaimed.push(entry.full);
        removedHere = true;
      } else keep(entry.full, "removal failed");
    }
    if (removedHere && !(await syncDirectory(parent))) {
      // The removal cannot be shown durable, so the outcome is not known.
      skip(parent);
    }
  }

  return {
    complete: kept.length === 0 && unscanned.length === 0,
    reclaimed,
    kept,
    unscanned,
  };
}

async function judgeLeased(
  lease: ExtractionLease,
  ports: ReclaimPorts,
): Promise<Verdict> {
  const owner = await observeLeaseProcess(
    {
      pid: lease.ownerPid,
      processStart: lease.ownerProcessStart,
      startedAtMs: lease.ownerStartedAtMs,
    },
    ports.read,
  );
  if (owner === "live") return keepFor("live owner");
  const children = [];
  for (const child of lease.children)
    children.push(await observeLeaseProcess(child, ports.read));
  if (children.includes("live")) return keepFor("live child");
  if (owner === "unknown" || children.includes("unknown"))
    return keepFor("unknown liveness");
  // A child may exist that the lease could not list yet. Only after the
  // extractor's own timeout (plus a margin) can that child no longer run.
  const age = ports.now() - lease.updatedAt;
  if (
    lease.phase === "spawning" &&
    !(age > EXTRACTOR_TIMEOUT_MS + SPAWN_MARGIN_MS)
  )
    return keepFor("spawning window");
  return { kind: "reclaim" };
}

/**
 * Remove one extraction by its captured identity. Contents go first, the lease
 * last, so a failure partway never turns a leased entry into a leaseless one.
 */
async function removeExtraction(
  entry: Inspected,
  ports: ReclaimPorts,
): Promise<boolean> {
  const unchanged = async () => {
    const now = await fs.lstat(entry.full, { bigint: true });
    if (!sameDirectory(now, entry.identity))
      throw new Error("extraction replaced");
  };
  try {
    await unchanged();
    const children = await fs.readdir(entry.full);
    for (const child of children) {
      if (child === LEASE_FILE) continue;
      await unchanged();
      await ports.removeDirectory(path.join(entry.full, child), true);
    }
    await unchanged();
    await ports.removeDirectory(path.join(entry.full, LEASE_FILE), true);
    await unchanged();
    await ports.removeDirectory(entry.full, false);
    return true;
  } catch (error) {
    // Already gone is what removal wanted, unless something took its place.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return fs.lstat(entry.full).then(
        () => false,
        (lookup: NodeJS.ErrnoException) => lookup.code === "ENOENT",
      );
    return false;
  }
}
