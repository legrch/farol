import type {
  CheckpointContent,
  CheckpointSummarizer,
} from "../../domain/checkpoint";
import type {
  ContextBinding,
  ContextSource,
} from "../../domain/context-continuity";

export type ContextSummaryRequest = Readonly<{
  binding: ContextBinding;
  epoch: number;
  operationId: string;
  source: ContextSource;
  sourceBoundary: string;
  parentCheckpointId: string | null;
  capability: Readonly<{
    kind: "checkpoint_return";
    operationId: string;
  }>;
  executionTools: readonly [];
}>;

export type ContextSummaryReceipt =
  | Readonly<{
      status: "completed";
      providerOperationId: string;
      sourceCursor: string;
      summarizer?: CheckpointSummarizer;
      content: unknown;
    }>
  | Readonly<{ status: "not_submitted"; code: string }>
  | Readonly<{ status: "blocked"; code: string }>
  | Readonly<{ status: "outcome_unknown"; code: string }>;

export interface ContextSummarizer {
  /** Starts the exact operation once. The operationId is the idempotency key. */
  request(request: ContextSummaryRequest): Promise<ContextSummaryReceipt>;
  /** Reconciles a persisted operation without creating a new provider request. */
  observe(request: ContextSummaryRequest): Promise<ContextSummaryReceipt>;
}

export type ValidContextSummaryReceipt = Extract<
  ContextSummaryReceipt,
  { status: "completed" }
> &
  Readonly<{ content: CheckpointContent }>;
