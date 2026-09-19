import {
  failure,
  success,
  type Result,
} from "../../../pkg/kernel/domain/result";

export type ContextSource = "retained_agent" | "canonical_history";

export type ContextBinding = Readonly<{
  ownerId: string;
  taskId: string;
  hostThreadId: string;
  sessionId: string;
  providerProfileId: string;
  modelId: string;
  mode: string;
}>;

export type ContextPhase =
  | "active"
  | "quiescing"
  | "checkpoint_requested"
  | "validated"
  | "durably_stored"
  | "handoff_offered"
  | "host_context_confirmed"
  | "old_epoch_retired"
  | "blocked"
  | "outcome_unknown";

export type SummaryDispatch = "not_observed" | "observed" | "result_received";

export type ContextOperation = Readonly<{
  operationId: string;
  source: ContextSource;
  sourceBoundary: string;
  sourceEpoch: number;
  summaryDispatch: SummaryDispatch;
  checkpointId: string | null;
  hostContextRef: string | null;
}>;

export type ContextSession = Readonly<{
  binding: ContextBinding;
  epoch: number;
  phase: ContextPhase;
  operation: ContextOperation | null;
  lastCheckpointId: string | null;
  lastCompletedOperationId: string | null;
  lastCompletedRequest: CompactionRequest | null;
  blockedCode: string | null;
}>;

export type ContextErrorCode =
  | "CONTEXT_OPERATION_INVALID"
  | "CONTEXT_OPERATION_CONFLICT"
  | "CONTEXT_OPERATION_IN_PROGRESS"
  | "CONTEXT_INVALID_TRANSITION"
  | "CHECKPOINT_BINDING_MISMATCH"
  | "CHECKPOINT_OPERATION_MISMATCH"
  | "CHECKPOINT_SOURCE_MISMATCH"
  | "CHECKPOINT_STALE_EPOCH";

export type CompactionRequest = Readonly<{
  operationId: string;
  source: ContextSource;
  sourceBoundary: string;
}>;

export type ValidatedCheckpointIdentity = Readonly<{
  checkpointId: string;
  operationId: string;
  binding: ContextBinding;
  epoch: number;
  source: ContextSource;
  sourceBoundary: string;
}>;

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 160;
}

export function sameContextBinding(
  left: ContextBinding,
  right: ContextBinding,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.taskId === right.taskId &&
    left.hostThreadId === right.hostThreadId &&
    left.sessionId === right.sessionId &&
    left.providerProfileId === right.providerProfileId &&
    left.modelId === right.modelId &&
    left.mode === right.mode
  );
}

export function sameContextSessionIdentity(
  left: ContextBinding,
  right: ContextBinding,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.taskId === right.taskId &&
    left.hostThreadId === right.hostThreadId &&
    left.sessionId === right.sessionId
  );
}

export function validContextBinding(binding: ContextBinding): boolean {
  return (
    validIdentity(binding.ownerId) &&
    validIdentity(binding.taskId) &&
    validIdentity(binding.hostThreadId) &&
    validIdentity(binding.sessionId) &&
    validIdentity(binding.providerProfileId) &&
    validIdentity(binding.modelId) &&
    validIdentity(binding.mode)
  );
}

export function validCompactionRequest(request: CompactionRequest): boolean {
  return (
    validIdentity(request.operationId) &&
    validIdentity(request.sourceBoundary) &&
    (request.source === "retained_agent" ||
      request.source === "canonical_history")
  );
}

export function sameCompactionRequest(
  left: CompactionRequest,
  right: CompactionRequest,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.source === right.source &&
    left.sourceBoundary === right.sourceBoundary
  );
}

export function createContextSession(binding: ContextBinding): ContextSession {
  return {
    binding: { ...binding },
    epoch: 1,
    phase: "active",
    operation: null,
    lastCheckpointId: null,
    lastCompletedOperationId: null,
    lastCompletedRequest: null,
    blockedCode: null,
  };
}

function sameOperation(
  operation: ContextOperation,
  request: CompactionRequest,
): boolean {
  return sameCompactionRequest(operation, request);
}

