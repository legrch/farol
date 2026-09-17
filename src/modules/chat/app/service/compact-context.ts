import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import type { Clock } from "../../../../pkg/kernel/app/clock";
import type { CheckpointStore } from "../port/checkpoint-store";
import type {
  ContextAdmissionLease,
  ContextRepository,
} from "../port/context-repository";
import type {
  ContextSummarizer,
  ContextSummaryReceipt,
  ContextSummaryRequest,
} from "../port/context-summarizer";
import type {
  HostContextBridge,
  HostContextReceipt,
} from "../port/host-context-bridge";
import type { ContextSourceControl } from "../port/context-source-control";
import {
  activateNextEpoch,
  beginCompaction,
  blockContext,
  confirmHostContext,
  createContextSession,
  markCheckpointStored,
  markContextOutcomeUnknown,
  markOldEpochRetired,
  markSummaryDispatchObserved,
  offerCheckpointHandoff,
  recordValidatedCheckpoint,
  requestCheckpoint,
  resumeSourceRetirementCleanup,
  restoreActiveBeforeSummaryDispatch,
  restoreStoredBeforeHostOffer,
  sameCompactionRequest,
  sameContextBinding,
  validCompactionRequest,
  validContextBinding,
  type CompactionRequest,
  type ContextBinding,
  type ContextSession,
} from "../../domain/context-continuity";
import {
  createCheckpointEnvelope,
  validateCheckpointContent,
  type CheckpointEnvelope,
} from "../../domain/checkpoint";

export type CompactContextCommand = CompactionRequest &
  Readonly<{ binding: ContextBinding }>;

export type CompactContextReceipt = Readonly<{
  session: ContextSession;
  checkpoint: CheckpointEnvelope | null;
}>;

export type CompactContextErrorCode =
  | "CONTEXT_ADMISSION_CONFLICT"
  | "CONTEXT_BINDING_CONFLICT"
  | "CONTEXT_OPERATION_IN_PROGRESS"
  | "CONTEXT_REPOSITORY_FAILED"
  | "CONTEXT_TRANSITION_FAILED"
  | "CHECKPOINT_STORE_FAILED"
  | "CHECKPOINT_MISSING";

export interface CheckpointIds {
  nextCheckpointId(): string;
}

function compactionRequest(command: CompactContextCommand): CompactionRequest {
  return {
    operationId: command.operationId,
    source: command.source,
    sourceBoundary: command.sourceBoundary,
  };
}

function checkpointMatchesValidatedSession(
  session: ContextSession,
  checkpoint: CheckpointEnvelope,
): boolean {
  const operation = session.operation;
  return (
    session.phase === "validated" &&
    operation !== null &&
    operation.checkpointId === checkpoint.checkpointId &&
    operation.operationId === checkpoint.operationId &&
    operation.source === checkpoint.source &&
    operation.sourceBoundary === checkpoint.sourceBoundary &&
    session.epoch === checkpoint.epoch &&
    session.lastCheckpointId === checkpoint.parentCheckpointId &&
    sameContextBinding(session.binding, checkpoint.binding)
  );
}

export class CompactContext {
  private readonly inFlight = new Map<
    string,
    Readonly<{
      command: CompactContextCommand;
      execution: Promise<
        Result<CompactContextReceipt, CompactContextErrorCode>
      >;
    }>
  >();

  constructor(
    private readonly summarizer: ContextSummarizer,
    private readonly sessions: ContextRepository,
    private readonly checkpoints: CheckpointStore,
    private readonly host: HostContextBridge,
    private readonly source: ContextSourceControl,
    private readonly clock: Clock,
    private readonly ids: CheckpointIds,
    private readonly maximumCheckpointBytes: number,
    private readonly onStatePersisted:
      ((session: ContextSession) => void | Promise<void>) | null = null,
  ) {}

