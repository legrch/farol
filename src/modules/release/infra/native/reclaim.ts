import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXTRACTION_PREFIX,
  ExtractionLease,
  LEASE_FILE,
  LEASE_MAX_BYTES,
  observeLeaseProcess,
  type ProcessRead,
} from "./lease";

// Startup reclaim of verifier extractions that a dead process left behind.
//
// Removal is destructive, so each entry must prove all of the following before
// anything is deleted: it is a real directory owned by this user with mode
// 0700, directly inside a staging parent this scan validated; its lease parses;
// and the owner and every extractor child it lists have positively ended. A
// probe that fails or a start that is not one provable instant keeps the entry.
// Elapsed time alone never proves a child ended, so a lease left in `spawning`
// (a child that may exist but is not listed) is removed only after the same 24
// hours as a legacy entry. A lease that is present but unreadable is kept. An
// entry with no lease at all is a legacy leftover, removed only after 24 hours
// and never while another entry in the same parent has a live, unknown or
// unreadable owner.

export const LEGACY_MINIMUM_AGE_MS = 24 * 3_600_000;
const DOWNLOAD_PARENT = /^download-[0-9a-f]{32}$/u;
const SCAN_LIMIT = 65_536;

export type KeptReason =
  | "identity mismatch"
  | "live owner"
  | "live child"
  | "unknown liveness"
  | "spawning window"
  | "lease unreadable"
  | "lease untrusted"
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
  /**
   * Called for each staging parent after discovery and before it is read. It
   * exists so a test can change the tree at the one moment the identity checks
   * must catch; production passes nothing.
   */
  afterDiscovery?(parent: string): Promise<void>;
}>;

