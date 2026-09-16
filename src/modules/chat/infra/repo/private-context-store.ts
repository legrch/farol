import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CheckpointStore } from "../../app/port/checkpoint-store";
import type { ContextRepository } from "../../app/port/context-repository";
import {
  validateCheckpointContent,
  type CheckpointEnvelope,
} from "../../domain/checkpoint";
import {
  sameContextBinding,
  type ContextBinding,
  type ContextSession,
} from "../../domain/context-continuity";

const bindingSchema = z.strictObject({
  ownerId: z.string().min(1).max(160),
  taskId: z.string().min(1).max(160),
  hostThreadId: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160),
  providerProfileId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(160),
  mode: z.string().min(1).max(160),
});

const operationSchema = z.strictObject({
  operationId: z.string().min(1).max(160),
  source: z.enum(["retained_agent", "canonical_history"]),
  sourceBoundary: z.string().min(1).max(160),
  sourceEpoch: z.number().int().positive(),
  summaryDispatch: z.enum(["not_observed", "observed", "result_received"]),
  checkpointId: z.string().min(1).max(160).nullable(),
  hostContextRef: z.string().min(1).max(160).nullable(),
});

const sessionSchema = z.strictObject({
  binding: bindingSchema,
  epoch: z.number().int().positive(),
  phase: z.enum([
    "active",
    "quiescing",
    "checkpoint_requested",
    "validated",
    "durably_stored",
    "handoff_offered",
    "host_context_confirmed",
    "old_epoch_retired",
    "blocked",
    "outcome_unknown",
  ]),
  operation: operationSchema.nullable(),
  lastCheckpointId: z.string().min(1).max(160).nullable(),
  lastCompletedOperationId: z.string().min(1).max(160).nullable(),
  blockedCode: z.string().min(1).max(160).nullable(),
});

const sessionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_session"),
  session: sessionSchema,
});

const checkpointEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checkpointId: z.string().min(1).max(160),
  operationId: z.string().min(1).max(160),
  providerOperationId: z.string().min(1).max(160),
  binding: bindingSchema,
  epoch: z.number().int().positive(),
  source: z.enum(["retained_agent", "canonical_history"]),
  sourceBoundary: z.string().min(1).max(160),
  sourceCursor: z.string().min(1).max(512),
  parentCheckpointId: z.string().min(1).max(160).nullable(),
  provider: z.strictObject({
    profileId: z.string().min(1).max(160),
    modelId: z.string().min(1).max(160),
    mode: z.string().min(1).max(160),
  }),
  createdAt: z.number().finite().nonnegative(),
  validation: z.literal("validated"),
  content: z.unknown(),
});

const checkpointRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_checkpoint"),
  checkpoint: checkpointEnvelopeSchema,
});

const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const DEFAULT_SESSION_BYTES = 64 * 1_024;
const DEFAULT_CHECKPOINT_CONTENT_BYTES = 256 * 1_024;
const DEFAULT_CHECKPOINT_RECORD_BYTES = 384 * 1_024;
const DEFAULT_RETENTION = 8;

export type PrivateContextStoreOptions = Readonly<{
  root: string;
  maximumSessionBytes?: number;
  maximumCheckpointContentBytes?: number;
  maximumCheckpointRecordBytes?: number;
  maxCheckpointsPerTask?: number;
}>;

export type AtomicWriteHooks = Readonly<{
  beforeCommit?: (target: string) => Promise<void>;
}>;

