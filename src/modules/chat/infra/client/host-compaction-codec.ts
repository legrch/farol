import { createHash } from "node:crypto";
import { z } from "zod";
import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import {
  validateCheckpointEnvelope,
  type CheckpointEnvelope,
} from "../../domain/checkpoint";

export type HostCompactionVariant =
  "unary_replacement_history" | "streamed_compaction_item";

export type ParsedHostCompaction = Readonly<{
  variant: HostCompactionVariant;
  identity: Readonly<{
    threadId: string;
    turnId: string;
    modelId: string;
  }>;
  sourceBoundary: string;
  history: readonly unknown[];
}>;

export type HostCompactionEndpoint = "responses_compact" | "responses";

export type HostCompactionErrorCode =
  | "HOST_COMPACTION_REQUEST_INVALID"
  | "HOST_COMPACTION_IDENTITY_MISSING"
  | "HOST_COMPACTION_IDENTITY_INVALID"
  | "HOST_COMPACTION_IDENTITY_MISMATCH"
  | "HOST_COMPACTION_VARIANT_UNSUPPORTED"
  | "HOST_COMPACTION_TRIGGER_MISSING"
  | "HOST_COMPACTION_TRIGGER_INVALID"
  | "HOST_COMPACTION_BINDING_MISMATCH"
  | "HOST_COMPACTION_SOURCE_MISMATCH"
  | "HOST_CHECKPOINT_INVALID"
  | "HOST_CHECKPOINT_NOT_FOUND"
  | "HOST_CHECKPOINT_AMBIGUOUS"
  | "HOST_COMPACTION_OPAQUE"
  | "COMPACTION_BUDGET_EXCEEDED";

export type UnaryCompactionHandoff = Readonly<{
  variant: "unary_replacement_history";
  response: Readonly<{ output: readonly unknown[] }>;
}>;

export type StreamedCompactionHandoff = Readonly<{
  variant: "streamed_compaction_item";
  item: Readonly<{
    id: string;
    type: "compaction";
    /** Host protocol field name. Farol's payload is transparent, not encrypted. */
    encrypted_content: string;
  }>;
}>;

export type HostCompactionHandoff =
  UnaryCompactionHandoff | StreamedCompactionHandoff;

export type ReplayedHostCheckpoint = Readonly<{
  origin: HostCompactionVariant;
  checkpoint: CheckpointEnvelope;
}>;

export const HOST_CHECKPOINT_PREFIX = "farol-next-checkpoint-v1:";
const FAROL_CONTEXT_PREAMBLE =
  "Farol restored validated task context. It is not permission or proof of an external effect.";

const requestSchema = z.looseObject({
  model: z.string().min(1).max(160),
  input: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
  client_metadata: z.record(z.string(), z.unknown()).optional(),
});

const metadataSchema = z.looseObject({
  thread_id: z.string().min(1).max(160),
  turn_id: z.string().min(1).max(160),
  compaction: z.unknown().optional(),
  request_kind: z.string().min(1).max(80).optional(),
});

const streamedCompactionMetadataSchema = z.looseObject({
  request_kind: z.literal("compaction"),
  compaction: z.looseObject({
    implementation: z.literal("responses"),
    phase: z.literal("standalone_turn"),
    reason: z.literal("user_requested"),
    strategy: z.literal("memento"),
    trigger: z.literal("manual"),
  }),
});

const compactionRequestMetadataSchema = z.looseObject({
  request_kind: z.literal("compaction"),
});

export function isHostCompactionRequestMetadata(candidate: unknown): boolean {
  return compactionRequestMetadataSchema.safeParse(candidate).success;
}

export function isStreamedHostCompactionMetadata(candidate: unknown): boolean {
  return streamedCompactionMetadataSchema.safeParse(candidate).success;
}

