import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import type { Clock } from "../../../../pkg/kernel/app/clock";
import type { CheckpointStore } from "../port/checkpoint-store";
import type { ContextRepository } from "../port/context-repository";
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
  restoreActiveBeforeSummaryDispatch,
  restoreStoredBeforeHostOffer,
  sameContextBinding,
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
  | "CONTEXT_REPOSITORY_FAILED"
  | "CONTEXT_TRANSITION_FAILED"
  | "CHECKPOINT_STORE_FAILED"
  | "CHECKPOINT_MISSING";

export interface CheckpointIds {
  nextCheckpointId(): string;
}

export class CompactContext {
  private readonly inFlight = new Map<
    string,
    Promise<Result<CompactContextReceipt, CompactContextErrorCode>>
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
  ) {}

  execute(
    command: CompactContextCommand,
  ): Promise<Result<CompactContextReceipt, CompactContextErrorCode>> {
    const key = JSON.stringify([
      command.binding.ownerId,
      command.binding.taskId,
      command.binding.sessionId,
      command.operationId,
    ]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const execution = this.executeOnce(command).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, execution);
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
      return failure("CONTEXT_REPOSITORY_FAILED");
    }

    if (
      session.phase === "active" &&
      session.lastCompletedOperationId === command.operationId
    ) {
      const checkpoint = await this.loadCheckpoint(
        session.binding,
        session.lastCheckpointId,
      );
      if (!checkpoint.ok) return checkpoint;
      return success({ session, checkpoint: checkpoint.value });
    }

    let shouldStartSummary = false;
    if (session.phase === "active") {
      const started = beginCompaction(session, command);
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
      return success({ session, checkpoint: null });
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
      return true;
    } catch {
      return false;
    }
  }
}