type Identity = Readonly<{ dev: bigint; ino: bigint }>;
/** A directory captured at discovery: where it is and which inode it was. */
type Ref = Readonly<{ path: string } & Identity>;
/** Raised when any directory on the way to an entry is no longer what was found. */
class ParentChanged extends Error {
  constructor() {
    super("parent identity changed");
  }
}
// A lease may be written by a clock a little off ours; beyond this it is not
// a lease this build wrote.
const CLOCK_SKEW_MS = 5 * 60_000;
// `ps` start times have one-second resolution.
const START_SKEW_MS = 2_000;
type Inspected = Readonly<{
  full: string;
  identity: Identity;
  modifiedMs: number;
  lease: ExtractionLease | null | "unreadable" | "untrusted";
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

async function directoryRef(
  directory: string,
  uid: number | undefined,
): Promise<Ref | null> {
  const stat = await ownedDirectory(directory, uid, "owner-only");
  if (!stat) return null;
  try {
    // Every component of the path must itself be real, not a link.
    if ((await fs.realpath(directory)) !== directory) return null;
  } catch {
    return null;
  }
  return { path: directory, dev: stat.dev, ino: stat.ino };
}

/** Every directory from the update root to the parent is still what it was. */
async function verifyChain(chain: readonly Ref[]): Promise<void> {
  for (const ref of chain) {
    try {
      const stat = await fs.lstat(ref.path, { bigint: true });
      if (!sameDirectory(stat, ref)) throw new ParentChanged();
      if ((await fs.realpath(ref.path)) !== ref.path) throw new ParentChanged();
    } catch {
      throw new ParentChanged();
    }
  }
}

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

/** Null: there is no lease. "unreadable": there is one that cannot be trusted. */
async function readLease(
  directory: string,
  uid: number | undefined,
): Promise<ExtractionLease | null | "unreadable"> {
  const file = path.join(directory, LEASE_FILE);
  let before: BigIntStats;
  try {
    before = await fs.lstat(file, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : "unreadable";
  }
  try {
    if (
      uid === undefined ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(uid) ||
      before.size < 1n ||
      before.size > BigInt(LEASE_MAX_BYTES)
    )
      return "unreadable";
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino)
        return "unreadable";
      const bytes = await handle.readFile({ encoding: "utf8" });
      const parsed = ExtractionLease.safeParse(JSON.parse(bytes));
      return parsed.success ? parsed.data : "unreadable";
    } finally {
      await handle.close();
    }
  } catch {
    return "unreadable";
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

/** Names in a staging parent, read only while its whole chain is verified. */
async function namesIn(chain: readonly Ref[]): Promise<string[] | null> {
  await verifyChain(chain);
  const found = await names(chain[chain.length - 1]!.path);
  await verifyChain(chain);
  return found;
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
  const skip = (parent: string, why = "not scanned") => {
    unscanned.push(parent);
    ports.log(`Update staging parent not scanned (${why}): ${parent}`);
  };

  // Staging parents are root and each real download-<32 hex> directory in it.
  // Nothing else is a parent, whatever a marker or a lease says. Each is kept
  // as a captured identity, and every directory from root down is rechecked
  // before anything is read or removed beneath it.
  const chains: Ref[][] = [];
  const rootRef = await directoryRef(ports.root, ports.uid);
  if (rootRef === null) skip(ports.root);
  else {
    let rootNames: string[] | null = null;
    try {
      rootNames = await namesIn([rootRef]);
    } catch {
      rootNames = null;
    }
    if (rootNames === null) skip(ports.root);
    else {
      chains.push([rootRef]);
      for (const name of rootNames) {
        if (!DOWNLOAD_PARENT.test(name)) continue;
        const parent = path.join(ports.root, name);
        const ref = await directoryRef(parent, ports.uid);
        if (ref) chains.push([rootRef, ref]);
        else skip(parent);
      }
    }
  }

  for (const chain of chains) {
    const parent = chain[chain.length - 1]!.path;
    try {
      await ports.afterDiscovery?.(parent);
      const entries = await namesIn(chain);
      if (entries === null) {
        skip(parent);
        continue;
      }
      await reclaimParent(chain, entries);
    } catch (error) {
      // Nothing more is removed under a parent that changed: abandon it whole.
      if (error instanceof ParentChanged) skip(parent, error.message);
      else throw error;
    }
  }

  async function reclaimParent(chain: readonly Ref[], entries: string[]) {
    const parent = chain[chain.length - 1]!.path;
    const inspected: Inspected[] = [];
    // An extraction that cannot be inspected might belong to a live owner, so
    // it protects its leaseless neighbours as a live or unknown owner would.
    let ownerAtRisk = false;
    for (const name of entries) {
      if (!name.startsWith(EXTRACTION_PREFIX)) continue;
      await verifyChain(chain);
      const full = path.join(parent, name);
      const stat = await ownedDirectory(full, ports.uid, "private");
      if (!stat) {
        keep(full, "identity mismatch");
        ownerAtRisk = true;
        continue;
      }
      const lease = await readLease(full, ports.uid);
      inspected.push({
        full,
        identity: { dev: stat.dev, ino: stat.ino },
        modifiedMs: Number(stat.mtimeMs),
        lease:
          lease === null || lease === "unreadable"
            ? lease
            : leaseConsistent(lease, ports)
              ? lease
              : "untrusted",
      });
    }

    // Liveness of every leased entry first: a leaseless leftover is judged
    // against what the leased ones in its own parent turn out to be.
    const verdicts = new Map<string, Verdict>();
    for (const entry of inspected) {
      if (entry.lease === null) continue;
      const verdict =
        entry.lease === "unreadable"
          ? keepFor("lease unreadable")
          : entry.lease === "untrusted"
            ? keepFor("lease untrusted")
            : await judgeLeased(entry.lease, ports);
      verdicts.set(entry.full, verdict);
      if (
        verdict.kind === "keep" &&
        (verdict.reason === "lease unreadable" ||
          verdict.reason === "lease untrusted" ||
          verdict.reason === "live owner" ||
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
      if (await removeExtraction(entry, chain, ports)) {
        reclaimed.push(entry.full);
        removedHere = true;
      } else keep(entry.full, "removal failed");
    }
    if (removedHere) {
      // The removal cannot be shown durable unless the parent is still it.
      await verifyChain(chain);
      if (!(await syncDirectory(parent))) skip(parent);
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
  // A child may exist that the lease does not list. Its own timeout dies with
  // its owner, so time proves nothing short of the legacy horizon.
  if (
    lease.phase === "spawning" &&
    !(ports.now() - lease.updatedAt > LEGACY_MINIMUM_AGE_MS)
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
  chain: readonly Ref[],
  ports: ReclaimPorts,
): Promise<boolean> {
  // Immediately before each step: every directory down to the parent, then the
  // entry itself, by lstat. Node has no remove-by-handle, so what is left is
  // the interval between this check and the one call that follows it.
  const unchanged = async () => {
    await verifyChain(chain);
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
    if (error instanceof ParentChanged) throw error;
    // Already gone is what removal wanted, unless something took its place.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return fs.lstat(entry.full).then(
        () => false,
        (lookup: NodeJS.ErrnoException) => lookup.code === "ENOENT",
      );
    return false;
  }
}

/**
 * A lease that does not hold together is not one this build wrote, whatever
 * it says about its owner. It is kept as untrusted, never reclaimed on.
 */
function leaseConsistent(lease: ExtractionLease, ports: ReclaimPorts): boolean {
  const { handle, createdAt, updatedAt, ownerStartedAtMs, phase } = lease;
  const relative = path.relative(ports.root, handle);
  const insideRoot =
    path.isAbsolute(handle) &&
    path.normalize(handle) === handle &&
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] !== "..";
  return (
    insideRoot &&
    createdAt <= updatedAt &&
    updatedAt <= ports.now() + CLOCK_SKEW_MS &&
    (ownerStartedAtMs === null ||
      ownerStartedAtMs <= createdAt + START_SKEW_MS) &&
    lease.children.every(
      (child) =>
        child.startedAtMs === null ||
        child.startedAtMs <= updatedAt + START_SKEW_MS,
    ) &&
    // `created` precedes every spawn; `spawned` follows the pid being listed.
    (phase !== "created" || lease.children.length === 0) &&
    (phase !== "spawned" || lease.children.length > 0)
  );
}
