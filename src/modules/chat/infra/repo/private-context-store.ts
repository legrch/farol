import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CheckpointStore } from "../../app/port/checkpoint-store";
import type {
  ContextAdmission,
  ContextAdmissionLease,
  ContextAdmissionResult,
  ContextRepository,
} from "../../app/port/context-repository";
import {
  validateCheckpointContent,
  validateCheckpointEnvelope,
  type CheckpointContent,
  type CheckpointEnvelope,
} from "../../domain/checkpoint";
import {
  sameCompactionRequest,
  sameContextBinding,
  sameContextSessionIdentity,
  type CompactionRequest,
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

const compactionRequestSchema = z.strictObject({
  operationId: z.string().min(1).max(160),
  source: z.enum(["retained_agent", "canonical_history"]),
  sourceBoundary: z.string().min(1).max(160),
});

const sessionSchema = z
  .strictObject({
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
    lastCompletedRequest: compactionRequestSchema.nullable().optional(),
    blockedCode: z.string().min(1).max(160).nullable(),
  })
  .superRefine((session, context) => {
    if (
      session.lastCompletedRequest &&
      session.lastCompletedOperationId !==
        session.lastCompletedRequest.operationId
    ) {
      context.addIssue({
        code: "custom",
        message: "completed operation identity mismatch",
      });
    }
  });

const sessionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_session"),
  session: sessionSchema,
});

const checkpointRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_checkpoint"),
  checkpoint: z.unknown(),
});

const contextSourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(160),
  binding: bindingSchema,
  source: z.enum(["retained_agent", "canonical_history"]),
  sourceBoundary: z.string().min(1).max(160),
  variant: z.enum(["unary_replacement_history", "streamed_compaction_item"]),
  history: z.array(z.unknown()).max(4_096),
});

const contextSourceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_source"),
  source: contextSourceSchema,
});

const contextSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(160),
  binding: bindingSchema,
  providerOperationId: z.string().min(1).max(160),
  sourceCursor: z.string().min(1).max(512),
  content: z.unknown(),
});

const contextSummaryRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_summary"),
  summary: contextSummarySchema,
});

const contextSummaryAttemptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(160),
  binding: bindingSchema,
  source: z.enum(["retained_agent", "canonical_history"]),
  sourceBoundary: z.string().min(1).max(160),
  phase: z.enum(["prepared", "possible_send", "outcome_unknown"]),
  conversationUrl: z.string().min(1).max(2_048).nullable(),
  turnUserId: z.string().min(1).max(256).nullable(),
  turnAssistantId: z.string().min(1).max(256).nullable(),
});

const contextSummaryAttemptRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_summary_attempt"),
  attempt: contextSummaryAttemptSchema,
});

const admissionSchema = z.strictObject({
  binding: bindingSchema,
  sourceEpoch: z.number().int().positive(),
  request: compactionRequestSchema,
});

const admissionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_admission"),
  admission: admissionSchema,
});

const admissionLeaseRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_admission_lease"),
  processId: z.number().int().positive(),
  token: z.string().length(32),
});

const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const DEFAULT_SESSION_BYTES = 64 * 1_024;
const DEFAULT_CHECKPOINT_CONTENT_BYTES = 256 * 1_024;
const DEFAULT_CHECKPOINT_RECORD_BYTES = 384 * 1_024;
const DEFAULT_SOURCE_RECORD_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_SUMMARY_RECORD_BYTES = 384 * 1_024;
const DEFAULT_SUMMARY_ATTEMPT_RECORD_BYTES = 16 * 1_024;
const DEFAULT_RETENTION = 8;

export type StoredContextSource = Readonly<z.infer<typeof contextSourceSchema>>;

export type StoredContextSummary = Readonly<{
  schemaVersion: 1;
  operationId: string;
  binding: ContextBinding;
  providerOperationId: string;
  sourceCursor: string;
  content: CheckpointContent;
}>;

export type StoredContextSummaryAttempt = Readonly<
  z.infer<typeof contextSummaryAttemptSchema>
>;

export type PrivateContextStoreOptions = Readonly<{
  root: string;
  maximumSessionBytes?: number;
  maximumCheckpointContentBytes?: number;
  maximumCheckpointRecordBytes?: number;
  maximumSourceRecordBytes?: number;
  maximumSummaryRecordBytes?: number;
  maximumSummaryAttemptRecordBytes?: number;
  maxCheckpointsPerTask?: number;
}>;