export function beginCompaction(
  session: ContextSession,
  request: CompactionRequest,
): Result<ContextSession, ContextErrorCode> {
  if (!validCompactionRequest(request)) {
    return failure("CONTEXT_OPERATION_INVALID");
  }
  if (session.operation) {
    return sameOperation(session.operation, request)
      ? success(session)
      : failure("CONTEXT_OPERATION_IN_PROGRESS");
  }
  if (session.phase !== "active") {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  if (session.lastCompletedRequest) {
    if (sameCompactionRequest(session.lastCompletedRequest, request)) {
      return success(session);
    }
    if (
      session.lastCompletedRequest.operationId === request.operationId ||
      (session.lastCompletedRequest.source === request.source &&
        session.lastCompletedRequest.sourceBoundary === request.sourceBoundary)
    ) {
      return failure("CONTEXT_OPERATION_CONFLICT");
    }
  } else if (session.lastCompletedOperationId === request.operationId) {
    return failure("CONTEXT_OPERATION_CONFLICT");
  }
  return success({
    ...session,
    phase: "quiescing",
    operation: {
      ...request,
      sourceEpoch: session.epoch,
      summaryDispatch: "not_observed",
      checkpointId: null,
      hostContextRef: null,
    },
  });
}

function transition(
  session: ContextSession,
  expected: ContextPhase,
  next: ContextPhase,
): Result<ContextSession, ContextErrorCode> {
  if (session.phase !== expected || session.operation === null) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({ ...session, phase: next });
}

export function requestCheckpoint(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  return transition(session, "quiescing", "checkpoint_requested");
}

export function restoreActiveBeforeSummaryDispatch(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  if (
    session.phase !== "checkpoint_requested" ||
    session.operation === null ||
    session.operation.summaryDispatch !== "not_observed"
  ) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({
    ...session,
    phase: "active",
    operation: null,
    blockedCode: null,
  });
}

export function markSummaryDispatchObserved(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  if (session.phase !== "checkpoint_requested" || session.operation === null) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  if (session.operation.summaryDispatch === "observed") {
    return success(session);
  }
  if (session.operation.summaryDispatch !== "not_observed") {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({
    ...session,
    operation: { ...session.operation, summaryDispatch: "observed" },
  });
}

export function recordValidatedCheckpoint(
  session: ContextSession,
  checkpoint: ValidatedCheckpointIdentity,
): Result<ContextSession, ContextErrorCode> {
  const operation = session.operation;
  if (session.phase !== "checkpoint_requested" || operation === null) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  if (!sameContextBinding(session.binding, checkpoint.binding)) {
    return failure("CHECKPOINT_BINDING_MISMATCH");
  }
  if (checkpoint.epoch !== session.epoch) {
    return failure("CHECKPOINT_STALE_EPOCH");
  }
  if (checkpoint.operationId !== operation.operationId) {
    return failure("CHECKPOINT_OPERATION_MISMATCH");
  }
  if (
    checkpoint.source !== operation.source ||
    checkpoint.sourceBoundary !== operation.sourceBoundary
  ) {
    return failure("CHECKPOINT_SOURCE_MISMATCH");
  }
  return success({
    ...session,
    phase: "validated",
    operation: {
      ...operation,
      summaryDispatch: "result_received",
      checkpointId: checkpoint.checkpointId,
    },
  });
}

export function markCheckpointStored(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  return transition(session, "validated", "durably_stored");
}

export function offerCheckpointHandoff(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  return transition(session, "durably_stored", "handoff_offered");
}

export function restoreStoredBeforeHostOffer(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  if (session.phase !== "handoff_offered" || session.operation === null) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({ ...session, phase: "durably_stored" });
}

export function confirmHostContext(
  session: ContextSession,
  hostContextRef: string,
): Result<ContextSession, ContextErrorCode> {
  if (
    session.phase !== "handoff_offered" ||
    session.operation === null ||
    !validIdentity(hostContextRef)
  ) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({
    ...session,
    phase: "host_context_confirmed",
    operation: { ...session.operation, hostContextRef },
  });
}

export function markOldEpochRetired(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  return transition(session, "host_context_confirmed", "old_epoch_retired");
}

export function activateNextEpoch(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  const operation = session.operation;
  if (
    session.phase !== "old_epoch_retired" ||
    operation === null ||
    operation.checkpointId === null ||
    operation.hostContextRef === null
  ) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({
    ...session,
    epoch: session.epoch + 1,
    phase: "active",
    operation: null,
    lastCheckpointId: operation.checkpointId,
    lastCompletedOperationId: operation.operationId,
    lastCompletedRequest: {
      operationId: operation.operationId,
      source: operation.source,
      sourceBoundary: operation.sourceBoundary,
    },
    blockedCode: null,
  });
}

export function blockContext(
  session: ContextSession,
  code: string,
): Result<ContextSession, ContextErrorCode> {
  if (session.phase === "active" || session.operation === null || !code) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({ ...session, phase: "blocked", blockedCode: code });
}

export function markContextOutcomeUnknown(
  session: ContextSession,
  code: string,
): Result<ContextSession, ContextErrorCode> {
  if (
    session.phase === "active" ||
    session.operation === null ||
    session.operation.summaryDispatch === "not_observed" ||
    !code
  ) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({
    ...session,
    phase: "outcome_unknown",
    blockedCode: code,
  });
}

export function resumeSourceRetirementCleanup(
  session: ContextSession,
): Result<ContextSession, ContextErrorCode> {
  if (
    (session.phase !== "blocked" && session.phase !== "outcome_unknown") ||
    session.operation === null ||
    session.operation.checkpointId === null ||
    session.operation.hostContextRef === null ||
    (session.blockedCode !== "SOURCE_RETIREMENT_UNKNOWN" &&
      session.blockedCode !== "SOURCE_RETIREMENT_SUPERSEDED" &&
      session.blockedCode !== "CONTEXT_SUMMARY_CLEANUP_FAILED" &&
      session.blockedCode !== "CONTEXT_RETIREMENT_STORE_FAILED")
  ) {
    return failure("CONTEXT_INVALID_TRANSITION");
  }
  return success({
    ...session,
    phase: "host_context_confirmed",
    blockedCode: null,
  });
}
