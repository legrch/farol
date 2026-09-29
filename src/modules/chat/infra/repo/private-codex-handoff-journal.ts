import type { ProjectPreferenceRecord } from "../../app/port/codex-project-preference";
import { z } from "zod";
import { constants, linkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TaskModelBindingSchema } from "../../../../pkg/owner-config/contract";

import type {
  HandoffJournal,
  HandoffRecord,
} from "../../app/service/persistent-codex-handoff";

const PreferencePath = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .slice(1)
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            !/[\u0000-\u001f\u007f]/u.test(part),
        ),
  );
const ProjectPreferenceRecordSchema = z.strictObject({
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/u),
  project: z.strictObject({
    root: PreferencePath,
    device: z.string().regex(/^[0-9]+$/u),
    inode: z.string().regex(/^[0-9]+$/u),
    gitCommonDirectory: PreferencePath,
  }),
});

const ProjectPreferenceSelectionSchema = z.strictObject({
  key: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    ),
});

const CatalogueObservationSchema = z.strictObject({
  modelId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
  observedAt: z.number().int().nonnegative().safe(),
  scope: z
    .string()
    .min(1)
    .max(240)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
});

const DispatchAttemptSchema = z.strictObject({
  attempt: z.number().int().min(0).max(31),
});
const MAX_DISPATCH_ATTEMPTS = 32;

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function validKey(key: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    key,
  );
}

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
  nonBlocking = false,
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
      const aliases = (await fs.readdir(directory)).filter(
        (name) =>
          name.startsWith(`${basename}.`) &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu.test(
            name.slice(basename.length + 1),
          ),
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
    if (
      !stat.isFile() ||
      (stat.nlink !== 1 && !publishedPair) ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4_096
    ) {
      throw new Error("HANDOFF_JOURNAL_UNSAFE");
    }
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    // Missing file is the only absence proof for the new title records.
    if (rejectJsonNull && value === null)
      throw new Error("HANDOFF_JOURNAL_INVALID");
    return value;
  } finally {
    await handle.close();
  }
}

function stringRecord(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,120}$/u.test(value)) {
    throw new Error("HANDOFF_JOURNAL_INVALID");
  }
  return value;
}

