import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CHATGPT_TASK_JOURNAL_FILE_NAME,
  deepTestJournalFileName,
  ChatGptTaskJournalOperationIdSchema,
  ChatGptTaskJournalRecordSchema,
  ChatGptTaskJournalResultSchema,
  MAX_CHATGPT_TASK_JOURNAL_BYTES,
  type ChatGptTaskJournalRecord,
  type ChatGptTaskJournalResult,
} from "./chatgpt-task-journal-record";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

// The record shapes live in `chatgpt-task-journal-record.ts` so the
// promotion reader validates this file against the very objects this
// journal writes.
const operationIdSchema = ChatGptTaskJournalOperationIdSchema;
const resultSchema = ChatGptTaskJournalResultSchema;
const recordSchema = ChatGptTaskJournalRecordSchema;

export type { ChatGptTaskJournalRecord, ChatGptTaskJournalResult };

type ResultInput = Readonly<{
  state: ChatGptTaskJournalResult["state"];
  code: string | null;
  deltaCount: number;
  observedCharacters: number;
  attachmentCount?: number;
  totalBytes?: number;
  stagingCleanup?: "removed" | "pending_startup_cleanup" | null;
}>;

type JournalOptions = Readonly<{ root: string; deepTestOperationId?: string }>;
type JournalDependencies = Readonly<{
  now?: () => number;
  beforeCommit?: () => Promise<void>;
}>;

function journalError(code: string): never {
  throw new Error(code);
}

export class PrivateChatGptTaskJournal {
  private readonly now: () => number;
  private readonly fileName: string;

