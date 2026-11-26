import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CompactionRequest,
  ContextBinding,
} from "../../domain/context-continuity";

// On-disk layout of the private context store: record keys and the paths they
// map to. Pure string rules; nothing here touches the filesystem.

const SHA256_HEX = /^[a-f0-9]{64}$/u;

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function bindingKey(binding: ContextBinding): string {
  return digest([
    binding.ownerId,
    binding.taskId,
    binding.hostThreadId,
    binding.sessionId,
  ]);
}

export function boundaryKey(request: CompactionRequest): string {
  return digest([request.source, request.sourceBoundary]);
}

export function checkpointKey(checkpointId: string): string {
  return digest([checkpointId]);
}

export function taskDirectory(root: string, binding: ContextBinding): string {
  return path.join(root, "tasks", bindingKey(binding));
}

export function checkpointDirectory(
  root: string,
  binding: ContextBinding,
): string {
  return path.join(taskDirectory(root, binding), "checkpoints");
}

export function sourceDirectory(root: string, binding: ContextBinding): string {
  return path.join(taskDirectory(root, binding), "sources");
}

export function summaryDirectory(
  root: string,
  binding: ContextBinding,
): string {
  return path.join(taskDirectory(root, binding), "summaries");
}

export function summaryAttemptDirectory(
  root: string,
  binding: ContextBinding,
): string {
  return path.join(taskDirectory(root, binding), "summary-attempts");
}

export function sessionFile(root: string, binding: ContextBinding): string {
  return path.join(taskDirectory(root, binding), "session.json");
}

export function completionFile(
  root: string,
  binding: ContextBinding,
  operationId: string,
): string {
  return path.join(
    taskDirectory(root, binding),
    `completion-${checkpointKey(operationId)}.json`,
  );
}

export function publicationFile(
  root: string,
  binding: ContextBinding,
  operationId: string,
): string {
  return path.join(
    checkpointDirectory(root, binding),
    `publication-${checkpointKey(operationId)}.json`,
  );
}

export function admissionLeaseFile(root: string, sessionKey: string): string {
  if (!SHA256_HEX.test(sessionKey)) {
    throw new Error("CONTEXT_ADMISSION_LEASE_KEY_INVALID");
  }
  return path.join(root, "tasks", sessionKey, "admission.lock");
}

export function ownerOperationKey(root: string, sessionKey: string): string {
  if (!SHA256_HEX.test(sessionKey))
    throw new Error("CONTEXT_ADMISSION_LEASE_INVALID");
  return path.join(root, "tasks", sessionKey, ".context-owner");
}
