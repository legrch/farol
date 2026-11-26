import { z } from "zod";
import type {
  CheckpointContent,
  CheckpointEnvelope,
} from "../../domain/checkpoint";
import type { ContextBinding } from "../../domain/context-continuity";

// Record schemas, byte budgets and stored shapes of the private context store.
// Declaration-only: every parser here is a strict schema over the on-disk JSON.

export const bindingSchema = z.strictObject({
  ownerId: z.string().min(1).max(160),
  taskId: z.string().min(1).max(160),
  hostThreadId: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160),
  providerProfileId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(160),
  mode: z.string().min(1).max(160),
});

export const operationSchema = z.strictObject({
  operationId: z.string().min(1).max(160),
  source: z.enum(["retained_agent", "canonical_history"]),
  sourceBoundary: z.string().min(1).max(160),
  sourceEpoch: z.number().int().positive(),
  summaryDispatch: z.enum(["not_observed", "observed", "result_received"]),
  checkpointId: z.string().min(1).max(160).nullable(),
  hostContextRef: z.string().min(1).max(160).nullable(),
});

export const compactionRequestSchema = z.strictObject({
  operationId: z.string().min(1).max(160),
  source: z.enum(["retained_agent", "canonical_history"]),
  sourceBoundary: z.string().min(1).max(160),
});

export const sessionSchema = z
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

export const sessionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_session"),
  session: sessionSchema,
});

export const checkpointRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_checkpoint"),
  checkpoint: z.unknown(),
});

export const contextSourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(160),
  binding: bindingSchema,
  source: z.enum(["retained_agent", "canonical_history"]),
  sourceBoundary: z.string().min(1).max(160),
  variant: z.enum(["unary_replacement_history", "streamed_compaction_item"]),
  history: z.array(z.unknown()).max(4_096),
});

export const contextSourceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_source"),
  source: contextSourceSchema,
});

export const contextSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(160),
  binding: bindingSchema,
  providerOperationId: z.string().min(1).max(160),
  sourceCursor: z.string().min(1).max(512),
  content: z.unknown(),
});

export const contextSummaryRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_summary"),
  summary: contextSummarySchema,
});

export const contextSummaryAttemptSchema = z.strictObject({
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

export const contextSummaryAttemptRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_summary_attempt"),
  attempt: contextSummaryAttemptSchema,
});

// The durable proof that one operation committed to detaching exactly this
// source conversation from its route, written before the route is reset. A
// reset clears the route's identity, so without it a retry after a local
// fault could no longer tell its own retired source from an empty route.
export const contextRetirementSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(160),
  binding: bindingSchema,
  epoch: z.number().int().positive(),
  sourceCursor: z.string().min(1).max(512),
});

export const contextRetirementRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_retirement"),
  retirement: contextRetirementSchema,
});

export const admissionSchema = z.strictObject({
  binding: bindingSchema,
  sourceEpoch: z.number().int().positive(),
  request: compactionRequestSchema,
});

export const admissionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_admission"),
  admission: admissionSchema,
});

// Bounded metadata per admitted operation; checkpoint payload retention is separate.
// Written only on the exact durable retired -> active transition, never backfilled.
export const completionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_completion"),
  admission: admissionSchema,
  checkpointId: z.string().min(1).max(160),
  checkpointSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const MAXIMUM_COMPLETION_RECORD_BYTES = 8 * 1_024;

export const admissionLeaseRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("context_admission_lease"),
  processId: z.number().int().positive(),
  processInstanceId: z.string().regex(/^[a-f0-9]{32}$/u),
  token: z.string().length(32),
});

export const DEFAULT_SESSION_BYTES = 64 * 1_024;
export const DEFAULT_CHECKPOINT_CONTENT_BYTES = 256 * 1_024;
export const DEFAULT_CHECKPOINT_RECORD_BYTES = 384 * 1_024;
export const DEFAULT_SOURCE_RECORD_BYTES = 1 * 1_024 * 1_024;
export const DEFAULT_SUMMARY_RECORD_BYTES = 384 * 1_024;
export const DEFAULT_SUMMARY_ATTEMPT_RECORD_BYTES = 16 * 1_024;
export const MAXIMUM_RETIREMENT_RECORD_BYTES = 8 * 1_024;
export const DEFAULT_RETENTION = 8;
export const MAXIMUM_PUBLICATION_RECORD_BYTES = 2 * 1_024 * 1_024;

export const publicationPolicySchema = z.strictObject({
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
export const publicationRequestSchema = z.strictObject({
  checkpoint: z.unknown(),
  expected: z.strictObject({
    source: contextSourceSchema,
    sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceEpoch: z.number().int().positive(),
    policy: publicationPolicySchema,
  }),
});
export const publicationRecordSchema = z.strictObject({
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
