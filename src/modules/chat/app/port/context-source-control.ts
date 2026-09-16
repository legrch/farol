import type { ContextBinding } from "../../domain/context-continuity";

export type SourceRetirementRequest = Readonly<{
  binding: ContextBinding;
  epoch: number;
  operationId: string;
}>;

export type SourceRetirementReceipt =
  | Readonly<{ status: "retired" }>
  | Readonly<{ status: "blocked"; code: string }>
  | Readonly<{ status: "outcome_unknown"; code: string }>;

export interface ContextSourceControl {
  retire(request: SourceRetirementRequest): Promise<SourceRetirementReceipt>;
}
