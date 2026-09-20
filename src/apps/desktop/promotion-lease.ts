import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  openSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// The one lock a Next promotion and the running app's work admission both
// honour: whichever side holds it excludes the other. A promotion takes it
// before it reads the drain report and keeps it through placement; every
// write that turns this generation's state into a promotion obligation (a
// new task, a running turn, a native Agent start, a guarded edit) takes it
// in the "admission" role for its durable critical phase.
//
// S35-03 (governing pre-review, 2026-09-20): the previous record-based
// protocol (`O_EXCL` create, pid liveness, rename-claim recovery) could
// still remove a live holder's record during a stale-lease recovery race
// and leave two holders. The lease is now a kernel advisory lock: `open(2)`
// with `O_EXLOCK | O_NONBLOCK` on ONE fixed inode that is never unlinked. A
// live holder keeps that descriptor open for the whole lease; a second
// opener -- in any process, this one included -- gets EAGAIN and is refused;
// a crash, SIGKILL or power loss releases the lock in the kernel, so there
// is no pid to trust, no stale record to recover and no claim window. The
// record in the file is diagnostics for a person reading the state
// directory, never the exclusion itself. It keeps the schema-1 shape so a
// binary running the previous protocol fails closed against a live lease
// instead of removing it. `tooling/promotion-lease.mjs` is the twin the
// promotion CLI runs; the two must stay behaviourally identical.

export const PROMOTION_LEASE_SCHEMA = "farol.next.promotion-lease/1";

const FILE_NAME = "promotion.lease";
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;
// macOS/BSD `open(2)` lock flags. Node does not export them; libuv passes
// the numeric flags to the kernel unchanged.
const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;
// A shared-lock probe (`isPromotionLeaseHeldSync`) holds the inode for a few
// microseconds and would make a genuine acquire arriving in that instant see
// EAGAIN; a handful of short retries absorbs that without ever waiting on a
// real holder for long.
const ACQUIRE_ATTEMPTS = 4;
const ACQUIRE_RETRY_MS = 5;

export type PromotionLeaseRole = "promotion" | "admission";

export type PromotionLeaseRecord = Readonly<{
  schema: 1;
  generation: string;
  role: PromotionLeaseRole;
  pid: number;
  nonce: string;
  acquiredAt: string;
}>;

export type PromotionLeaseHandle = Readonly<{
  file: string;
  record: PromotionLeaseRecord;
}>;

type HoldState = {
  handle: fs.FileHandle;
  device: bigint;
  inode: bigint;
  released: boolean;
};

// Private per-handle state: the open descriptor that IS the lease, and the
// identity of the inode it locks. Kept out of the handle object so a handle
// serialised into a log or a receipt never carries a descriptor.
const holds = new WeakMap<PromotionLeaseHandle, HoldState>();

export function promotionLeasePath(userData: string): string {
  if (!path.isAbsolute(userData)) {
    throw new Error("PROMOTION_LEASE_ROOT_NOT_ABSOLUTE");
  }
  return path.join(userData, "farol-next-state", FILE_NAME);
}

function assertPlatform(): void {
  if (process.platform !== "darwin") {
    throw new Error("PROMOTION_LEASE_PLATFORM_UNSUPPORTED");
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type OwnershipFields = Readonly<{
  uid: bigint | number;
  mode: bigint | number;
}>;

function privateAndOwned(info: OwnershipFields): boolean {
  const effectiveUser = process.geteuid?.();
  return (
    (effectiveUser === undefined || Number(info.uid) === effectiveUser) &&
    (Number(info.mode) & 0o077) === 0
  );
}

// The state directory must be the app's own private directory: a symlink or
// a shared directory in its place would let the lease file be redirected or
// observed by another user, so both are refused rather than used.
async function ensureStateDirectory(file: string): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory, { bigint: true });
  if (!info.isDirectory() || !privateAndOwned(info)) {
    throw new Error("PROMOTION_LEASE_UNSAFE");
  }
}