type ParsedRecord = Readonly<{
  value: unknown;
  serialized: string;
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingKey(binding: ContextBinding): string {
  return digest([
    binding.ownerId,
    binding.taskId,
    binding.hostThreadId,
    binding.sessionId,
    binding.providerProfileId,
    binding.modelId,
    binding.mode,
  ]);
}

function checkpointKey(checkpointId: string): string {
  return digest([checkpointId]);
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

export class PrivateContextStore implements ContextRepository, CheckpointStore {
  private readonly maximumSessionBytes: number;
  private readonly maximumCheckpointContentBytes: number;
  private readonly maximumCheckpointRecordBytes: number;
  private readonly maxCheckpointsPerTask: number;

  constructor(
    private readonly options: PrivateContextStoreOptions,
    private readonly hooks: AtomicWriteHooks = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("CONTEXT_STATE_ROOT_NOT_ABSOLUTE");
    }
    this.maximumSessionBytes = positiveInteger(
      options.maximumSessionBytes ?? DEFAULT_SESSION_BYTES,
      "CONTEXT_SESSION_BUDGET_INVALID",
    );
    this.maximumCheckpointContentBytes = positiveInteger(
      options.maximumCheckpointContentBytes ?? DEFAULT_CHECKPOINT_CONTENT_BYTES,
      "CHECKPOINT_CONTENT_BUDGET_INVALID",
    );
    this.maximumCheckpointRecordBytes = positiveInteger(
      options.maximumCheckpointRecordBytes ?? DEFAULT_CHECKPOINT_RECORD_BYTES,
      "CHECKPOINT_RECORD_BUDGET_INVALID",
    );
    this.maxCheckpointsPerTask = positiveInteger(
      options.maxCheckpointsPerTask ?? DEFAULT_RETENTION,
      "CHECKPOINT_RETENTION_INVALID",
    );
  }

  async load(binding: ContextBinding): Promise<ContextSession | null> {
    const file = this.sessionFile(binding);
    const record = await this.readRecord(
      file,
      this.maximumSessionBytes,
      "CONTEXT_STATE",
    );
    if (!record) return null;
    const parsed = sessionRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CONTEXT_STATE");
    }
    if (!sameContextBinding(parsed.data.session.binding, binding)) {
      throw new Error("CONTEXT_STATE_BINDING_MISMATCH");
    }
    return structuredClone(parsed.data.session);
  }

  async save(session: ContextSession): Promise<void> {
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) throw new Error("CONTEXT_STATE_INVALID");
    const directory = await this.ensureTaskDirectory(session.binding);
    await this.atomicWrite(
      path.join(directory, "session.json"),
      {
        schemaVersion: 1,
        kind: "context_session",
        session: parsed.data,
      },
      this.maximumSessionBytes,
      "CONTEXT_STATE_OVERSIZED",
    );
  }

  async put(checkpoint: CheckpointEnvelope): Promise<void> {
    const validated = this.validateCheckpoint(checkpoint);
    const directory = await this.ensureCheckpointDirectory(validated.binding);
    const file = path.join(
      directory,
      `${checkpointKey(validated.checkpointId)}.json`,
    );
    const existing = await this.readCheckpointFile(file, validated.binding);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(validated)) return;
      throw new Error("CHECKPOINT_ID_CONFLICT");
    }
    await this.atomicWrite(
      file,
      {
        schemaVersion: 1,
        kind: "context_checkpoint",
        checkpoint: validated,
      },
      this.maximumCheckpointRecordBytes,
      "CHECKPOINT_RECORD_OVERSIZED",
    );
    await this.pruneCheckpoints(directory, validated.binding);
  }

  async get(
    binding: ContextBinding,
    checkpointId: string,
  ): Promise<CheckpointEnvelope | null> {
    if (!checkpointId || checkpointId.length > 160) {
      throw new Error("CHECKPOINT_ID_INVALID");
    }
    const file = path.join(
      this.checkpointDirectory(binding),
      `${checkpointKey(checkpointId)}.json`,
    );
    const checkpoint = await this.readCheckpointFile(file, binding);
    if (checkpoint && checkpoint.checkpointId !== checkpointId) {
      throw new Error("CHECKPOINT_ID_MISMATCH");
    }
    return checkpoint;
  }

  async deleteTask(binding: ContextBinding): Promise<void> {
    await this.ensureRoot();
    const directory = this.taskDirectory(binding);
    let info;
    try {
      info = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.assertPrivateDirectory(info, "CONTEXT_TASK_DIRECTORY_UNSAFE");
    await fs.rm(directory, { recursive: true, force: false });
    await this.syncDirectory(path.join(this.options.root, "tasks"));
  }

  private validateCheckpoint(candidate: unknown): CheckpointEnvelope {
    const parsed = checkpointEnvelopeSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CHECKPOINT_STATE_INVALID");
    const content = validateCheckpointContent(
      parsed.data.content,
      this.maximumCheckpointContentBytes,
    );
    if (!content.ok) throw new Error(content.error.code);
    const checkpoint = {
      ...parsed.data,
      content: content.value,
    } as CheckpointEnvelope;
    if (
      checkpoint.provider.profileId !== checkpoint.binding.providerProfileId ||
      checkpoint.provider.modelId !== checkpoint.binding.modelId ||
      checkpoint.provider.mode !== checkpoint.binding.mode
    ) {
      throw new Error("CHECKPOINT_PROVIDER_BINDING_MISMATCH");
    }
    return structuredClone(checkpoint);
  }

  private async readCheckpointFile(
    file: string,
    binding: ContextBinding,
  ): Promise<CheckpointEnvelope | null> {
    const record = await this.readRecord(
      file,
      this.maximumCheckpointRecordBytes,
      "CHECKPOINT_STATE",
    );
    if (!record) return null;
    const parsed = checkpointRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CHECKPOINT_STATE");
    }
    const checkpoint = this.validateCheckpoint(parsed.data.checkpoint);
    if (!sameContextBinding(checkpoint.binding, binding)) {
      throw new Error("CHECKPOINT_BINDING_MISMATCH");
    }
    return checkpoint;
  }

  private async pruneCheckpoints(
    directory: string,
    binding: ContextBinding,
  ): Promise<void> {
    const names = (await fs.readdir(directory)).filter((name) =>
      /^[a-f0-9]{64}\.json$/u.test(name),
    );
    const records = await Promise.all(
      names.map(async (name) => ({
        name,
        checkpoint: await this.readCheckpointFile(
          path.join(directory, name),
          binding,
        ),
      })),
    );
    const ordered = records
      .filter(
        (
          record,
        ): record is Readonly<{
          name: string;
          checkpoint: CheckpointEnvelope;
        }> => record.checkpoint !== null,
      )
      .sort((left, right) => {
        const byTime = right.checkpoint.createdAt - left.checkpoint.createdAt;
        return byTime !== 0
          ? byTime
          : right.checkpoint.checkpointId.localeCompare(
              left.checkpoint.checkpointId,
            );
      });
    const expired = ordered.slice(this.maxCheckpointsPerTask);
    await Promise.all(
      expired.map((record) => fs.unlink(path.join(directory, record.name))),
    );
    if (expired.length > 0) await this.syncDirectory(directory);
  }

  private async readRecord(
    file: string,
    maximumBytes: number,
    code: "CONTEXT_STATE" | "CHECKPOINT_STATE",
  ): Promise<ParsedRecord | null> {
    let handle;
    try {
      handle = await fs.open(
        file,
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info, maximumBytes, `${code}_UNSAFE`);
      const serialized = await handle.readFile("utf8");
      let value: unknown;
      try {
        value = JSON.parse(serialized);
      } catch {
        throw new Error(`${code}_CORRUPT`);
      }
      return { value, serialized };
    } finally {
      await handle.close();
    }
  }

  private schemaError(value: unknown, code: string): Error {
    if (
      value &&
      typeof value === "object" &&
      "schemaVersion" in value &&
      (value as { schemaVersion?: unknown }).schemaVersion !== 1
    ) {
      return new Error(`${code}_UNSUPPORTED`);
    }
    return new Error(`${code}_CORRUPT`);
  }

  private async atomicWrite(
    target: string,
    value: unknown,
    maximumBytes: number,
    oversizedCode: string,
  ): Promise<void> {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
      throw new Error(oversizedCode);
    }
    const directory = path.dirname(target);
    const temporary = path.join(
      directory,
      `.${path.basename(target)}.tmp-${randomBytes(8).toString("hex")}`,
    );
    const handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    let temporaryExists = true;
    try {
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforeCommit?.(target);
      await fs.rename(temporary, target);
      temporaryExists = false;
      await this.syncDirectory(directory);
    } finally {
      if (temporaryExists) {
        await fs.unlink(temporary).catch(() => undefined);
      }
    }
  }

  private async ensureRoot(): Promise<void> {
    await this.ensurePrivateDirectory(this.options.root);
    await this.ensurePrivateDirectory(path.join(this.options.root, "tasks"));
  }

  private async ensureTaskDirectory(binding: ContextBinding): Promise<string> {
    await this.ensureRoot();
    const directory = this.taskDirectory(binding);
    await this.ensurePrivateDirectory(directory);
    return directory;
  }

  private async ensureCheckpointDirectory(
    binding: ContextBinding,
  ): Promise<string> {
    const task = await this.ensureTaskDirectory(binding);
    const directory = path.join(task, "checkpoints");
    await this.ensurePrivateDirectory(directory);
    return directory;
  }

  private async ensurePrivateDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid())
    ) {
      throw new Error("CONTEXT_STATE_DIRECTORY_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
  }

  private assertPrivateDirectory(info: Stats, code: string): void {
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(code);
    }
  }

  private assertPrivateFile(
    info: Stats,
    maximumBytes: number,
    code: string,
  ): void {
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > maximumBytes ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(code);
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(
      directory,
      fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private taskDirectory(binding: ContextBinding): string {
    return path.join(this.options.root, "tasks", bindingKey(binding));
  }

  private checkpointDirectory(binding: ContextBinding): string {
    return path.join(this.taskDirectory(binding), "checkpoints");
  }

  private sessionFile(binding: ContextBinding): string {
    return path.join(this.taskDirectory(binding), "session.json");
  }
}