  execute(
    command: CompactContextCommand,
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    const selected: CompactContextCommand = {
      binding: { ...command.binding },
      operationId: command.operationId,
      source: command.source,
      sourceBoundary: command.sourceBoundary,
    };
    if (
      !validContextBinding(selected.binding) ||
      !validCompactionRequest(selected)
    ) {
      return Promise.resolve(failure("CONTEXT_TRANSITION_FAILED"));
    }
    const key = JSON.stringify([
      selected.binding.ownerId,
      selected.binding.taskId,
      selected.binding.hostThreadId,
      selected.binding.sessionId,
    ]);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (!sameContextBinding(existing.command.binding, selected.binding)) {
        return Promise.resolve(failure("CONTEXT_BINDING_CONFLICT"));
      }
      if (!sameCompactionRequest(existing.command, selected)) {
        return Promise.resolve(failure("CONTEXT_ADMISSION_CONFLICT"));
      }
      return existing.execution;
    }
    const execution = this.executeOnce(selected).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, { command: selected, execution });
    return execution;
  }

  private async executeOnce(
    command: CompactContextCommand,
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    let session: ContextSession;
    try {
      session =
        (await this.sessions.load(command.binding)) ??
        createContextSession(command.binding);
    } catch {
      return failure("CONTEXT_REPOSITORY_FAILED");
    }
    if (!sameContextBinding(session.binding, command.binding)) {
      return failure("CONTEXT_BINDING_CONFLICT");
    }

    if (session.phase !== "active") {
      if (session.operation === null) {
        return failure("CONTEXT_TRANSITION_FAILED");
      }
      if (!sameCompactionRequest(session.operation, command)) {
        return failure("CONTEXT_ADMISSION_CONFLICT");
      }
    }

    if (session.phase === "active" && session.lastCompletedRequest) {
      if (!sameCompactionRequest(session.lastCompletedRequest, command)) {
        if (
          session.lastCompletedRequest.operationId === command.operationId ||
          (session.lastCompletedRequest.source === command.source &&
            session.lastCompletedRequest.sourceBoundary ===
              command.sourceBoundary)
        ) {
          return failure("CONTEXT_ADMISSION_CONFLICT");
        }
      } else {
        const checkpoint = await this.loadCheckpoint(
          session.binding,
          session.lastCheckpointId,
        );
        if (!checkpoint.ok) return checkpoint;
        return success({ session, checkpoint: checkpoint.value });
      }
    } else if (
      session.phase === "active" &&
      session.lastCompletedOperationId === command.operationId
    ) {
      return failure("CONTEXT_ADMISSION_CONFLICT");
    }

    const sourceEpoch = session.operation?.sourceEpoch ?? session.epoch;
    let admission;
    try {
      admission = await this.sessions.acquireCompactionAdmission(
        command.binding,
        sourceEpoch,
        compactionRequest(command),
      );
    } catch {
      return failure("CONTEXT_REPOSITORY_FAILED");
    }
    if (admission.status === "busy") {
      return failure("CONTEXT_OPERATION_IN_PROGRESS");
    }
    if (admission.status === "conflict") {
      return failure(
        admission.reason === "binding"
          ? "CONTEXT_BINDING_CONFLICT"
          : "CONTEXT_ADMISSION_CONFLICT",
      );
    }

    return this.executeAdmitted(command, session, admission.lease);
  }

  private async executeAdmitted(
    command: CompactContextCommand,
    initial: ContextSession,
    lease: ContextAdmissionLease,
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    let result: Result<CompactContextReceipt, CompactContextErrorCode>;
    try {
      result = await this.advance(command, initial);
    } catch (error) {
      try {
        await this.sessions.releaseCompactionAdmission(lease);
      } catch {
        // Keep the original unexpected failure; the durable lease fails closed.
      }
      throw error;
    }
    try {
      await this.sessions.releaseCompactionAdmission(lease);
    } catch {
      return failure("CONTEXT_REPOSITORY_FAILED");
    }
    return result;
  }

  private async advance(
    command: CompactContextCommand,
    initial: ContextSession,
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    let session = initial;
    let shouldStartSummary = false;
    if (session.phase === "active") {
      const started = beginCompaction(session, compactionRequest(command));
      if (!started.ok) return failure("CONTEXT_TRANSITION_FAILED");
      session = started.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
    }
    if (session.phase === "quiescing") {
      const requested = requestCheckpoint(session);
      if (!requested.ok) return failure("CONTEXT_TRANSITION_FAILED");
      session = requested.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
      shouldStartSummary = true;
    }

    if (session.phase === "checkpoint_requested") {
      const request = this.summaryRequest(session);
      if (!request) return failure("CONTEXT_TRANSITION_FAILED");
      let summary: ContextSummaryReceipt;
      try {
        summary = shouldStartSummary
          ? await this.summarizer.request(request)
          : await this.summarizer.observe(request);
      } catch {
        summary = {
          status: "outcome_unknown",
          code: "SUMMARY_OBSERVATION_FAILED",
        };
      }
      const handled = await this.handleSummary(session, summary);
      if (!handled.ok) return handled;
      session = handled.value.session;
      if (handled.value.checkpoint === null) return handled;
    }

    if (session.phase === "validated") {
      const checkpointId = session.operation?.checkpointId;
      if (!checkpointId) return failure("CONTEXT_TRANSITION_FAILED");
      let durableCheckpoint: CheckpointEnvelope | null;
      try {
        durableCheckpoint = await this.checkpoints.get(
          session.binding,
          checkpointId,
        );
      } catch {
        return failure("CHECKPOINT_STORE_FAILED");
      }
      if (durableCheckpoint) {
        if (!checkpointMatchesValidatedSession(session, durableCheckpoint)) {
          return failure("CHECKPOINT_STORE_FAILED");
        }
        const stored = markCheckpointStored(session);
        if (!stored.ok) return failure("CONTEXT_TRANSITION_FAILED");
        session = stored.value;
        if (!(await this.persist(session))) {
          return failure("CONTEXT_REPOSITORY_FAILED");
        }
      } else {
        const request = this.summaryRequest(session);
        if (!request) return failure("CONTEXT_TRANSITION_FAILED");
        let observed: ContextSummaryReceipt;
        try {
          observed = await this.summarizer.observe(request);
        } catch {
          return failure("CHECKPOINT_STORE_FAILED");
        }
        const handled = await this.handleSummary(session, observed);
        if (!handled.ok) return handled;
        session = handled.value.session;
        if (handled.value.checkpoint === null) return handled;
      }
    }

    return this.advanceHandoff(session);
  }

  private summaryRequest(
    session: ContextSession,
  ): ContextSummaryRequest | null {
    const operation = session.operation;
    if (!operation) return null;
    return {
      binding: { ...session.binding },
      epoch: session.epoch,
      operationId: operation.operationId,
      source: operation.source,
      sourceBoundary: operation.sourceBoundary,
      parentCheckpointId: session.lastCheckpointId,
      capability: {
        kind: "checkpoint_return",
        operationId: operation.operationId,
      },
      executionTools: [],
    };
  }

  private async handleSummary(
    current: ContextSession,
    receipt: ContextSummaryReceipt,
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    if (receipt.status === "not_submitted") {
      const restored = restoreActiveBeforeSummaryDispatch(current);
      if (!restored.ok) return failure("CONTEXT_TRANSITION_FAILED");
      if (!(await this.persist(restored.value))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
      return success({ session: restored.value, checkpoint: null });
    }

    let session = current;
    if (session.operation?.summaryDispatch === "not_observed") {
      const observed = markSummaryDispatchObserved(session);
      if (!observed.ok) return failure("CONTEXT_TRANSITION_FAILED");
      session = observed.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
    }
    if (receipt.status === "blocked") {
      return this.persistClassified(session, receipt.code, "blocked");
    }
    if (receipt.status === "outcome_unknown") {
      return this.persistClassified(session, receipt.code, "outcome_unknown");
    }

    const parsed = validateCheckpointContent(
      receipt.content,
      this.maximumCheckpointBytes,
    );
    if (!parsed.ok) {
      return this.persistClassified(session, parsed.error.code, "blocked");
    }
    const existingCheckpointId = session.operation?.checkpointId;
    const checkpoint = createCheckpointEnvelope(session, parsed.value, {
      checkpointId: existingCheckpointId ?? this.ids.nextCheckpointId(),
      providerOperationId: receipt.providerOperationId,
      parentCheckpointId: session.lastCheckpointId,
      sourceCursor: receipt.sourceCursor,
      createdAt: this.clock.now(),
    });
    if (session.phase === "checkpoint_requested") {
      const validated = recordValidatedCheckpoint(session, checkpoint);
      if (!validated.ok) return failure("CONTEXT_TRANSITION_FAILED");
      session = validated.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
    }
    try {
      await this.checkpoints.put(checkpoint);
    } catch {
      return failure("CHECKPOINT_STORE_FAILED");
    }
    const stored = markCheckpointStored(session);
    if (!stored.ok) return failure("CONTEXT_TRANSITION_FAILED");
    session = stored.value;
    if (!(await this.persist(session))) {
      return failure("CONTEXT_REPOSITORY_FAILED");
    }
    return success({ session, checkpoint });
  }

  private async persistClassified(
    session: ContextSession,
    code: string,
    classification: "blocked" | "outcome_unknown",
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    const result =
      classification === "blocked"
        ? blockContext(session, code)
        : markContextOutcomeUnknown(session, code);
    if (!result.ok) return failure("CONTEXT_TRANSITION_FAILED");
    if (!(await this.persist(result.value))) {
      return failure("CONTEXT_REPOSITORY_FAILED");
    }
    return success({ session: result.value, checkpoint: null });
  }

  private async advanceHandoff(
    current: ContextSession,
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    let session = current;
    if (session.phase === "blocked" || session.phase === "outcome_unknown") {
      const resumed = resumeSourceRetirementCleanup(session);
      if (!resumed.ok) return success({ session, checkpoint: null });
      session = resumed.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
    }
    if (session.phase === "durably_stored") {
      const checkpoint = await this.requiredCheckpoint(session);
      if (!checkpoint.ok) return checkpoint;
      const offered = offerCheckpointHandoff(session);
      if (!offered.ok) return failure("CONTEXT_TRANSITION_FAILED");
      session = offered.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
      let receipt: HostContextReceipt;
      try {
        receipt = await this.host.offer(checkpoint.value);
      } catch {
        receipt = { status: "outcome_unknown", code: "HOST_HANDOFF_UNKNOWN" };
      }
      const handled = await this.handleHostReceipt(
        session,
        checkpoint.value,
        receipt,
      );
      if (
        !handled.ok ||
        handled.value.session.phase !== "host_context_confirmed"
      ) {
        return handled;
      }
      session = handled.value.session;
    } else if (session.phase === "handoff_offered") {
      const checkpoint = await this.requiredCheckpoint(session);
      if (!checkpoint.ok) return checkpoint;
      let receipt: HostContextReceipt;
      try {
        receipt = await this.host.reconcile(checkpoint.value);
      } catch {
        receipt = { status: "outcome_unknown", code: "HOST_HANDOFF_UNKNOWN" };
      }
      if (receipt.status === "not_offered") {
        const restored = restoreStoredBeforeHostOffer(session);
        if (!restored.ok) return failure("CONTEXT_TRANSITION_FAILED");
        if (!(await this.persist(restored.value))) {
          return failure("CONTEXT_REPOSITORY_FAILED");
        }
        return this.advanceHandoff(restored.value);
      }
      const handled = await this.handleHostReceipt(
        session,
        checkpoint.value,
        receipt,
      );
      if (
        !handled.ok ||
        handled.value.session.phase !== "host_context_confirmed"
      ) {
        return handled;
      }
      session = handled.value.session;
    }

    if (session.phase === "host_context_confirmed") {
      const operation = session.operation;
      if (!operation) return failure("CONTEXT_TRANSITION_FAILED");
      const checkpoint = await this.requiredCheckpoint(session);
      if (!checkpoint.ok) return checkpoint;
      let retirement: Awaited<ReturnType<ContextSourceControl["retire"]>>;
      try {
        retirement = await this.source.retire({
          binding: session.binding,
          epoch: session.epoch,
          operationId: operation.operationId,
        });
      } catch {
        retirement = {
          status: "outcome_unknown",
          code: "SOURCE_RETIREMENT_UNKNOWN",
        };
      }
      if (retirement.status === "blocked") {
        return this.persistClassified(session, retirement.code, "blocked");
      }
      if (retirement.status === "outcome_unknown") {
        return this.persistClassified(
          session,
          retirement.code,
          "outcome_unknown",
        );
      }
      const retired = markOldEpochRetired(session);
      if (!retired.ok) return failure("CONTEXT_TRANSITION_FAILED");
      session = retired.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
      const activated = activateNextEpoch(session);
      if (!activated.ok) return failure("CONTEXT_TRANSITION_FAILED");
      session = activated.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
      return success({ session, checkpoint: checkpoint.value });
    }

    if (session.phase === "old_epoch_retired") {
      const activated = activateNextEpoch(session);
      if (!activated.ok) return failure("CONTEXT_TRANSITION_FAILED");
      session = activated.value;
      if (!(await this.persist(session))) {
        return failure("CONTEXT_REPOSITORY_FAILED");
      }
      const checkpoint = await this.loadCheckpoint(
        session.binding,
        session.lastCheckpointId,
      );
      if (!checkpoint.ok) return checkpoint;
      return success({ session, checkpoint: checkpoint.value });
    }
    return success({ session, checkpoint: null });
  }

  private async handleHostReceipt(
    session: ContextSession,
    checkpoint: CheckpointEnvelope,
    receipt: HostContextReceipt,
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    if (
      receipt.status === "awaiting_confirmation" ||
      receipt.status === "not_offered"
    ) {
      return success({ session, checkpoint });
    }
    if (receipt.status === "blocked") {
      return this.persistClassified(session, receipt.code, "blocked");
    }
    if (receipt.status === "outcome_unknown") {
      return this.persistClassified(session, receipt.code, "outcome_unknown");
    }
    const confirmed = confirmHostContext(session, receipt.hostContextRef);
    if (!confirmed.ok) return failure("CONTEXT_TRANSITION_FAILED");
    if (!(await this.persist(confirmed.value))) {
      return failure("CONTEXT_REPOSITORY_FAILED");
    }
    return success({ session: confirmed.value, checkpoint });
  }

  private async requiredCheckpoint(
    session: ContextSession,
  ): Promise<Result<CheckpointEnvelope, CompactContextErrorCode>> {
    return this.loadCheckpoint(
      session.binding,
      session.operation?.checkpointId ?? null,
    );
  }

  private async loadCheckpoint(
    binding: ContextBinding,
    checkpointId: string | null,
  ): Promise<Result<CheckpointEnvelope, CompactContextErrorCode>> {
    if (!checkpointId) return failure("CHECKPOINT_MISSING");
    try {
      const checkpoint = await this.checkpoints.get(binding, checkpointId);
      return checkpoint ? success(checkpoint) : failure("CHECKPOINT_MISSING");
    } catch {
      return failure("CHECKPOINT_STORE_FAILED");
    }
  }

  private async persist(session: ContextSession): Promise<boolean> {
    try {
      await this.sessions.save(session);
    } catch {
      return false;
    }
    try {
      await this.onStatePersisted?.(session);
    } catch {
      // The private session is already durable. Presentation failures are
      // observed by their owning adapter and cannot roll this transition back.
    }
    return true;
  }
}
