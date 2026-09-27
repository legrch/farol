import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

async function readPrivate(file: string): Promise<unknown | null> {
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
    return JSON.parse(await handle.readFile("utf8")) as unknown;
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
    return {
      requestDigest: record.requestDigest,
      workspaceId: stringRecord(record.workspaceId),
      workspace: record.workspace,
      projectId: stringRecord(record.projectId),
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
