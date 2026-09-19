import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// The one lock a Next promotion and the running app's work admission both
// honour: whichever side holds it excludes the other. A promotion takes it
// before it reads the drain report and keeps it through placement, so no
// task can be admitted in the gap the two-read drain check cannot fence by
// itself. Work admission only ever checks it — see `isLeaseHeldSync` — a
// synchronous, momentary read that a promotion holding the lease across its
// whole run is guaranteed to be visible to.
//
// The lease is a private regular file: created with `O_EXCL` so only one
// side ever succeeds, read with `O_NOFOLLOW` so a symlinked lease is refused
// rather than followed, and identified by the process that holds it so a
// crash leaves evidence a live check can recover from instead of a wedge.

export const PROMOTION_LEASE_SCHEMA = "farol.next.promotion-lease/1";

const FILE_NAME = "promotion.lease";
const MAX_BYTES = 4 * 1_024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const ACQUIRE_ATTEMPTS = 8;

const leaseRecordSchema = z.strictObject({
  schema: z.literal(1),
  generation: z.string().min(1).max(200),
  role: z.enum(["promotion", "admission"]),
  pid: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/u),
  acquiredAt: z.string().min(1).max(64),
});

export type PromotionLeaseRecord = z.infer<typeof leaseRecordSchema>;

export type PromotionLeaseHandle = Readonly<{
  file: string;
  record: PromotionLeaseRecord;
}>;

export type PromotionLeaseDependencies = Readonly<{
  pid?: number;
  isAlive?: (pid: number) => boolean;
}>;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function promotionLeasePath(userData: string): string {
  if (!path.isAbsolute(userData)) {
    throw new Error("PROMOTION_LEASE_ROOT_NOT_ABSOLUTE");
  }
  return path.join(userData, "farol-next-state", FILE_NAME);
}

type ReadOutcome = Readonly<{
  record: PromotionLeaseRecord;
  serialized: string;
}>;

async function readLease(file: string): Promise<ReadOutcome | null> {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error("PROMOTION_LEASE_UNSAFE");
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("PROMOTION_LEASE_CORRUPT");
    }
    const result = leaseRecordSchema.safeParse(parsed);
    if (!result.success) throw new Error("PROMOTION_LEASE_CORRUPT");
    return { record: result.data, serialized: text };
  } finally {
    await handle.close();
  }
}

async function ensureStateDirectory(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
}

async function createLease(
  file: string,
  record: PromotionLeaseRecord,
): Promise<boolean> {
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
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

// Removes a lease file whose holder is confirmed dead, but only the exact
// bytes just read: a second recovery racing the same stale lease must not
// unlink a fresh one that replaced it in between.
async function removeConfirmedStaleLease(
  file: string,
  expectedSerialized: string,
): Promise<boolean> {
  const stale = path.join(
    path.dirname(file),
    `.${FILE_NAME}.stale-${randomBytes(8).toString("hex")}`,
  );
  try {
    const current = await readLease(file);
    if (!current || current.serialized !== expectedSerialized) return false;
    await fs.rename(file, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fs.unlink(stale).catch(() => undefined);
  return true;
}

/**
 * Takes the lease for `generation`, or returns `null` when another live
 * holder already has it. A holder whose process is no longer alive is
 * recovered automatically so a crash cannot wedge every later promotion or
 * every later task; recovery only removes the exact bytes this call itself
 * observed to be dead, never a lease it has not proven dead.
 */
export async function acquirePromotionLease(
  userData: string,
  generation: string,
  role: "promotion" | "admission",
  dependencies: PromotionLeaseDependencies = {},
): Promise<PromotionLeaseHandle | null> {
  const file = promotionLeasePath(userData);
  const pid = dependencies.pid ?? process.pid;
  const isAlive = dependencies.isAlive ?? defaultIsAlive;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const record: PromotionLeaseRecord = {
      schema: 1,
      generation,
      role,
      pid,
      nonce: randomBytes(16).toString("hex"),
      acquiredAt: new Date().toISOString(),
    };
    if (await createLease(file, record)) return { file, record };

    const existing = await readLease(file);
    if (!existing) continue; // Released between our create and this read.
    if (isAlive(existing.record.pid)) return null;
    await removeConfirmedStaleLease(file, existing.serialized);
  }
  throw new Error("PROMOTION_LEASE_CONTENTION");
}

/**
 * Releases a lease this exact call acquired. A lease already recovered as
 * stale by someone else, or already released, is left alone — releasing is
 * never a reason to remove a file this handle does not still own.
 */
export async function releasePromotionLease(
  handle: PromotionLeaseHandle,
): Promise<void> {
  const current = await readLease(handle.file).catch(() => null);
  if (!current) return;
  if (
    current.record.pid !== handle.record.pid ||
    current.record.nonce !== handle.record.nonce
  ) {
    return;
  }
  await fs.unlink(handle.file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/**
 * The synchronous, momentary check work admission uses: is a *different*,
 * *live* process currently holding the promotion lease? Any ambiguity —
 * an unsafe file, a corrupt record, an unreadable state — fails closed and
 * refuses admission rather than guessing the lease is free.
 */
export function isPromotionLeaseHeldSync(
  userData: string,
  dependencies: PromotionLeaseDependencies = {},
): boolean {
  const file = promotionLeasePath(userData);
  const pid = dependencies.pid ?? process.pid;
  const isAlive = dependencies.isAlive ?? defaultIsAlive;
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    return true; // ELOOP or anything else: fail closed.
  }
  try {
    const info = fstatSync(fd);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_BYTES
    ) {
      return true;
    }
    const text = readFileSync(fd, "utf8");
    const parsed = leaseRecordSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) return true;
    if (parsed.data.pid === pid) return false;
    return isAlive(parsed.data.pid);
  } catch {
    return true;
  } finally {
    closeSync(fd);
  }
}
