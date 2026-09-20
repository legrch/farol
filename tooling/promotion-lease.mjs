import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// The tooling-side half of the promotion lease protocol. It reads and
// writes exactly the record shape `src/apps/desktop/promotion-lease.ts`
// does, so the two sides interoperate as one lock even though they run as
// separate processes in separate runtimes: the promotion CLI is plain Node,
// the app's admission check runs inside Electron. See that file for the
// lease's contract; this file must stay behaviourally identical to it.

export const PROMOTION_LEASE_SCHEMA = "farol.next.promotion-lease/1";

const FILE_NAME = "promotion.lease";
const MAX_BYTES = 4 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC = fsConstants.O_CLOEXEC ?? 0;
const ACQUIRE_ATTEMPTS = 8;
const ROLES = new Set(["promotion", "admission"]);

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function promotionLeasePath(userData) {
  if (!path.isAbsolute(userData)) {
    throw new Error("PROMOTION_LEASE_ROOT_NOT_ABSOLUTE");
  }
  return path.join(userData, "farol-next-state", FILE_NAME);
}

function validRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.schema === 1 &&
    typeof value.generation === "string" &&
    value.generation.length > 0 &&
    value.generation.length <= 200 &&
    ROLES.has(value.role) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    /^[a-f0-9]{32}$/u.test(value.nonce ?? "") &&
    typeof value.acquiredAt === "string" &&
    value.acquiredAt.length > 0 &&
    value.acquiredAt.length <= 64
  );
}

async function readLease(file) {
  let handle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") throw new Error("PROMOTION_LEASE_UNSAFE");
    throw error;
  }
  try {
    const info = await handle.stat();
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("PROMOTION_LEASE_UNSAFE");
    }
    if (info.size > MAX_BYTES) throw new Error("PROMOTION_LEASE_CORRUPT");
    const text = await handle.readFile("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("PROMOTION_LEASE_CORRUPT");
    }
    if (!validRecord(parsed)) throw new Error("PROMOTION_LEASE_CORRUPT");
    return { record: parsed, serialized: text };
  } finally {
    await handle.close();
  }
}

async function ensureStateDirectory(file) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
}

async function createLease(file, record) {
  await ensureStateDirectory(file);
  const serialized = `${JSON.stringify(record)}\n`;
  let handle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

// S35-03/3: `rename()` is atomic and requires its source to exist, so it
// doubles as an exclusive claim on whatever currently occupies `file` — at
// most one caller across every process can ever win it for a given
// occupant; every later caller sees ENOENT once the winner has moved it.
// This is the "read, then remove in a separate step" gap this function used
// to have: a second recoverer could read the same stale bytes, then rename
// away whatever a third process had *already* written in its place,
// destroying a lease nobody here ever confirmed was stale.
async function claimForExchange(file) {
  const claim = `${file}.claim-${randomBytes(8).toString("hex")}`;
  try {
    await fs.rename(file, claim);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return claim;
}

// Puts a claimed occupant back, but only if nobody has legitimately
// recreated `file` since it was claimed: `link()` is atomic and requires its
// destination to be absent, so a fresh writer that raced in during the
// claim window always wins over the restore.
async function restoreClaim(claim, file) {
  try {
    await fs.link(claim, file);
  } finally {
    await fs.unlink(claim).catch(() => undefined);
  }
}

async function removeConfirmedStaleLease(
  file,
  expectedSerialized,
  beforeExchange,
) {
  const claim = await claimForExchange(file);
  if (!claim) return false;
  await beforeExchange?.();
  let matches;
  try {
    const info = await fs.lstat(claim);
    // A claimed occupant that is not a private regular file cannot be
    // trusted to compare or to restore faithfully; treat it the same as a
    // mismatch (put it back, or drop it if something else already took its
    // place) and let the next real read apply the full safety checks.
    matches =
      info.isFile() &&
      (await fs.readFile(claim, "utf8")) === expectedSerialized;
  } catch {
    matches = false;
  }
  if (!matches) {
    await restoreClaim(claim, file).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    return false;
  }
  await fs.unlink(claim).catch(() => undefined);
  return true;
}

export async function acquirePromotionLease(
  userData,
  generation,
  role,
  dependencies = {},
) {
  const file = promotionLeasePath(userData);
  const pid = dependencies.pid ?? process.pid;
  const isAlive = dependencies.isAlive ?? defaultIsAlive;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const record = {
      schema: 1,
      generation,
      role,
      pid,
      nonce: randomBytes(16).toString("hex"),
      acquiredAt: new Date().toISOString(),
    };
    if (await createLease(file, record)) return { file, record };

    const existing = await readLease(file);
    if (!existing) continue;
    if (isAlive(existing.record.pid)) return null;
    await removeConfirmedStaleLease(
      file,
      existing.serialized,
      dependencies.beforeExchange,
    );
  }
  throw new Error("PROMOTION_LEASE_CONTENTION");
}

export async function releasePromotionLease(handle) {
  const current = await readLease(handle.file).catch(() => null);
  if (!current) return;
  if (
    current.record.pid !== handle.record.pid ||
    current.record.nonce !== handle.record.nonce
  ) {
    return;
  }
  await fs.unlink(handle.file).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export async function isPromotionLeaseHeld(userData, dependencies = {}) {
  const pid = dependencies.pid ?? process.pid;
  const isAlive = dependencies.isAlive ?? defaultIsAlive;
  let existing;
  try {
    existing = await readLease(promotionLeasePath(userData));
  } catch {
    return true; // Unsafe or corrupt: fail closed.
  }
  if (!existing) return false;
  if (existing.record.pid === pid) return false;
  return isAlive(existing.record.pid);
}
