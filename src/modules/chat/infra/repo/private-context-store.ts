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

// The durable proof that one operation committed to detaching exactly this
// source conversation from its route, written before the route is reset. A
// reset clears the route's identity, so without it a retry after a local
// fault could no longer tell its own retired source from an empty route.
const contextRetirementSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(160),
  binding: bindingSchema,
  epoch: z.number().int().positive(),
  sourceCursor: z.string().min(1).max(512),
});

const contextRetirementRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_retirement"),
  retirement: contextRetirementSchema,
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

// Bounded metadata per admitted operation; checkpoint payload retention is separate.
// Written only on the exact durable retired -> active transition, never backfilled.
const completionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_completion"),
  admission: admissionSchema,
  checkpointId: z.string().min(1).max(160),
  checkpointSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const MAXIMUM_COMPLETION_RECORD_BYTES = 8 * 1_024;

const admissionLeaseRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_admission_lease"),
  processId: z.number().int().positive(),
  processInstanceId: z.string().regex(/^[a-f0-9]{32}$/u),
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
const MAXIMUM_RETIREMENT_RECORD_BYTES = 8 * 1_024;
const DEFAULT_RETENTION = 8;
const PROCESS_INSTANCE_ID = randomBytes(16).toString("hex");
const MAXIMUM_PUBLICATION_RECORD_BYTES = 2 * 1_024 * 1_024;

const publicationPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  maximumSessionBytes: z.number().int().positive(),
  maximumCheckpointContentBytes: z.number().int().positive(),
  maximumCheckpointRecordBytes: z.number().int().positive(),
  maximumSourceRecordBytes: z.number().int().positive(),
  maximumSummaryRecordBytes: z.number().int().positive(),
  maximumSummaryAttemptRecordBytes: z.number().int().positive(),
  maxCheckpointsPerTask: z.number().int().positive(),
  maximumPublicationRecordBytes: z.literal(MAXIMUM_PUBLICATION_RECORD_BYTES),
});
const publicationRequestSchema = z.strictObject({
  checkpoint: z.unknown(),
  expected: z.strictObject({
    source: contextSourceSchema,
    sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceEpoch: z.number().int().positive(),
    policy: publicationPolicySchema,
  }),
});
const publicationRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_checkpoint_publication"),
  request: publicationRequestSchema,
  requestSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ContextPublicationPolicy = Readonly<
  z.infer<typeof publicationPolicySchema>
>;
export type ContextPublicationRequest = Readonly<{
  checkpoint: CheckpointEnvelope;
  expected: Readonly<{
    source: StoredContextSource;
    sourceSHA256: string;
    sourceEpoch: number;
    policy: ContextPublicationPolicy;
  }>;
}>;
export type ContextPublicationObservation =
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "outcome_unknown";
      request: ContextPublicationRequest | null;
      requestSHA256: string | null;
    }>
  | Readonly<{
      status: "published";
      request: ContextPublicationRequest;
      requestSHA256: string;
    }>;

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

export type StoredContextRetirement = Readonly<
  z.infer<typeof contextRetirementSchema>
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
  afterStaleLeaseRead?: (target: string) => Promise<void>;
  afterExclusiveCreate?: (target: string) => Promise<void>;
  afterExclusivePublish?: (target: string) => Promise<void>;
  processId?: number;
  processInstanceId?: string;
}>;

// The product constructs this store only in the Electron primary process after
// requestSingleInstanceLock succeeds. This keyed queue is the corresponding
// same-process record authority; test stores share it just like product stores.
const exclusiveRecordOperations = new Map<string, Promise<void>>();

