// The completed receipt of a summary: the stored summary and the operation's
// source boundary, shaped for the summarizer port. The route alias is not
// observed browser model or effort evidence, so both stay null.

export function completedSummaryReceipt(
  summary: Readonly<{
    providerOperationId: string;
    sourceCursor: string;
    content: unknown;
  }>,
  sourceBoundary: string,
) {
  return {
    status: "completed" as const,
    providerOperationId: summary.providerOperationId,
    sourceCursor: summary.sourceCursor,
    content: summary.content,
    summarizer: {
      engine: "current_chatgpt" as const,
      provider: "chatgpt-web" as const,
      observedModel: null,
      observedEffort: null,
      providerOperationId: summary.providerOperationId,
      sourceBoundary,
      sourceCursor: summary.sourceCursor,
    },
  };
}
