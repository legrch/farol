// The durable record written about one summary submission. The `possible_send`
// record is written before the prompt can reach the conversation; this module
// only shapes it, and the driver decides when it is written.

export type AttemptScope<Binding, Source> = Readonly<{
  binding: Binding;
  operationId: string;
  source: Readonly<{ source: Source; sourceBoundary: string }>;
}>;

export type AttemptCorrelation = Readonly<{
  turnUserId?: string | null;
  turnAssistantId?: string | null;
}>;

export function summaryAttemptRecord<
  Binding extends object,
  Source,
  Phase extends string,
>(
  scope: AttemptScope<Binding, Source>,
  phase: Phase,
  conversationUrl: string | null,
  correlation: AttemptCorrelation = {},
) {
  return {
    schemaVersion: 1 as const,
    operationId: scope.operationId,
    binding: { ...scope.binding },
    source: scope.source.source,
    sourceBoundary: scope.source.sourceBoundary,
    phase,
    conversationUrl,
    turnUserId: correlation.turnUserId ?? null,
    turnAssistantId: correlation.turnAssistantId ?? null,
  };
}
