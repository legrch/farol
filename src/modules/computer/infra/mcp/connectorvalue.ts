// The content-free answer to a recorded connector verification, and the
// classification of a recorder failure into the codes a caller may see.
export function connectorReceiptValue(
  input: Readonly<{
    recorded: Readonly<{
      receipt: Readonly<{ challengeSha256: string }>;
      receiptSha256: string;
    }>;
    binding: Readonly<{
      taskId: string;
      participantId: string;
      turnId: string;
      generation: number;
    }>;
    workspaceId: string;
    entryCount: number;
    truncated: boolean;
  }>,
) {
  return {
    ok: true,
    challengeSha256: input.recorded.receipt.challengeSha256,
    receiptSha256: input.recorded.receiptSha256,
    workspaceId: input.workspaceId,
    operation: "workspace.list" as const,
    entryCount: input.entryCount,
    truncated: input.truncated,
    correlation: {
      taskId: input.binding.taskId,
      participantId: input.binding.participantId,
      turnId: input.binding.turnId,
      generation: input.binding.generation,
    },
  };
}

// Only the two known recorder refusals keep their own code; anything else,
// thrown value or not, is an unspecific receipt failure.
export function connectorRecordFailureCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "CONNECTOR_VERIFICATION_ALREADY_RECORDED") return code;
  if (code === "CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH") return code;
  return "CONNECTOR_VERIFICATION_RECEIPT_FAILED";
}