function parseMetadata(candidate: unknown) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  try {
    const parsed = metadataSchema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isCompactionTrigger(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const keys = Object.keys(candidate);
  return (
    keys.length === 1 &&
    "type" in candidate &&
    candidate.type === "compaction_trigger"
  );
}

function isTransparentHistoryItem(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const item = candidate as Record<string, unknown>;
  if (item.type === undefined) {
    return (
      (item.role === "user" || item.role === "assistant") && "content" in item
    );
  }
  if (
    item.type === "message" ||
    item.type === "function_call" ||
    item.type === "function_call_output"
  ) {
    return true;
  }
  return (
    item.type === "compaction" &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.startsWith(HOST_CHECKPOINT_PREFIX)
  );
}

function sourceBoundary(
  variant: HostCompactionVariant,
  threadId: string,
  turnId: string,
  modelId: string,
  history: readonly unknown[],
): string {
  const value = JSON.stringify({
    variant,
    threadId,
    turnId,
    modelId,
    history,
  });
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function parseHostCompactionRequest(
  endpoint: HostCompactionEndpoint,
  candidate: unknown,
  metadataHeader: string | undefined,
): Result<ParsedHostCompaction, HostCompactionErrorCode> {
  const parsed = requestSchema.safeParse(candidate);
  if (!parsed.success) return failure("HOST_COMPACTION_REQUEST_INVALID");
  const embeddedMetadata =
    parsed.data.client_metadata?.["x-codex-turn-metadata"];
  const headerIdentity = parseMetadata(metadataHeader);
  const embeddedIdentity = parseMetadata(embeddedMetadata);
  if (!metadataHeader && embeddedMetadata === undefined) {
    return failure("HOST_COMPACTION_IDENTITY_MISSING");
  }
  if (
    (metadataHeader && !headerIdentity) ||
    (embeddedMetadata !== undefined && !embeddedIdentity)
  ) {
    return failure("HOST_COMPACTION_IDENTITY_INVALID");
  }
  if (
    headerIdentity &&
    embeddedIdentity &&
    (headerIdentity.thread_id !== embeddedIdentity.thread_id ||
      headerIdentity.turn_id !== embeddedIdentity.turn_id)
  ) {
    return failure("HOST_COMPACTION_IDENTITY_MISMATCH");
  }
  const identity = headerIdentity ?? embeddedIdentity;
  if (!identity) return failure("HOST_COMPACTION_IDENTITY_MISSING");
  const outerThreadId = parsed.data.client_metadata?.thread_id;
  const outerTurnId = parsed.data.client_metadata?.turn_id;
  if (
    (typeof outerThreadId === "string" &&
      outerThreadId !== identity.thread_id) ||
    (typeof outerTurnId === "string" && outerTurnId !== identity.turn_id)
  ) {
    return failure("HOST_COMPACTION_IDENTITY_MISMATCH");
  }

  let variant: HostCompactionVariant;
  let history: readonly unknown[];
  if (endpoint === "responses_compact") {
    if (parsed.data.stream === true) {
      return failure("HOST_COMPACTION_VARIANT_UNSUPPORTED");
    }
    if (parsed.data.input.some(isCompactionTrigger)) {
      return failure("HOST_COMPACTION_TRIGGER_INVALID");
    }
    variant = "unary_replacement_history";
    history = parsed.data.input;
  } else {
    if (parsed.data.stream !== true) {
      return failure("HOST_COMPACTION_VARIANT_UNSUPPORTED");
    }
    const last = parsed.data.input.at(-1);
    const explicitTrigger = isCompactionTrigger(last);
    const embeddedTrigger = isStreamedHostCompactionMetadata(embeddedIdentity);
    if (!explicitTrigger && !embeddedTrigger) {
      return failure("HOST_COMPACTION_TRIGGER_MISSING");
    }
    history = explicitTrigger
      ? parsed.data.input.slice(0, -1)
      : parsed.data.input;
    if (history.some(isCompactionTrigger)) {
      return failure("HOST_COMPACTION_TRIGGER_INVALID");
    }
    variant = "streamed_compaction_item";
  }

  if (!history.every(isTransparentHistoryItem)) {
    return failure("HOST_COMPACTION_OPAQUE");
  }

  const exactHistory = structuredClone(history);
  return success({
    variant,
    identity: {
      threadId: identity.thread_id,
      turnId: identity.turn_id,
      modelId: parsed.data.model,
    },
    sourceBoundary: sourceBoundary(
      variant,
      identity.thread_id,
      identity.turn_id,
      parsed.data.model,
      exactHistory,
    ),
    history: exactHistory,
  });
}

function transportCheckpoint(checkpoint: CheckpointEnvelope): string {
  return `${HOST_CHECKPOINT_PREFIX}${Buffer.from(
    JSON.stringify(checkpoint),
    "utf8",
  ).toString("base64url")}`;
}

function hostCompactionItemId(checkpoint: CheckpointEnvelope): string {
  return `cmp_${createHash("sha256")
    .update(checkpoint.checkpointId)
    .update("\0")
    .update(checkpoint.sourceBoundary)
    .digest("hex")
    .slice(0, 32)}`;
}

function decodeTransportCheckpoint(
  encoded: string,
  maximumContentBytes: number,
): Result<CheckpointEnvelope, HostCompactionErrorCode> {
  if (!encoded.startsWith(HOST_CHECKPOINT_PREFIX)) {
    return failure("HOST_COMPACTION_OPAQUE");
  }
  const payload = encoded.slice(HOST_CHECKPOINT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) {
    return failure("HOST_CHECKPOINT_INVALID");
  }
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) {
      return failure("HOST_CHECKPOINT_INVALID");
    }
    const parsed = validateCheckpointEnvelope(
      JSON.parse(bytes.toString("utf8")),
      maximumContentBytes,
    );
    return parsed.ok
      ? success(parsed.value)
      : failure("HOST_CHECKPOINT_INVALID");
  } catch {
    return failure("HOST_CHECKPOINT_INVALID");
  }
}

