import type { Stats } from "node:fs";
import type { HandoffRecord } from "../../app/service/persistent-codex-handoff";
import { isRecordObject } from "./journalrecords";

type FileFacts = Pick<
  Stats,
  "isFile" | "nlink" | "mode" | "uid" | "size" | "mtimeMs" | "ctimeMs"
>;
type DirectoryFacts = Pick<
  Stats,
  "isDirectory" | "isSymbolicLink" | "mode" | "uid"
>;
type Identity = Pick<Stats, "dev" | "ino" | "mtimeMs" | "ctimeMs">;

/** A record file must be a private, owner-held, small regular file. */
export function fileUnsafe(
  stat: FileFacts,
  publishedPair: boolean,
  euid: number | undefined,
): boolean {
  return (
    !stat.isFile() ||
    (stat.nlink !== 1 && !publishedPair) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== euid ||
    stat.size > 4_096
  );
}

/** True when a record changed while it was being read. */
export function fileChanged(
  before: FileFacts,
  after: FileFacts,
  bytesRead: number,
): boolean {
  return (
    bytesRead !== before.size ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  );
}

/** A journal directory must be a private, owner-held, real directory. */
export function directoryUnsafe(
  stat: DirectoryFacts,
  euid: number | undefined,
): boolean {
  return (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (euid !== undefined && stat.uid !== euid)
  );
}

export function identityChanged(before: Identity, after: Identity): boolean {
  return (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  );
}

export function inodeChanged(
  before: Pick<Stats, "dev" | "ino">,
  after: Pick<Stats, "dev" | "ino">,
): boolean {
  return before.dev !== after.dev || before.ino !== after.ino;
}

/** True while thread intent exists and no turn intent has been published. */
export function dispatchOpen(record: HandoffRecord | null): boolean {
  return (
    record?.dispatchProtocol === 1 &&
    !!record.threadIntent &&
    !record.turnIntent
  );
}

/** A turn may not exist without its intent, nor a thread without its intent. */
export function intentOrderBroken(
  thread: unknown,
  threadIntent: unknown,
  turn: unknown,
  turnIntent: unknown,
): boolean {
  return (
    (turnIntent !== null && thread === null) ||
    (thread !== null && threadIntent === null) ||
    (turn !== null && turnIntent === null)
  );
}

/** A verified continuation must belong to a continued record's own turn. */
export function continuationBroken(
  continuation: unknown,
  continuedFrom: string | undefined,
  turn: unknown,
): boolean {
  return (
    continuation !== null &&
    (continuedFrom === undefined || turn === null || continuation !== turn)
  );
}

/** A dispatch directory is listed once it holds more than its reservation. */
export function hasDispatchProgress(
  files: number,
  record: HandoffRecord,
): boolean {
  return Boolean(
    files > 1 ||
    record.threadIntent ||
    record.turnIntent ||
    record.threadId ||
    record.turnId,
  );
}

/** A parent's continuation binding must be confirmed by its child's record. */
export function continuationUnresolved(
  parsed: { turnId: string },
  record: HandoffRecord,
  next: HandoffRecord | null,
  childKey: string,
): boolean {
  return (
    parsed.turnId !== record.turnId ||
    !next?.continuationVerified ||
    next.continuedFrom !== childKey ||
    next.threadId !== record.threadId
  );
}

/** The slot/witness inventory of one preference selection is malformed. */
export function selectionInventoryInvalid(
  slots: readonly string[],
  witnesses: readonly string[],
  entryCount: number,
  anyUnexpected: boolean,
): boolean {
  return (
    slots.length > 256 ||
    witnesses.length !== slots.length ||
    entryCount > 1024 ||
    anyUnexpected
  );
}

/** A title receipt is exactly {key, digest, threadId} and matches its intent. */
export function titleReceiptMismatch(
  confirmed: Record<string, unknown>,
  intent: Record<string, unknown>,
): boolean {
  return (
    confirmed.key !== intent.key ||
    confirmed.digest !== intent.digest ||
    Object.keys(confirmed).length !== 3
  );
}

/** A stored continuation binding equals the one being claimed. */
export function continuationBindingMatches(
  previous: unknown,
  binding: Readonly<{ key: string; turnId: string }>,
): boolean {
  return (
    isRecordObject(previous) &&
    previous.key === binding.key &&
    previous.turnId === binding.turnId
  );
}