async function withExclusiveRecordOperation<Value>(
  key: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const previous = exclusiveRecordOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  exclusiveRecordOperations.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (exclusiveRecordOperations.get(key) === current) {
      exclusiveRecordOperations.delete(key);
    }
  }
}

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
  private readonly processId: number;
  private readonly processInstanceId: string;

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
    this.processId = positiveInteger(
      hooks.processId ?? process.pid,
      "CONTEXT_PROCESS_ID_INVALID",
    );
    this.processInstanceId = hooks.processInstanceId ?? PROCESS_INSTANCE_ID;
    if (!/^[a-f0-9]{32}$/u.test(this.processInstanceId)) {
      throw new Error("CONTEXT_PROCESS_INSTANCE_ID_INVALID");
    }
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
    return withExclusiveRecordOperation(
      this.ownerOperationKey(bindingKey(session.binding)),
      () => this.saveWithinOwner(session, lease),
    );
  }

  private async saveWithinOwner(
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
    if (
      lease &&
      existing?.phase === "old_epoch_retired" &&
      existing.operation &&
      existing.operation.summaryDispatch === "result_received" &&
      existing.operation.hostContextRef !== null &&
      existing.operation.sourceEpoch === existing.epoch &&
      session.phase === "active" &&
      !session.operation &&
      session.epoch === existing.epoch + 1 &&
      session.lastCompletedRequest &&
      sameCompactionRequest(existing.operation, session.lastCompletedRequest) &&
      session.lastCompletedOperationId === existing.operation.operationId &&
      session.lastCheckpointId === existing.operation.checkpointId
    ) {
      const checkpoint = session.lastCheckpointId
        ? await this.get(session.binding, session.lastCheckpointId)
        : null;
      if (
        !checkpoint ||
        checkpoint.epoch !== existing.epoch ||
        !sameCompactionRequest(checkpoint, session.lastCompletedRequest)
      )
        throw new Error("CONTEXT_COMPLETION_CHECKPOINT_MISMATCH");
      const admission = {
        binding: session.binding,
        sourceEpoch: checkpoint.epoch,
        request: session.lastCompletedRequest,
      };
      await this.assertCompletionAdmission(admission);
      const record = {
        schemaVersion: 1,
        kind: "context_completion",
        admission,
        checkpointId: checkpoint.checkpointId,
        checkpointSHA256: digest(checkpoint),
      } as const;
      const file = this.completionFile(session.binding, checkpoint.operationId);
      const created = await this.exclusiveWrite(
        file,
        record,
        MAXIMUM_COMPLETION_RECORD_BYTES,
        "CONTEXT_COMPLETION_OVERSIZED",
        () => this.assertAdmissionLease(session.binding, lease),
      );
      if (
        !created &&
        JSON.stringify(
          await this.readCompletion(session.binding, checkpoint.operationId),
        ) !== JSON.stringify(record)
      )
        throw new Error("CONTEXT_COMPLETION_CONFLICT");
    }
  }

  private completionFile(binding: ContextBinding, operationId: string): string {
    return path.join(
      this.taskDirectory(binding),
      `completion-${checkpointKey(operationId)}.json`,
    );
  }

  private async assertCompletionAdmission(
    admission: ContextAdmission,
  ): Promise<void> {
    for (const relative of [
      `admissions/epochs/${admission.sourceEpoch}.json`,
      `admissions/boundaries/${boundaryKey(admission.request)}.json`,
    ]) {
      const original = await this.readAdmission(
        path.join(this.taskDirectory(admission.binding), relative),
      );
      if (
        !original ||
        admissionConflict(
          original,
          admission.binding,
          admission.sourceEpoch,
          admission.request,
        )
      )
        throw new Error("CONTEXT_COMPLETION_ADMISSION_MISMATCH");
    }
  }

  private async readCompletion(binding: ContextBinding, operationId: string) {
    const record = await this.readRecord(
      this.completionFile(binding, operationId),
      MAXIMUM_COMPLETION_RECORD_BYTES,
      "CONTEXT_COMPLETION",
      true,
    );
    if (!record) return null;
    const parsed = completionRecordSchema.safeParse(record.value);
    if (!parsed.success)
      throw this.schemaError(record.value, "CONTEXT_COMPLETION");
    if (
      !sameContextBinding(parsed.data.admission.binding, binding) ||
      parsed.data.admission.request.operationId !== operationId
    )
      throw new Error("CONTEXT_COMPLETION_BINDING_MISMATCH");
    await this.assertCompletionAdmission(parsed.data.admission);
    return parsed.data;
  }

  async acquireCompactionAdmission(
    binding: ContextBinding,
    sourceEpoch: number,
    request: CompactionRequest,
  ): Promise<ContextAdmissionResult> {
    return this.acquireCompactionAdmissionWithinOwner(
      binding,
      sourceEpoch,
      request,
    );
  }

  private async acquireCompactionAdmissionWithinOwner(
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
          await this.releaseCompactionAdmissionWithinOwner(lease);
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
          await this.releaseCompactionAdmissionWithinOwner(lease);
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
      await this.releaseCompactionAdmissionWithinOwner(lease).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async releaseCompactionAdmission(
    lease: ContextAdmissionLease,
  ): Promise<void> {
    return withExclusiveRecordOperation(
      this.ownerOperationKey(lease.sessionKey),
      () => this.releaseCompactionAdmissionWithinOwner(lease),
    );
  }

  private async releaseCompactionAdmissionWithinOwner(
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

  checkpointPublicationPolicy(): ContextPublicationPolicy {
    return Object.freeze({
      schemaVersion: 1,
      maximumSessionBytes: this.maximumSessionBytes,
      maximumCheckpointContentBytes: this.maximumCheckpointContentBytes,
      maximumCheckpointRecordBytes: this.maximumCheckpointRecordBytes,
      maximumSourceRecordBytes: this.maximumSourceRecordBytes,
      maximumSummaryRecordBytes: this.maximumSummaryRecordBytes,
      maximumSummaryAttemptRecordBytes: this.maximumSummaryAttemptRecordBytes,
      maxCheckpointsPerTask: this.maxCheckpointsPerTask,
      maximumPublicationRecordBytes: MAXIMUM_PUBLICATION_RECORD_BYTES,
    });
  }

  // This is the existing Electron context owner's TS binding and admission.
  // It neither maps Go SourceRef nor makes two distinct owners atomic.
  async publishCheckpoint(
    candidate: ContextPublicationRequest,
    lease: ContextAdmissionLease,
  ): Promise<Extract<ContextPublicationObservation, { status: "published" }>> {
    const request = this.validatePublicationRequest(candidate);
    if (
      JSON.stringify(request.expected.policy) !==
      JSON.stringify(this.checkpointPublicationPolicy())
    )
      throw new Error("CONTEXT_PUBLICATION_POLICY_CHANGED");
    const record = {
      schemaVersion: 1,
      kind: "context_checkpoint_publication",
      request,
      requestSHA256: digest(request),
    } as const;
    if (
      Buffer.byteLength(JSON.stringify(record) + "\n", "utf8") >
      MAXIMUM_PUBLICATION_RECORD_BYTES
    )
      throw new Error("CONTEXT_PUBLICATION_OVERSIZED");
    const binding = request.checkpoint.binding;
    return withExclusiveRecordOperation(
      this.ownerOperationKey(bindingKey(binding)),
      async () => {
        const directory = await this.ensureCheckpointDirectory(binding);
        const intentFile = this.publicationFile(
          binding,
          request.checkpoint.operationId,
        );
        const original = await this.readPublicationFile(intentFile, binding);
        if (original) {
          if (
            original.requestSHA256 !== record.requestSHA256 ||
            JSON.stringify(original.request) !== JSON.stringify(request)
          )
            throw new Error("CONTEXT_PUBLICATION_OPERATION_CONFLICT");
          // A repeated call may observe a completed original, never resume its IO.
          const observed = await this.observeCheckpoint(
            binding,
            request.checkpoint.operationId,
          );
          if (observed.status === "published") return observed;
          throw new Error("CONTEXT_PUBLICATION_OUTCOME_UNKNOWN");
        }
        await this.assertPublicationOwner(request, lease);
        const file = path.join(
          directory,
          `${checkpointKey(request.checkpoint.checkpointId)}.json`,
        );
        const previous = await this.readCheckpointFile(file, binding);
        if (
          previous &&
          JSON.stringify(previous) !== JSON.stringify(request.checkpoint)
        )
          throw new Error("CHECKPOINT_ID_CONFLICT");
        // Everything after attempted intent publication is uncertain on failure.
        // The durable full request cannot be overwritten or blindly completed.
        try {
          const admitted = await this.exclusiveWrite(
            intentFile,
            record,
            MAXIMUM_PUBLICATION_RECORD_BYTES,
            "CONTEXT_PUBLICATION_OVERSIZED",
            () => this.assertPublicationOwner(request, lease),
          );
          if (!admitted)
            throw new Error("CONTEXT_PUBLICATION_OPERATION_CONFLICT");
          const written = await this.exclusiveWrite(
            file,
            {
              schemaVersion: 1,
              kind: "context_checkpoint",
              checkpoint: request.checkpoint,
            },
            this.maximumCheckpointRecordBytes,
            "CHECKPOINT_RECORD_OVERSIZED",
            () => this.assertPublicationOwner(request, lease),
          );
          if (!written) {
            const current = await this.readCheckpointFile(file, binding);
            if (
              !current ||
              JSON.stringify(current) !== JSON.stringify(request.checkpoint)
            )
              throw new Error("CHECKPOINT_ID_CONFLICT");
          }
          await this.assertPublicationOwner(request, lease);
          const observed = await this.observeCheckpoint(
            binding,
            request.checkpoint.operationId,
          );
          if (observed.status !== "published")
            throw new Error("CONTEXT_PUBLICATION_OUTCOME_UNKNOWN");
          await this.pruneCheckpoints(
            directory,
            binding,
            request.checkpoint.checkpointId,
          );
          return observed;
        } catch (cause) {
          throw new Error("CONTEXT_PUBLICATION_OUTCOME_UNKNOWN", { cause });
        }
      },
    );
  }

  async observeCheckpoint(
    binding: ContextBinding,
    operationId: string,
  ): Promise<ContextPublicationObservation> {
    if (!operationId || operationId.length > 160)
      throw new Error("CONTEXT_PUBLICATION_ID_INVALID");
    if (!bindingSchema.safeParse(binding).success)
      throw new Error("CONTEXT_PUBLICATION_BINDING_INVALID");
    const original = await this.readPublicationFile(
      this.publicationFile(binding, operationId),
      binding,
    );
    if (!original) {
      const recorded = await this.hasOriginalOperation(binding, operationId);
      return recorded
        ? { status: "outcome_unknown", request: null, requestSHA256: null }
        : { status: "absent" };
    }
    if (original.request.checkpoint.operationId !== operationId)
      throw new Error("CONTEXT_PUBLICATION_OPERATION_MISMATCH");
    const checkpoint = await this.get(
      binding,
      original.request.checkpoint.checkpointId,
    );
    if (!checkpoint) return { status: "outcome_unknown", ...original };
    if (
      JSON.stringify(checkpoint) !== JSON.stringify(original.request.checkpoint)
    )
      throw new Error("CONTEXT_PUBLICATION_CHECKPOINT_CONFLICT");
    return { status: "published", ...original };
  }

  private ownerOperationKey(sessionKey: string): string {
    if (!/^[a-f0-9]{64}$/u.test(sessionKey))
      throw new Error("CONTEXT_ADMISSION_LEASE_INVALID");
    return path.join(this.options.root, "tasks", sessionKey, ".context-owner");
  }

  private publicationFile(
    binding: ContextBinding,
    operationId: string,
  ): string {
    return path.join(
      this.checkpointDirectory(binding),
      `publication-${checkpointKey(operationId)}.json`,
    );
  }

  private validatePublicationRequest(
    candidate: unknown,
  ): ContextPublicationRequest {
    const parsed = publicationRequestSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CONTEXT_PUBLICATION_INVALID");
    const checkpoint = this.validateCheckpoint(parsed.data.checkpoint);
    const expected = parsed.data.expected;
    if (
      !sameContextBinding(checkpoint.binding, expected.source.binding) ||
      checkpoint.operationId !== expected.source.operationId ||
      checkpoint.source !== expected.source.source ||
      checkpoint.sourceBoundary !== expected.source.sourceBoundary ||
      checkpoint.epoch !== expected.sourceEpoch ||
      digest(expected.source) !== expected.sourceSHA256
    )
      throw new Error("CONTEXT_PUBLICATION_SOURCE_MISMATCH");
    return structuredClone({ checkpoint, expected });
  }

  private async readPublicationFile(
    file: string,
    binding: ContextBinding,
  ): Promise<Readonly<{
    request: ContextPublicationRequest;
    requestSHA256: string;
  }> | null> {
    const record = await this.readRecord(
      file,
      MAXIMUM_PUBLICATION_RECORD_BYTES,
      "CONTEXT_PUBLICATION",
      true,
    );
    if (!record) return null;
    const parsed = publicationRecordSchema.safeParse(record.value);
    if (!parsed.success)
      throw this.schemaError(record.value, "CONTEXT_PUBLICATION");
    const request = this.validatePublicationRequest(parsed.data.request);
    if (!sameContextBinding(binding, request.checkpoint.binding))
      throw new Error("CONTEXT_PUBLICATION_BINDING_MISMATCH");
    if (digest(request) !== parsed.data.requestSHA256)
      throw new Error("CONTEXT_PUBLICATION_DIGEST_MISMATCH");
    return { request, requestSHA256: parsed.data.requestSHA256 };
  }

  private async assertPublicationOwner(
    request: ContextPublicationRequest,
    lease: ContextAdmissionLease,
  ): Promise<void> {
    const { checkpoint, expected } = request;
    await this.assertAdmissionLease(checkpoint.binding, lease);
    const lock = await this.readRecord(
      this.admissionLeaseFile(bindingKey(checkpoint.binding)),
      this.maximumSessionBytes,
      "CONTEXT_LEASE",
    );
    const owner = lock
      ? admissionLeaseRecordSchema.safeParse(lock.value)
      : null;
    if (
      !owner?.success ||
      owner.data.processId !== this.processId ||
      owner.data.processInstanceId !== this.processInstanceId
    )
      throw new Error("CONTEXT_PUBLICATION_OWNER_CHANGED");
    const session = await this.load(checkpoint.binding);
    if (
      !session ||
      !sameContextBinding(session.binding, checkpoint.binding) ||
      session.epoch !== expected.sourceEpoch ||
      session.phase !== "validated" ||
      !session.operation ||
      !sameCompactionRequest(session.operation, expected.source) ||
      session.operation.sourceEpoch !== expected.sourceEpoch ||
      session.operation.checkpointId !== checkpoint.checkpointId ||
      session.operation.summaryDispatch !== "result_received"
    )
      throw new Error("CONTEXT_PUBLICATION_SESSION_CHANGED");
    const stored = await this.getSource(
      checkpoint.binding,
      checkpoint.operationId,
    );
    if (
      !stored ||
      digest(stored) !== expected.sourceSHA256 ||
      JSON.stringify(stored) !== JSON.stringify(expected.source)
    )
      throw new Error("CONTEXT_PUBLICATION_SOURCE_CHANGED");
    for (const file of [
      path.join(
        this.taskDirectory(checkpoint.binding),
        "admissions",
        "epochs",
        `${expected.sourceEpoch}.json`,
      ),
      path.join(
        this.taskDirectory(checkpoint.binding),
        "admissions",
        "boundaries",
        `${boundaryKey(expected.source)}.json`,
      ),
    ]) {
      const admission = await this.readAdmission(file);
      if (
        !admission ||
        admissionConflict(
          admission,
          checkpoint.binding,
          expected.sourceEpoch,
          expected.source,
        )
      )
        throw new Error("CONTEXT_PUBLICATION_ADMISSION_CHANGED");
    }
  }

  private async hasOriginalOperation(
    binding: ContextBinding,
    operationId: string,
  ): Promise<boolean> {
    return (await this.originalOperationIds(binding)).has(operationId);
  }

  private async confirmedCompletedOperation(
    binding: ContextBinding,
    operationId: string,
  ): Promise<boolean> {
    const session = await this.load(binding);
    if (
      !session ||
      !sameContextBinding(session.binding, binding) ||
      session.phase !== "active" ||
      session.operation ||
      !session.lastCompletedOperationId ||
      !session.lastCompletedRequest ||
      !session.lastCheckpointId
    )
      return false;
    const head = await this.get(binding, session.lastCheckpointId);
    if (
      !head ||
      head.operationId !== session.lastCompletedOperationId ||
      head.epoch + 1 !== session.epoch ||
      !sameCompactionRequest(head, session.lastCompletedRequest)
    )
      return false;
    const completion = await this.readCompletion(binding, operationId);
    if (head.operationId === operationId) {
      return (
        !completion ||
        (completion.admission.sourceEpoch === head.epoch &&
          completion.checkpointId === head.checkpointId &&
          completion.checkpointSHA256 === digest(head))
      );
    }
    // Earlier epochs require their original checkpoint or the exact completion
    // evidence recorded before pruning, plus the same owner's later active head.
    const originals: CheckpointEnvelope[] = [];
    for (const name of (
      await fs.readdir(this.checkpointDirectory(binding))
    ).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
      const checkpoint = await this.readCheckpointFile(
        path.join(this.checkpointDirectory(binding), name),
        binding,
      );
      if (checkpoint?.operationId === operationId) originals.push(checkpoint);
    }
    if (completion) {
      if (completion.admission.sourceEpoch >= head.epoch) return false;
      if (
        originals.length > 0 &&
        (originals.length !== 1 ||
          originals[0]!.checkpointId !== completion.checkpointId ||
          digest(originals[0]) !== completion.checkpointSHA256)
      )
        return false;
      return true;
    }
    // Historical stores without completion evidence still require the original.
    return originals.length === 1 && originals[0]!.epoch < head.epoch;
  }

  private async originalOperationIds(
    binding: ContextBinding,
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    const session = await this.load(binding);
    if (session && !sameContextBinding(session.binding, binding))
      throw new Error("CONTEXT_PUBLICATION_BINDING_MISMATCH");
    if (session?.operation) ids.add(session.operation.operationId);
    if (session?.lastCompletedOperationId)
      ids.add(session.lastCompletedOperationId);
    const retirement = await this.getRetirement(binding);
    if (retirement) ids.add(retirement.operationId);
    const taskNames = await fs
      .readdir(this.taskDirectory(binding))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    for (const name of taskNames.filter((name) =>
      /^completion-[a-f0-9]{64}\.json$/u.test(name),
    )) {
      const record = await this.readRecord(
        path.join(this.taskDirectory(binding), name),
        MAXIMUM_COMPLETION_RECORD_BYTES,
        "CONTEXT_COMPLETION",
        true,
      );
      const parsed = completionRecordSchema.safeParse(record?.value);
      if (!parsed.success) throw new Error("CONTEXT_COMPLETION_CORRUPT");
      const operationId = parsed.data.admission.request.operationId;
      if (name !== path.basename(this.completionFile(binding, operationId)))
        throw new Error("CONTEXT_COMPLETION_BINDING_MISMATCH");
      await this.readCompletion(binding, operationId);
      ids.add(operationId);
    }
    for (const attempt of await this.listSummaryAttempts(binding))
      ids.add(attempt.operationId);
    for (const relative of [
      "checkpoints",
      "summaries",
      "admissions/epochs",
      "admissions/boundaries",
    ]) {
      const directory = path.join(this.taskDirectory(binding), relative);
      let names: string[];
      try {
        names = await fs.readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names.filter((name) =>
        /^(?:[a-f0-9]{64}|[0-9]+)\.json$/u.test(name),
      )) {
        if (relative === "checkpoints") {
          const checkpoint = await this.readCheckpointFile(
            path.join(directory, name),
            binding,
          );
          if (checkpoint) ids.add(checkpoint.operationId);
        } else if (relative === "summaries") {
          const summary = await this.readSummaryFile(
            path.join(directory, name),
            binding,
          );
          if (summary) ids.add(summary.operationId);
        } else {
          const admission = await this.readAdmission(
            path.join(directory, name),
          );
          if (admission && !sameContextBinding(admission.binding, binding))
            throw new Error("CONTEXT_PUBLICATION_BINDING_MISMATCH");
          if (admission) ids.add(admission.request.operationId);
        }
      }
    }
    return ids;
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
    const created = await this.exclusiveWrite(
      file,
      {
        schemaVersion: 1,
        kind: "context_checkpoint",
        checkpoint: validated,
      },
      this.maximumCheckpointRecordBytes,
      "CHECKPOINT_RECORD_OVERSIZED",
    );
    if (!created) {
      const original = await this.readCheckpointFile(file, validated.binding);
      if (!original || JSON.stringify(original) !== JSON.stringify(validated))
        throw new Error("CHECKPOINT_ID_CONFLICT");
    }
    await withExclusiveRecordOperation(
      this.ownerOperationKey(bindingKey(validated.binding)),
      () =>
        this.pruneCheckpoints(
          directory,
          validated.binding,
          validated.checkpointId,
        ),
    );
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
    const created = await this.exclusiveWrite(
      file,
      { schemaVersion: 1, kind: "context_source", source },
      this.maximumSourceRecordBytes,
      "CONTEXT_SOURCE_OVERSIZED",
    );
    if (!created) {
      const original = await this.readSourceFile(file, source.binding);
      if (!original || JSON.stringify(original) !== JSON.stringify(source))
        throw new Error("CONTEXT_SOURCE_ID_CONFLICT");
    }
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
    return withExclusiveRecordOperation(
      this.ownerOperationKey(bindingKey(binding)),
      () => this.deleteSourceWithinOwner(binding, operationId),
    );
  }

  private async deleteSourceWithinOwner(
    binding: ContextBinding,
    operationId: string,
  ): Promise<void> {
    if (!operationId || operationId.length > 160) {
      throw new Error("CONTEXT_SOURCE_ID_INVALID");
    }
    const original = await this.readPublicationFile(
      this.publicationFile(binding, operationId),
      binding,
    );
    if (
      original &&
      (await this.observeCheckpoint(binding, operationId)).status !==
        "published"
    )
      throw new Error("CONTEXT_PUBLICATION_SOURCE_RETAINED");
    if (
      (await this.hasOriginalOperation(binding, operationId)) &&
      !(await this.confirmedCompletedOperation(binding, operationId))
    )
      throw new Error("CONTEXT_PUBLICATION_SOURCE_RETAINED");
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

  // One retirement record per task. It only moves forward, to a later
  // epoch's retirement; the same record is accepted again unchanged, and
  // anything else is a conflict rather than an overwrite.
  async putRetirement(candidate: StoredContextRetirement): Promise<void> {
    const parsed = contextRetirementSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CONTEXT_RETIREMENT_INVALID");
    const retirement = structuredClone(parsed.data);
    const directory = await this.ensureTaskDirectory(retirement.binding);
    const file = path.join(directory, "retirement.json");
    const existing = await this.readRetirementFile(file, retirement.binding);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(retirement)) return;
      if (existing.epoch >= retirement.epoch) {
        throw new Error("CONTEXT_RETIREMENT_CONFLICT");
      }
    }
    await this.atomicWrite(
      file,
      { schemaVersion: 1, kind: "context_retirement", retirement },
      MAXIMUM_RETIREMENT_RECORD_BYTES,
      "CONTEXT_RETIREMENT_OVERSIZED",
    );
  }

  async getRetirement(
    binding: ContextBinding,
  ): Promise<StoredContextRetirement | null> {
    return this.readRetirementFile(
      path.join(this.taskDirectory(binding), "retirement.json"),
      binding,
    );
  }

  // Every summary attempt a task still holds. An attempt that cannot be
  // read is an error, not a missing one: whether its summary is over is
  // exactly what a caller asking for the list needs to know.
  async listSummaryAttempts(
    binding: ContextBinding,
  ): Promise<ReadonlyArray<StoredContextSummaryAttempt>> {
    const directory = this.summaryAttemptDirectory(binding);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const attempts: StoredContextSummaryAttempt[] = [];
    for (const name of names
      .filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry))
      .sort()) {
      const attempt = await this.readSummaryAttemptFile(
        path.join(directory, name),
        binding,
      );
      if (attempt) attempts.push(attempt);
    }
    return attempts;
  }

  // Every task directory the store holds, by the binding its session names.
  // A directory whose session cannot be read is reported as unreadable: its
  // owner is unknown, so a sweep must leave it alone.
  async listTaskBindings(): Promise<
    ReadonlyArray<
      | Readonly<{ readable: true; binding: ContextBinding }>
      | Readonly<{ readable: false; key: string }>
    >
  > {
    await this.ensureRoot();
    const tasks = path.join(this.options.root, "tasks");
    let names: string[];
    try {
      names = await fs.readdir(tasks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const listed: Array<
      | Readonly<{ readable: true; binding: ContextBinding }>
      | Readonly<{ readable: false; key: string }>
    > = [];
    for (const name of names.filter((entry) => /^[a-f0-9]{64}$/u.test(entry))) {
      try {
        const record = await this.readRecord(
          path.join(tasks, name, "session.json"),
          this.maximumSessionBytes,
          "CONTEXT_STATE",
        );
        const parsed = record
          ? sessionRecordSchema.safeParse(record.value)
          : null;
        if (
          !parsed?.success ||
          bindingKey(parsed.data.session.binding) !== name
        ) {
          listed.push({ readable: false, key: name });
          continue;
        }
        listed.push({
          readable: true,
          binding: structuredClone(parsed.data.session.binding),
        });
      } catch {
        listed.push({ readable: false, key: name });
      }
    }
    return listed;
  }

  async deleteTask(binding: ContextBinding): Promise<void> {
    return withExclusiveRecordOperation(
      this.ownerOperationKey(bindingKey(binding)),
      () => this.deleteTaskWithinOwner(binding),
    );
  }

  private async deleteTaskWithinOwner(binding: ContextBinding): Promise<void> {
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
    let names: string[];
    try {
      names = await fs.readdir(this.checkpointDirectory(binding));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    for (const name of names.filter((name) =>
      /^publication-[a-f0-9]{64}\.json$/u.test(name),
    )) {
      const original = await this.readPublicationFile(
        path.join(this.checkpointDirectory(binding), name),
        binding,
      );
      if (
        original &&
        (
          await this.observeCheckpoint(
            binding,
            original.request.checkpoint.operationId,
          )
        ).status !== "published"
      )
        throw new Error("CONTEXT_PUBLICATION_TASK_RETAINED");
    }
    const lease = await this.readRecord(
      this.admissionLeaseFile(bindingKey(binding)),
      this.maximumSessionBytes,
      "CONTEXT_LEASE",
    );
    if (lease) throw new Error("CONTEXT_PUBLICATION_TASK_RETAINED");
    for (const operationId of await this.originalOperationIds(binding)) {
      if (!(await this.confirmedCompletedOperation(binding, operationId)))
        throw new Error("CONTEXT_PUBLICATION_TASK_RETAINED");
    }
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
          processId: this.processId,
          processInstanceId: this.processInstanceId,
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
      if (
        parsed.data.processId === this.processId &&
        parsed.data.processInstanceId === this.processInstanceId
      ) {
        return null;
      }
      if (
        parsed.data.processId !== this.processId &&
        (await this.processIsAlive(parsed.data.processId))
      ) {
        throw new Error("CONTEXT_ADMISSION_OWNER_AMBIGUOUS");
      }
      await this.hooks.afterStaleLeaseRead?.(file);
      const repaired = await withExclusiveRecordOperation(file, async () => {
        const current = await this.readRecord(
          file,
          this.maximumSessionBytes,
          "CONTEXT_LEASE",
        );
        if (!current || current.serialized !== record.serialized) return false;

        const stale = path.join(
          taskDirectory,
          `.admission.lock.stale-${randomBytes(8).toString("hex")}`,
        );
        try {
          await fs.rename(file, stale);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
        await this.syncDirectory(taskDirectory);
        await fs.unlink(stale);
        await this.syncDirectory(taskDirectory);
        return true;
      });
      if (!repaired) continue;
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
      true,
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
      true,
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

  private async readRetirementFile(
    file: string,
    binding: ContextBinding,
  ): Promise<StoredContextRetirement | null> {
    const record = await this.readRecord(
      file,
      MAXIMUM_RETIREMENT_RECORD_BYTES,
      "CONTEXT_RETIREMENT",
    );
    if (!record) return null;
    const parsed = contextRetirementRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw this.schemaError(record.value, "CONTEXT_RETIREMENT");
    }
    if (!sameContextBinding(parsed.data.retirement.binding, binding)) {
      throw new Error("CONTEXT_RETIREMENT_BINDING_MISMATCH");
    }
    return structuredClone(parsed.data.retirement);
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
    newlyWrittenCheckpointId: string,
  ): Promise<void> {
    const protectedCheckpointIds = new Set([newlyWrittenCheckpointId]);
    for (const name of (await fs.readdir(directory)).filter((name) =>
      /^publication-[a-f0-9]{64}\.json$/u.test(name),
    )) {
      const original = await this.readPublicationFile(
        path.join(directory, name),
        binding,
      );
      if (original)
        protectedCheckpointIds.add(original.request.checkpoint.checkpointId);
    }
    const session = await this.load(binding);
    if (session?.lastCheckpointId) {
      protectedCheckpointIds.add(session.lastCheckpointId);
    }
    if (session?.operation?.checkpointId) {
      protectedCheckpointIds.add(session.operation.checkpointId);
    }
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
    const protectedCount = ordered.filter((record) =>
      protectedCheckpointIds.has(record.checkpoint.checkpointId),
    ).length;
    const unprotectedCapacity = Math.max(
      0,
      this.maxCheckpointsPerTask - protectedCount,
    );
    const expired = ordered
      .filter(
        (record) => !protectedCheckpointIds.has(record.checkpoint.checkpointId),
      )
      .slice(unprotectedCapacity);
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
      | "CONTEXT_PUBLICATION"
      | "CONTEXT_COMPLETION"
      | "CONTEXT_ADMISSION"
      | "CONTEXT_LEASE"
      | "CONTEXT_SOURCE"
      | "CONTEXT_SUMMARY"
      | "CONTEXT_SUMMARY_ATTEMPT"
      | "CONTEXT_RETIREMENT"
      | "CONTEXT_STATE",
    sealedPublication = false,
  ): Promise<ParsedRecord | null> {
    const createOnly =
      sealedPublication ||
      code === "CONTEXT_ADMISSION" ||
      code === "CONTEXT_LEASE";
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        if (createOnly && info.nlink === 2) {
          await handle.close();
          handle = undefined;
          await this.finishExclusivePublication(
            file,
            maximumBytes,
            `${code}_PUBLICATION_INCOMPLETE`,
          );
          continue;
        }
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
        await handle?.close();
      }
    }
    throw new Error(`${code}_PUBLICATION_INCOMPLETE`);
  }

  private async finishExclusivePublication(
    target: string,
    maximumBytes: number,
    incompleteCode: string,
  ): Promise<void> {
    await withExclusiveRecordOperation(target, async () => {
      let handle;
      try {
        handle = await fs.open(
          target,
          fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      try {
        let info = await handle.stat();
        if (info.nlink === 1) return;
        this.assertPrivateFile(info, maximumBytes, incompleteCode, 2);
        const directory = path.dirname(target);
        const prefix = `.${path.basename(target)}.tmp-`;
        const matches: string[] = [];
        for (const name of await fs.readdir(directory)) {
          if (!name.startsWith(prefix)) continue;
          const temporary = path.join(directory, name);
          try {
            const candidate = await fs.lstat(temporary);
            if (
              candidate.isFile() &&
              !candidate.isSymbolicLink() &&
              candidate.dev === info.dev &&
              candidate.ino === info.ino
            ) {
              matches.push(temporary);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (matches.length !== 1) {
          info = await handle.stat();
          if (info.nlink === 1) return;
          throw new Error(incompleteCode);
        }
        try {
          await fs.unlink(matches[0]!);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await this.syncDirectory(directory);
        info = await handle.stat();
        if (info.nlink !== 1) throw new Error(incompleteCode);
      } finally {
        await handle.close();
      }
    });
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
    beforePublish?: () => Promise<void>,
  ): Promise<boolean> {
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
        await this.hooks.afterExclusiveCreate?.(target);
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforeCommit?.(target);
      await beforePublish?.();
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      await this.hooks.afterExclusivePublish?.(target);
      try {
        await fs.unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      temporaryExists = false;
      await this.syncDirectory(directory);
      return true;
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
    maximumLinks = 1,
  ): void {
    if (
      !info.isFile() ||
      info.nlink < 1 ||
      info.nlink > maximumLinks ||
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
