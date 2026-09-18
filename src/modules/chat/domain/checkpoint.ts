import { z } from "zod";
import {
  failure,
  success,
  type Result,
} from "../../../pkg/kernel/domain/result";
import type {
  ContextBinding,
  ContextSession,
  ContextSource,
} from "./context-continuity";

const boundedText = z.string().trim().min(1).max(4_096);
const boundedList = z.array(boundedText).max(64);
const evidenceItem = z.strictObject({
  description: boundedText,
  evidenceRefs: z.array(z.string().trim().min(1).max(512)).max(32),
});
const unknownOutcome = z.strictObject({
  operationRef: z.string().trim().min(1).max(160),
  description: boundedText,
});
const reference = z.strictObject({
  reference: z.string().trim().min(1).max(1_024),
  availability: z.enum(["available", "unavailable"]),
});

const checkpointContentSchema = z.strictObject({
  goal: boundedText,
  activeConstraints: boundedList,
  latestCorrections: boundedList,
  keyDecisions: boundedList,
  completedWork: z.array(evidenceItem).max(64),
  unfinishedWork: boundedList,
  unresolvedQuestions: boundedList,
  unknownOutcomes: z.array(unknownOutcome).max(64),
  artifactRefs: z.array(reference).max(64),
  attachmentRefs: z.array(reference).max(32),
  nextSafeStep: boundedText,
});

const bindingSchema = z.strictObject({
  ownerId: z.string().min(1).max(160),
  taskId: z.string().min(1).max(160),
  hostThreadId: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160),
  providerProfileId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(160),
  mode: z.string().min(1).max(160),
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
  content: checkpointContentSchema,
});

export type CheckpointContent = Readonly<
  z.infer<typeof checkpointContentSchema>
>;

export type CheckpointEnvelope = Readonly<{
  schemaVersion: 1;
  checkpointId: string;
  operationId: string;
  providerOperationId: string;
  binding: ContextBinding;
  epoch: number;
  source: ContextSource;
  sourceBoundary: string;
  sourceCursor: string;
  parentCheckpointId: string | null;
  provider: Readonly<{
    profileId: string;
    modelId: string;
    mode: string;
  }>;
  createdAt: number;
  validation: "validated";
  content: CheckpointContent;
}>;

// Facts the host's own record proves, independent of any model summary: the
// receipts that may be cited, completed work an earlier validated checkpoint
// already proved, and calls whose result never arrived.
export type AuthoritativeContextFacts = Readonly<{
  receipts: readonly string[];
  carriedWork: readonly Readonly<{
    description: string;
    evidenceRefs: readonly string[];
  }>[];
  unresolved: readonly Readonly<{
    operationRef: string;
    description: string;
  }>[];
}>;

export type CheckpointErrorCode =
  | "CHECKPOINT_CONTENT_INVALID"
  | "CHECKPOINT_CONTENT_OVERSIZED"
  | "CHECKPOINT_ENVELOPE_INVALID"
  | "CHECKPOINT_PROVIDER_BINDING_MISMATCH";

export function validateCheckpointContent(
  candidate: unknown,
  maximumBytes: number,
): Result<CheckpointContent, CheckpointErrorCode> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return failure("CHECKPOINT_CONTENT_OVERSIZED");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(candidate);
  } catch {
    return failure("CHECKPOINT_CONTENT_INVALID");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > maximumBytes) {
    return failure("CHECKPOINT_CONTENT_OVERSIZED");
  }
  const parsed = checkpointContentSchema.safeParse(candidate);
  if (!parsed.success) return failure("CHECKPOINT_CONTENT_INVALID");
  return success(structuredClone(parsed.data));
}

const UNVERIFIED_PREFIX = "Unverified, no receipt exists: ";

/**
 * A model summary is lossy and can be wrong in the ways that matter most, so
 * the facts the host record proves override it: every call whose result never
 * arrived stays an unknown outcome even if the summary forgot it, completed
 * work may cite only receipts that exist, and work an earlier checkpoint proved
 * stays cited. A claim whose every cited receipt is absent is kept as an
 * unverified question, never as completed work.
 */
