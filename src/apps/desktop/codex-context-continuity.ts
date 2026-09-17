import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { failure, success, type Result } from "../../pkg/kernel/domain/result";
import type {
  ContextSummaryReceipt,
  ContextSummaryRequest,
} from "../../modules/chat/app/port/context-summarizer";
import type {
  SourceRetirementReceipt,
  SourceRetirementRequest,
} from "../../modules/chat/app/port/context-source-control";
import { CompactContext } from "../../modules/chat/app/service/compact-context";
import type { CheckpointEnvelope } from "../../modules/chat/domain/checkpoint";
import {
  sameContextBinding,
  validContextBinding,
  type ContextBinding,
  type ContextSession,
  type ContextSource,
} from "../../modules/chat/domain/context-continuity";
import {
  buildHostCompactionHandoff,
  parseHostCompactionRequest,
  renderTrustedCheckpointContext,
  replayHostCheckpoint,
  type HostCompactionErrorCode,
  type HostCompactionHandoff,
  type ParsedHostCompaction,
} from "../../modules/chat/infra/client/host-compaction-codec";
import {
  PrivateContextStore,
  type StoredContextSource,
} from "../../modules/chat/infra/repo/private-context-store";
import type {
  CodexChatGptCompaction,
  CodexChatGptCompactionErrorCode,
} from "./codex-chatgpt-provider";

const preparedTurnSchema = z
  .object({
    model: z.string().min(1).max(160),
    input: z.array(z.unknown()),
    client_metadata: z
      .object({
        session_id: z.string().min(1).max(160),
        thread_id: z.string().min(1).max(160),
        turn_id: z.string().min(1).max(160),
      })
      .passthrough(),
  })
  .passthrough();

const MAXIMUM_CHECKPOINT_CONTENT_BYTES = 256 * 1_024;
const RETAINED_TAIL_MAXIMUM_BYTES = 64 * 1_024;
// This is a conservative encoded transport ceiling, not a token estimate.
// The ordinary provider separately enforces its complete 128 Ki-character
// prompt boundary when the checkpoint is consumed.
const MAXIMUM_HOST_HANDOFF_BYTES = 128 * 1_024;

export type CodexContextSummaryInput = Readonly<{
  request: ContextSummaryRequest;
  source: StoredContextSource;
}>;

export interface CodexContextSummaryDriver {
  selectSource(
    input: Readonly<{
      binding: ContextBinding;
      variant: ParsedHostCompaction["variant"];
      history: readonly unknown[];
    }>,
  ): Promise<ContextSource>;
  request(input: CodexContextSummaryInput): Promise<ContextSummaryReceipt>;
  observe(input: CodexContextSummaryInput): Promise<ContextSummaryReceipt>;
  retire(
    input: SourceRetirementRequest & Readonly<{ source: StoredContextSource }>,
  ): Promise<SourceRetirementReceipt>;
}

export type CodexContextContinuityOptions = Readonly<{
  ownerId: string;
  providerProfileId: string;
  store: PrivateContextStore;
  summary: CodexContextSummaryDriver;
  onStateChanged?: (session: ContextSession) => void | Promise<void>;
}>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationId(request: ParsedHostCompaction): string {
  return operationIdFor(
    request.identity.threadId,
    request.identity.turnId,
    request.sourceBoundary,
  );
}

function operationIdFor(
  threadId: string,
  turnId: string,
  sourceBoundary: string,
): string {
  return `compact-${hash([threadId, turnId, sourceBoundary]).slice(0, 40)}`;
}

function modeFromModel(model: string): string {
  const mode = model.split("/").at(-1);
  return mode && mode.length <= 160 ? mode : "default";
}

function bindingFor(
  request: ParsedHostCompaction,
  options: Pick<CodexContextContinuityOptions, "ownerId" | "providerProfileId">,
): ContextBinding {
  return {
    ownerId: options.ownerId,
    taskId: request.identity.threadId,
    hostThreadId: request.identity.threadId,
    sessionId: request.identity.threadId,
    providerProfileId: options.providerProfileId,
    modelId: request.identity.modelId,
    mode: modeFromModel(request.identity.modelId),
  };
}