export class PrivateCodexHandoffJournal implements HandoffJournal {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("HANDOFF_JOURNAL_ROOT_INVALID");
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
    const value = await readPrivate(
      path.join(this.root, `project-preference-${key.toLowerCase()}.json`),
      true,
      true,
    );
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
    const slot = path.join(
      directory,
      `${String(sequence).padStart(6, "0")}.json`,
    );
    // Publish intent first. Missing/corrupt receipt blocks lookup and further
    // selections; it can never turn into an implicit fallback to an old choice.
    if (!(await writeOnce(slot, { key: key.toLowerCase() })))
      throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_CONFLICT");
    const witness = path.join(
      directory,
      `witness-${String(sequence).padStart(6, "0")}.json`,
    );
    if (!(await writeOnce(witness, { key: key.toLowerCase() })))
      throw new Error("HANDOFF_PROJECT_PREFERENCE_WITNESS_CONFLICT");
    await writeOnce(
      path.join(this.root, `project-preference-${key.toLowerCase()}.json`),
      parsed,
    );
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
    const digest = createHash("sha256")
      .update(JSON.stringify(canonical), "utf8")
      .digest("hex");
    return path.join(this.root, `project-preference-selections-${digest}`);
  }

  private async verifyPreferenceDirectory(directory: string) {
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.geteuid?.() !== undefined && stat.uid !== process.geteuid?.())
    )
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
    const slots = entries
      .filter((name) => /^[0-9]{6}\.json$/u.test(name))
      .sort();
    const witnesses = entries
      .filter((name) => /^witness-[0-9]{6}\.json$/u.test(name))
      .sort();
    if (
      slots.length > 256 ||
      witnesses.length !== slots.length ||
      entries.length > 1024 ||
      entries.some(
        (name) =>
          !/^(?:witness-)?[0-9]{6}\.json(?:\.[0-9a-f-]{36}\.tmp)?$/iu.test(
            name,
          ),
      )
    )
      throw new Error("HANDOFF_PROJECT_PREFERENCE_SELECTION_INVALID");
    const keys = new Set<string>();
    let latest = null;
    for (let index = 0; index < slots.length; index++) {
      const sequence = index + 1;
      if (slots[index] !== `${String(sequence).padStart(6, "0")}.json`)
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
    const finalSlots = (await fs.readdir(directory))
      .filter((name) => /^(?:witness-)?[0-9]{6}\.json$/u.test(name))
      .sort();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
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
    if (
      record?.dispatchProtocol !== 1 ||
      !record.threadIntent ||
      record.turnIntent
    )
      return null;
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
    if (
      record?.dispatchProtocol !== 1 ||
      !record.threadIntent ||
      record.turnIntent
    )
      return;
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
    return (
      previous !== null &&
      typeof previous === "object" &&
      !Array.isArray(previous) &&
      (previous as { key?: unknown }).key === binding.key &&
      (previous as { turnId?: unknown }).turnId === binding.turnId
    );
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
    );
    if (intent === null) return false;
    if (!intent || typeof intent !== "object" || Array.isArray(intent))
      throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    const value = intent as Record<string, unknown>;
    if (
      !validKey(String(value.key)) ||
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.digest)
    )
      throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
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
    if (!intent || typeof intent !== "object" || Array.isArray(intent))
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    const value = intent as Record<string, unknown>;
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
    if (!validKey(key) || !/^[a-f0-9]{64}$/u.test(digest))
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
    if (typeof intent !== "object" || Array.isArray(intent))
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    const prior = intent as Record<string, unknown>;
    if (
      !validKey(String(prior.key)) ||
      typeof prior.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(prior.digest)
    )
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    if (prior.key !== key) return { digest: "", threadId: null };
    const receipt = await readPrivate(path.join(directory, "title.json"), true);
    if (receipt === null) return { digest: prior.digest, threadId: null };
    if (typeof receipt !== "object" || Array.isArray(receipt))
      throw new Error("HANDOFF_TITLE_UNVERIFIED");
    const confirmed = receipt as Record<string, unknown>;
    if (
      confirmed.key !== prior.key ||
      confirmed.digest !== prior.digest ||
      Object.keys(confirmed).length !== 3
    )
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
    if (!validKey(key) || !/^[a-f0-9]{64}$/u.test(digest))
      throw new Error("HANDOFF_MESSAGE_INVALID");
    const file = path.join(this.directory(dispatchId), "message-intent.json");
    if (await writeOnce(file, { key, digest })) return "claimed";
    const existing = await readPrivate(file);
    if (!existing || typeof existing !== "object" || Array.isArray(existing))
      throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    const prior = existing as Record<string, unknown>;
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
    if (typeof intent !== "object" || Array.isArray(intent))
      throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    const prior = intent as Record<string, unknown>;
    if (
      !validKey(String(prior.key)) ||
      typeof prior.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(prior.digest)
    )
      throw new Error("HANDOFF_MESSAGE_UNVERIFIED");
    if (prior.key !== key) return { digest: "", turnId: null };
    const receipt = await readPrivate(path.join(directory, "message.json"));
    if (receipt === null) return { digest: prior.digest, turnId: null };
    return { digest: prior.digest, turnId: stringRecord(receipt) };
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
    if (typeof base !== "object" || Array.isArray(base)) {
      throw new Error("HANDOFF_JOURNAL_INVALID");
    }
    const record = base as Partial<HandoffRecord>;
    if (
      typeof record.requestDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.requestDigest) ||
      (record.adopted !== undefined && record.adopted !== true) ||
      (record.model !== undefined &&
        (typeof record.model !== "string" ||
          !/^[A-Za-z0-9_.\/-]{1,120}$/u.test(record.model))) ||
      (record.continuedFrom !== undefined &&
        (typeof record.continuedFrom !== "string" ||
          !validKey(record.continuedFrom))) ||
      record.continuationVerified !== undefined ||
      (record.dispatchProtocol !== undefined &&
        record.dispatchProtocol !== 1) ||
      (record.reasoningEffort !== undefined &&
        (typeof record.reasoningEffort !== "string" ||
          !/^[A-Za-z0-9_-]{1,40}$/u.test(record.reasoningEffort))) ||
      typeof record.workspaceId !== "string" ||
      typeof record.projectId !== "string" ||
      !record.workspace ||
      typeof record.workspace.root !== "string" ||
      typeof record.workspace.device !== "string" ||
      typeof record.workspace.inode !== "string" ||
      typeof record.workspace.gitCommonDirectory !== "string" ||
      !record.workspace.project ||
      typeof record.workspace.project.root !== "string" ||
      typeof record.workspace.project.device !== "string" ||
      typeof record.workspace.project.inode !== "string" ||
      typeof record.workspace.project.gitCommonDirectory !== "string" ||
      record.workspace.project.gitCommonDirectory !==
        record.workspace.gitCommonDirectory ||
      !record.workspace.execution ||
      !["read-only", "workspace-write"].includes(
        record.workspace.execution.sandbox,
      ) ||
      !["untrusted", "on-request"].includes(
        record.workspace.execution.approvalPolicy,
      )
    ) {
      throw new Error("HANDOFF_JOURNAL_INVALID");
    }
    if (
      record.modelCatalogue !== undefined &&
      !CatalogueObservationSchema.safeParse(record.modelCatalogue).success
    )
      throw new Error("HANDOFF_JOURNAL_CATALOGUE_INVALID");
    if (record.modelBinding !== undefined) {
      const binding = TaskModelBindingSchema.safeParse(record.modelBinding);
      if (
        !binding.success ||
        binding.data.selection.harness !== "codex" ||
        binding.data.selection.model !== record.model ||
        binding.data.selection.effort !== record.reasoningEffort
      ) {
        throw new Error("HANDOFF_JOURNAL_MODEL_BINDING_INVALID");
      }
    }
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
    if (turnIntent !== null && thread === null)
      throw new Error("HANDOFF_JOURNAL_INVALID");
    if (thread !== null && threadIntent === null)
      throw new Error("HANDOFF_JOURNAL_INVALID");
    if (turn !== null && turnIntent === null)
      throw new Error("HANDOFF_JOURNAL_INVALID");
    const continuation = await readPrivate(
      path.join(directory, "continuation-verified.json"),
    );
    if (
      continuation !== null &&
      (record.continuedFrom === undefined ||
        turn === null ||
        continuation !== turn)
    ) {
      throw new Error("HANDOFF_CONTINUATION_BINDING_INVALID");
    }
    return {
      requestDigest: record.requestDigest,
      ...(record.dispatchProtocol === undefined
        ? {}
        : { dispatchProtocol: record.dispatchProtocol }),
      ...(record.adopted ? { adopted: true as const } : {}),
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: record.reasoningEffort }),
      workspaceId: stringRecord(record.workspaceId),
      workspace: record.workspace,
      projectId: stringRecord(record.projectId),
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: record.reasoningEffort }),
      ...(record.modelBinding === undefined
        ? {}
        : { modelBinding: record.modelBinding }),
      ...(record.modelCatalogue === undefined
        ? {}
        : { modelCatalogue: record.modelCatalogue }),
      ...(record.continuedFrom === undefined
        ? {}
        : {
            continuedFrom: record.continuedFrom,
            continuationVerified: continuation !== null,
          }),
      threadIntent: threadIntent !== null,
      turnIntent: turnIntent !== null,
      ...(thread === null ? {} : { threadId: stringRecord(thread) }),
      ...(turn === null ? {} : { turnId: stringRecord(turn) }),
    };
  }

  private directory(key: string): string {
    if (!validKey(key)) throw new Error("HANDOFF_JOURNAL_KEY_INVALID");
    return path.join(this.root, key.toLowerCase());
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
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.geteuid?.() !== undefined && stat.uid !== process.geteuid?.())
    ) {
      throw new Error("HANDOFF_JOURNAL_ROOT_UNSAFE");
    }
    return true;
  }
}