  constructor(
    private readonly options: JournalOptions,
    private readonly dependencies: JournalDependencies = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("CHATGPT_TASK_JOURNAL_ROOT_NOT_ABSOLUTE");
    }
    this.now = dependencies.now ?? Date.now;
    this.fileName =
      options.deepTestOperationId === undefined
        ? CHATGPT_TASK_JOURNAL_FILE_NAME
        : deepTestJournalFileName(options.deepTestOperationId);
  }

  async load(): Promise<ChatGptTaskJournalRecord | null> {
    await this.ensureRoot();
    let handle;
    try {
      handle = await fs.open(
        path.join(this.options.root, this.fileName),
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") journalError("CHATGPT_TASK_JOURNAL_UNSAFE");
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      if (info.size > MAX_CHATGPT_TASK_JOURNAL_BYTES) {
        journalError("CHATGPT_TASK_JOURNAL_CORRUPT");
      }
      const parsed = recordSchema.safeParse(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
      if (!parsed.success) journalError("CHATGPT_TASK_JOURNAL_CORRUPT");
      if (
        this.options.deepTestOperationId !== undefined &&
        (parsed.data.operationId !== this.options.deepTestOperationId ||
          parsed.data.kind !== "readonly")
      )
        journalError("CHATGPT_TASK_JOURNAL_CORRUPT");
      return parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) {
        journalError("CHATGPT_TASK_JOURNAL_CORRUPT");
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  async prepare(
    input: Readonly<{
      operationId: string;
      kind: "readonly" | "attachment";
    }>,
  ): Promise<void> {
    const operationId = operationIdSchema.parse(input.operationId);
    if (
      this.options.deepTestOperationId !== undefined &&
      (operationId !== this.options.deepTestOperationId ||
        input.kind !== "readonly")
    )
      journalError("CHATGPT_TASK_JOURNAL_CONFLICT");
    const current = await this.load();
    if (this.options.deepTestOperationId !== undefined && current !== null)
      journalError("CHATGPT_TASK_JOURNAL_ACTIVE");
    if (current && current.phase !== "delivery_acknowledged") {
      if (
        current.phase === "prepared" &&
        current.operationId === operationId &&
        current.kind === input.kind
      ) {
        return;
      }
      journalError("CHATGPT_TASK_JOURNAL_ACTIVE");
    }
    const timestamp = this.timestamp();
    await this.save({
      schema: 1,
      operationId,
      kind: input.kind,
      phase: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp,
      result: null,
    });
  }

  async markDispatchIntent(operationId: string): Promise<void> {
    const current = await this.requireOperation(operationId);
    if (current.phase === "dispatch_intent") return;
    if (current.phase !== "prepared") {
      journalError("CHATGPT_TASK_JOURNAL_TRANSITION");
    }
    await this.save({
      ...current,
      phase: "dispatch_intent",
      updatedAt: this.timestamp(),
    });
  }

  async retainResult(operationId: string, input: ResultInput): Promise<void> {
    const current = await this.requireOperation(operationId);
    const result = resultSchema.parse({
      ...input,
      attachmentCount: input.attachmentCount ?? 0,
      totalBytes: input.totalBytes ?? 0,
      stagingCleanup: input.stagingCleanup ?? null,
    });
    if (current.phase === "result_retained") {
      if (isDeepStrictEqual(current.result, result)) return;
      journalError("CHATGPT_TASK_JOURNAL_CONFLICT");
    }
    if (current.phase !== "dispatch_intent") {
      journalError("CHATGPT_TASK_JOURNAL_TRANSITION");
    }
    await this.save({
      ...current,
      phase: "result_retained",
      updatedAt: this.timestamp(),
      result,
    });
  }

  async retainPreDispatchResult(
    operationId: string,
    input: ResultInput,
  ): Promise<void> {
    const current = await this.requireOperation(operationId);
    if (
      current.phase !== "prepared" ||
      (input.state !== "failed_before_submit" &&
        input.state !== "not_authenticated")
    )
      journalError("CHATGPT_TASK_JOURNAL_TRANSITION");
    const result = resultSchema.parse({
      ...input,
      attachmentCount: 0,
      totalBytes: 0,
      stagingCleanup: null,
    });
    await this.save({
      ...current,
      phase: "result_retained",
      updatedAt: this.timestamp(),
      result,
    });
  }

  async acknowledgeDelivery(operationId: string): Promise<void> {
    const current = await this.requireOperation(operationId);
    if (current.phase === "delivery_acknowledged") return;
    if (current.phase !== "result_retained" || current.result === null) {
      journalError("CHATGPT_TASK_JOURNAL_TRANSITION");
    }
    await this.save({
      ...current,
      phase: "delivery_acknowledged",
      updatedAt: this.timestamp(),
    });
  }

  async discardPrepared(operationId: string): Promise<void> {
    const current = await this.requireOperation(operationId);
    if (current.phase === "delivery_acknowledged") return;
    if (current.phase !== "prepared") {
      journalError("CHATGPT_TASK_JOURNAL_TRANSITION");
    }
    await this.save({
      ...current,
      phase: "delivery_acknowledged",
      updatedAt: this.timestamp(),
    });
  }

  async reconcileAfterRestart(): Promise<ChatGptTaskJournalRecord | null> {
    const current = await this.load();
    if (!current || current.phase === "delivery_acknowledged") return null;
    if (current.phase === "prepared") {
      await this.discardPrepared(current.operationId);
      return null;
    }
    if (current.phase === "dispatch_intent") {
      await this.retainResult(current.operationId, {
        state: "outcome_unknown",
        code: "CHATGPT_TASK_INTERRUPTED_AFTER_INTENT",
        deltaCount: 0,
        observedCharacters: 0,
      });
      return this.load();
    }
    return current;
  }

  private async requireOperation(
    operationId: string,
  ): Promise<ChatGptTaskJournalRecord> {
    operationIdSchema.parse(operationId);
    const current = await this.load();
    if (!current || current.operationId !== operationId) {
      journalError("CHATGPT_TASK_JOURNAL_NOT_FOUND");
    }
    return current;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private async save(record: ChatGptTaskJournalRecord): Promise<void> {
    const validated = recordSchema.parse(record);
    await this.ensureRoot();
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    const target = path.join(this.options.root, this.fileName);
    await this.assertReplaceableTarget(target);
    const temporary = path.join(
      this.options.root,
      `.${this.fileName}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.dependencies.beforeCommit?.();
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await this.syncRoot();
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.options.root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      journalError("CHATGPT_TASK_JOURNAL_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) {
      if (this.options.deepTestOperationId !== undefined)
        journalError("CHATGPT_TASK_JOURNAL_UNSAFE");
      await fs.chmod(this.options.root, 0o700);
    }
  }

  private assertPrivateFile(info: Stats): void {
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      journalError("CHATGPT_TASK_JOURNAL_UNSAFE");
    }
  }

  private async assertReplaceableTarget(target: string): Promise<void> {
    try {
      this.assertPrivateFile(await fs.lstat(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async syncRoot(): Promise<void> {
    const directory = await fs.open(
      this.options.root,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
