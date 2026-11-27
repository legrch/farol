import { createHash } from "node:crypto";

// The identities of one summary operation: the key that tells two operations
// apart in memory, the cursor that names the conversation a summary came from
// and the provider operation id derived from both. Pure digests of their
// arguments; nothing is read or stored here.

export type OperationBinding = Readonly<{
  ownerId: string;
  taskId: string;
  hostThreadId: string;
  sessionId: string;
}>;

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function operationKey(
  binding: OperationBinding,
  operationId: string,
): string {
  return digest(
    JSON.stringify([
      binding.ownerId,
      binding.taskId,
      binding.hostThreadId,
      binding.sessionId,
      operationId,
    ]),
  );
}

export function conversationSourceCursor(conversationUrl: string): string {
  return `conversation:${digest(conversationUrl)}`;
}

export function summaryProviderOperationId(
  operationId: string,
  sourceBoundary: string,
  conversationUrl: string,
): string {
  return `summary-${digest(
    JSON.stringify([operationId, sourceBoundary, conversationUrl]),
  ).slice(0, 40)}`;
}
