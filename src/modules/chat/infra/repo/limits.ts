import { positiveInteger } from "./integrity";
import {
  DEFAULT_CHECKPOINT_CONTENT_BYTES,
  DEFAULT_CHECKPOINT_RECORD_BYTES,
  DEFAULT_RETENTION,
  DEFAULT_SESSION_BYTES,
  DEFAULT_SOURCE_RECORD_BYTES,
  DEFAULT_SUMMARY_ATTEMPT_RECORD_BYTES,
  DEFAULT_SUMMARY_RECORD_BYTES,
  MAXIMUM_PUBLICATION_RECORD_BYTES,
  type ContextPublicationPolicy,
} from "./records";

// Budgets and process identity of the private context store: defaults, their
// validation order and the policy a publication is bound to. Pure; nothing
// here touches the filesystem.

export type ContextLimits = Readonly<{
  maximumSessionBytes: number;
  maximumCheckpointContentBytes: number;
  maximumCheckpointRecordBytes: number;
  maximumSourceRecordBytes: number;
  maximumSummaryRecordBytes: number;
  maximumSummaryAttemptRecordBytes: number;
  maxCheckpointsPerTask: number;
}>;

// Each budget is validated in this order, so the first bad one names the error.
export function resolveLimits(options: Partial<ContextLimits>): ContextLimits {
  const maximumSessionBytes = positiveInteger(
    options.maximumSessionBytes ?? DEFAULT_SESSION_BYTES,
    "CONTEXT_SESSION_BUDGET_INVALID",
  );
  const maximumCheckpointContentBytes = positiveInteger(
    options.maximumCheckpointContentBytes ?? DEFAULT_CHECKPOINT_CONTENT_BYTES,
    "CHECKPOINT_CONTENT_BUDGET_INVALID",
  );
  const maximumCheckpointRecordBytes = positiveInteger(
    options.maximumCheckpointRecordBytes ?? DEFAULT_CHECKPOINT_RECORD_BYTES,
    "CHECKPOINT_RECORD_BUDGET_INVALID",
  );
  const maximumSourceRecordBytes = positiveInteger(
    options.maximumSourceRecordBytes ?? DEFAULT_SOURCE_RECORD_BYTES,
    "CONTEXT_SOURCE_BUDGET_INVALID",
  );
  const maximumSummaryRecordBytes = positiveInteger(
    options.maximumSummaryRecordBytes ?? DEFAULT_SUMMARY_RECORD_BYTES,
    "CONTEXT_SUMMARY_BUDGET_INVALID",
  );
  const maximumSummaryAttemptRecordBytes = positiveInteger(
    options.maximumSummaryAttemptRecordBytes ??
      DEFAULT_SUMMARY_ATTEMPT_RECORD_BYTES,
    "CONTEXT_SUMMARY_ATTEMPT_BUDGET_INVALID",
  );
  const maxCheckpointsPerTask = positiveInteger(
    options.maxCheckpointsPerTask ?? DEFAULT_RETENTION,
    "CHECKPOINT_RETENTION_INVALID",
  );
  return {
    maximumSessionBytes,
    maximumCheckpointContentBytes,
    maximumCheckpointRecordBytes,
    maximumSourceRecordBytes,
    maximumSummaryRecordBytes,
    maximumSummaryAttemptRecordBytes,
    maxCheckpointsPerTask,
  };
}

export function resolveProcessIdentity(
  hooks: Readonly<{ processId?: number; processInstanceId?: string }>,
  currentProcessId: number,
  defaultInstanceId: string,
): Readonly<{ processId: number; processInstanceId: string }> {
  const processId = positiveInteger(
    hooks.processId ?? currentProcessId,
    "CONTEXT_PROCESS_ID_INVALID",
  );
  const processInstanceId = hooks.processInstanceId ?? defaultInstanceId;
  if (!/^[a-f0-9]{32}$/u.test(processInstanceId)) {
    throw new Error("CONTEXT_PROCESS_INSTANCE_ID_INVALID");
  }
  return { processId, processInstanceId };
}

export function publicationPolicy(
  limits: ContextLimits,
): ContextPublicationPolicy {
  return Object.freeze({
    schemaVersion: 1,
    maximumSessionBytes: limits.maximumSessionBytes,
    maximumCheckpointContentBytes: limits.maximumCheckpointContentBytes,
    maximumCheckpointRecordBytes: limits.maximumCheckpointRecordBytes,
    maximumSourceRecordBytes: limits.maximumSourceRecordBytes,
    maximumSummaryRecordBytes: limits.maximumSummaryRecordBytes,
    maximumSummaryAttemptRecordBytes: limits.maximumSummaryAttemptRecordBytes,
    maxCheckpointsPerTask: limits.maxCheckpointsPerTask,
    maximumPublicationRecordBytes: MAXIMUM_PUBLICATION_RECORD_BYTES,
  });
}