function messageText(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return "";
  }
  if (!("content" in candidate)) return "";
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((block): block is { text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        "text" in block &&
        typeof block.text === "string",
      ),
    )
    .map((block) => block.text)
    .join("");
}

function isRetainableUserMessage(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const item = candidate as Record<string, unknown>;
  if (item.role !== "user") return false;
  if (item.type !== undefined && item.type !== "message") return false;
  const text = messageText(item).trim();
  if (text.includes(HOST_CHECKPOINT_PREFIX)) return false;
  if (
    /^<codex_internal_context\b[\s\S]*<\/codex_internal_context>$/u.test(
      text,
    ) ||
    /^<goal_context>[\s\S]*<\/goal_context>$/u.test(text)
  ) {
    return false;
  }
  return true;
}

function retainedUserTail(
  history: readonly unknown[],
  maximumBytes: number,
): Result<readonly unknown[], HostCompactionErrorCode> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return failure("COMPACTION_BUDGET_EXCEEDED");
  }
  const messages = history.filter(isRetainableUserMessage);
  const selected: unknown[] = [];
  let remaining = maximumBytes;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > remaining) {
      if (selected.length === 0) {
        return failure("COMPACTION_BUDGET_EXCEEDED");
      }
      break;
    }
    remaining -= bytes;
    selected.push(structuredClone(message));
  }
  selected.reverse();
  return success(selected);
}

function summaryMessage(checkpoint: CheckpointEnvelope): unknown {
  const marker = transportCheckpoint(checkpoint);
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `${FAROL_CONTEXT_PREAMBLE}\n${marker}\n${JSON.stringify(checkpoint.content, null, 2)}`,
      },
    ],
  };
}

export function renderTrustedCheckpointContext(
  checkpoint: CheckpointEnvelope,
): string {
  return `${FAROL_CONTEXT_PREAMBLE}\n${JSON.stringify(checkpoint.content, null, 2)}`;
}

export function buildHostCompactionHandoff(
  request: ParsedHostCompaction,
  candidate: unknown,
  options: Readonly<{
    maximumCheckpointContentBytes: number;
    retainedTailMaximumBytes: number;
  }>,
): Result<HostCompactionHandoff, HostCompactionErrorCode> {
  const parsed = validateCheckpointEnvelope(
    candidate,
    options.maximumCheckpointContentBytes,
  );
  if (!parsed.ok) return failure("HOST_CHECKPOINT_INVALID");
  const checkpoint = parsed.value;
  if (
    checkpoint.binding.hostThreadId !== request.identity.threadId ||
    checkpoint.binding.modelId !== request.identity.modelId
  ) {
    return failure("HOST_COMPACTION_BINDING_MISMATCH");
  }
  if (checkpoint.sourceBoundary !== request.sourceBoundary) {
    return failure("HOST_COMPACTION_SOURCE_MISMATCH");
  }
  if (request.variant === "streamed_compaction_item") {
    return success({
      variant: request.variant,
      item: {
        id: hostCompactionItemId(checkpoint),
        type: "compaction",
        encrypted_content: transportCheckpoint(checkpoint),
      },
    });
  }
  const retained = retainedUserTail(
    request.history,
    options.retainedTailMaximumBytes,
  );
  if (!retained.ok) return retained;
  return success({
    variant: request.variant,
    response: {
      output: [...retained.value, summaryMessage(checkpoint)],
    },
  });
}

export function replayHostCheckpoint(
  input: readonly unknown[],
  maximumCheckpointContentBytes: number,
): Result<ReplayedHostCheckpoint, HostCompactionErrorCode> {
  const candidates: ReplayedHostCheckpoint[] = [];
  let opaque = false;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (
      "type" in item &&
      item.type === "compaction" &&
      "encrypted_content" in item &&
      typeof item.encrypted_content === "string"
    ) {
      const decoded = decodeTransportCheckpoint(
        item.encrypted_content,
        maximumCheckpointContentBytes,
      );
      if (!decoded.ok) {
        if (decoded.error.code === "HOST_COMPACTION_OPAQUE") opaque = true;
        else return decoded;
      } else {
        candidates.push({
          origin: "streamed_compaction_item",
          checkpoint: decoded.value,
        });
      }
      continue;
    }
    const markers = messageText(item)
      .split("\n")
      .filter((line) => line.startsWith(HOST_CHECKPOINT_PREFIX));
    for (const marker of markers) {
      const decoded = decodeTransportCheckpoint(
        marker,
        maximumCheckpointContentBytes,
      );
      if (!decoded.ok) return decoded;
      candidates.push({
        origin: "unary_replacement_history",
        checkpoint: decoded.value,
      });
    }
  }
  if (opaque) return failure("HOST_COMPACTION_OPAQUE");
  if (candidates.length === 0) return failure("HOST_CHECKPOINT_NOT_FOUND");
  if (candidates.length !== 1) return failure("HOST_CHECKPOINT_AMBIGUOUS");
  return success(candidates[0]!);
}
