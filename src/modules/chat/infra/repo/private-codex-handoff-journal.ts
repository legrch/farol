import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskModelBindingSchema } from "../../../../pkg/owner-config/contract";

import type {
  HandoffJournal,
  HandoffRecord,
} from "../../app/service/persistent-codex-handoff";

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

async function writeOnce(file: string, value: unknown): Promise<boolean> {
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
      await fs.link(temporary, file);
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
): Promise<unknown | null> {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | NO_FOLLOW);
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
    const stat = await fs.lstat(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.geteuid?.() !== undefined && stat.uid !== process.geteuid?.())
    ) {
      throw new Error("HANDOFF_JOURNAL_ROOT_UNSAFE");
    }
  }
}
