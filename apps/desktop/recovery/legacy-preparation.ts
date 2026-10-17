import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CHATGPT_TASK_JOURNAL_FILE_NAME,
  ChatGptTaskJournalRecordSchema,
  MAX_CHATGPT_TASK_JOURNAL_BYTES,
  LEGACY_PREPARATION_ARCHIVE_NAME,
} from "../../../src/apps/desktop/chatgpt-task-journal-record";
import {
  closedRecoveryHostMechanics as host,
  type StartupLegacyPreparation,
} from "../../../src/apps/desktop/closed-empty-chat-recovery";
import { parseJSON } from "../bridge/frame";

type Snapshot = Awaited<ReturnType<typeof host.snapshot>>;
export type { StartupLegacyPreparation } from "../../../src/apps/desktop/closed-empty-chat-recovery";
const selected = new WeakMap<StartupLegacyPreparation, string>();
export { LEGACY_PREPARATION_ARCHIVE_NAME } from "../../../src/apps/desktop/chatgpt-task-journal-record";

export function assertStartupLegacyPreparation(
  pin: StartupLegacyPreparation,
  userData: string,
): void {
  if (selected.get(pin) !== userData)
    throw Error("STARTUP_LEGACY_PREPARATION_SELECTION_INVALID");
}
async function sync(directory: string): Promise<void> {
  const handle = await fs.open(
    directory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Select only metadata that the original legacy owner still classifies before
// dispatch. Go may independently have dispatched the same operation: no Go
// outcome, result delivery, ACK or terminal is inferred or changed here.
// Retiring this inactive legacy branch preserves the original bytes/phase;
// dispatch_intent/result_retained and malformed records never receive a pin.
export async function selectStartupLegacyPreparation(
  userData: string,
  assertCurrent: () => Promise<void>,
): Promise<StartupLegacyPreparation | null> {
  if (
    !path.isAbsolute(userData) ||
    path.normalize(userData) !== userData ||
    /[\0\r\n]/u.test(userData)
  )
    throw Error("STARTUP_LEGACY_PREPARATION_SELECTION_INVALID");
  const state = path.join(userData, "farol-next-state");
  const root = path.join(state, "chatgpt-task-journal");
  try {
    await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await assertCurrent();
  await host.privateRoot(userData);
  await host.privateRoot(state);
  const identity = await host.privateRoot(root);
  const file = path.join(root, CHATGPT_TASK_JOURNAL_FILE_NAME);
  try {
    await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const original = await host.snapshot(file, MAX_CHATGPT_TASK_JOURNAL_BYTES);
  if (
    ![identity.dev, identity.ino, original.device, original.inode].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw Error("STARTUP_LEGACY_PREPARATION_SELECTION_INVALID");
  const record = ChatGptTaskJournalRecordSchema.parse(
    parseJSON(new TextDecoder("utf-8", { fatal: true }).decode(original.bytes)),
  );
  if (
    record.phase !== "prepared" ||
    record.kind !== "readonly" ||
    record.result !== null
  )
    return null;
  let retirement: Promise<Snapshot> | undefined;
  let destination: string | undefined;
  const verifyOriginal = async () => {
    await assertCurrent();
    if (!isDeepStrictEqual(await host.privateRoot(root), identity))
      throw Error("STARTUP_LEGACY_PREPARATION_CHANGED");
    await host.unchanged(file, original);
    await assertCurrent();
  };
  const verify = async () => {
    if (retirement) throw Error("STARTUP_LEGACY_PREPARATION_CONSUMED");
    await verifyOriginal();
    if (retirement) throw Error("STARTUP_LEGACY_PREPARATION_CONSUMED");
  };
  const retire = async (archive: string): Promise<Snapshot> => {
    if (
      path.dirname(archive) !== path.join(state, "go-core") ||
      !/^chat-retired-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
        path.basename(archive),
      )
    )
      throw Error("STARTUP_LEGACY_PREPARATION_ARCHIVE_INVALID");
    await verifyOriginal();
    const archiveIdentity = await host.privateRoot(archive);
    const pending = path.join(state, "go-core.empty-recovery.pending");
    const intent = await host.snapshot(pending, 65536);
    if (
      ![
        archiveIdentity.dev,
        archiveIdentity.ino,
        intent.device,
        intent.inode,
      ].every((n) => Number.isSafeInteger(n) && n > 0)
    )
      throw Error("STARTUP_LEGACY_PREPARATION_SELECTION_INVALID");
    const target = path.join(archive, LEGACY_PREPARATION_ARCHIVE_NAME);
    await host.absent(target);
    await assertCurrent();
    await host.unchanged(pending, intent);
    await fs.rename(file, target);
    await sync(root);
    await sync(archive);
    const verifyRelocated = async () => {
      await host.unchanged(target, original);
      await host.absent(file);
      await host.unchanged(pending, intent);
      if (
        !isDeepStrictEqual(await host.privateRoot(archive), archiveIdentity) ||
        !isDeepStrictEqual(await host.privateRoot(root), identity)
      )
        throw Error("STARTUP_LEGACY_PREPARATION_CHANGED");
    };
    await verifyRelocated();
    await assertCurrent();
    await verifyRelocated();
    return original;
  };
  const pin: StartupLegacyPreparation = Object.freeze({
    operationId: record.operationId,
    sha256: createHash("sha256").update(original.bytes).digest("hex"),
    verify,
    retireInto: (archive: string): Promise<Snapshot> => {
      if (destination !== undefined && destination !== archive)
        return Promise.reject(
          Error("STARTUP_LEGACY_PREPARATION_SELECTION_CHANGED"),
        );
      if (!retirement) {
        destination = archive;
        retirement = retire(archive);
      }
      return retirement;
    },
  });
  await verify();
  selected.set(pin, userData);
  return pin;
}
