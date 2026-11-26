import type { ProjectPreferenceRecord } from "../../app/port/codex-project-preference";
import { z } from "zod";
import { constants, linkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  HandoffJournal,
  HandoffRecord,
} from "../../app/service/persistent-codex-handoff";
import {
  continuationBindingMatches,
  continuationBroken,
  continuationUnresolved,
  directoryUnsafe,
  dispatchOpen,
  fileChanged,
  fileUnsafe,
  hasDispatchProgress,
  identityChanged,
  inodeChanged,
  intentOrderBroken,
  selectionInventoryInvalid,
  titleReceiptMismatch,
} from "./journalintegrity";
import {
  dispatchDirectory,
  isDispatchRecordFile,
  isPreferenceRootEntry,
  isTemporaryAlias,
  MAX_DISPATCH_FILES,
  MAX_ROOT_ENTRIES,
  preferenceFile,
  preferenceSelectionDirectory,
  selectionEntryUnexpected,
  selectionPublished,
  selectionSlotName,
  selectionSlots,
  selectionWitnessName,
  selectionWitnesses,
  validKey,
} from "./journallayout";
import {
  DispatchAttemptSchema,
  isDigest,
  isIntentBinding,
  isRecordObject,
  MAX_DISPATCH_ATTEMPTS,
  parseReservation,
  ProjectPreferenceRecordSchema,
  ProjectPreferenceSelectionSchema,
  stringRecord,
} from "./journalrecords";
import { buildHandoffRecord, messageState } from "./journalresults";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NO_FOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeOnce(
  file: string,
  value: unknown,
  canPublish?: () => boolean,
): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
  } catch (error) {
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  try {
    // link publishes fully written bytes without replacing another claimant.
    // A reader never observes an empty or partially written final file.
    try {
      if (canPublish) {
        // Prepare and sync privately, then check cancellation and publish in
        // one synchronous segment. No awaited gap can grant retry after abort.
        if (!canPublish()) return false;
        linkSync(temporary, file);
      } else {
        await fs.link(temporary, file);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    await syncDirectory(path.dirname(file));
    return true;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
    await syncDirectory(path.dirname(file));
  }
}

async function readPrivate(
  file: string,
  rejectJsonNull = false,
  nonBlocking = true,
): Promise<unknown | null> {
  if (
    nonBlocking &&
    (!Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0)
  )
    throw new Error("HANDOFF_JOURNAL_NONBLOCK_UNAVAILABLE");
  let handle;
  try {
    handle = await fs.open(
      file,
      constants.O_RDONLY | NO_FOLLOW | (nonBlocking ? constants.O_NONBLOCK : 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    let publishedPair = false;
    if (stat.nlink === 2) {
      const directory = path.dirname(file);
      const basename = path.basename(file);
      const aliases = (await fs.readdir(directory)).filter((name) =>
        isTemporaryAlias(basename, name),
      );
      for (const name of aliases) {
        const alias = await fs.lstat(path.join(directory, name));
        if (
          alias.isFile() &&
          !alias.isSymbolicLink() &&
          alias.ino === stat.ino &&
          alias.dev === stat.dev &&
          (alias.mode & 0o077) === 0
        ) {
          publishedPair = true;
          break;
        }
      }
    }
    if (fileUnsafe(stat, publishedPair, process.geteuid?.())) {
      throw new Error("HANDOFF_JOURNAL_UNSAFE");
    }
    const bytes = Buffer.alloc(4_097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (fileChanged(stat, after, bytesRead))
      throw new Error("HANDOFF_JOURNAL_CHANGED");
    const value = JSON.parse(
      bytes.subarray(0, bytesRead).toString("utf8"),
    ) as unknown;
    // Missing file is the only absence proof for the new title records.
    if (rejectJsonNull && value === null)
      throw new Error("HANDOFF_JOURNAL_INVALID");
    return value;
  } finally {
    await handle.close();
  }
}

export class PrivateCodexHandoffJournal implements HandoffJournal {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("HANDOFF_JOURNAL_ROOT_INVALID");
  }

  /** Read only, under the caller's exclusive dispatch/Computer fence. No
   * persisted intent is dismissed because a client or process has exited. */
  async updateTaskKeys(): Promise<readonly string[]> {
    if (!(await this.verifyRoot())) return [];
    const before = await fs.lstat(this.root);
    const keys: string[] = [];
    let count = 0;
    const directory = await fs.opendir(this.root);
    for await (const entry of directory) {
      if (++count > MAX_ROOT_ENTRIES)
        throw new Error("HANDOFF_JOURNAL_SCAN_LIMIT");
      if (isPreferenceRootEntry(entry.name)) continue;
      if (!validKey(entry.name))
        throw new Error("HANDOFF_JOURNAL_UNEXPECTED_ENTRY");
      const child = path.join(this.root, entry.name);
      const childBefore = await this.verifyPreferenceDirectory(child);
      if ((await fs.realpath(child)) !== child)
        throw new Error("HANDOFF_JOURNAL_UNSAFE");
      let files = 0;
      for await (const file of await fs.opendir(child)) {
        // Only complete published records participate. A leftover temporary or
        // unknown record may hide an interrupted dispatch and is not discarded.
        if (++files > MAX_DISPATCH_FILES || !isDispatchRecordFile(file.name))
          throw new Error("HANDOFF_JOURNAL_UNEXPECTED_ENTRY");
        if ((await readPrivate(path.join(child, file.name), true)) === null)
          throw new Error("HANDOFF_JOURNAL_CHANGED");
      }
      const record = await this.read(entry.name);
      if (
        !record ||
        (await this.hasUnconfirmedMessage(entry.name)) ||
        (await this.hasUnconfirmedTitle(entry.name))
      )
        throw new Error("HANDOFF_JOURNAL_UNRESOLVED");
      const continuation = await readPrivate(
        path.join(child, "continuation-child.json"),
        true,
      );
      if (continuation !== null) {
        const parsed = z
          .strictObject({ key: z.string().uuid(), turnId: z.string() })
          .parse(continuation);
        const next = await this.read(parsed.key);
        if (continuationUnresolved(parsed, record, next, entry.name))
          throw new Error("HANDOFF_JOURNAL_UNRESOLVED");
      }
      // A reservation before any dispatch has no remote effect. Once an intent
      // exists, only the normal exact-identity status path may establish idle.
      if (hasDispatchProgress(files, record)) keys.push(entry.name);
      const childAfter = await this.verifyPreferenceDirectory(child);
      if (
        identityChanged(childBefore, childAfter) ||
        (await fs.realpath(child)) !== child
      )
        throw new Error("HANDOFF_JOURNAL_CHANGED");
    }
    const after = await fs.lstat(this.root);
    if (
      identityChanged(before, after) ||
      (await fs.realpath(this.root)) !== this.root ||
      !(await this.verifyRoot())
    )
      throw new Error("HANDOFF_JOURNAL_CHANGED");
    return keys;
  }

  async readProjectPreference(
    key: string,
  ): Promise<ProjectPreferenceRecord | null> {
    if (!validKey(key))
      throw new Error("HANDOFF_PROJECT_PREFERENCE_KEY_INVALID");
    await this.ensureRoot();
    return this.readExistingProjectPreference(key);
  }

  private async readExistingProjectPreference(
    key: string,
  ): Promise<ProjectPreferenceRecord | null> {
    const value = await readPrivate(preferenceFile(this.root, key), true, true);
    return value === null ? null : ProjectPreferenceRecordSchema.parse(value);
  }

  async rememberProjectPreference(
    key: string,
    record: ProjectPreferenceRecord,
  ): Promise<ProjectPreferenceRecord> {
    if (!validKey(key))
      throw new Error("HANDOFF_PROJECT_PREFERENCE_KEY_INVALID");
    const parsed = ProjectPreferenceRecordSchema.parse(record);
    if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 4000)
      throw new Error("HANDOFF_PROJECT_PREFERENCE_TOO_LARGE");
    await this.ensureRoot();
    const prior = await this.readProjectPreference(key);
    if (prior) return prior; // Reading an old handle never reorders preference.
    const head = await this.readPreferenceSelection(parsed.project);
    const sequence = (head?.sequence ?? 0) + 1;
    if (sequence > 256)
      throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_LIMIT");
    const directory = this.preferenceSelectionDirectory(parsed.project);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      await syncDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.verifyPreferenceDirectory(directory);
    const slot = path.join(directory, selectionSlotName(sequence));
    // Publish intent first. Missing/corrupt receipt blocks lookup and further
    // selections; it can never turn into an implicit fallback to an old choice.
    if (!(await writeOnce(slot, { key: key.toLowerCase() })))
      throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_CONFLICT");
    const witness = path.join(directory, selectionWitnessName(sequence));
    if (!(await writeOnce(witness, { key: key.toLowerCase() })))
      throw new Error("HANDOFF_PROJECT_PREFERENCE_WITNESS_CONFLICT");
    await writeOnce(preferenceFile(this.root, key), parsed);
    await this.readPreferenceSelection(parsed.project);
    const stored = await this.readProjectPreference(key);
    if (!stored)
      throw new Error("HANDOFF_PROJECT_PREFERENCE_PUBLICATION_UNKNOWN");
    return stored;
  }

  async readLatestProjectPreference(
    project: ProjectPreferenceRecord["project"],
  ) {
    if (!(await this.verifyRoot())) return null;
    const selected = await this.readPreferenceSelection(
      ProjectPreferenceRecordSchema.shape.project.parse(project),
    );
    return selected === null
      ? null
      : { key: selected.key, record: selected.record };
  }

  private preferenceSelectionDirectory(
    project: ProjectPreferenceRecord["project"],
  ): string {
    const canonical =
      ProjectPreferenceRecordSchema.shape.project.parse(project);
    return preferenceSelectionDirectory(this.root, canonical);
  }

  private async verifyPreferenceDirectory(directory: string) {
    const stat = await fs.lstat(directory);
    if (directoryUnsafe(stat, process.geteuid?.()))
      throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_UNSAFE");
    return stat;
  }

  private async readPreferenceSelection(
    project: ProjectPreferenceRecord["project"],
  ): Promise<{
    sequence: number;
    key: string;
    record: ProjectPreferenceRecord;
  } | null> {
    const directory = this.preferenceSelectionDirectory(project);
    let before;
    try {
      before = await this.verifyPreferenceDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const entries = await fs.readdir(directory);
    const slots = selectionSlots(entries);
    const witnesses = selectionWitnesses(entries);
    if (
      selectionInventoryInvalid(
        slots,
        witnesses,
        entries.length,
        entries.some(selectionEntryUnexpected),
      )
    )
      throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_INVALID");
    const keys = new Set<string>();
    let latest = null;
    for (let index = 0; index < slots.length; index++) {
      const sequence = index + 1;
      if (slots[index] !== selectionSlotName(sequence))
        throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_GAP");
      const { key } = ProjectPreferenceSelectionSchema.parse(
        await readPrivate(path.join(directory, slots[index]!), true, true),
      );
      if (
        witnesses[index] !== `witness-${slots[index]}` ||
        ProjectPreferenceSelectionSchema.parse(
          await readPrivate(
            path.join(directory, witnesses[index]!),
            true,
            true,
          ),
        ).key !== key
      )
        throw new Error("HANDOFF_PROJECT_PREFERENCE_WITNESS_UNVERIFIED");
      if (keys.has(key))
        throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_DUPLICATE");
      keys.add(key);
      const record = await this.readExistingProjectPreference(key);
      if (
        !record ||
        JSON.stringify(record.project) !==
          JSON.stringify(
            ProjectPreferenceRecordSchema.shape.project.parse(project),
          )
      )
        throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_UNVERIFIED");
      latest = { sequence, key, record };
    }
    const after = await this.verifyPreferenceDirectory(directory);
    const finalSlots = selectionPublished(await fs.readdir(directory));
    if (
      inodeChanged(before, after) ||
      JSON.stringify([...slots, ...witnesses].sort()) !==
        JSON.stringify(finalSlots)
    )
      throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_CHANGED");
    return latest;
  }

  async reserve(key: string, record: HandoffRecord): Promise<HandoffRecord> {
    await this.ensureRoot();
    const directory = this.directory(key);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      await syncDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.read(key);
      if (!existing) throw new Error("HANDOFF_JOURNAL_INCOMPLETE_RESERVATION");
      return existing;
    }
    if (!(await writeOnce(path.join(directory, "reservation.json"), record))) {
      throw new Error("HANDOFF_JOURNAL_RESERVATION_CONFLICT");
    }
    return record;
  }

  async claimThread(key: string): Promise<boolean> {
    return writeOnce(path.join(this.directory(key), "thread-intent.json"), {
      intent: true,
    });
  }

  async claimDispatchAttempt(
    key: string,
    initial: boolean,
  ): Promise<number | null> {
    const record = await this.read(key);
    if (!dispatchOpen(record)) return null;
    const directory = this.directory(key);
    for (let attempt = 0; attempt < MAX_DISPATCH_ATTEMPTS; attempt++) {
      const file = path.join(directory, `dispatch-attempt-${attempt}.json`);
      const current = await readPrivate(file, true, true);
      if (current !== null) {
        if (DispatchAttemptSchema.parse(current).attempt !== attempt)
          throw new Error("HANDOFF_DISPATCH_ATTEMPT_INVALID");
        if (initial) return null;
        const proof = await readPrivate(
          path.join(directory, `pre-effect-proof-${attempt}.json`),
          true,
          true,
        );
        if (proof === null) return null;
        if (DispatchAttemptSchema.parse(proof).attempt !== attempt)
          throw new Error("HANDOFF_PRE_EFFECT_PROOF_INVALID");
        continue;
      }
      // Missing attempt zero on a replay is unknown, never ownership. Each
      // retry consumes its predecessor's immutable no-effect proof by CAS.
      if ((attempt === 0) !== initial) return null;
      return (await writeOnce(file, { attempt })) ? attempt : null;
    }
    return null;
  }

  async recordPreEffectRefusal(
    key: string,
    attempt: number,
    canPublish: () => boolean = () => true,
  ): Promise<void> {
    DispatchAttemptSchema.parse({ attempt });
    const record = await this.read(key);
    if (!dispatchOpen(record)) return;
    const directory = this.directory(key);
    const claimed = await readPrivate(
      path.join(directory, `dispatch-attempt-${attempt}.json`),
      true,
      true,
    );
    if (
      claimed === null ||
      DispatchAttemptSchema.parse(claimed).attempt !== attempt
    )
      throw new Error("HANDOFF_DISPATCH_ATTEMPT_MISSING");
    const proofFile = path.join(directory, `pre-effect-proof-${attempt}.json`);
    if (!(await writeOnce(proofFile, { attempt }, canPublish))) {
      const proof = await readPrivate(proofFile, true, true);
      if (
        proof === null ||
        DispatchAttemptSchema.parse(proof).attempt !== attempt
      )
        throw new Error("HANDOFF_PRE_EFFECT_PROOF_INVALID");
    }
  }

  async recordThread(key: string, threadId: string): Promise<void> {
    if (
      !(await writeOnce(
        path.join(this.directory(key), "thread.json"),
        stringRecord(threadId),
      ))
    ) {
      throw new Error("HANDOFF_JOURNAL_THREAD_CONFLICT");
    }
  }

  async claimTurn(key: string): Promise<boolean> {
    return writeOnce(path.join(this.directory(key), "turn-intent.json"), {
      intent: true,
    });
  }

  async recordTurn(key: string, turnId: string): Promise<void> {
    if (
      !(await writeOnce(
        path.join(this.directory(key), "turn.json"),
        stringRecord(turnId),
      ))
    ) {
      throw new Error("HANDOFF_JOURNAL_TURN_CONFLICT");
    }
  }

  async claimContinuation(
    parentKey: string,
    parentTurnId: string,
    key: string,
  ): Promise<boolean> {
    if (!validKey(key)) throw new Error("HANDOFF_CONTINUATION_KEY_INVALID");
    const parent = await this.read(parentKey);
    if (!parent?.turnId || parent.turnId !== stringRecord(parentTurnId)) {
      throw new Error("HANDOFF_CONTINUATION_PARENT_INVALID");
    }
    const file = path.join(
      this.directory(parentKey),
      "continuation-child.json",
    );
    const binding = { key: key.toLowerCase(), turnId: parentTurnId };
    if (await writeOnce(file, binding)) return true;
    const previous = await readPrivate(file);
    return continuationBindingMatches(previous, binding);
  }

  async confirmContinuation(key: string, turnId: string): Promise<void> {
    const record = await this.read(key);
    if (!record?.continuedFrom || record.turnId !== stringRecord(turnId)) {
      throw new Error("HANDOFF_CONTINUATION_BINDING_INVALID");
    }
    if (
      !(await writeOnce(
        path.join(this.directory(key), "continuation-verified.json"),
        turnId,
      ))
    ) {
      throw new Error("HANDOFF_CONTINUATION_CONFIRMATION_CONFLICT");
    }
  }

  async hasUnconfirmedMessage(dispatchId: string): Promise<boolean> {
    const directory = this.directory(dispatchId);
    const intent = await readPrivate(
      path.join(directory, "message-intent.json"),
      true,
    );
    if (intent === null) {
      if (
        (await readPrivate(path.join(directory, "message.json"), true)) !== null
      )
        throw new Error("HANDOFF_MESSAGE_ORPHAN_RECEIPT");
      return false;
    }
    if (!isRecordObject(intent)) throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    if (!isIntentBinding(intent)) throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    const receipt = await readPrivate(path.join(directory, "message.json"));
    if (receipt === null) return true;
    const parent = await this.read(dispatchId);
    if (!parent?.turnId || stringRecord(receipt) !== parent.turnId)
      throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    return false;
  }

  async hasUnconfirmedTitle(dispatchId: string): Promise<boolean> {
    const intent = await readPrivate(
      path.join(this.directory(dispatchId), "title-intent.json"),
      true,
    );
    if (intent === null) {
      if (
        (await readPrivate(
          path.join(this.directory(dispatchId), "title.json"),
          true,
        )) !== null
      )
        throw new Error("HANDOFF_TITLE_ORPHAN_RECEIPT");
      return false;
    }
    if (!isRecordObject(intent)) throw new Error("HANDOFF_TITLE_UNVERIFIED");
    const value = intent;
    if (typeof value.key !== "string" || !validKey(value.key))
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    const receipt = await this.readTitle(dispatchId, value.key);
    if (!receipt || receipt.digest === "")
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    if (receipt.threadId === null) return true;
    const parent = await this.read(dispatchId);
    if (receipt.threadId !== parent?.threadId)
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    return false;
  }

  async claimTitle(
    dispatchId: string,
    key: string,
    digest: string,
  ): Promise<"claimed" | "existing" | "conflict"> {
    if (!validKey(key) || !isDigest(digest))
      throw new Error("HANDOFF_TITLE_INVALID");
    // Validate absence before publishing an intent; an orphan receipt is not a fresh operation.
    const before = await this.readTitle(dispatchId, key);
    if (before) return before.digest === digest ? "existing" : "conflict";
    const file = path.join(this.directory(dispatchId), "title-intent.json");
    if (await writeOnce(file, { key, digest })) return "claimed";
    const prior = await this.readTitle(dispatchId, key);
    return prior?.digest === digest ? "existing" : "conflict";
  }

  async readTitle(
    dispatchId: string,
    key: string,
  ): Promise<Readonly<{ digest: string; threadId: string | null }> | null> {
    if (!validKey(key)) throw new Error("HANDOFF_TITLE_INVALID");
    const directory = this.directory(dispatchId);
    const intent = await readPrivate(
      path.join(directory, "title-intent.json"),
      true,
    );
    if (intent === null) {
      if (
        (await readPrivate(path.join(directory, "title.json"), true)) !== null
      )
        throw new Error("HANDOFF_TITLE_ORPHAN_RECEIPT");
      return null;
    }
    if (!isRecordObject(intent)) throw new Error("HANDOFF_TITLE_UNVERIFIED");
    const prior = intent;
    if (!isIntentBinding(prior)) throw new Error("HANDOFF_TITLE_UNVERIFIED");
    if (prior.key !== key) return { digest: "", threadId: null };
    const receipt = await readPrivate(path.join(directory, "title.json"), true);
    if (receipt === null) return { digest: prior.digest, threadId: null };
    if (!isRecordObject(receipt)) throw new Error("HANDOFF_TITLE_UNVERIFIED");
    const confirmed = receipt;
    if (titleReceiptMismatch(confirmed, prior))
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    return { digest: prior.digest, threadId: stringRecord(confirmed.threadId) };
  }

  async recordTitle(
    dispatchId: string,
    key: string,
    threadId: string,
  ): Promise<void> {
    const prior = await this.readTitle(dispatchId, key);
    if (!prior || prior.digest === "" || prior.threadId !== null)
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    const record = await this.read(dispatchId);
    if (record?.threadId !== threadId)
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    if (
      !(await writeOnce(path.join(this.directory(dispatchId), "title.json"), {
        key,
        digest: prior.digest,
        threadId: stringRecord(threadId),
      }))
    )
      throw new Error("HANDOFF_TITLE_CONFLICT");
  }

  async claimMessage(
    dispatchId: string,
    key: string,
    digest: string,
  ): Promise<"claimed" | "existing" | "conflict"> {
    if (!validKey(key) || !isDigest(digest))
      throw new Error("HANDOFF_MESSAGE_INVALID");
    const file = path.join(this.directory(dispatchId), "message-intent.json");
    if (await writeOnce(file, { key, digest })) return "claimed";
    const existing = await readPrivate(file);
    if (!isRecordObject(existing))
      throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    const prior = existing;
    return prior.key === key && prior.digest === digest
      ? "existing"
      : "conflict";
  }

  async readMessage(
    dispatchId: string,
    key: string,
  ): Promise<Readonly<{ digest: string; turnId: string | null }> | null> {
    if (!validKey(key)) throw new Error("HANDOFF_MESSAGE_INVALID");
    const directory = this.directory(dispatchId);
    const intent = await readPrivate(
      path.join(directory, "message-intent.json"),
    );
    if (intent === null) return null;
    if (!isRecordObject(intent)) throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    const prior = intent;
    if (!isIntentBinding(prior)) throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    if (prior.key !== key) return { digest: "", turnId: null };
    const receipt = await readPrivate(path.join(directory, "message.json"));
    return messageState(prior.digest, receipt);
  }

  async recordMessage(
    dispatchId: string,
    key: string,
    turnId: string,
  ): Promise<void> {
    const prior = await this.readMessage(dispatchId, key);
    if (!prior || prior.digest === "" || prior.turnId !== null)
      throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    if (
      !(await writeOnce(
        path.join(this.directory(dispatchId), "message.json"),
        stringRecord(turnId),
      ))
    )
      throw new Error("HANDOFF_MESSAGE_CONFLICT");
  }

  async read(key: string): Promise<HandoffRecord | null> {
    const directory = this.directory(key);
    const base = await readPrivate(path.join(directory, "reservation.json"));
    if (base === null) return null;
    const record = parseReservation(base);
    let threadIntent = await readPrivate(
      path.join(directory, "thread-intent.json"),
    );
    let thread = await readPrivate(path.join(directory, "thread.json"));
    let turnIntent = await readPrivate(
      path.join(directory, "turn-intent.json"),
    );
    // A concurrent writer may have committed thread.json between the first
    // thread read and the turn-intent read. Re-read before declaring corruption.
    if (turnIntent !== null && thread === null) {
      thread = await readPrivate(path.join(directory, "thread.json"));
    }
    const turn = await readPrivate(path.join(directory, "turn.json"));
    if (thread !== null && threadIntent === null) {
      threadIntent = await readPrivate(
        path.join(directory, "thread-intent.json"),
      );
    }
    if (turn !== null && turnIntent === null) {
      turnIntent = await readPrivate(path.join(directory, "turn-intent.json"));
    }
    if (intentOrderBroken(thread, threadIntent, turn, turnIntent))
      throw new Error("HANDOFF_JOURNAL_INVALID");
    const continuation = await readPrivate(
      path.join(directory, "continuation-verified.json"),
    );
    if (continuationBroken(continuation, record.continuedFrom, turn)) {
      throw new Error("HANDOFF_CONTINUATION_BINDING_INVALID");
    }
    return buildHandoffRecord(record, {
      threadIntent,
      thread,
      turnIntent,
      turn,
      continuation,
    });
  }

  private directory(key: string): string {
    if (!validKey(key)) throw new Error("HANDOFF_JOURNAL_KEY_INVALID");
    return dispatchDirectory(this.root, key);
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await this.verifyRoot()))
      throw new Error("HANDOFF_JOURNAL_ROOT_UNSAFE");
  }

  private async verifyRoot(): Promise<boolean> {
    let stat;
    try {
      stat = await fs.lstat(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (directoryUnsafe(stat, process.geteuid?.())) {
      throw new Error("HANDOFF_JOURNAL_ROOT_UNSAFE");
    }
    return true;
  }
}
