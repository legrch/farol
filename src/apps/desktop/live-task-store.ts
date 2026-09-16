import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProductTaskSchema } from "../../modules/chat/contract/product-task";

const FILE_NAME = "live-tasks.json";
const MAXIMUM_BYTES = 128 * 1_024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

const timestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

export const StoredLiveTaskSchema = ProductTaskSchema.extend({
  provider: z.literal("chatgpt"),
  conversationUrl: z.url().max(2_048).nullable(),
}).refine((task) => task.lifecycle !== "event_driven");

const recordSchema = z.strictObject({
  schema: z.literal(1),
  revision: z.number().int().nonnegative(),
  tasks: z.array(StoredLiveTaskSchema).max(5),
  updatedAt: timestampSchema,
});

export type StoredLiveTask = z.infer<typeof StoredLiveTaskSchema>;
export type LiveTaskStoreRecord = z.infer<typeof recordSchema>;

type StoreOptions = Readonly<{ root: string }>;
type StoreDependencies = Readonly<{
  now?: () => number;
  beforeCommit?: () => Promise<void>;
}>;

function stateError(code: string): never {
  throw new Error(code);
}

export class PrivateLiveTaskStore {
  private readonly now: () => number;

  constructor(
    private readonly options: StoreOptions,
    private readonly dependencies: StoreDependencies = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("LIVE_TASK_ROOT_NOT_ABSOLUTE");
    }
    this.now = dependencies.now ?? Date.now;
  }

  async load(): Promise<LiveTaskStoreRecord | null> {
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
      if (code === "ELOOP") stateError("LIVE_TASK_STATE_UNSAFE");
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      if (info.size > MAXIMUM_BYTES) stateError("LIVE_TASK_STATE_CORRUPT");
      const parsed = recordSchema.safeParse(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
      if (!parsed.success) stateError("LIVE_TASK_STATE_CORRUPT");
      return parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) stateError("LIVE_TASK_STATE_CORRUPT");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async save(
    input: Readonly<{ revision: number; tasks: StoredLiveTask[] }>,
  ): Promise<void> {
    const validated = recordSchema.parse({
      schema: 1,
      revision: input.revision,
      tasks: input.tasks,
      updatedAt: new Date(this.now()).toISOString(),
    });
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
      stateError("LIVE_TASK_STATE_UNSAFE");
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
      stateError("LIVE_TASK_STATE_UNSAFE");
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