async function openLocked(
  file: string,
  flags: number,
  mode: number,
): Promise<fs.FileHandle | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.open(file, flags, mode);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        if (attempt >= ACQUIRE_ATTEMPTS) return null;
        await sleep(ACQUIRE_RETRY_MS);
        continue;
      }
      if (code === "ELOOP") throw new Error("PROMOTION_LEASE_UNSAFE");
      throw error;
    }
  }
}

/**
 * Takes the lease for `generation` in `role`, or returns `null` when a live
 * holder -- another process or this one -- already has it. There is no
 * recovery step: a holder that died has already lost the kernel lock.
 */
export async function acquirePromotionLease(
  userData: string,
  generation: string,
  role: PromotionLeaseRole,
): Promise<PromotionLeaseHandle | null> {
  assertPlatform();
  if (generation.length < 1 || generation.length > 200) {
    throw new Error("PROMOTION_LEASE_GENERATION_INVALID");
  }
  if (role !== "promotion" && role !== "admission") {
    throw new Error("PROMOTION_LEASE_ROLE_INVALID");
  }
  const file = promotionLeasePath(userData);
  await ensureStateDirectory(file);
  const handle = await openLocked(
    file,
    fsConstants.O_RDWR |
      fsConstants.O_CREAT |
      NO_FOLLOW |
      CLOSE_ON_EXEC |
      O_EXLOCK |
      NON_BLOCKING,
    0o600,
  );
  if (!handle) return null;
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || !privateAndOwned(info)) {
      throw new Error("PROMOTION_LEASE_UNSAFE");
    }
    const record: PromotionLeaseRecord = {
      schema: 1,
      generation,
      role,
      pid: process.pid,
      nonce: randomBytes(16).toString("hex"),
      acquiredAt: new Date().toISOString(),
    };
    await handle.truncate(0);
    await handle.write(`${JSON.stringify(record)}\n`, 0, "utf8");
    await handle.sync();
    const lease: PromotionLeaseHandle = { file, record };
    holds.set(lease, {
      handle,
      device: info.dev,
      inode: info.ino,
      released: false,
    });
    return lease;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Releases a lease this process acquired. The file stays in place (the lock
 * lives on that one inode; unlinking it would let a later acquirer lock a
 * different inode while an older holder still holds this one); its record
 * is emptied so nobody reads a stale holder. Idempotent.
 */
export async function releasePromotionLease(
  lease: PromotionLeaseHandle,
): Promise<void> {
  const state = holds.get(lease);
  if (!state || state.released) return;
  state.released = true;
  try {
    await state.handle.truncate(0);
    await state.handle.sync();
  } catch {
    // The lock is released by the close below regardless.
  } finally {
    await state.handle.close().catch(() => undefined);
  }
}

/**
 * Fencing check for the moment before a durable step: the lease path must
 * still name the very inode this lease locks. Only a deliberate deletion of
 * the lease file could make it false (a fresh acquirer would then lock a new
 * inode), and a holder that proceeds regardless would be one of two.
 */
export async function verifyPromotionLease(
  lease: PromotionLeaseHandle,
): Promise<boolean> {
  const state = holds.get(lease);
  if (!state || state.released) return false;
  let info;
  try {
    info = await fs.lstat(lease.file, { bigint: true });
  } catch {
    return false;
  }
  return (
    info.isFile() &&
    info.nlink === 1n &&
    info.dev === state.device &&
    info.ino === state.inode
  );
}

/**
 * The synchronous, momentary check: does some live process (this one
 * included) hold the lease right now? A shared, non-blocking lock attempt
 * answers without ever taking the lease: EAGAIN means an exclusive holder
 * exists. Anything unsafe or unreadable fails closed as held.
 */
export function isPromotionLeaseHeldSync(userData: string): boolean {
  assertPlatform();
  let fd: number;
  try {
    fd = openSync(
      promotionLeasePath(userData),
      fsConstants.O_RDONLY |
        NO_FOLLOW |
        CLOSE_ON_EXEC |
        O_SHLOCK |
        NON_BLOCKING,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    return true; // EAGAIN (held), ELOOP (symlink) or anything else: closed.
  }
  try {
    const info = fstatSync(fd, { bigint: true });
    return !(info.isFile() && info.nlink === 1n && privateAndOwned(info));
  } catch {
    return true;
  } finally {
    closeSync(fd);
  }
}
