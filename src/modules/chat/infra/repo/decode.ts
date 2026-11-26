import type { ContextAdmission } from "../../app/port/context-repository";
import {
  validateCheckpointContent,
  type CheckpointEnvelope,
} from "../../domain/checkpoint";
import {
  sameContextBinding,
  sameContextSessionIdentity,
  type ContextBinding,
  type ContextSession,
} from "../../domain/context-continuity";
import { schemaError } from "./integrity";
import { digest } from "./layout";
import {
  admissionLeaseRecordSchema,
  admissionRecordSchema,
  checkpointRecordSchema,
  completionRecordSchema,
  contextRetirementRecordSchema,
  contextSourceRecordSchema,
  contextSummaryAttemptRecordSchema,
  contextSummaryRecordSchema,
  publicationRecordSchema,
  publicationRequestSchema,
  sessionRecordSchema,
  type ContextPublicationRequest,
  type StoredContextRetirement,
  type StoredContextSource,
  type StoredContextSummary,
  type StoredContextSummaryAttempt,
} from "./records";

// Decoders of the private context store: each turns the JSON a record file
// held into the stored value, or throws the exact classified error the store
// has always thrown. Order of checks is part of the contract. Nothing here
// touches the filesystem.

export function decodeSession(
  value: unknown,
  binding: ContextBinding,
): ContextSession {
  const parsed = sessionRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw schemaError(value, "CONTEXT_STATE");
  }
  if (!sameContextSessionIdentity(parsed.data.session.binding, binding)) {
    throw new Error("CONTEXT_STATE_IDENTITY_MISMATCH");
  }
  return structuredClone({
    ...parsed.data.session,
    lastCompletedRequest: parsed.data.session.lastCompletedRequest ?? null,
  });
}

export function decodeCheckpoint(
  value: unknown,
  binding: ContextBinding,
  validate: (candidate: unknown) => CheckpointEnvelope,
): CheckpointEnvelope {
  const parsed = checkpointRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw schemaError(value, "CHECKPOINT_STATE");
  }
  const checkpoint = validate(parsed.data.checkpoint);
  if (!sameContextBinding(checkpoint.binding, binding)) {
    throw new Error("CHECKPOINT_BINDING_MISMATCH");
  }
  return checkpoint;
}

export function decodeSource(
  value: unknown,
  binding: ContextBinding,
): StoredContextSource {
  const parsed = contextSourceRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw schemaError(value, "CONTEXT_SOURCE");
  }
  if (!sameContextBinding(parsed.data.source.binding, binding)) {
    throw new Error("CONTEXT_SOURCE_BINDING_MISMATCH");
  }
  return structuredClone(parsed.data.source);
}

export function decodeSummary(
  value: unknown,
  binding: ContextBinding,
  maximumContentBytes: number,
): StoredContextSummary {
  const parsed = contextSummaryRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw schemaError(value, "CONTEXT_SUMMARY");
  }
  if (!sameContextBinding(parsed.data.summary.binding, binding)) {
    throw new Error("CONTEXT_SUMMARY_BINDING_MISMATCH");
  }
  const content = validateCheckpointContent(
    parsed.data.summary.content,
    maximumContentBytes,
  );
  if (!content.ok) throw new Error(content.error.code);
  return structuredClone({ ...parsed.data.summary, content: content.value });
}

export function decodeRetirement(
  value: unknown,
  binding: ContextBinding,
): StoredContextRetirement {
  const parsed = contextRetirementRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw schemaError(value, "CONTEXT_RETIREMENT");
  }
  if (!sameContextBinding(parsed.data.retirement.binding, binding)) {
    throw new Error("CONTEXT_RETIREMENT_BINDING_MISMATCH");
  }
  return structuredClone(parsed.data.retirement);
}

export function decodeSummaryAttempt(
  value: unknown,
  binding: ContextBinding,
): StoredContextSummaryAttempt {
  const parsed = contextSummaryAttemptRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw schemaError(value, "CONTEXT_SUMMARY_ATTEMPT");
  }
  if (!sameContextBinding(parsed.data.attempt.binding, binding)) {
    throw new Error("CONTEXT_SUMMARY_ATTEMPT_BINDING_MISMATCH");
  }
  return structuredClone(parsed.data.attempt);
}

export function decodeAdmission(value: unknown): ContextAdmission {
  const parsed = admissionRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw schemaError(value, "CONTEXT_ADMISSION");
  }
  return structuredClone(parsed.data.admission);
}

// The lease record as stored: callers compare its owner and token themselves.
export function decodeLease(value: unknown) {
  const parsed = admissionLeaseRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw schemaError(value, "CONTEXT_LEASE");
  }
  return parsed.data;
}

// A completion record as stored. The admission it names is still checked
// against the original admission records by the caller.
export function decodeCompletion(
  value: unknown,
  binding: ContextBinding,
  operationId: string,
) {
  const parsed = completionRecordSchema.safeParse(value);
  if (!parsed.success) throw schemaError(value, "CONTEXT_COMPLETION");
  if (
    !sameContextBinding(parsed.data.admission.binding, binding) ||
    parsed.data.admission.request.operationId !== operationId
  )
    throw new Error("CONTEXT_COMPLETION_BINDING_MISMATCH");
  return parsed.data;
}

export function checkPublicationRequest(
  candidate: unknown,
  validate: (candidate: unknown) => CheckpointEnvelope,
): ContextPublicationRequest {
  const parsed = publicationRequestSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("CONTEXT_PUBLICATION_INVALID");
  const checkpoint = validate(parsed.data.checkpoint);
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

export function decodePublication(
  value: unknown,
  binding: ContextBinding,
  validate: (candidate: unknown) => CheckpointEnvelope,
): Readonly<{
  request: ContextPublicationRequest;
  requestSHA256: string;
}> {
  const parsed = publicationRecordSchema.safeParse(value);
  if (!parsed.success) throw schemaError(value, "CONTEXT_PUBLICATION");
  const request = checkPublicationRequest(parsed.data.request, validate);
  if (!sameContextBinding(binding, request.checkpoint.binding))
    throw new Error("CONTEXT_PUBLICATION_BINDING_MISMATCH");
  if (digest(request) !== parsed.data.requestSHA256)
    throw new Error("CONTEXT_PUBLICATION_DIGEST_MISMATCH");
  return { request, requestSHA256: parsed.data.requestSHA256 };
}
