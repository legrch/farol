import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  QUIT_RECEIPT_FILE_NAME,
  serializeQuitReceipt,
  type QuitReceiptInput,
} from "./quit-receipt";

// S35-TA-8: the durable write of the quit receipt.
//
// `main.ts` claimed this write "earns that the same way `live-task-store.ts`
// does", and it did not. The store validates its root is a private directory
// this user owns, refuses to rename over a target that is not a private
// regular file, and fsyncs the directory after the rename so the rename
// itself survives a crash. The version in `main.ts` did none of those three.
// The comment was the only thing asserting parity, and no test could check
// it, because `main.ts` exports nothing and no test loads it.
//
// This module makes the claim true rather than making the comment honest.
// The write is the last durable act of a quit, and the promotion CLI reads
// what it leaves: a receipt lost to an unsynced rename reads as
// `QUIT_UNCONFIRMED:crash`, so a clean quit is reported as a crash and the
// next `--apply` is refused. That direction is safe, which is why this was
// not urgent; it is still wrong, and it is why a real quit can look like a
// crash on a machine that lost power at the wrong moment.
//
// Kept out of `quit-receipt.ts` on purpose: that module is loaded by the
// `.mjs` promotion CLI through Node's unflagged type stripping and is
// deliberately free of imports it does not need. The bytes stay there; only
// the filesystem discipline lives here.

function stateError(code: string): never {
  throw new Error(code);
}

function assertPrivateFile(info: Stats): void {
  const effectiveUser = process.geteuid?.();
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (effectiveUser !== undefined && info.uid !== effectiveUser) ||
    (info.mode & 0o077) !== 0
  ) {
    stateError("QUIT_RECEIPT_STATE_UNSAFE");
  }
}

/**
 * The directory must be a real private directory this user owns — not a
 * symlink standing in for one, and not one another user can write.
 * `mkdir` with a mode does nothing at all when the directory already
 * exists, which is exactly the case that matters here.
 */
async function ensureRoot(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    stateError("QUIT_RECEIPT_STATE_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
}

/**
 * A target that already exists must be the kind of file this app writes.
 * `rename` would replace a symlink or a hard-linked entry silently; the
 * point is not that the rename would leak, it is that something has
 * replaced this app's private state and the quit should refuse rather than
 * paper over it.
 */
async function assertReplaceableTarget(target: string): Promise<void> {
  try {
    assertPrivateFile(await fs.lstat(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Makes the rename itself durable. Syncing the file persists its bytes;
 * only syncing the directory persists the name now pointing at them.
 */
async function syncRoot(directory: string): Promise<void> {
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0) |
      ((fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ??
        0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes the receipt as the private regular file the promotion reader
 * insists on: a private temporary next to the target, synced, renamed over
 * it, then the directory synced. Throws on anything it cannot do safely —
 * the caller treats a receipt that could not be written as a quit that
 * never confirmed, which leaves the run marker in place and refuses the
 * next promotion.
 */
export async function writeQuitReceipt(
  directory: string,
  receipt: QuitReceiptInput,
  at: string,
): Promise<void> {
  const serialized = serializeQuitReceipt(receipt, at);
  await ensureRoot(directory);
  const target = path.join(directory, QUIT_RECEIPT_FILE_NAME);
  await assertReplaceableTarget(target);
  const temporary = path.join(
    directory,
    `.${QUIT_RECEIPT_FILE_NAME}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0) |
        ((fsConstants as typeof fsConstants & { O_CLOEXEC?: number })
          .O_CLOEXEC ?? 0),
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    await syncRoot(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
