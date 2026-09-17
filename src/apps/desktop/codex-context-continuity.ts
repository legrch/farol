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
import type {
  ContextBinding,
  ContextSession,
  ContextSource,
} from "../../modules/chat/domain/context-continuity";
import {
  buildHostCompactionHandoff,
  parseHostCompactionRequest,
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
  return `compact-${hash([
    request.identity.threadId,
    request.identity.turnId,
    request.sourceBoundary,
  ]).slice(0, 40)}`;
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
    return "FAROL_NEXT_COMPACTION_SUMMARY_BLOCKED";
  }
  if (session.phase === "outcome_unknown") {
    return "FAROL_NEXT_COMPACTION_SUMMARY_OUTCOME_UNKNOWN";
  }
  return null;
}

export class CodexContextContinuity implements CodexChatGptCompaction {
  private readonly confirmations = new Map<string, string>();
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

    const compacted = await this.service.execute({
      binding,
      operationId: selectedOperationId,
      source: source.source,
      sourceBoundary: source.sourceBoundary,
    });
    if (!compacted.ok) {
      return failure("FAROL_NEXT_COMPACTION_STATE_FAILED");
    }
    await this.options.onStateChanged?.(compacted.value.session);
    const classified = normalizeSessionFailure(compacted.value.session);
    if (classified) return failure(classified);
    if (!compacted.value.checkpoint) {
      return failure("HOST_CHECKPOINT_NOT_FOUND");
    }
    const handoff = buildHostCompactionHandoff(
      request,
      compacted.value.checkpoint,
      {
        maximumCheckpointContentBytes: MAXIMUM_CHECKPOINT_CONTENT_BYTES,
        retainedTailMaximumBytes: RETAINED_TAIL_MAXIMUM_BYTES,
      },
    );
    return handoff.ok ? handoff : failure(handoff.error.code);
  }

  async prepareTurn(
    input: Parameters<NonNullable<CodexChatGptCompaction["prepareTurn"]>>[0],
  ): Promise<Result<null, CodexChatGptCompactionErrorCode>> {
    const parsed = preparedTurnSchema.safeParse(input.body);
    if (!parsed.success) {
      return failure("HOST_COMPACTION_REQUEST_INVALID");
    }
    const replayed = replayHostCheckpoint(
      parsed.data.input,
      MAXIMUM_CHECKPOINT_CONTENT_BYTES,
    );
    if (!replayed.ok) {
      return replayed.error.code === "HOST_CHECKPOINT_NOT_FOUND"
        ? success(null)
        : failure(replayed.error.code);
    }
    const checkpoint = replayed.value.checkpoint;
    if (
      checkpoint.binding.hostThreadId !==
        parsed.data.client_metadata.thread_id ||
      checkpoint.binding.modelId !== parsed.data.model
    ) {
      return failure("HOST_COMPACTION_BINDING_MISMATCH");
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
    await this.options.onStateChanged?.(compacted.value.session);
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
    return success(null);
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