function preparedBindingFor(
  request: z.infer<typeof preparedTurnSchema>,
  options: Pick<CodexContextContinuityOptions, "ownerId" | "providerProfileId">,
): ContextBinding {
  return {
    ownerId: options.ownerId,
    taskId: request.client_metadata.thread_id,
    hostThreadId: request.client_metadata.thread_id,
    sessionId: request.client_metadata.thread_id,
    providerProfileId: options.providerProfileId,
    modelId: request.model,
    mode: modeFromModel(request.model),
  };
}

function sameCheckpointEnvelope(
  left: CheckpointEnvelope,
  right: CheckpointEnvelope,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceMatchesRequest(
  source: StoredContextSource,
  parsed: ParsedHostCompaction,
): boolean {
  return (
    source.sourceBoundary === parsed.sourceBoundary &&
    source.variant === parsed.variant &&
    JSON.stringify(source.history) === JSON.stringify(parsed.history)
  );
}

function normalizeSessionFailure(
  session: ContextSession,
): CodexChatGptCompactionErrorCode | null {
  if (session.phase === "blocked") {
    if (session.blockedCode === "COMPACTION_BUDGET_EXCEEDED") {
      return "COMPACTION_BUDGET_EXCEEDED";
    }
    return "FAROL_NEXT_COMPACTION_SUMMARY_BLOCKED";
  }
  if (session.phase === "outcome_unknown") {
    return "FAROL_NEXT_COMPACTION_SUMMARY_OUTCOME_UNKNOWN";
  }
  return null;
}

export class CodexContextContinuity implements CodexChatGptCompaction {
  private readonly confirmations = new Map<string, string>();
  private readonly compactionRequests = new Map<string, ParsedHostCompaction>();
  private readonly handoffPreflights = new Map<
    string,
    Result<HostCompactionHandoff, HostCompactionErrorCode>
  >();
  private readonly service: CompactContext;

  constructor(private readonly options: CodexContextContinuityOptions) {
    if (
      !options.ownerId ||
      options.ownerId.length > 160 ||
      !options.providerProfileId ||
      options.providerProfileId.length > 160
    ) {
      throw new Error("CODEX_CONTEXT_CONTINUITY_OPTIONS_INVALID");
    }
    this.service = new CompactContext(
      {
        request: (request) => this.summarize("request", request),
        observe: (request) => this.summarize("observe", request),
      },
      options.store,
      options.store,
      {
        preflight: async (checkpoint) => {
          const request = this.compactionRequests.get(checkpoint.operationId);
          if (!request) {
            return {
              status: "blocked",
              code: "HOST_COMPACTION_REQUEST_INVALID",
            };
          }
          const handoff = buildHostCompactionHandoff(request, checkpoint, {
            maximumCheckpointContentBytes: MAXIMUM_CHECKPOINT_CONTENT_BYTES,
            retainedTailMaximumBytes: RETAINED_TAIL_MAXIMUM_BYTES,
            maximumHandoffBytes: MAXIMUM_HOST_HANDOFF_BYTES,
          });
          this.handoffPreflights.set(checkpoint.operationId, handoff);
          return handoff.ok
            ? { status: "ready" }
            : { status: "blocked", code: handoff.error.code };
        },
        offer: async () => ({ status: "awaiting_confirmation" }),
        reconcile: async (checkpoint) => {
          const hostContextRef = this.confirmations.get(
            checkpoint.checkpointId,
          );
          return hostContextRef
            ? { status: "confirmed", hostContextRef }
            : { status: "awaiting_confirmation" };
        },
      },
      {
        retire: (request) => this.retire(request),
      },
      { now: () => Date.now() },
      { nextCheckpointId: () => `checkpoint-${randomUUID()}` },
      MAXIMUM_CHECKPOINT_CONTENT_BYTES,
      options.onStateChanged ?? null,
    );
  }

  async compact(
    input: Parameters<CodexChatGptCompaction["compact"]>[0],
  ): Promise<Result<HostCompactionHandoff, CodexChatGptCompactionErrorCode>> {
    const parsed = parseHostCompactionRequest(
      input.endpoint,
      input.body,
      input.metadataHeader,
    );
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    const binding = bindingFor(request, this.options);
    const selectedOperationId = operationId(request);
    try {
      const session = await this.options.store.load(binding);
      if (
        session?.phase === "active" &&
        session.lastCompletedRequest?.operationId === selectedOperationId
      ) {
        const completed = session.lastCompletedRequest;
        if (completed.sourceBoundary !== request.sourceBoundary) {
          return failure("HOST_COMPACTION_SOURCE_MISMATCH");
        }
        const checkpoint = session.lastCheckpointId
          ? await this.options.store.get(binding, session.lastCheckpointId)
          : null;
        if (
          !checkpoint ||
          !sameContextBinding(checkpoint.binding, binding) ||
          checkpoint.operationId !== completed.operationId ||
          checkpoint.source !== completed.source ||
          checkpoint.sourceBoundary !== completed.sourceBoundary
        ) {
          return failure("HOST_CHECKPOINT_INVALID");
        }
        const replay = buildHostCompactionHandoff(request, checkpoint, {
          maximumCheckpointContentBytes: MAXIMUM_CHECKPOINT_CONTENT_BYTES,
          retainedTailMaximumBytes: RETAINED_TAIL_MAXIMUM_BYTES,
          maximumHandoffBytes: MAXIMUM_HOST_HANDOFF_BYTES,
        });
        return replay.ok ? replay : failure(replay.error.code);
      }
    } catch {
      return failure("FAROL_NEXT_COMPACTION_SOURCE_STORE_FAILED");
    }
    let source: StoredContextSource | null;
    try {
      source = await this.options.store.getSource(binding, selectedOperationId);
      if (!source) {
        const selected = await this.options.summary.selectSource({
          binding,
          variant: request.variant,
          history: [...structuredClone(request.history)],
        });
        const created: StoredContextSource = {
          schemaVersion: 1,
          operationId: selectedOperationId,
          binding,
          source: selected,
          sourceBoundary: request.sourceBoundary,
          variant: request.variant,
          history: [...structuredClone(request.history)],
        };
        await this.options.store.putSource(created);
        source = created;
      }
    } catch {
      return failure("FAROL_NEXT_COMPACTION_SOURCE_STORE_FAILED");
    }
    if (!source) {
      return failure("FAROL_NEXT_COMPACTION_SOURCE_UNAVAILABLE");
    }
    if (!sourceMatchesRequest(source, request)) {
      return failure("HOST_COMPACTION_SOURCE_MISMATCH");
    }

    this.compactionRequests.set(selectedOperationId, request);
    this.handoffPreflights.delete(selectedOperationId);
    let compacted;
    try {
      compacted = await this.service.execute({
        binding,
        operationId: selectedOperationId,
        source: source.source,
        sourceBoundary: source.sourceBoundary,
      });
    } finally {
      this.compactionRequests.delete(selectedOperationId);
    }
    const preflight = this.handoffPreflights.get(selectedOperationId);
    this.handoffPreflights.delete(selectedOperationId);
    if (!compacted.ok) {
      return failure("FAROL_NEXT_COMPACTION_STATE_FAILED");
    }
    const classified = normalizeSessionFailure(compacted.value.session);
    if (classified) {
      return preflight && !preflight.ok
        ? failure(preflight.error.code)
        : failure(classified);
    }
    if (!compacted.value.checkpoint) {
      return failure("HOST_CHECKPOINT_NOT_FOUND");
    }
    const handoff =
      preflight ??
      buildHostCompactionHandoff(request, compacted.value.checkpoint, {
        maximumCheckpointContentBytes: MAXIMUM_CHECKPOINT_CONTENT_BYTES,
        retainedTailMaximumBytes: RETAINED_TAIL_MAXIMUM_BYTES,
        maximumHandoffBytes: MAXIMUM_HOST_HANDOFF_BYTES,
      });
    return handoff.ok ? handoff : failure(handoff.error.code);
  }

  async prepareTurn(
    input: Parameters<NonNullable<CodexChatGptCompaction["prepareTurn"]>>[0],
  ): Promise<
    Result<
      Readonly<{ trustedContext: string | null }>,
      CodexChatGptCompactionErrorCode
    >
  > {
    const parsed = preparedTurnSchema.safeParse(input.body);
    if (!parsed.success) {
      return failure("HOST_COMPACTION_REQUEST_INVALID");
    }
    const binding = preparedBindingFor(parsed.data, this.options);
    const replayed = replayHostCheckpoint(
      parsed.data.input,
      MAXIMUM_CHECKPOINT_CONTENT_BYTES,
    );
    if (!replayed.ok) {
      if (replayed.error.code !== "HOST_CHECKPOINT_NOT_FOUND") {
        return failure(replayed.error.code);
      }
      let session: ContextSession | null;
      try {
        session = await this.options.store.load(binding);
      } catch {
        return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
      }
      if (!session) return success({ trustedContext: null });
      if (!sameContextBinding(session.binding, binding)) {
        return failure("HOST_COMPACTION_BINDING_MISMATCH");
      }
      const classified = normalizeSessionFailure(session);
      if (classified) return failure(classified);
      return session.phase === "active"
        ? success({ trustedContext: null })
        : failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    const transportedCheckpoint = replayed.value.checkpoint;
    if (!sameContextBinding(transportedCheckpoint.binding, binding)) {
      return failure("HOST_COMPACTION_BINDING_MISMATCH");
    }
    let session: ContextSession | null;
    let checkpoint: CheckpointEnvelope | null;
    let source: StoredContextSource | null;
    try {
      session = await this.options.store.load(binding);
      checkpoint = await this.options.store.get(
        binding,
        transportedCheckpoint.checkpointId,
      );
      source = await this.options.store.getSource(
        binding,
        transportedCheckpoint.operationId,
      );
    } catch {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    if (
      !session ||
      !sameContextBinding(session.binding, binding) ||
      session.phase !== "handoff_offered" ||
      session.operation?.checkpointId !== transportedCheckpoint.checkpointId ||
      session.operation.operationId !== transportedCheckpoint.operationId ||
      !checkpoint ||
      !sameCheckpointEnvelope(checkpoint, transportedCheckpoint) ||
      !source ||
      !sameContextBinding(source.binding, binding) ||
      source.operationId !== checkpoint.operationId ||
      source.source !== checkpoint.source ||
      source.sourceBoundary !== checkpoint.sourceBoundary ||
      source.variant !== replayed.value.origin
    ) {
      return failure("HOST_CHECKPOINT_INVALID");
    }
    const hostContextRef = `host-${hash([
      parsed.data.client_metadata.thread_id,
      parsed.data.client_metadata.turn_id,
      checkpoint.checkpointId,
    ]).slice(0, 40)}`;
    this.confirmations.set(checkpoint.checkpointId, hostContextRef);
    const compacted = await this.service.execute({
      binding: checkpoint.binding,
      operationId: checkpoint.operationId,
      source: checkpoint.source,
      sourceBoundary: checkpoint.sourceBoundary,
    });
    if (!compacted.ok) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    const classified = normalizeSessionFailure(compacted.value.session);
    if (classified) return failure(classified);
    if (
      compacted.value.session.phase !== "active" ||
      compacted.value.session.lastCompletedOperationId !==
        checkpoint.operationId
    ) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    try {
      await this.options.store.deleteSource(
        checkpoint.binding,
        checkpoint.operationId,
      );
    } catch {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    this.confirmations.delete(checkpoint.checkpointId);
    return success({
      trustedContext: renderTrustedCheckpointContext(checkpoint),
    });
  }

  async confirmHostCompaction(
    input: Readonly<{
      modelId: string;
      threadId: string;
      turnId: string;
      itemId: string | null;
      signal: "turn_completed" | "thread_compacted";
    }>,
  ): Promise<Result<ContextSession, CodexChatGptCompactionErrorCode>> {
    const binding: ContextBinding = {
      ownerId: this.options.ownerId,
      taskId: input.threadId,
      hostThreadId: input.threadId,
      sessionId: input.threadId,
      providerProfileId: this.options.providerProfileId,
      modelId: input.modelId,
      mode: modeFromModel(input.modelId),
    };
    if (
      !validContextBinding(binding) ||
      input.turnId.length < 1 ||
      input.turnId.length > 160 ||
      (input.signal === "turn_completed" && input.itemId === null) ||
      (input.itemId !== null &&
        (input.itemId.length < 1 || input.itemId.length > 160))
    ) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }

    let session: ContextSession | null;
    try {
      session = await this.options.store.load(binding);
    } catch {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    if (!session || !sameContextBinding(session.binding, binding)) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    const request = session.operation ?? session.lastCompletedRequest;
    if (
      !request ||
      operationIdFor(input.threadId, input.turnId, request.sourceBoundary) !==
        request.operationId
    ) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    const checkpointId =
      session.operation?.checkpointId ?? session.lastCheckpointId;
    if (!checkpointId) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    let checkpoint;
    try {
      checkpoint = await this.options.store.get(binding, checkpointId);
    } catch {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    if (
      !checkpoint ||
      !sameContextBinding(checkpoint.binding, binding) ||
      checkpoint.operationId !== request.operationId ||
      checkpoint.sourceBoundary !== request.sourceBoundary
    ) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    if (
      session.phase === "active" &&
      session.lastCompletedOperationId === request.operationId
    ) {
      try {
        await this.options.store.deleteSource(binding, request.operationId);
      } catch {
        return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
      }
      this.confirmations.delete(checkpoint.checkpointId);
      return success(session);
    }
    if (!session.operation) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }

    const hostContextRef = `host-${hash([
      input.threadId,
      input.turnId,
      input.itemId,
      input.signal,
      checkpoint.checkpointId,
    ]).slice(0, 40)}`;
    this.confirmations.set(checkpoint.checkpointId, hostContextRef);
    const compacted = await this.service.execute({
      binding,
      operationId: session.operation.operationId,
      source: session.operation.source,
      sourceBoundary: session.operation.sourceBoundary,
    });
    if (
      !compacted.ok ||
      compacted.value.session.phase !== "active" ||
      compacted.value.session.lastCompletedOperationId !== request.operationId
    ) {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    try {
      await this.options.store.deleteSource(binding, request.operationId);
    } catch {
      return failure("FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED");
    }
    this.confirmations.delete(checkpoint.checkpointId);
    return success(compacted.value.session);
  }

  private async summarize(
    method: "request" | "observe",
    request: ContextSummaryRequest,
  ): Promise<ContextSummaryReceipt> {
    let source: StoredContextSource | null;
    try {
      source = await this.options.store.getSource(
        request.binding,
        request.operationId,
      );
    } catch {
      return { status: "blocked", code: "CONTEXT_SOURCE_UNAVAILABLE" };
    }
    if (
      !source ||
      source.source !== request.source ||
      source.sourceBoundary !== request.sourceBoundary
    ) {
      return { status: "blocked", code: "CONTEXT_SOURCE_UNAVAILABLE" };
    }
    try {
      return await this.options.summary[method]({ request, source });
    } catch {
      return {
        status: "outcome_unknown",
        code: "SUMMARY_SUBMISSION_UNRESOLVED",
      };
    }
  }

  private async retire(
    request: SourceRetirementRequest,
  ): Promise<SourceRetirementReceipt> {
    let source: StoredContextSource | null;
    try {
      source = await this.options.store.getSource(
        request.binding,
        request.operationId,
      );
    } catch {
      return { status: "blocked", code: "CONTEXT_SOURCE_UNAVAILABLE" };
    }
    if (!source) {
      return { status: "blocked", code: "CONTEXT_SOURCE_UNAVAILABLE" };
    }
    try {
      return await this.options.summary.retire({ ...request, source });
    } catch {
      return { status: "outcome_unknown", code: "SOURCE_RETIREMENT_UNKNOWN" };
    }
  }
}

export type { HostCompactionErrorCode };