export type AtomicWriteHooks = Readonly<{
  beforeCommit?: (target: string) => Promise<void>;
  isProcessAlive?: (processId: number) => boolean | Promise<boolean>;
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
  ]);
}

function boundaryKey(request: CompactionRequest): string {
  return digest([request.source, request.sourceBoundary]);
}

function admissionConflict(
  admission: ContextAdmission,
  binding: ContextBinding,
  sourceEpoch: number,
  request: CompactionRequest,
): ContextAdmissionResult | null {
  if (!sameContextBinding(admission.binding, binding)) {
    return { status: "conflict", reason: "binding" };
  }
  if (admission.sourceEpoch !== sourceEpoch) {
    return { status: "conflict", reason: "epoch" };
  }
  if (!sameCompactionRequest(admission.request, request)) {
    return { status: "conflict", reason: "request" };
  }
  return null;
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
  private readonly maximumSourceRecordBytes: number;
  private readonly maximumSummaryRecordBytes: number;
  private readonly maximumSummaryAttemptRecordBytes: number;
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
    this.maximumSourceRecordBytes = positiveInteger(
      options.maximumSourceRecordBytes ?? DEFAULT_SOURCE_RECORD_BYTES,
      "CONTEXT_SOURCE_BUDGET_INVALID",
    );
    this.maximumSummaryRecordBytes = positiveInteger(
      options.maximumSummaryRecordBytes ?? DEFAULT_SUMMARY_RECORD_BYTES,
      "CONTEXT_SUMMARY_BUDGET_INVALID",
    );
    this.maximumSummaryAttemptRecordBytes = positiveInteger(
      options.maximumSummaryAttemptRecordBytes ??
        DEFAULT_SUMMARY_ATTEMPT_RECORD_BYTES,
      "CONTEXT_SUMMARY_ATTEMPT_BUDGET_INVALID",
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
    if (!sameContextSessionIdentity(parsed.data.session.binding, binding)) {
      throw new Error("CONTEXT_STATE_IDENTITY_MISMATCH");
    }
    return structuredClone({
      ...parsed.data.session,
      lastCompletedRequest: parsed.data.session.lastCompletedRequest ?? null,
    });
  }

  async save(
    session: ContextSession,
    lease?: ContextAdmissionLease,
  ): Promise<void> {
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) throw new Error("CONTEXT_STATE_INVALID");
    await this.assertAdmissionLease(session.binding, lease);
    const existing = await this.load(session.binding);
    if (existing && !sameContextBinding(existing.binding, session.binding)) {
      throw new Error("CONTEXT_STATE_BINDING_MISMATCH");
    }
    const directory = await this.ensureTaskDirectory(session.binding);
    await this.atomicWrite(
      path.join(directory, "session.json"),
      {
        schemaVersion: 1,
        kind: "context_session",
        session: {
          ...parsed.data,
          lastCompletedRequest: parsed.data.lastCompletedRequest ?? null,
        },
      },
      this.maximumSessionBytes,
      "CONTEXT_STATE_OVERSIZED",
      () => this.assertAdmissionLease(session.binding, lease),
    );
  }

  async acquireCompactionAdmission(
    binding: ContextBinding,
    sourceEpoch: number,
    request: CompactionRequest,
  ): Promise<ContextAdmissionResult> {
    if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch < 1) {
      throw new Error("CONTEXT_ADMISSION_EPOCH_INVALID");
    }
    const task = await this.ensureTaskDirectory(binding);
    const lease = await this.acquireAdmissionLease(binding, task);
    if (!lease) return { status: "busy" };

    try {
      const admissions = await this.ensureAdmissionDirectories(task);
      const boundaryFile = path.join(
        admissions.boundaries,
        `${boundaryKey(request)}.json`,
      );
      const existingBoundary = await this.readAdmission(boundaryFile);
      if (existingBoundary) {
        const conflict = admissionConflict(
          existingBoundary,
          binding,
          sourceEpoch,
          request,
        );
        if (conflict) {
          await this.releaseCompactionAdmission(lease);
          return conflict;
        }
      }

      const epochFile = path.join(admissions.epochs, `${sourceEpoch}.json`);
      const existingEpoch = await this.readAdmission(epochFile);
      if (existingEpoch) {
        const conflict = admissionConflict(
          existingEpoch,
          binding,
          sourceEpoch,
          request,
        );
        if (conflict) {
          await this.releaseCompactionAdmission(lease);
          return conflict;
        }
      }

      const admission: ContextAdmission = {
        binding: { ...binding },
        sourceEpoch,
        request: { ...request },
      };
      if (!existingEpoch) {
        await this.createAdmission(epochFile, admission);
      }
      if (!existingBoundary) {
        await this.createAdmission(boundaryFile, admission);
      }
      return {
        status: "acquired",
        admission: structuredClone(admission),
        lease,
      };
    } catch (error) {
      await this.releaseCompactionAdmission(lease).catch(() => undefined);
      throw error;
    }
  }

  async releaseCompactionAdmission(
    lease: ContextAdmissionLease,
  ): Promise<void> {
    const file = this.admissionLeaseFile(lease.sessionKey);
    const record = await this.readRecord(
      file,
      this.maximumSessionBytes,
      "CONTEXT_LEASE",
    );
    if (!record) throw new Error("CONTEXT_ADMISSION_LEASE_MISSING");
    const parsed = admissionLeaseRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CONTEXT_LEASE");
    }
    if (parsed.data.token !== lease.token) {
      throw new Error("CONTEXT_ADMISSION_LEASE_MISMATCH");
    }
    await fs.unlink(file);
    await this.syncDirectory(path.dirname(file));
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

  async putSource(candidate: StoredContextSource): Promise<void> {
    const parsed = contextSourceSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CONTEXT_SOURCE_INVALID");
    const source = structuredClone(parsed.data);
    const directory = await this.ensureSourceDirectory(source.binding);
    const file = path.join(
      directory,
      `${checkpointKey(source.operationId)}.json`,
    );
    const existing = await this.readSourceFile(file, source.binding);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(source)) return;
      throw new Error("CONTEXT_SOURCE_ID_CONFLICT");
    }
    await this.atomicWrite(
      file,
      { schemaVersion: 1, kind: "context_source", source },
      this.maximumSourceRecordBytes,
      "CONTEXT_SOURCE_OVERSIZED",
    );
  }

  async getSource(
    binding: ContextBinding,
    operationId: string,
  ): Promise<StoredContextSource | null> {
    if (!operationId || operationId.length > 160) {
      throw new Error("CONTEXT_SOURCE_ID_INVALID");
    }
    const file = path.join(
      this.sourceDirectory(binding),
      `${checkpointKey(operationId)}.json`,
    );
    const source = await this.readSourceFile(file, binding);
    if (source && source.operationId !== operationId) {
      throw new Error("CONTEXT_SOURCE_ID_MISMATCH");
    }
    return source;
  }

  async deleteSource(
    binding: ContextBinding,
    operationId: string,
  ): Promise<void> {
    if (!operationId || operationId.length > 160) {
      throw new Error("CONTEXT_SOURCE_ID_INVALID");
    }
    const file = path.join(
      this.sourceDirectory(binding),
      `${checkpointKey(operationId)}.json`,
    );
    try {
      await fs.unlink(file);
      await this.syncDirectory(path.dirname(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async putSummary(candidate: StoredContextSummary): Promise<void> {
    const parsed = contextSummarySchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CONTEXT_SUMMARY_INVALID");
    const content = validateCheckpointContent(
      parsed.data.content,
      this.maximumCheckpointContentBytes,
    );
    if (!content.ok) throw new Error(content.error.code);
    const summary: StoredContextSummary = {
      ...parsed.data,
      content: content.value,
    };
    const directory = await this.ensureSummaryDirectory(summary.binding);
    const file = path.join(
      directory,
      `${checkpointKey(summary.operationId)}.json`,
    );
    const existing = await this.readSummaryFile(file, summary.binding);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(summary)) return;
      throw new Error("CONTEXT_SUMMARY_ID_CONFLICT");
    }
    await this.atomicWrite(
      file,
      { schemaVersion: 1, kind: "context_summary", summary },
      this.maximumSummaryRecordBytes,
      "CONTEXT_SUMMARY_OVERSIZED",
    );
  }

  async getSummary(
    binding: ContextBinding,
    operationId: string,
  ): Promise<StoredContextSummary | null> {
    if (!operationId || operationId.length > 160) {
      throw new Error("CONTEXT_SUMMARY_ID_INVALID");
    }
    const file = path.join(
      this.summaryDirectory(binding),
      `${checkpointKey(operationId)}.json`,
    );
    const summary = await this.readSummaryFile(file, binding);
    if (summary && summary.operationId !== operationId) {
      throw new Error("CONTEXT_SUMMARY_ID_MISMATCH");
    }
    return summary;
  }

  async deleteSummary(
    binding: ContextBinding,
    operationId: string,
  ): Promise<void> {
    if (!operationId || operationId.length > 160) {
      throw new Error("CONTEXT_SUMMARY_ID_INVALID");
    }
    const file = path.join(
      this.summaryDirectory(binding),
      `${checkpointKey(operationId)}.json`,
    );
    try {
      await fs.unlink(file);
      await this.syncDirectory(path.dirname(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async putSummaryAttempt(
    candidate: StoredContextSummaryAttempt,
  ): Promise<void> {
    const parsed = contextSummaryAttemptSchema.safeParse(candidate);
    if (
      !parsed.success ||
      (parsed.data.turnAssistantId !== null && parsed.data.turnUserId === null)
    ) {
      throw new Error("CONTEXT_SUMMARY_ATTEMPT_INVALID");
    }
    const attempt = structuredClone(parsed.data);
    const directory = await this.ensureSummaryAttemptDirectory(attempt.binding);
    const file = path.join(
      directory,
      `${checkpointKey(attempt.operationId)}.json`,
    );
    const existing = await this.readSummaryAttemptFile(file, attempt.binding);
    if (existing) {
      const sameIdentity =
        existing.operationId === attempt.operationId &&
        existing.source === attempt.source &&
        existing.sourceBoundary === attempt.sourceBoundary &&
        sameContextBinding(existing.binding, attempt.binding);
      const phases = {
        prepared: 0,
        possible_send: 1,
        outcome_unknown: 2,
      } as const;
      const stableConversation =
        existing.conversationUrl === null ||
        existing.conversationUrl === attempt.conversationUrl;
      const stableUser =
        existing.turnUserId === null ||
        existing.turnUserId === attempt.turnUserId;
      const stableAssistant =
        existing.turnAssistantId === null ||
        existing.turnAssistantId === attempt.turnAssistantId;
      if (
        !sameIdentity ||
        phases[attempt.phase] < phases[existing.phase] ||
        !stableConversation ||
        !stableUser ||
        !stableAssistant
      ) {
        throw new Error("CONTEXT_SUMMARY_ATTEMPT_CONFLICT");
      }
      if (JSON.stringify(existing) === JSON.stringify(attempt)) return;
    }
    await this.atomicWrite(
      file,
      {
        schemaVersion: 1,
        kind: "context_summary_attempt",
        attempt,
      },
      this.maximumSummaryAttemptRecordBytes,
      "CONTEXT_SUMMARY_ATTEMPT_OVERSIZED",
    );
  }

  async getSummaryAttempt(
    binding: ContextBinding,
    operationId: string,
  ): Promise<StoredContextSummaryAttempt | null> {
    if (!operationId || operationId.length > 160) {
      throw new Error("CONTEXT_SUMMARY_ATTEMPT_ID_INVALID");
    }
    const file = path.join(
      this.summaryAttemptDirectory(binding),
      `${checkpointKey(operationId)}.json`,
    );
    const attempt = await this.readSummaryAttemptFile(file, binding);
    if (attempt && attempt.operationId !== operationId) {
      throw new Error("CONTEXT_SUMMARY_ATTEMPT_ID_MISMATCH");
    }
    return attempt;
  }

  async deleteSummaryAttempt(
    binding: ContextBinding,
    operationId: string,
  ): Promise<void> {
    if (!operationId || operationId.length > 160) {
      throw new Error("CONTEXT_SUMMARY_ATTEMPT_ID_INVALID");
    }
    const file = path.join(
      this.summaryAttemptDirectory(binding),
      `${checkpointKey(operationId)}.json`,
    );
    try {
      await fs.unlink(file);
      await this.syncDirectory(path.dirname(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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

  private async acquireAdmissionLease(
    binding: ContextBinding,
    taskDirectory: string,
  ): Promise<ContextAdmissionLease | null> {
    const sessionKey = bindingKey(binding);
    const file = path.join(taskDirectory, "admission.lock");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = randomBytes(16).toString("hex");
      const created = await this.exclusiveWrite(
        file,
        {
          schemaVersion: 1,
          kind: "context_admission_lease",
          processId: process.pid,
          token,
        },
        this.maximumSessionBytes,
        "CONTEXT_LEASE_OVERSIZED",
      );
      if (created) return { sessionKey, token };

      let record: ParsedRecord | null;
      try {
        record = await this.readRecord(
          file,
          this.maximumSessionBytes,
          "CONTEXT_LEASE",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (
          attempt < 7 &&
          (message === "CONTEXT_LEASE_UNSAFE" ||
            message === "CONTEXT_LEASE_CORRUPT")
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          continue;
        }
        throw error;
      }
      if (!record) continue;
      const parsed = admissionLeaseRecordSchema.safeParse(record.value);
      if (!parsed.success) {
        throw this.schemaError(record.value, "CONTEXT_LEASE");
      }
      if (await this.processIsAlive(parsed.data.processId)) return null;

      const stale = path.join(
        taskDirectory,
        `.admission.lock.stale-${randomBytes(8).toString("hex")}`,
      );
      try {
        await fs.rename(file, stale);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await this.syncDirectory(taskDirectory);
      await fs.unlink(stale);
      await this.syncDirectory(taskDirectory);
    }
    throw new Error("CONTEXT_ADMISSION_CONTENTION");
  }

  private async processIsAlive(processId: number): Promise<boolean> {
    if (this.hooks.isProcessAlive) {
      return this.hooks.isProcessAlive(processId);
    }
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      return true;
    }
  }

  private async assertAdmissionLease(
    binding: ContextBinding,
    lease?: ContextAdmissionLease,
  ): Promise<void> {
    if (lease && lease.sessionKey !== bindingKey(binding)) {
      throw new Error("CONTEXT_ADMISSION_LEASE_MISMATCH");
    }
    const record = await this.readRecord(
      this.admissionLeaseFile(bindingKey(binding)),
      this.maximumSessionBytes,
      "CONTEXT_LEASE",
    );
    if (!record) {
      if (lease) throw new Error("CONTEXT_ADMISSION_LEASE_MISSING");
      return;
    }
    const parsed = admissionLeaseRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CONTEXT_LEASE");
    }
    if (!lease) throw new Error("CONTEXT_ADMISSION_LEASE_REQUIRED");
    if (parsed.data.token !== lease.token) {
      throw new Error("CONTEXT_ADMISSION_LEASE_MISMATCH");
    }
  }

  private async createAdmission(
    file: string,
    admission: ContextAdmission,
  ): Promise<void> {
    const created = await this.exclusiveWrite(
      file,
      {
        schemaVersion: 1,
        kind: "context_admission",
        admission,
      },
      this.maximumSessionBytes,
      "CONTEXT_ADMISSION_OVERSIZED",
    );
    if (!created) throw new Error("CONTEXT_ADMISSION_RACE");
  }

  private async readAdmission(file: string): Promise<ContextAdmission | null> {
    const record = await this.readRecord(
      file,
      this.maximumSessionBytes,
      "CONTEXT_ADMISSION",
    );
    if (!record) return null;
    const parsed = admissionRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CONTEXT_ADMISSION");
    }
    return structuredClone(parsed.data.admission);
  }

  private validateCheckpoint(candidate: unknown): CheckpointEnvelope {
    const parsed = validateCheckpointEnvelope(
      candidate,
      this.maximumCheckpointContentBytes,
    );
    if (!parsed.ok) throw new Error(parsed.error.code);
    return parsed.value;
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

  private async readSourceFile(
    file: string,
    binding: ContextBinding,
  ): Promise<StoredContextSource | null> {
    const record = await this.readRecord(
      file,
      this.maximumSourceRecordBytes,
      "CONTEXT_SOURCE",
    );
    if (!record) return null;
    const parsed = contextSourceRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CONTEXT_SOURCE");
    }
    if (!sameContextBinding(parsed.data.source.binding, binding)) {
      throw new Error("CONTEXT_SOURCE_BINDING_MISMATCH");
    }
    return structuredClone(parsed.data.source);
  }

  private async readSummaryFile(
    file: string,
    binding: ContextBinding,
  ): Promise<StoredContextSummary | null> {
    const record = await this.readRecord(
      file,
      this.maximumSummaryRecordBytes,
      "CONTEXT_SUMMARY",
    );
    if (!record) return null;
    const parsed = contextSummaryRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CONTEXT_SUMMARY");
    }
    if (!sameContextBinding(parsed.data.summary.binding, binding)) {
      throw new Error("CONTEXT_SUMMARY_BINDING_MISMATCH");
    }
    const content = validateCheckpointContent(
      parsed.data.summary.content,
      this.maximumCheckpointContentBytes,
    );
    if (!content.ok) throw new Error(content.error.code);
    return structuredClone({ ...parsed.data.summary, content: content.value });
  }

  private async readSummaryAttemptFile(
    file: string,
    binding: ContextBinding,
  ): Promise<StoredContextSummaryAttempt | null> {
    const record = await this.readRecord(
      file,
      this.maximumSummaryAttemptRecordBytes,
      "CONTEXT_SUMMARY_ATTEMPT",
    );
    if (!record) return null;
    const parsed = contextSummaryAttemptRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CONTEXT_SUMMARY_ATTEMPT");
    }
    if (!sameContextBinding(parsed.data.attempt.binding, binding)) {
      throw new Error("CONTEXT_SUMMARY_ATTEMPT_BINDING_MISMATCH");
    }
    return structuredClone(parsed.data.attempt);
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
    code:
      | "CHECKPOINT_STATE"
      | "CONTEXT_ADMISSION"
      | "CONTEXT_LEASE"
      | "CONTEXT_SOURCE"
      | "CONTEXT_SUMMARY"
      | "CONTEXT_SUMMARY_ATTEMPT"
      | "CONTEXT_STATE",
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
    beforePublish?: () => Promise<void>,
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
      await beforePublish?.();
      await fs.rename(temporary, target);
      temporaryExists = false;
      await this.syncDirectory(directory);
    } finally {
      if (temporaryExists) {
        await fs.unlink(temporary).catch(() => undefined);
      }
    }
  }

  private async exclusiveWrite(
    target: string,
    value: unknown,
    maximumBytes: number,
    oversizedCode: string,
  ): Promise<boolean> {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
      throw new Error(oversizedCode);
    }
    let handle;
    try {
      handle = await fs.open(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    let complete = false;
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      complete = true;
    } finally {
      await handle.close();
      if (!complete) await fs.unlink(target).catch(() => undefined);
    }
    await this.syncDirectory(path.dirname(target));
    return true;
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

  private async ensureSourceDirectory(
    binding: ContextBinding,
  ): Promise<string> {
    const task = await this.ensureTaskDirectory(binding);
    const directory = path.join(task, "sources");
    await this.ensurePrivateDirectory(directory);
    return directory;
  }

  private async ensureSummaryDirectory(
    binding: ContextBinding,
  ): Promise<string> {
    const task = await this.ensureTaskDirectory(binding);
    const directory = path.join(task, "summaries");
    await this.ensurePrivateDirectory(directory);
    return directory;
  }

  private async ensureSummaryAttemptDirectory(
    binding: ContextBinding,
  ): Promise<string> {
    const task = await this.ensureTaskDirectory(binding);
    const directory = path.join(task, "summary-attempts");
    await this.ensurePrivateDirectory(directory);
    return directory;
  }

  private async ensureAdmissionDirectories(task: string): Promise<
    Readonly<{
      boundaries: string;
      epochs: string;
    }>
  > {
    const root = path.join(task, "admissions");
    const boundaries = path.join(root, "boundaries");
    const epochs = path.join(root, "epochs");
    await this.ensurePrivateDirectory(root);
    await this.ensurePrivateDirectory(boundaries);
    await this.ensurePrivateDirectory(epochs);
    return { boundaries, epochs };
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

  private admissionLeaseFile(sessionKey: string): string {
    if (!/^[a-f0-9]{64}$/u.test(sessionKey)) {
      throw new Error("CONTEXT_ADMISSION_LEASE_KEY_INVALID");
    }
    return path.join(this.options.root, "tasks", sessionKey, "admission.lock");
  }

  private checkpointDirectory(binding: ContextBinding): string {
    return path.join(this.taskDirectory(binding), "checkpoints");
  }

  private sourceDirectory(binding: ContextBinding): string {
    return path.join(this.taskDirectory(binding), "sources");
  }

  private summaryDirectory(binding: ContextBinding): string {
    return path.join(this.taskDirectory(binding), "summaries");
  }

  private summaryAttemptDirectory(binding: ContextBinding): string {
    return path.join(this.taskDirectory(binding), "summary-attempts");
  }

  private sessionFile(binding: ContextBinding): string {
    return path.join(this.taskDirectory(binding), "session.json");
  }
}