export function reconcileCheckpointContent(
  content: CheckpointContent,
  facts: AuthoritativeContextFacts,
  maximumBytes: number,
): Result<CheckpointContent, CheckpointErrorCode> {
  const receipts = new Set(facts.receipts);
  const completedWork: CheckpointContent["completedWork"][number][] = [];
  const unresolvedQuestions = [...content.unresolvedQuestions];
  for (const item of content.completedWork) {
    if (item.evidenceRefs.length === 0) {
      completedWork.push(item);
      continue;
    }
    const evidenceRefs = item.evidenceRefs.filter((ref) => receipts.has(ref));
    if (evidenceRefs.length > 0) {
      completedWork.push({ ...item, evidenceRefs });
    } else {
      unresolvedQuestions.push(
        `${UNVERIFIED_PREFIX}${item.description}`.slice(0, 4_096),
      );
    }
  }
  const cited = new Set(completedWork.flatMap((item) => item.evidenceRefs));
  for (const item of facts.carriedWork) {
    if (item.evidenceRefs.some((ref) => cited.has(ref))) continue;
    completedWork.push({
      description: item.description,
      evidenceRefs: [...item.evidenceRefs],
    });
    for (const ref of item.evidenceRefs) cited.add(ref);
  }
  const unknownOutcomes = [...content.unknownOutcomes];
  const known = new Set(unknownOutcomes.map((entry) => entry.operationRef));
  for (const entry of facts.unresolved) {
    if (known.has(entry.operationRef)) continue;
    known.add(entry.operationRef);
    unknownOutcomes.push({ ...entry });
  }
  return validateCheckpointContent(
    { ...content, completedWork, unresolvedQuestions, unknownOutcomes },
    maximumBytes,
  );
}

export function validateCheckpointEnvelope(
  candidate: unknown,
  maximumContentBytes: number,
): Result<CheckpointEnvelope, CheckpointErrorCode> {
  const parsed = checkpointEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return failure("CHECKPOINT_ENVELOPE_INVALID");
  const content = validateCheckpointContent(
    parsed.data.content,
    maximumContentBytes,
  );
  if (!content.ok) return content;
  if (
    parsed.data.provider.profileId !== parsed.data.binding.providerProfileId ||
    parsed.data.provider.modelId !== parsed.data.binding.modelId ||
    parsed.data.provider.mode !== parsed.data.binding.mode
  ) {
    return failure("CHECKPOINT_PROVIDER_BINDING_MISMATCH");
  }
  return success(
    structuredClone({
      ...parsed.data,
      content: content.value,
    }) as CheckpointEnvelope,
  );
}

export function createCheckpointEnvelope(
  session: ContextSession,
  content: CheckpointContent,
  metadata: Readonly<{
    checkpointId: string;
    providerOperationId: string;
    parentCheckpointId: string | null;
    sourceCursor: string;
    createdAt: number;
  }>,
): CheckpointEnvelope {
  const operation = session.operation;
  if (
    (session.phase !== "checkpoint_requested" &&
      session.phase !== "validated") ||
    operation === null
  ) {
    throw new Error("CHECKPOINT_SESSION_NOT_REQUESTED");
  }
  return {
    schemaVersion: 1,
    checkpointId: metadata.checkpointId,
    operationId: operation.operationId,
    providerOperationId: metadata.providerOperationId,
    binding: { ...session.binding },
    epoch: session.epoch,
    source: operation.source,
    sourceBoundary: operation.sourceBoundary,
    sourceCursor: metadata.sourceCursor,
    parentCheckpointId: metadata.parentCheckpointId,
    provider: {
      profileId: session.binding.providerProfileId,
      modelId: session.binding.modelId,
      mode: session.binding.mode,
    },
    createdAt: metadata.createdAt,
    validation: "validated",
    content: structuredClone(content),
  };
}
