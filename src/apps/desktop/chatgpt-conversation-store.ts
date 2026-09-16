import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const FILE_NAME = "chatgpt-conversation.json";
const MAXIMUM_BYTES = 16 * 1_024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

const operationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const timestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

const recordSchema = z
  .strictObject({
    schema: z.literal(1),
    state: z.enum(["retained", "unresolved"]),
    operationId: operationIdSchema,
    conversationUrl: z.url().max(2_048).nullable(),
    reason: z.literal("CHATGPT_CONVERSATION_URL_UNAVAILABLE").nullable(),
    updatedAt: timestampSchema,
  })
  .refine((record) =>
    record.state === "retained"
      ? record.conversationUrl !== null && record.reason === null
      : record.conversationUrl === null && record.reason !== null,
  );

export type ChatGptConversationRecord = z.infer<typeof recordSchema>;

type StoreOptions = Readonly<{ root: string }>;
type StoreDependencies = Readonly<{
  now?: () => number;
  beforeCommit?: () => Promise<void>;
}>;

function stateError(code: string): never {
  throw new Error(code);
}

export class PrivateChatGptConversationStore {
  private readonly now: () => number;

  constructor(
    private readonly options: StoreOptions,
    private readonly dependencies: StoreDependencies = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("CHATGPT_CONVERSATION_ROOT_NOT_ABSOLUTE");
    }
    this.now = dependencies.now ?? Date.now;
  }

  async load(): Promise<ChatGptConversationRecord | null> {
    await this.ensureRoot();
    let handle;
    try {
      handle = await fs.open(
        path.join(this.options.root, FILE_NAME),
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") stateError("CHATGPT_CONVERSATION_STATE_UNSAFE");
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      if (info.size > MAXIMUM_BYTES) {
        stateError("CHATGPT_CONVERSATION_STATE_CORRUPT");
      }
      const parsed = recordSchema.safeParse(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
      if (!parsed.success) {
        stateError("CHATGPT_CONVERSATION_STATE_CORRUPT");
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) {
        stateError("CHATGPT_CONVERSATION_STATE_CORRUPT");
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  async retain(
    input: Readonly<{
      operationId: string;
      conversationUrl: string;
    }>,
  ): Promise<void> {
    await this.save({
      schema: 1,
      state: "retained",
      operationId: operationIdSchema.parse(input.operationId),
      conversationUrl: z.url().max(2_048).parse(input.conversationUrl),
      reason: null,
      updatedAt: this.timestamp(),
    });
  }

  async markUnresolved(operationId: string): Promise<void> {
    await this.save({
      schema: 1,
      state: "unresolved",
      operationId: operationIdSchema.parse(operationId),
      conversationUrl: null,
      reason: "CHATGPT_CONVERSATION_URL_UNAVAILABLE",
      updatedAt: this.timestamp(),
    });
  }

  async clear(): Promise<void> {
    await this.ensureRoot();
    const target = path.join(this.options.root, FILE_NAME);
    try {
      this.assertPrivateFile(await fs.lstat(target));
      await fs.unlink(target);
      await this.syncRoot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private async save(record: ChatGptConversationRecord): Promise<void> {
    const validated = recordSchema.parse(record);
    await this.ensureRoot();
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    const target = path.join(this.options.root, FILE_NAME);
    await this.assertReplaceableTarget(target);
    const temporary = path.join(
      this.options.root,
      `.${FILE_NAME}.${randomUUID()}.tmp`,
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
      stateError("CHATGPT_CONVERSATION_STATE_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(this.options.root, 0o700);
  }

  private assertPrivateFile(info: Stats): void {
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      stateError("CHATGPT_CONVERSATION_STATE_UNSAFE");
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
