import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import { MAX_RECORD_BYTES, RestoreIntent, type RepairInode } from "./record";

// The guarded filesystem layer under the update records: authentication of the
// owned state directories, the bounded private record read and the atomic
// durable write. Every check fails closed and keeps its classification: only a
// verified absence reads as null, a record changing under the read is refused,
// and a write is not complete until the file and its directory are synced. The
// open flags, modes and the fsync and rename order are the stored contract that
// earlier installed builds rely on.

type RepairInodeValue = z.infer<typeof RepairInode>;

export async function canonicalOwnedDirectory(
  directory: string,
  privateMode: boolean,
): Promise<void> {
  const stat = await fs.lstat(directory);
  if (directory === "/Applications" && !privateMode) {
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o002) !== 0 ||
      ((stat.mode & 0o020) !== 0 && stat.gid !== 80) ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("UPDATE_PRIVATE_STATE_INVALID");
    const current = await fs.lstat(directory);
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.mode !== stat.mode ||
      current.uid !== stat.uid ||
      current.gid !== stat.gid
    )
      throw new Error("UPDATE_PRIVATE_STATE_INVALID");
    return;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    throw new Error("UPDATE_PRIVATE_STATE_INVALID");
}
export async function repairDirectoryIdentity(
  directory: string,
  expected: RepairInodeValue,
  privateMode: boolean,
): Promise<void> {
  await canonicalOwnedDirectory(directory, privateMode);
  const fd = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = await fd.stat({ bigint: true });
    const named = await fs.lstat(directory, { bigint: true });
    if (
      !actual.isDirectory() ||
      !named.isDirectory() ||
      actual.dev !== BigInt(expected[0]) ||
      actual.ino !== BigInt(expected[1]) ||
      actual.dev !== named.dev ||
      actual.ino !== named.ino ||
      actual.uid !== BigInt(process.getuid!()) ||
      (actual.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n
    )
      throw new Error("UPDATE_REPAIR_PHYSICAL_PAIR_CHANGED");
  } finally {
    await fd.close();
  }
}
export async function privateDirectory(directory: string): Promise<void> {
  // Electron has already created its profile. Refuse redirected parents before
  // creating any updater state, rather than recursively traversing an alias.
  await canonicalOwnedDirectory(path.dirname(directory), false);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await canonicalOwnedDirectory(directory, true);
}
export async function readRecord(
  file: string,
  privateMode = true,
  observeDigest?: (digest: string) => void,
  maximumBytes = MAX_RECORD_BYTES,
  observeBytes?: (bytes: Buffer) => void,
): Promise<unknown | null> {
  let before;
  let value: unknown;
  let digest: string;
  let observedBytes: Buffer | undefined;
  try {
    before = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    before.size > maximumBytes
  )
    throw new Error("UPDATE_RECORD_INVALID");
  const fd = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await fd.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("UPDATE_RECORD_CHANGED");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await fd.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await fd.stat();
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("UPDATE_RECORD_CHANGED");
    const bytes = buffer.subarray(0, bytesRead);
    value = JSON.parse(bytes.toString("utf8")) as unknown;
    digest = createHash("sha256").update(bytes).digest("hex");
    if (observeBytes) observedBytes = Buffer.from(bytes);
  } finally {
    await fd.close();
  }
  const named = await fs.lstat(file);
  if (
    named.dev !== before.dev ||
    named.ino !== before.ino ||
    named.size !== before.size ||
    named.mtimeMs !== before.mtimeMs ||
    named.ctimeMs !== before.ctimeMs ||
    named.mode !== before.mode ||
    named.uid !== before.uid ||
    named.nlink !== 1
  )
    throw new Error("UPDATE_RECORD_CHANGED");
  observeDigest?.(digest!);
  observeBytes?.(observedBytes!);
  return value;
}
// The restore intent is the recovery fence, so presence is not the value the
// reader returns: readRecord yields null both for a missing file and for a
// present file holding JSON null. Only a verified absence (ENOENT) is "no
// restore pending"; a present record that is not an intent is invalid.
export async function readRestoreIntent(
  file: string,
  read: typeof readRecord,
  absent: (file: string) => Promise<boolean>,
): Promise<z.infer<typeof RestoreIntent> | null> {
  const raw = await readPresentRecord(file, read, absent);
  if (raw === null) return null;
  const parsed = RestoreIntent.safeParse(raw);
  if (!parsed.success) throw new Error("UPDATE_RECORD_INVALID");
  return parsed.data;
}
// The cleanup marker fences updates while a verifier extraction may be on disk,
// so it needs the same presence rule as the restore intent, and the same
// strictness as the repair tool that also reads it (`strict_json` there). The
// ordinary reader decodes invalid UTF-8 to U+FFFD and lets the last duplicate
// key win, so the bytes are checked again here: invalid UTF-8, a duplicate key
// at any depth, or a NUL or other control character in a path field make the
// marker present but invalid. Beyond that its content is returned unjudged:
// whether it is well formed enough to be settled is `settleCleanupMarker`'s.
export async function readCleanupMarker(
  file: string,
  read: typeof readRecord,
  absent: (file: string) => Promise<boolean>,
): Promise<unknown | null> {
  let bytes: Buffer | undefined;
  const value = await readPresentRecord(
    file,
    (name, privateMode, observeDigest, maximumBytes) =>
      read(name, privateMode, observeDigest, maximumBytes, (observed) => {
        bytes = observed;
      }),
    absent,
  );
  if (value === null) return null;
  if (bytes === undefined || !strictMarkerBytes(bytes, value))
    throw new Error("UPDATE_RECORD_INVALID");
  return value;
}
const CONTROL = /[\u0000-\u001f\u007f]/u;
function strictMarkerBytes(bytes: Buffer, value: unknown): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (hasDuplicateKeys(text)) return false;
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    for (const field of ["handle", "operationRoot"] as const) {
      const item = (value as Record<string, unknown>)[field];
      if (typeof item === "string" && CONTROL.test(item)) return false;
    }
  return true;
}
// `text` already parsed as JSON, so this only walks its structure: it keeps one
// key set per open object and decodes each key through JSON.parse so that
// escaped spellings of the same key collide.
function hasDuplicateKeys(text: string): boolean {
  type Frame = { keys: Set<string> | null; expectKey: boolean };
  const stack: Frame[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (char === "[") stack.push({ keys: null, expectKey: false });
    else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = true;
    } else if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(index, end + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      index = end;
    }
    index += 1;
  }
  return false;
}
// Null means a verified absence (ENOENT) and nothing else. A present record
// that cannot be read or parsed, or that holds JSON null, is invalid evidence,
// not a generic startup failure. Errors that already carry an update code keep
// it.
async function readPresentRecord(
  file: string,
  read: typeof readRecord,
  absent: (file: string) => Promise<boolean>,
): Promise<unknown | null> {
  let raw: unknown;
  try {
    raw = await read(file);
  } catch (error) {
    throw error instanceof Error && /^UPDATE_[A-Z_]+$/u.test(error.message)
      ? error
      : new Error("UPDATE_RECORD_INVALID");
  }
  if (raw === null) {
    if (await absent(file)) return null;
    throw new Error("UPDATE_RECORD_INVALID");
  }
  return raw;
}
export async function writeRecord(
  file: string,
  value: unknown,
  beforeEffect: () => void = () => undefined,
): Promise<void> {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
    throw new Error("UPDATE_RECORD_OVERSIZED");
  const temporary = `${file}.${randomBytes(12).toString("hex")}`;
  beforeEffect();
  const fd = await fs.open(temporary, "wx", 0o600);
  try {
    beforeEffect();
    await fd.writeFile(bytes);
    beforeEffect();
    await fd.sync();
  } finally {
    await fd.close();
  }
  beforeEffect();
  await fs.rename(temporary, file);
  beforeEffect();
  const parent = await fs.open(
    path.dirname(file),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    beforeEffect();
    await parent.sync();
    beforeEffect();
  } finally {
    await parent.close();
  }
}
